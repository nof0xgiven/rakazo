import type {
  IssueTrackerEvent,
  IssueTrackerEventKind,
  IssueTrackerFailure,
  Page,
} from "@rakazo/adapter-kit";
import { isIssueTrackerError } from "@rakazo/adapter-kit";
import { type LinearSource, type Prisma, withTransactionRetry } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { recordLinearEvent } from "./linear-events.js";
import {
  eligibleLinearTriggerWhere,
  type LinearTx,
  type LockedLinearSource,
  lockLinearSources,
  refreshLinearSourceMonitoring,
} from "./linear-lifecycle.js";
import type { LinearWorkerDeps } from "./linear-sync.js";

export type LinearSourceLease = {
  connectionId: string;
  spaceId: string;
  userId: string;
  revision: number;
  generation: number;
  leaseToken: string;
};

export type LinearSyncClock = { startedAt: number; signal: AbortSignal };

export type LinearRequestBudget = { signal: AbortSignal; full: boolean };

export type LinearRequestFailure =
  | { kind: "failure"; failure: IssueTrackerFailure }
  | { kind: "aborted" };

type Collection = "issues" | "comments";

type WindowPlan =
  | { kind: "unneeded"; collection: Collection }
  | { kind: "waiting"; collection: Collection }
  | {
      kind: "fetch";
      collection: Collection;
      base: Date;
      from: Date;
      through: Date;
      cursor: string | null;
      catchUp: boolean;
    };

type PageOutcome =
  | { kind: "committed"; more: boolean }
  | { kind: "stopped" }
  | LinearRequestFailure;

export const LINEAR_POLL_PHASE_MS = 25_000;
export const LINEAR_DISPATCH_PHASE_MS = 55_000;
const REQUEST_TIMEOUT_MS = 20_000;
const COMMIT_RESERVE_MS = 2_000;
const MIN_REQUEST_MS = 1_000;
const POLL_INTERVAL_MS = 60_000;
const POLL_CONTINUATION_MS = 5_000;
const SETTLE_MS = 5_000;
const OVERLAP_MS = 120_000;
const MAX_WINDOW_MS = 3_600_000;
const RATE_LIMIT_FALLBACK_MS = 60_000;
const BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 480_000];
const MAX_BACKOFF_MS = 900_000;

const COLLECTION_KINDS: Record<Collection, readonly IssueTrackerEventKind[]> = {
  issues: ["issue.created", "issue.updated"],
  comments: ["comment.created"],
};

export function linearBackoffMs(errorCount: number): number {
  return BACKOFF_MS[Math.max(errorCount, 1) - 1] ?? MAX_BACKOFF_MS;
}

export function linearRateLimitDeadline(failure: IssueTrackerFailure, now: number): Date {
  const retryAt = failure.retryAt ? Date.parse(failure.retryAt) : Number.NaN;
  return new Date(Number.isFinite(retryAt) ? retryAt : now + RATE_LIMIT_FALLBACK_MS);
}

/** The per-request abort: min(20s, remaining phase minus a commit reserve); null when no usable time remains. */
export function linearRequestBudget(
  clock: LinearSyncClock,
  phaseMs: number,
): LinearRequestBudget | null {
  if (clock.signal.aborted) return null;
  const remaining = clock.startedAt + phaseMs - COMMIT_RESERVE_MS - Date.now();
  const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, remaining);
  if (timeoutMs < MIN_REQUEST_MS) return null;
  return {
    signal: AbortSignal.any([clock.signal, AbortSignal.timeout(timeoutMs)]),
    full: timeoutMs === REQUEST_TIMEOUT_MS,
  };
}

/** Local phase or shutdown aborts are not provider failures; a full request timeout is. */
export function classifyLinearRequestError(
  error: unknown,
  clock: LinearSyncClock,
  budget: LinearRequestBudget,
): LinearRequestFailure {
  if (isIssueTrackerError(error)) return { kind: "failure", failure: error.failure };
  if (clock.signal.aborted || (budget.signal.aborted && !budget.full)) return { kind: "aborted" };
  if (!budget.signal.aborted) getLogger().warn("linear request failed");
  return { kind: "failure", failure: { code: "unavailable", retryAt: null } };
}

