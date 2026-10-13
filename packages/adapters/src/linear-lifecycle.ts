import { isIP } from "node:net";
import type { SecretStore } from "@rakazo/adapter-kit";
import { IssueTrackerError } from "@rakazo/adapter-kit";
import type { LinearSource, PrismaClient } from "@rakazo/db";
import { Prisma } from "@rakazo/db";
import { isPrivateRemoteMcpHostname } from "./remote-mcp.js";

export type LinearTx = Prisma.TransactionClient;

export type LockedLinearSource = LinearSource & {
  connection: {
    id: string;
    spaceId: string;
    userId: string;
    status: string;
    secretId: string | null;
    displayName: string;
  };
};

export async function lockLinearSources(
  tx: LinearTx,
  connectionIds: string[],
): Promise<Map<string, LockedLinearSource>> {
  const ids = [...new Set(connectionIds)].sort();
  const locked = new Map<string, LockedLinearSource>();
  if (ids.length === 0) return locked;
  await tx.$queryRaw`
    SELECT id FROM connections WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`;
  await tx.$queryRaw`
    SELECT "connectionId" FROM linear_sources
    WHERE "connectionId" IN (${Prisma.join(ids)})
    ORDER BY "connectionId" FOR UPDATE`;
  const rows = await tx.linearSource.findMany({
    where: { connectionId: { in: ids } },
    include: {
      connection: {
        select: {
          id: true,
          spaceId: true,
          userId: true,
          status: true,
          secretId: true,
          displayName: true,
        },
      },
    },
  });
  for (const id of ids) {
    const row = rows.find((candidate) => candidate.connectionId === id);
    if (row) locked.set(id, row);
  }
  return locked;
}

export async function linearDatabaseNow(tx: LinearTx): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date | string }>>`
    SELECT clock_timestamp() AS "now"`;
  const value = rows[0]?.now;
  if (value === undefined) throw new Error("Database clock unavailable");
  return value instanceof Date ? value : new Date(value);
}

export function eligibleLinearTriggerWhere(source: {
  connectionId: string;
  spaceId: string;
  userId: string;
}): Prisma.RoutineLinearTriggerWhereInput {
  return {
    connectionId: source.connectionId,
    activatedAt: { not: null },
    routine: {
      active: true,
      userId: source.userId,
      spaceId: source.spaceId,
      bot: { archivedAt: null },
      space: {
        deletingAt: null,
        memberships: { some: { userId: source.userId } },
      },
    },
  };
}

export async function refreshLinearSourceMonitoring(
  tx: LinearTx,
  connectionId: string,
): Promise<{ enqueue: boolean }> {
  const source = await tx.linearSource.findUnique({
    where: { connectionId },
    include: { connection: { select: { spaceId: true, userId: true, status: true } } },
  });
  if (!source) return { enqueue: false };
  const owner = {
    connectionId,
    spaceId: source.connection.spaceId,
    userId: source.connection.userId,
  };
  const membership =
    source.connection.status === "connected"
      ? await tx.spaceMember.findFirst({
          where: { spaceId: owner.spaceId, userId: owner.userId, space: { deletingAt: null } },
          select: { id: true },
        })
      : null;
  const eligible = membership
    ? await tx.routineLinearTrigger.count({ where: eligibleLinearTriggerWhere(owner) })
    : 0;
  const fenced = { revision: { increment: 1 }, leaseToken: null, leaseExpiresAt: null };
  if (eligible === 0) {
    await tx.linearSource.update({
      where: { connectionId },
      data: {
        ...fenced,
        monitoringSince: null,
        issueWindowEnd: null,
        commentWindowEnd: null,
        issueCursor: null,
        commentCursor: null,
        nextPollAt: null,
        nextSyncAt: null,
      },
    });
    await discardPendingLinearEvents(tx, connectionId);
    return { enqueue: false };
  }
  const now = await linearDatabaseNow(tx);
  if (source.monitoringSince === null) {
    await tx.linearSource.update({
      where: { connectionId },
      data: {
        ...fenced,
        monitoringSince: now,
        issuesThrough: now,
        commentsThrough: now,
        issueWindowEnd: null,
        commentWindowEnd: null,
        issueCursor: null,
        commentCursor: null,
        nextPollAt: now,
        nextSyncAt: now,
      },
    });
    return { enqueue: true };
  }
  const nextSyncAt =
    source.nextSyncAt && source.nextSyncAt.getTime() < now.getTime() ? source.nextSyncAt : now;
  await tx.linearSource.update({ where: { connectionId }, data: { ...fenced, nextSyncAt } });
  return { enqueue: true };
}

export async function discardPendingLinearEvents(
  tx: LinearTx,
  connectionId: string,
): Promise<void> {
  await tx.linearEvent.updateMany({
    where: { connectionId, status: "pending" },
    data: { status: "discarded", seed: Prisma.DbNull, snapshot: Prisma.DbNull },
  });
}

export async function readLinearCredential(
  db: Pick<PrismaClient, "secret"> | LinearTx,
  secrets: SecretStore,
  source: { connection: { secretId: string | null; userId: string; spaceId: string } },
): Promise<string> {
  const { secretId, userId, spaceId } = source.connection;
  const secret = secretId
    ? await db.secret.findFirst({
        where: { id: secretId, userId, spaceId, kind: "connector" },
        select: { id: true, ciphertext: true },
      })
    : null;
  if (!secret) throw new IssueTrackerError({ code: "auth", retryAt: null });
  return secrets.load(secret.ciphertext, { recordId: secret.id });
}

const NONPUBLIC_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".intranet",
  ".lan",
  ".home",
  ".home.arpa",
  ".corp",
  ".private",
  ".test",
  ".example",
  ".invalid",
];

function isPublicHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (!normalized || isIP(normalized) !== 0) return false;
  if (!normalized.includes(".")) return false;
  if (/^[\d.]+$/.test(normalized) || normalized.startsWith("0x")) return false;
  if (NONPUBLIC_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return false;
  return !isPrivateRemoteMcpHostname(normalized);
}

export function linearWebhookUrl(apiUrl: string | undefined, connectionId: string): string | null {
  if (!apiUrl) return null;
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash || apiUrl.includes("?") || apiUrl.includes("#")) return null;
  if (!isPublicHostname(url.hostname)) return null;
  return `${url.origin}/api/integrations/linear/${encodeURIComponent(connectionId)}/webhook`;
}
