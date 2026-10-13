import type { IssueTrackerEvent } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import { expandSkillReferencesInPrompt, type SkillRecord } from "@rakazo/core";
import {
  IsolationError,
  lockSpaceForContentCreation,
  Prisma,
  SpaceDeletionInProgressError,
  withModelConfigurationOwnerLock,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { findRoutineTargetThreadId } from "./executor.js";
import {
  buildLinearTaskPrompt,
  linearRunNonce,
  linearSnapshotFromSeed,
  matchLinearTrigger,
  parseLinearSeed,
  parseLinearSnapshot,
} from "./linear-events.js";
import { refreshLinearSourceMonitoring } from "./linear-lifecycle.js";
import {
  applyLinearAuthFailure,
  applyLinearRateLimit,
  classifyLinearRequestError,
  LINEAR_DISPATCH_PHASE_MS,
  type LinearRequestFailure,
  type LinearSourceLease,
  type LinearSyncClock,
  linearBackoffMs,
  linearRateLimitDeadline,
  linearRequestBudget,
  lockActiveLinearLease,
  lockLeasedLinearSource,
  lockLinearMembership,
} from "./linear-poll.js";
import type { LinearWorkerDeps } from "./linear-sync.js";
import { routineRunModelPin } from "./model-selection.js";
import { listAgentSkillRecords } from "./skill-tools.js";

const READY_EVENT_LIMIT = 25;
const CANDIDATE_PAGE_SIZE = 25;
const READY_CONTINUATION_MS = 1_000;

type CandidateOutcome =
  | { kind: "advanced"; runId: string | null }
  | { kind: "event_changed" }
  | { kind: "stopped" };

type HydrationResult =
  | { kind: "observed"; snapshot: IssueTrackerEvent | null }
  | LinearRequestFailure;

/** Hydrates one webhook receipt, then fans out up to 25 ready events until the dispatch phase ends. */
export async function dispatchLinearEvents(
  deps: LinearWorkerDeps,
  lease: LinearSourceLease,
  clock: LinearSyncClock,
  credential: string,
): Promise<"continue" | "stopped"> {
  if ((await hydrateLinearEvent(deps, lease, clock, credential)) === "stopped") return "stopped";
  const ready = await deps.prisma.linearEvent.findMany({
    where: {
      connectionId: lease.connectionId,
      status: "pending",
      sourceGeneration: lease.generation,
      snapshot: { not: Prisma.DbNull },
      nextAttemptAt: { lte: new Date() },
    },
    orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
    take: READY_EVENT_LIMIT,
    select: { id: true, snapshot: true, afterRoutineId: true },
  });
  if (ready.length === 0) return "continue";
  const skills = await listAgentSkillRecords(deps.prisma, {
    spaceId: lease.spaceId,
    userId: lease.userId,
  });
  for (const event of ready) {
    if (phaseEnded(clock)) return "continue";
    if ((await fanOutLinearEvent(deps, lease, clock, event, skills)) === "stopped") {
      return "stopped";
    }
  }
  return "continue";
}

function phaseEnded(clock: LinearSyncClock): boolean {
  return clock.signal.aborted || Date.now() >= clock.startedAt + LINEAR_DISPATCH_PHASE_MS;
}

async function hydrateLinearEvent(
  deps: LinearWorkerDeps,
  lease: LinearSourceLease,
  clock: LinearSyncClock,
  credential: string,
): Promise<"continue" | "stopped"> {
  const now = new Date();
  const source = await deps.prisma.linearSource.findUnique({
    where: { connectionId: lease.connectionId },
    select: { rateLimitedUntil: true },
  });
  if (!source) return "stopped";
  if (source.rateLimitedUntil && source.rateLimitedUntil > now) return "continue";
  const event = await deps.prisma.linearEvent.findFirst({
    where: {
      connectionId: lease.connectionId,
      status: "pending",
      sourceGeneration: lease.generation,
      snapshot: { equals: Prisma.DbNull },
      nextAttemptAt: { lte: now },
    },
    orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
    select: { id: true, seed: true, errorCount: true },
  });
  if (!event) return "continue";

  const seed = parseLinearSeed(event.seed);
  let result: HydrationResult;
  if (!seed) {
    result = { kind: "observed", snapshot: null };
  } else {
    const budget = linearRequestBudget(clock, LINEAR_DISPATCH_PHASE_MS);
    if (!budget) return "continue";
    try {
      const observed = await deps.provider.hydrate(credential, seed, budget.signal);
      result = {
        kind: "observed",
        snapshot: observed ? linearSnapshotFromSeed(seed, observed) : null,
      };
    } catch (error) {
      result = classifyLinearRequestError(error, clock, budget);
    }
  }
  if (result.kind === "aborted") return "continue";
  const outcome = result;

  return withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      const locked = await lockActiveLinearLease(tx, lease);
      if (!locked) return "stopped" as const;
      const at = new Date();
      const where = {
        id: event.id,
        status: "pending",
        sourceGeneration: lease.generation,
        snapshot: { equals: Prisma.DbNull },
      };
      if (outcome.kind === "observed") {
        await tx.linearEvent.updateMany({
          where,
          data: outcome.snapshot
            ? {
                snapshot: outcome.snapshot as unknown as Prisma.InputJsonValue,
                nextAttemptAt: at,
                errorCount: 0,
                errorCode: null,
              }
            : { status: "discarded", seed: Prisma.DbNull, snapshot: Prisma.DbNull },
        });
        if (seed && locked.rateLimitedUntil && locked.rateLimitedUntil <= at) {
          await tx.linearSource.update({
            where: { connectionId: lease.connectionId },
            data: {
              rateLimitedUntil: null,
              ...(locked.errorCode === "rate_limit" ? { errorCode: null } : {}),
            },
          });
        }
        return "continue" as const;
      }
      const failure = outcome.failure;
      if (failure.code === "auth") {
        await applyLinearAuthFailure(tx, lease.connectionId);
        return "stopped" as const;
      }
      if (failure.code === "rate_limit") {
        const deadline = linearRateLimitDeadline(failure, at.getTime());
        await applyLinearRateLimit(tx, locked, deadline);
        await tx.linearEvent.updateMany({
          where,
          data: { nextAttemptAt: deadline, errorCode: "rate_limit" },
        });
        return "continue" as const;
      }
      const errorCount = event.errorCount + 1;
      await tx.linearEvent.updateMany({
        where,
        data: {
          errorCount,
          errorCode: failure.code === "invalid_cursor" ? "invalid_response" : failure.code,
          nextAttemptAt: new Date(at.getTime() + linearBackoffMs(errorCount)),
        },
      });
      return "continue" as const;
    }),
  );
}