export async function lockLinearMembership(
  tx: LinearTx,
  lease: LinearSourceLease,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM space_members
    WHERE "spaceId" = ${lease.spaceId} AND "userId" = ${lease.userId}
    FOR SHARE
  `;
  return rows.length > 0;
}

/** Connection then LinearSource FOR UPDATE, then the revision/generation/lease fence. */
export async function lockLeasedLinearSource(
  tx: LinearTx,
  lease: LinearSourceLease,
): Promise<LockedLinearSource | null> {
  const source = (await lockLinearSources(tx, [lease.connectionId])).get(lease.connectionId);
  if (
    !source ||
    source.revision !== lease.revision ||
    source.generation !== lease.generation ||
    source.leaseToken !== lease.leaseToken ||
    !source.leaseExpiresAt ||
    source.leaseExpiresAt.getTime() <= Date.now()
  ) {
    return null;
  }
  return source;
}

/** Membership row FOR SHARE, then the fenced source; a lost membership idles the source. */
export async function lockActiveLinearLease(
  tx: LinearTx,
  lease: LinearSourceLease,
): Promise<LockedLinearSource | null> {
  const member = await lockLinearMembership(tx, lease);
  const source = await lockLeasedLinearSource(tx, lease);
  if (!source) return null;
  if (!member) {
    await refreshLinearSourceMonitoring(tx, lease.connectionId);
    return null;
  }
  return source.connection.status === "connected" ? source : null;
}

export async function applyLinearAuthFailure(tx: LinearTx, connectionId: string): Promise<void> {
  await tx.connection.update({ where: { id: connectionId }, data: { status: "error" } });
  await tx.linearSource.update({
    where: { connectionId },
    data: {
      errorCode: "auth",
      errorCount: { increment: 1 },
      nextPollAt: null,
      nextSyncAt: null,
    },
  });
}

export async function applyLinearRateLimit(
  tx: LinearTx,
  source: Pick<LinearSource, "connectionId" | "rateLimitedUntil" | "nextPollAt">,
  deadline: Date,
): Promise<void> {
  const rateLimitedUntil =
    source.rateLimitedUntil && source.rateLimitedUntil > deadline
      ? source.rateLimitedUntil
      : deadline;
  await tx.linearSource.update({
    where: { connectionId: source.connectionId },
    data: {
      rateLimitedUntil,
      errorCode: "rate_limit",
      ...(source.nextPollAt && source.nextPollAt < rateLimitedUntil
        ? { nextPollAt: rateLimitedUntil }
        : {}),
    },
  });
}

function windowState(
  collection: Collection,
  state: { through: Date; windowEnd: Date | null; cursor: string | null },
): Prisma.LinearSourceUpdateInput {
  return collection === "issues"
    ? { issuesThrough: state.through, issueWindowEnd: state.windowEnd, issueCursor: state.cursor }
    : {
        commentsThrough: state.through,
        commentWindowEnd: state.windowEnd,
        commentCursor: state.cursor,
      };
}

function planLinearWindow(
  source: LinearSource,
  collection: Collection,
  triggers: ReadonlyArray<{ events: string[]; activatedAt: Date | null }>,
  now: number,
): WindowPlan {
  const kinds = COLLECTION_KINDS[collection];
  const activations = triggers.flatMap((trigger) =>
    trigger.activatedAt &&
    trigger.events.some((kind) => kinds.includes(kind as IssueTrackerEventKind))
      ? [trigger.activatedAt.getTime()]
      : [],
  );
  if (!source.monitoringSince || activations.length === 0) return { kind: "unneeded", collection };
  const state =
    collection === "issues"
      ? { through: source.issuesThrough, windowEnd: source.issueWindowEnd, cursor: source.issueCursor }
      : {
          through: source.commentsThrough,
          windowEnd: source.commentWindowEnd,
          cursor: source.commentCursor,
        };
  const completed = (state.through ?? source.monitoringSince).getTime();
  const base = state.windowEnd ? completed : Math.max(completed, Math.min(...activations));
  const settled = now - SETTLE_MS;
  const through = state.windowEnd
    ? state.windowEnd.getTime()
    : Math.min(settled, base + MAX_WINDOW_MS);
  if (through <= base) return { kind: "waiting", collection };
  return {
    kind: "fetch",
    collection,
    base: new Date(base),
    from: new Date(Math.max(source.monitoringSince.getTime(), base - OVERLAP_MS)),
    through: new Date(through),
    cursor: state.windowEnd ? state.cursor : null,
    catchUp: base + MAX_WINDOW_MS < settled,
  };
}

async function commitLinearPage(
  tx: LinearTx,
  lease: LinearSourceLease,
  plan: Extract<WindowPlan, { kind: "fetch" }>,
  page: Page<IssueTrackerEvent>,
): Promise<PageOutcome> {
  const source = await lockActiveLinearLease(tx, lease);
  if (!source) return { kind: "stopped" };
  const receivedAt = new Date();
  for (const event of page.items) {
    await recordLinearEvent(tx, source, { transport: "poll", event, receivedAt });
  }
  const final = page.nextCursor === null;
  await tx.linearSource.update({
    where: { connectionId: lease.connectionId },
    data: final
      ? {
          ...windowState(plan.collection, { through: plan.through, windowEnd: null, cursor: null }),
          lastPolledAt: receivedAt,
        }
      : windowState(plan.collection, {
          through: plan.base,
          windowEnd: plan.through,
          cursor: page.nextCursor,
        }),
  });
  return { kind: "committed", more: !final || plan.catchUp };
}

async function fetchLinearPage(
  deps: LinearWorkerDeps,
  lease: LinearSourceLease,
  clock: LinearSyncClock,
  credential: string,
  plan: Extract<WindowPlan, { kind: "fetch" }>,
): Promise<PageOutcome> {
  const budget = linearRequestBudget(clock, LINEAR_POLL_PHASE_MS);
  if (!budget) return { kind: "aborted" };
  let page: Page<IssueTrackerEvent>;
  try {
    page = await deps.provider.changes(
      credential,
      {
        collection: plan.collection,
        from: plan.from.toISOString(),
        through: plan.through.toISOString(),
        ...(plan.cursor ? { cursor: plan.cursor } : {}),
      },
      budget.signal,
    );
  } catch (error) {
    return classifyLinearRequestError(error, clock, budget);
  }
  try {
    return await withTransactionRetry(() =>
      deps.prisma.$transaction((tx) => commitLinearPage(tx, lease, plan, page)),
    );
  } catch (error) {
    if (isIssueTrackerError(error)) return { kind: "failure", failure: error.failure };
    throw error;
  }
}

/** One page per needed collection within the polling phase; each page commits separately under the fence. */
export async function pollLinearConnection(
  deps: LinearWorkerDeps,
  lease: LinearSourceLease,
  clock: LinearSyncClock,
  credential: string,
): Promise<"continue" | "stopped"> {
  const source = await deps.prisma.linearSource.findUnique({
    where: { connectionId: lease.connectionId },
  });
  if (!source || source.leaseToken !== lease.leaseToken) return "stopped";
  const startedAt = Date.now();
  if (!source.monitoringSince || !source.nextPollAt || source.nextPollAt.getTime() > startedAt) {
    return "continue";
  }
  if (source.rateLimitedUntil && source.rateLimitedUntil.getTime() > startedAt) return "continue";

  const triggers = await deps.prisma.routineLinearTrigger.findMany({
    where: eligibleLinearTriggerWhere(lease),
    select: { events: true, activatedAt: true },
  });
  const plans = (["issues", "comments"] as const).map((collection) =>
    planLinearWindow(source, collection, triggers, startedAt),
  );
  const settled = await Promise.allSettled(
    plans.map(async (plan) => ({
      plan,
      outcome:
        plan.kind === "fetch"
          ? await fetchLinearPage(deps, lease, clock, credential, plan)
          : null,
    })),
  );
  const outcomes: Array<{ plan: WindowPlan; outcome: PageOutcome | null }> = [];
  for (const result of settled) {
    if (result.status === "rejected") throw result.reason;
    outcomes.push(result.value);
  }
  if (outcomes.some(({ outcome }) => outcome?.kind === "stopped")) return "stopped";

  return withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      const locked = await lockActiveLinearLease(tx, lease);
      if (!locked) return "stopped" as const;
      const now = Date.now();
      const failures = outcomes.flatMap(({ plan, outcome }) =>
        outcome?.kind === "failure" ? [{ collection: plan.collection, failure: outcome.failure }] : [],
      );
      if (failures.some(({ failure }) => failure.code === "auth")) {
        await applyLinearAuthFailure(tx, lease.connectionId);
        return "stopped" as const;
      }

      const data: Prisma.LinearSourceUpdateInput = {};
      for (const { plan } of outcomes) {
        if (plan.kind === "unneeded") {
          Object.assign(
            data,
            windowState(plan.collection, { through: new Date(now), windowEnd: null, cursor: null }),
          );
        }
      }
      for (const { collection, failure } of failures) {
        if (failure.code === "invalid_cursor") {
          Object.assign(data, collection === "issues" ? { issueCursor: null } : { commentCursor: null });
        }
      }

      if (failures.length === 0) {
        const aborted = outcomes.some(({ outcome }) => outcome?.kind === "aborted");
        const more = outcomes.some(
          ({ outcome }) => outcome?.kind === "committed" && outcome.more,
        );
        if (!aborted) {
          data.errorCount = 0;
          data.errorCode = null;
          if (locked.rateLimitedUntil && locked.rateLimitedUntil.getTime() <= now) {
            data.rateLimitedUntil = null;
          }
        }
        data.nextPollAt = new Date(now + (aborted || more ? POLL_CONTINUATION_MS : POLL_INTERVAL_MS));
        await tx.linearSource.update({ where: { connectionId: lease.connectionId }, data });
        return "continue" as const;
      }

      let nextPollAt = now;
      const providerFailure = failures.find(({ failure }) => failure.code !== "rate_limit");
      if (providerFailure) {
        const errorCount = locked.errorCount + 1;
        data.errorCount = errorCount;
        if (providerFailure.failure.code !== "invalid_cursor") {
          data.errorCode = providerFailure.failure.code;
        }
        nextPollAt = now + linearBackoffMs(errorCount);
      }
      const rateLimit = failures.find(({ failure }) => failure.code === "rate_limit");
      if (rateLimit) {
        const deadline = linearRateLimitDeadline(rateLimit.failure, now);
        const until =
          locked.rateLimitedUntil && locked.rateLimitedUntil > deadline
            ? locked.rateLimitedUntil
            : deadline;
        data.rateLimitedUntil = until;
        data.errorCode = "rate_limit";
        nextPollAt = Math.max(nextPollAt, until.getTime());
      }
      data.nextPollAt = new Date(nextPollAt);
      await tx.linearSource.update({ where: { connectionId: lease.connectionId }, data });
      return "continue" as const;
    }),
  );
}
