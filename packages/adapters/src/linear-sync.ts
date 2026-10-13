import { randomUUID } from "node:crypto";
import type { IssueTrackerProvider, JobPublisher, SecretStore } from "@rakazo/adapter-kit";
import { isIssueTrackerError, linearSyncJob } from "@rakazo/adapter-kit";
import { Prisma, type PrismaClient, withTransactionRetry } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { dispatchLinearEvents } from "./linear-dispatch.js";
import {
  eligibleLinearTriggerWhere,
  type LockedLinearSource,
  readLinearCredential,
  refreshLinearSourceMonitoring,
} from "./linear-lifecycle.js";
import {
  applyLinearAuthFailure,
  type LinearSourceLease,
  lockActiveLinearLease,
  lockLeasedLinearSource,
  lockLinearMembership,
  pollLinearConnection,
} from "./linear-poll.js";

export type LinearWorkerDeps = {
  prisma: PrismaClient;
  secrets: SecretStore;
  provider: IssueTrackerProvider;
  jobs: JobPublisher;
  signal: AbortSignal;
};

const LEASE_MS = 90_000;
const INVOCATION_MS = 60_000;
const READY_CONTINUATION_MS = 1_000;
const PROVIDER_CONTINUATION_MS = 5_000;
const RECONCILE_BATCH_SIZE = 100;

/** One leased pass: poll, hydrate and fan out, then persist the next due time before enqueueing it. */
export async function syncLinearConnection(
  deps: LinearWorkerDeps,
  input: { connectionId: string },
): Promise<void> {
  const startedAt = Date.now();
  const stored = await deps.prisma.linearSource.findUnique({
    where: { connectionId: input.connectionId },
    select: {
      revision: true,
      generation: true,
      connection: { select: { spaceId: true, userId: true } },
    },
  });
  if (!stored) return;
  const leaseToken = randomUUID();
  const claimed = await deps.prisma.linearSource.updateMany({
    where: {
      connectionId: input.connectionId,
      revision: stored.revision,
      generation: stored.generation,
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: new Date() } }],
    },
    data: { leaseToken, leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
  });
  if (!claimed.count) return;
  const lease: LinearSourceLease = {
    connectionId: input.connectionId,
    spaceId: stored.connection.spaceId,
    userId: stored.connection.userId,
    revision: stored.revision,
    generation: stored.generation,
    leaseToken,
  };
  const clock = {
    startedAt,
    signal: AbortSignal.any([deps.signal, AbortSignal.timeout(INVOCATION_MS)]),
  };

  try {
    const source = await openLinearSync(deps, lease);
    if (!source) return;
    let credential: string;
    try {
      credential = await readLinearCredential(deps.prisma, deps.secrets, source);
    } catch (error) {
      if (!isIssueTrackerError(error) || error.failure.code !== "auth") throw error;
      await withTransactionRetry(() =>
        deps.prisma.$transaction(async (tx) => {
          if (await lockActiveLinearLease(tx, lease)) {
            await applyLinearAuthFailure(tx, lease.connectionId);
          }
        }),
      );
      return;
    }
    if ((await pollLinearConnection(deps, lease, clock, credential)) === "stopped") return;
    if ((await dispatchLinearEvents(deps, lease, clock, credential)) === "stopped") return;
    const nextSyncAt = await scheduleLinearSync(deps, lease);
    if (nextSyncAt) {
      await deps.jobs
        .enqueue(linearSyncJob({ connectionId: lease.connectionId }, nextSyncAt))
        .catch(() => getLogger().warn("linear sync scheduling deferred to reconciliation"));
    }
  } finally {
    await deps.prisma.linearSource.updateMany({
      where: { connectionId: lease.connectionId, leaseToken },
      data: { leaseToken: null, leaseExpiresAt: null },
    });
  }
}