async function fanOutLinearEvent(
  deps: LinearWorkerDeps,
  lease: LinearSourceLease,
  clock: LinearSyncClock,
  event: { id: string; snapshot: Prisma.JsonValue; afterRoutineId: string | null },
  skills: readonly SkillRecord[],
): Promise<"continue" | "stopped"> {
  const snapshot = parseLinearSnapshot(event.snapshot);
  if (!snapshot) return finishLinearEvent(deps, lease, event.id, event.afterRoutineId, "discarded");
  const occurredAt = new Date(snapshot.occurredAt);
  const candidates = await deps.prisma.routineLinearTrigger.findMany({
    where: {
      connectionId: lease.connectionId,
      events: { has: snapshot.kind },
      teamId: snapshot.issue.teamId,
      activatedAt: { lt: occurredAt },
      ...(event.afterRoutineId ? { routineId: { gt: event.afterRoutineId } } : {}),
    },
    orderBy: { routineId: "asc" },
    take: CANDIDATE_PAGE_SIZE,
    select: { routineId: true, routine: { select: { botId: true } } },
  });

  let after = event.afterRoutineId;
  for (const candidate of candidates) {
    if (phaseEnded(clock)) return "continue";
    const outcome = await dispatchLinearCandidate(deps, lease, {
      eventId: event.id,
      expectedAfter: after,
      routineId: candidate.routineId,
      botId: candidate.routine.botId,
      snapshot,
      skills,
    });
    if (outcome.kind === "stopped") return "stopped";
    if (outcome.kind === "event_changed") return "continue";
    after = candidate.routineId;
    if (outcome.runId) {
      await deps.jobs.enqueue(runContinueJob(outcome.runId)).catch(() => {
        getLogger().warn("linear run continuation deferred to reconciliation");
      });
    }
  }
  if (candidates.length === CANDIDATE_PAGE_SIZE) {
    return withTransactionRetry(() =>
      deps.prisma.$transaction(async (tx) => {
        if (!(await lockActiveLinearLease(tx, lease))) return "stopped" as const;
        await tx.linearEvent.updateMany({
          where: { id: event.id, status: "pending", afterRoutineId: after },
          data: { nextAttemptAt: new Date(Date.now() + READY_CONTINUATION_MS) },
        });
        return "continue" as const;
      }),
    );
  }
  return finishLinearEvent(deps, lease, event.id, after, "done");
}

async function finishLinearEvent(
  deps: LinearWorkerDeps,
  lease: LinearSourceLease,
  eventId: string,
  afterRoutineId: string | null,
  status: "done" | "discarded",
): Promise<"continue" | "stopped"> {
  return withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      if (!(await lockActiveLinearLease(tx, lease))) return "stopped" as const;
      await tx.linearEvent.updateMany({
        where: {
          id: eventId,
          status: "pending",
          sourceGeneration: lease.generation,
          afterRoutineId,
        },
        data: {
          status,
          seed: Prisma.DbNull,
          snapshot: Prisma.DbNull,
          errorCount: 0,
          errorCode: null,
        },
      });
      return "continue" as const;
    }),
  );
}

