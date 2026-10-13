import { ORPCError } from "@orpc/server";
import type { JobPublisher } from "@rakazo/adapter-kit";
import { linearSyncJob, runJobKey } from "@rakazo/adapter-kit";
import type { CancelledLinearRuns, LockedLinearSource } from "@rakazo/adapters";
import {
  cancelLinearRunsInTransaction,
  publishCancelledLinearRuns,
  refreshLinearSourceMonitoring,
} from "@rakazo/adapters";
import type { Actor, LinearTrigger } from "@rakazo/contracts";
import { LINEAR_EVENT_KINDS } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { Prisma, ThreadEvents } from "@rakazo/db";
import { IsolationError, lockSpaceForContentCreation } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

export const AUTOMATION_CHANGED_MESSAGE = "Automation changed. Reload and try again.";
export const UNAVAILABLE_LINEAR_OPTION_MESSAGE = "Choose an available Linear option";

type LinearTriggerRow = {
  connectionId: string;
  teamId: string;
  events: string[];
  projectId: string | null;
  assigneeId: string | null;
  stateId: string | null;
  labelIds: string[];
};

export function toLinearTrigger(row: LinearTriggerRow | null | undefined): LinearTrigger | null {
  if (!row) return null;
  return {
    connectionId: row.connectionId,
    teamId: row.teamId,
    events: LINEAR_EVENT_KINDS.filter((kind) => row.events.includes(kind)),
    projectId: row.projectId,
    assigneeId: row.assigneeId,
    stateId: row.stateId,
    labelIds: [...new Set(row.labelIds)].sort(),
  };
}

export function sameLinearTrigger(left: LinearTrigger | null, right: LinearTrigger | null) {
  if (!left || !right) return left === right;
  return (
    left.connectionId === right.connectionId &&
    left.teamId === right.teamId &&
    left.projectId === right.projectId &&
    left.assigneeId === right.assigneeId &&
    left.stateId === right.stateId &&
    left.events.join("\n") === right.events.join("\n") &&
    left.labelIds.join("\n") === right.labelIds.join("\n")
  );
}

export function sameLinearTriggerState(
  left: (LinearTriggerRow & { revision: number; activatedAt: Date | null }) | null,
  right: (LinearTriggerRow & { revision: number; activatedAt: Date | null }) | null,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.revision === right.revision &&
    (left.activatedAt?.getTime() ?? null) === (right.activatedAt?.getTime() ?? null) &&
    sameLinearTrigger(toLinearTrigger(left), toLinearTrigger(right))
  );
}

export function linearTriggerData(trigger: LinearTrigger) {
  return {
    connectionId: trigger.connectionId,
    teamId: trigger.teamId,
    events: [...trigger.events],
    projectId: trigger.projectId,
    assigneeId: trigger.assigneeId,
    stateId: trigger.stateId,
    labelIds: [...trigger.labelIds],
  };
}

export function linearConnectionIds(
  ...triggers: Array<{ connectionId: string } | null | undefined>
): string[] {
  return [
    ...new Set(triggers.flatMap((trigger) => (trigger ? [trigger.connectionId] : []))),
  ].sort();
}

export async function lockRoutineOwnerBot(
  tx: Prisma.TransactionClient,
  actor: Pick<Actor, "spaceId" | "userId">,
  botId: string,
  options: { membership: boolean; includeArchived: boolean },
): Promise<void> {
  if (options.membership) {
    await lockSpaceForContentCreation(tx, actor);
    const member = await tx.$queryRaw<Array<{ locked: number }>>`
      SELECT 1 AS locked FROM "space_members"
      WHERE "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId}
      FOR SHARE
    `;
    if (member.length !== 1) throw new IsolationError();
  }
  const bot = await tx.$queryRaw<Array<{ archivedAt: Date | null }>>`
    SELECT "archivedAt" FROM bots
    WHERE id = ${botId} AND "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId}
    FOR SHARE
  `;
  const locked = bot[0];
  if (!locked || (!options.includeArchived && locked.archivedAt)) throw new IsolationError();
}

export function assertAttachableLinearSource(
  source: LockedLinearSource | undefined,
  actor: Pick<Actor, "spaceId" | "userId">,
  sourceRevision: number,
): void {
  if (
    !source ||
    source.connection.userId !== actor.userId ||
    source.connection.spaceId !== actor.spaceId
  ) {
    throw new ORPCError("BAD_REQUEST", { message: UNAVAILABLE_LINEAR_OPTION_MESSAGE });
  }
  if (source.revision !== sourceRevision) {
    throw new ORPCError("CONFLICT", { message: AUTOMATION_CHANGED_MESSAGE });
  }
  if (source.connection.status !== "connected") {
    throw new ORPCError("BAD_REQUEST", { message: UNAVAILABLE_LINEAR_OPTION_MESSAGE });
  }
}

export async function refreshRoutineLinearSources(
  tx: Prisma.TransactionClient,
  sources: ReadonlyMap<string, LockedLinearSource>,
  connectionIds: readonly string[],
): Promise<string[]> {
  const enqueue: string[] = [];
  for (const connectionId of connectionIds) {
    if (!sources.has(connectionId)) continue;
    if ((await refreshLinearSourceMonitoring(tx, connectionId)).enqueue) enqueue.push(connectionId);
  }
  return enqueue;
}

export async function cancelRoutineLinearRuns(
  tx: Prisma.TransactionClient,
  routineId: string,
  now: Date,
): Promise<CancelledLinearRuns> {
  const runs = await tx.run.findMany({
    where: { routineId, trigger: "linear", status: { in: [...ACTIVE_RUN_STATUSES] } },
    select: { id: true },
  });
  return cancelLinearRunsInTransaction(tx, runs, now);
}

export async function publishRoutineLinearWork(
  deps: { jobs: JobPublisher; events: Pick<ThreadEvents, "notify"> },
  work: { linearSyncIds: readonly string[]; cancelled: CancelledLinearRuns | null },
): Promise<void> {
  await Promise.all([
    ...work.linearSyncIds.map((connectionId) =>
      deps.jobs.enqueue(linearSyncJob({ connectionId })).catch((error: unknown) => {
        getLogger().error("routine linear sync enqueue", error);
      }),
    ),
    ...(work.cancelled?.runIds ?? []).map((runId) =>
      deps.jobs.cancel(runJobKey(runId)).catch((error: unknown) => {
        getLogger().error("routine linear run cancel", error);
      }),
    ),
  ]);
  if (work.cancelled) await publishCancelledLinearRuns(deps, work.cancelled);
}
