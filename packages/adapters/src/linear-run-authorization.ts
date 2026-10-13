import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  cancelRunsInTransaction,
  createPendingSteeringRun,
  expireComputerExecutionLeases,
  IsolationError,
  lockSpaceForContentCreation,
  SpaceDeletionInProgressError,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { lockLinearSources } from "./linear-lifecycle.js";

export type CancelledLinearRuns = {
  runIds: string[];
  continuationRunIds: string[];
  events: Array<{ threadId: string; seq: number }>;
};

export type LinearRunAuthorization = "authorized" | "cancelled" | "lost";

export const LINEAR_RUN_UNAUTHORIZED = "This Linear automation is no longer authorized to run.";

export async function cancelLinearRunsInTransaction(
  tx: Prisma.TransactionClient,
  runs: ReadonlyArray<{ id: string }>,
  now: Date,
): Promise<CancelledLinearRuns> {
  const requested = [...new Set(runs.map((run) => run.id))];
  if (requested.length === 0) return { runIds: [], continuationRunIds: [], events: [] };
  const candidates = await tx.run.findMany({
    where: { id: { in: requested } },
    select: { threadId: true },
  });
  for (const threadId of [...new Set(candidates.map((run) => run.threadId))].sort()) {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
  }
  const active = await tx.run.findMany({
    where: { id: { in: requested }, status: { in: [...ACTIVE_RUN_STATUSES] } },
    select: { id: true, taskId: true, spaceId: true, threadId: true, botId: true },
    orderBy: { id: "asc" },
  });
  if (active.length === 0) return { runIds: [], continuationRunIds: [], events: [] };
  const runIds = active.map((run) => run.id);
  await cancelRunsInTransaction(tx, active, now);
  const events: CancelledLinearRuns["events"] = [];
  for (const run of active) {
    const event = await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      type: "run.cancelled",
      runId: run.id,
      payload: {},
    });
    events.push({ threadId: run.threadId, seq: event.seq });
  }
  await tx.event.deleteMany({ where: { type: "thread.progress", runId: { in: runIds } } });
  await expireComputerExecutionLeases(tx, { runId: { in: runIds } });
  await tx.computer.updateMany({
    where: {
      controlRunId: { in: runIds },
      OR: [{ controlHolder: { not: "user" } }, { controlLeaseId: null }],
    },
    data: { controlRunId: null },
  });
  await tx.computer.updateMany({
    where: { executionRunId: { in: runIds } },
    data: { executionRunId: null, executionBotId: null, executionLeaseExpiresAt: null },
  });
  await tx.steeringMessage.updateMany({
    where: { runId: { in: runIds } },
    data: { runId: null, claimedAt: null },
  });
  const continuationRunIds: string[] = [];
  const seen = new Set<string>();
  for (const run of active) {
    const key = JSON.stringify([run.spaceId, run.threadId, run.botId]);
    if (seen.has(key)) continue;
    seen.add(key);
    const continuation = await createPendingSteeringRun(tx, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
    });
    if (continuation) continuationRunIds.push(continuation);
  }
  return { runIds, continuationRunIds, events };
}

export async function publishCancelledLinearRuns(
  deps: { jobs: Pick<JobPublisher, "enqueue">; events?: Pick<ThreadEvents, "notify"> },
  cancelled: CancelledLinearRuns,
): Promise<void> {
  const latest = new Map<string, number>();
  for (const event of cancelled.events) {
    latest.set(event.threadId, Math.max(latest.get(event.threadId) ?? 0, event.seq));
  }
  await Promise.all([
    ...[...latest].map(([threadId, seq]) =>
      deps.events?.notify(threadId, seq).catch((error) => {
        getLogger().error("linear run cancellation realtime notification", error);
      }),
    ),
    ...cancelled.continuationRunIds.map((runId) =>
      deps.jobs.enqueue(runContinueJob(runId)).catch((error) => {
        getLogger().error("linear run cancellation continuation enqueue", error);
      }),
    ),
  ]);
}