async function dispatchLinearCandidate(
  deps: LinearWorkerDeps,
  lease: LinearSourceLease,
  input: {
    eventId: string;
    expectedAfter: string | null;
    routineId: string;
    botId: string;
    snapshot: IssueTrackerEvent;
    skills: readonly SkillRecord[];
  },
): Promise<CandidateOutcome> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await withModelConfigurationOwnerLock(deps.prisma, lease.userId, (tx) =>
        createLinearCandidateRun(tx, lease, input),
      );
    } catch (error) {
      // A clientNonce unique race aborts the transaction; the retry adopts the winner.
      const unique =
        error && typeof error === "object" && "code" in error && error.code === "P2002";
      if (attempt >= 2 || !unique) throw error;
    }
  }
}

async function createLinearCandidateRun(
  tx: Prisma.TransactionClient,
  lease: LinearSourceLease,
  input: Parameters<typeof dispatchLinearCandidate>[2],
): Promise<CandidateOutcome> {
  let spaceAvailable = true;
  try {
    await lockSpaceForContentCreation(tx, { spaceId: lease.spaceId, userId: lease.userId });
  } catch (error) {
    if (!(error instanceof IsolationError) && !(error instanceof SpaceDeletionInProgressError)) {
      throw error;
    }
    spaceAvailable = false;
  }
  const member = spaceAvailable && (await lockLinearMembership(tx, lease));
  if (!member) {
    if (await lockLeasedLinearSource(tx, lease)) {
      await refreshLinearSourceMonitoring(tx, lease.connectionId);
    }
    return { kind: "stopped" };
  }
  await tx.$queryRaw`SELECT id FROM bots WHERE id = ${input.botId} FOR UPDATE`;
  const source = await lockLeasedLinearSource(tx, lease);
  if (source?.connection.status !== "connected") return { kind: "stopped" };
  await tx.$queryRaw`SELECT id FROM routines WHERE id = ${input.routineId} FOR UPDATE`;
  await tx.$queryRaw`
    SELECT "routineId" FROM routine_linear_triggers WHERE "routineId" = ${input.routineId} FOR UPDATE
  `;
  const [event] = await tx.$queryRaw<
    Array<{ status: string; sourceGeneration: number; afterRoutineId: string | null }>
  >`
    SELECT status, "sourceGeneration", "afterRoutineId"
    FROM linear_events WHERE id = ${input.eventId} FOR UPDATE
  `;
  if (
    event?.status !== "pending" ||
    event.sourceGeneration !== lease.generation ||
    event.afterRoutineId !== input.expectedAfter
  ) {
    return { kind: "event_changed" };
  }

  const routine = await tx.routine.findUnique({
    where: { id: input.routineId },
    select: {
      id: true,
      spaceId: true,
      userId: true,
      botId: true,
      threadId: true,
      active: true,
      prompt: true,
      modelProvider: true,
      modelId: true,
      thinkingLevel: true,
      linearTrigger: true,
      bot: { select: { id: true, spaceId: true, userId: true, archivedAt: true } },
    },
  });
  const trigger = routine?.linearTrigger;
  const eligible =
    routine &&
    trigger &&
    routine.active &&
    routine.botId === input.botId &&
    routine.spaceId === lease.spaceId &&
    routine.userId === lease.userId &&
    routine.bot.spaceId === lease.spaceId &&
    routine.bot.userId === lease.userId &&
    !routine.bot.archivedAt &&
    trigger.connectionId === lease.connectionId &&
    matchLinearTrigger(trigger, input.snapshot);

  let runId: string | null = null;
  if (eligible) {
    const threadId =
      (await findRoutineTargetThreadId(tx, routine, routine.botId)) ??
      (
        await tx.thread.findFirst({
          where: { botId: routine.botId, spaceId: lease.spaceId },
          select: { id: true },
        })
      )?.id;
    if (threadId) {
      const clientNonce = linearRunNonce(lease.connectionId, routine.id, input.snapshot.key);
      const winner = await tx.run.findUnique({
        where: { spaceId_clientNonce: { spaceId: lease.spaceId, clientNonce } },
        select: { id: true, status: true },
      });
      if (winner) {
        runId = winner.status === "queued" ? winner.id : null;
      } else {
        const task = await tx.task.create({
          data: {
            spaceId: lease.spaceId,
            botId: routine.botId,
            threadId,
            userId: lease.userId,
            prompt: buildLinearTaskPrompt(
              expandSkillReferencesInPrompt(routine.prompt, input.skills),
              input.snapshot,
            ),
            status: "queued",
          },
        });
        const run = await tx.run.create({
          data: {
            spaceId: lease.spaceId,
            botId: routine.botId,
            threadId,
            taskId: task.id,
            userId: lease.userId,
            status: "queued",
            trigger: "linear",
            routineId: routine.id,
            linearEventId: input.eventId,
            clientNonce,
            ...routineRunModelPin(routine),
          },
        });
        runId = run.id;
      }
      await tx.routine.update({ where: { id: routine.id }, data: { lastRunAt: new Date() } });
    }
  }
  await tx.linearEvent.update({
    where: { id: input.eventId },
    data: { afterRoutineId: input.routineId },
  });
  return { kind: "advanced", runId };
}