/** Revoked or auth-failed sources drop due work; lost membership or no eligible target idles without HTTP. */
async function openLinearSync(
  deps: LinearWorkerDeps,
  lease: LinearSourceLease,
): Promise<LockedLinearSource | null> {
  return withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      const member = await lockLinearMembership(tx, lease);
      const source = await lockLeasedLinearSource(tx, lease);
      if (!source) return null;
      if (source.connection.status !== "connected" || source.errorCode === "auth") {
        await tx.linearSource.update({
          where: { connectionId: lease.connectionId },
          data: { nextPollAt: null, nextSyncAt: null, leaseToken: null, leaseExpiresAt: null },
        });
        return null;
      }
      const target = member
        ? await tx.routineLinearTrigger.findFirst({
            where: eligibleLinearTriggerWhere(lease),
            select: { routineId: true },
          })
        : null;
      if (!target) {
        await refreshLinearSourceMonitoring(tx, lease.connectionId);
        return null;
      }
      return source;
    }),
  );
}

async function scheduleLinearSync(
  deps: LinearWorkerDeps,
  lease: LinearSourceLease,
): Promise<Date | null> {
  return withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      const source = await lockActiveLinearLease(tx, lease);
      if (!source) return null;
      const now = Date.now();
      const pending = {
        connectionId: lease.connectionId,
        status: "pending",
        sourceGeneration: lease.generation,
      };
      const ready = await tx.linearEvent.findFirst({
        where: { ...pending, snapshot: { not: Prisma.DbNull } },
        orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
        select: { nextAttemptAt: true },
      });
      const unhydrated = await tx.linearEvent.findFirst({
        where: { ...pending, snapshot: { equals: Prisma.DbNull } },
        orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
        select: { nextAttemptAt: true },
      });
      const readyDue = ready
        ? Math.max(ready.nextAttemptAt.getTime(), now + READY_CONTINUATION_MS)
        : null;
      const providerWork = earliest(
        source.nextPollAt
          ? Math.max(source.nextPollAt.getTime(), now + PROVIDER_CONTINUATION_MS)
          : null,
        unhydrated
          ? Math.max(unhydrated.nextAttemptAt.getTime(), now + PROVIDER_CONTINUATION_MS)
          : null,
      );
      const providerDue =
        providerWork === null
          ? null
          : Math.max(source.rateLimitedUntil?.getTime() ?? 0, providerWork);
      const due = earliest(readyDue, providerDue);
      const nextSyncAt = due === null ? null : new Date(due);
      await tx.linearSource.update({
        where: { connectionId: lease.connectionId },
        data: { nextSyncAt, leaseToken: null, leaseExpiresAt: null },
      });
      return nextSyncAt;
    }),
  );
}

function earliest(...values: Array<number | null>): number | null {
  const defined = values.filter((value): value is number => value !== null);
  return defined.length ? Math.min(...defined) : null;
}

/** Enqueue-only recovery for due sources; remote pagination never runs here. */
export async function reconcileLinearSources(deps: LinearWorkerDeps): Promise<void> {
  const now = new Date();
  let cursor: { nextSyncAt: Date; connectionId: string } | undefined;
  for (;;) {
    const due = await deps.prisma.linearSource.findMany({
      where: {
        AND: [
          { nextSyncAt: { lte: now } },
          { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
          ...(cursor
            ? [
                {
                  OR: [
                    { nextSyncAt: { gt: cursor.nextSyncAt } },
                    { nextSyncAt: cursor.nextSyncAt, connectionId: { gt: cursor.connectionId } },
                  ],
                },
              ]
            : []),
        ],
      },
      orderBy: [{ nextSyncAt: "asc" }, { connectionId: "asc" }],
      take: RECONCILE_BATCH_SIZE,
      select: { connectionId: true, nextSyncAt: true },
    });
    await Promise.all(
      due.map((source) => deps.jobs.enqueue(linearSyncJob({ connectionId: source.connectionId }))),
    );
    const last = due.at(-1);
    if (due.length < RECONCILE_BATCH_SIZE || !last?.nextSyncAt) return;
    cursor = { nextSyncAt: last.nextSyncAt, connectionId: last.connectionId };
  }
}