async function holdsSpaceMembership(
  tx: Prisma.TransactionClient,
  run: { spaceId: string; userId: string },
): Promise<boolean> {
  try {
    await lockSpaceForContentCreation(tx, { spaceId: run.spaceId, userId: run.userId });
  } catch (error) {
    if (error instanceof IsolationError || error instanceof SpaceDeletionInProgressError) {
      return false;
    }
    throw error;
  }
  const held = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM space_members
    WHERE "spaceId" = ${run.spaceId} AND "userId" = ${run.userId}
    FOR SHARE
  `;
  return held.length === 1;
}

export type LinearRunClaim = {
  where: Prisma.RunWhereInput;
  data: Prisma.RunUpdateManyMutationInput;
};

export async function authorizeLinearRun(
  deps: {
    prisma: PrismaClient;
    jobs: Pick<JobPublisher, "enqueue">;
    events?: Pick<ThreadEvents, "notify">;
  },
  input: { runId: string; workerId: string; fence: number; claim?: LinearRunClaim },
): Promise<LinearRunAuthorization> {
  const provenance = await deps.prisma.run.findUnique({
    where: { id: input.runId },
    select: {
      spaceId: true,
      userId: true,
      botId: true,
      threadId: true,
      routineId: true,
      linearEventId: true,
      linearEvent: { select: { connectionId: true } },
    },
  });
  if (!provenance) return "lost";
  const outcome = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      const member = await holdsSpaceMembership(tx, provenance);
      await tx.$queryRaw`SELECT id FROM bots WHERE id = ${provenance.botId} FOR SHARE`;
      const bot = await tx.bot.findUnique({
        where: { id: provenance.botId },
        select: { spaceId: true, userId: true, archivedAt: true },
      });
      const connectionId = provenance.linearEvent?.connectionId ?? null;
      const source = connectionId
        ? ((await lockLinearSources(tx, [connectionId])).get(connectionId) ?? null)
        : null;
      if (provenance.routineId) {
        await tx.$queryRaw`SELECT id FROM routines WHERE id = ${provenance.routineId} FOR SHARE`;
        await tx.$queryRaw`
          SELECT "routineId" FROM routine_linear_triggers
          WHERE "routineId" = ${provenance.routineId}
          FOR SHARE
        `;
      }
      const routine = provenance.routineId
        ? await tx.routine.findUnique({
            where: { id: provenance.routineId },
            select: {
              spaceId: true,
              userId: true,
              botId: true,
              active: true,
              linearTrigger: { select: { connectionId: true, activatedAt: true } },
            },
          })
        : null;
      if (provenance.linearEventId) {
        await tx.$queryRaw`
          SELECT id FROM linear_events WHERE id = ${provenance.linearEventId} FOR SHARE
        `;
      }
      const event = provenance.linearEventId
        ? await tx.linearEvent.findUnique({
            where: { id: provenance.linearEventId },
            select: { connectionId: true, sourceGeneration: true, occurredAt: true },
          })
        : null;
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${provenance.threadId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM runs WHERE id = ${input.runId} FOR UPDATE`;
      const run = await tx.run.findUnique({
        where: { id: input.runId },
        select: {
          status: true,
          leaseOwner: true,
          leaseFence: true,
          startedAt: true,
          trigger: true,
          routineId: true,
          linearEventId: true,
          botId: true,
          spaceId: true,
          userId: true,
        },
      });
      if (!run) return { kind: "lost" as const };
      if (
        !input.claim &&
        (run.status !== "running" ||
          run.leaseOwner !== input.workerId ||
          run.leaseFence !== input.fence)
      ) {
        return { kind: "lost" as const };
      }
      const eligible =
        member &&
        run.trigger === "linear" &&
        run.routineId === provenance.routineId &&
        run.linearEventId === provenance.linearEventId &&
        bot?.archivedAt === null &&
        bot.spaceId === run.spaceId &&
        bot.userId === run.userId &&
        source?.connection.status === "connected" &&
        source.connection.spaceId === run.spaceId &&
        source.connection.userId === run.userId &&
        event?.connectionId === source.connectionId &&
        source.generation === event.sourceGeneration &&
        routine?.active === true &&
        routine.botId === run.botId &&
        routine.spaceId === run.spaceId &&
        routine.userId === run.userId &&
        routine.linearTrigger?.connectionId === event.connectionId &&
        routine.linearTrigger.activatedAt !== null &&
        routine.linearTrigger.activatedAt.getTime() < event.occurredAt.getTime();
      if (!eligible) {
        const cancelled = await cancelLinearRunsInTransaction(
          tx,
          [{ id: input.runId }],
          new Date(),
        );
        return cancelled.runIds.length > 0
          ? { kind: "cancelled" as const, cancelled }
          : { kind: "lost" as const };
      }
      if (!input.claim) return { kind: "authorized" as const };
      const claimed = await tx.run.updateMany({
        where: { AND: [input.claim.where, { id: input.runId }] },
        data: input.claim.data,
      });
      if (claimed.count !== 1) return { kind: "lost" as const };
      const started = await tx.run.updateMany({
        where: {
          id: input.runId,
          status: "leased",
          leaseOwner: input.workerId,
          leaseFence: input.fence,
        },
        data: { status: "running", startedAt: run.startedAt ?? new Date() },
      });
      return started.count === 1 ? { kind: "authorized" as const } : { kind: "lost" as const };
    }),
  );
  if (outcome.kind === "cancelled") {
    await publishCancelledLinearRuns(deps, outcome.cancelled);
  }
  return outcome.kind;
}
