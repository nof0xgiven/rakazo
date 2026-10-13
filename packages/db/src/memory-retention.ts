import { randomUUID } from "node:crypto";
import { type MemorySelection, MemorySelectionSchema, type MessageBlock } from "@rakazo/contracts";
import { isConversationalRun } from "@rakazo/core";
import { Prisma, type PrismaClient } from "./client.js";
import { withTransactionRetry } from "./transaction-retry.js";

export const MEMORY_RETENTION_MAX_SOURCES = 16;
export const MEMORY_RETENTION_MAX_CONVERSATION_BYTES = 80 * 1024;
export const MEMORY_RETENTION_MAX_EXPLICIT_BYTES = 16 * 1024;
export const MEMORY_RETENTION_OCCURRED_SKEW_MS = 5 * 60_000;
export const MEMORY_RETENTION_CONVERSATION_SOURCE_KEY = "conversation";

export type MemoryRetentionDenial = "binding_retired" | "forbidden";
export type MemoryRetentionState = "pending" | "processing" | "completed" | "failed";

type RetentionClient = PrismaClient | Prisma.TransactionClient;

interface RetentionRun {
  id: string;
  spaceId: string;
  botId: string;
  userId: string;
  threadId: string;
  sourceMessageId: string | null;
  memorySelection: unknown;
}

const encoder = new TextEncoder();

function utf8Length(text: string): number {
  return encoder.encode(text).byteLength;
}

function parseStoredSelection(value: unknown): MemorySelection | null {
  if (value === null || value === undefined) return null;
  return MemorySelectionSchema.parse(value);
}

export async function readRunMemorySelection(
  prisma: RetentionClient,
  runId: string,
): Promise<MemorySelection | null> {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: { memorySelection: true },
  });
  return parseStoredSelection(run?.memorySelection);
}

export async function pinRunMemorySelection(
  prisma: RetentionClient,
  input: { runId: string; leaseOwner: string; leaseFence: number; selection: MemorySelection },
): Promise<MemorySelection | null> {
  const selection = MemorySelectionSchema.parse(input.selection);
  const fence = {
    id: input.runId,
    status: "running",
    leaseOwner: input.leaseOwner,
    leaseFence: input.leaseFence,
  };
  const pinned = await prisma.run.updateMany({
    where: { ...fence, memorySelection: { equals: Prisma.DbNull } },
    data: { memorySelection: selection },
  });
  if (pinned.count === 1) return selection;
  const current = await prisma.run.findFirst({ where: fence, select: { memorySelection: true } });
  return current ? parseStoredSelection(current.memorySelection) : null;
}

async function authorizeRetention(
  tx: Prisma.TransactionClient,
  run: RetentionRun,
  bindingId: string,
): Promise<"ok" | MemoryRetentionDenial> {
  const pin = MemorySelectionSchema.safeParse(run.memorySelection);
  if (!pin.success || pin.data.kind !== "bank" || pin.data.bindingId !== bindingId) {
    return "binding_retired";
  }
  const [binding] = await tx.$queryRaw<
    Array<{ botId: string; spaceMemoryConfigId: string; bankId: string }>
  >`SELECT "botId", "spaceMemoryConfigId", "bankId" FROM bot_memory_banks WHERE id = ${bindingId} FOR KEY SHARE`;
  if (
    !binding ||
    binding.botId !== run.botId ||
    binding.spaceMemoryConfigId !== pin.data.configId ||
    binding.bankId !== pin.data.bankId
  ) {
    return "binding_retired";
  }
  const config = await tx.spaceMemoryConfig.findUnique({
    where: { id: pin.data.configId },
    select: { spaceId: true, provider: true },
  });
  if (!config || config.spaceId !== run.spaceId || config.provider !== pin.data.provider) {
    return "binding_retired";
  }
  const bot = await tx.bot.findUnique({
    where: { id: run.botId },
    select: { userId: true, spaceId: true },
  });
  if (!bot || bot.userId !== run.userId || bot.spaceId !== run.spaceId) return "forbidden";
  const member = await tx.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: config.spaceId, userId: run.userId } },
    select: { id: true },
  });
  return member ? "ok" : "forbidden";
}

async function retentionSourceRows(
  client: RetentionClient,
  run: Pick<RetentionRun, "id" | "botId" | "threadId" | "sourceMessageId">,
  messageIds: string[],
) {
  const ids = [...new Set(messageIds)];
  if (ids.length === 0) return [];
  return client.message.findMany({
    where: {
      id: { in: ids },
      threadId: run.threadId,
      role: "user",
      OR: [
        ...(run.sourceMessageId
          ? [{ id: run.sourceMessageId, steeringMessages: { none: { botId: run.botId } } }]
          : []),
        { steeringMessages: { some: { runId: run.id, claimedAt: { not: null } } } },
      ],
    },
    select: { id: true, seq: true, createdAt: true, blocks: true },
    orderBy: [{ seq: "asc" }, { id: "asc" }],
  });
}

function userText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return (blocks as MessageBlock[])
    .flatMap((block) =>
      block?.kind === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("\n\n")
    .trim();
}

export async function loadRetentionSourceMessages(
  prisma: RetentionClient,
  input: { runId: string; threadId: string; messageIds: string[] },
): Promise<Array<{ id: string; seq: number; createdAt: Date; text: string }>> {
  const run = await prisma.run.findUnique({
    where: { id: input.runId },
    select: { id: true, botId: true, threadId: true, sourceMessageId: true },
  });
  if (!run || run.threadId !== input.threadId) return [];
  const rows = await retentionSourceRows(prisma, run, input.messageIds);
  return rows.flatMap((row) => {
    const text = userText(row.blocks);
    return text ? [{ id: row.id, seq: row.seq, createdAt: row.createdAt, text }] : [];
  });
}

export interface ConversationRetentionInput {
  bindingId: string;
  content: string;
  occurredAt: string;
  sourceMessageIds: string[];
}

export async function insertConversationRetentionInTransaction(
  tx: Prisma.TransactionClient,
  input: { runId: string; now: Date; retention: ConversationRetentionInput },
): Promise<string | null> {
  const { retention, now } = input;
  const ids = [...new Set(retention.sourceMessageIds)];
  if (
    retention.sourceMessageIds.length < 1 ||
    retention.sourceMessageIds.length > MEMORY_RETENTION_MAX_SOURCES ||
    !retention.content.trim() ||
    utf8Length(retention.content) > MEMORY_RETENTION_MAX_CONVERSATION_BYTES
  ) {
    return null;
  }
  const occurredAt = new Date(retention.occurredAt);
  if (
    !Number.isFinite(occurredAt.getTime()) ||
    Math.abs(occurredAt.getTime() - now.getTime()) > MEMORY_RETENTION_OCCURRED_SKEW_MS
  ) {
    return null;
  }
  const run = await tx.run.findUnique({
    where: { id: input.runId },
    select: {
      id: true,
      spaceId: true,
      botId: true,
      userId: true,
      threadId: true,
      trigger: true,
      sourceMessageId: true,
      memorySelection: true,
    },
  });
  if (!run || !isConversationalRun(run.trigger)) return null;
  if ((await authorizeRetention(tx, run, retention.bindingId)) !== "ok") return null;
  const sources = await retentionSourceRows(tx, run, ids);
  if (sources.length !== ids.length) return null;
  const created = await tx.memoryRetention.create({
    data: {
      runId: run.id,
      bindingId: retention.bindingId,
      sourceKey: MEMORY_RETENTION_CONVERSATION_SOURCE_KEY,
      sourceKind: "conversation",
      content: retention.content,
      occurredAt,
      operationId: randomUUID(),
      state: "pending",
      attemptCount: 0,
      nextAttemptAt: now,
      createdAt: now,
    },
    select: { id: true },
  });
  return created.id;
}

export async function insertExplicitMemoryRetention(
  prisma: PrismaClient,
  input: {
    runId: string;
    leaseOwner: string;
    leaseFence: number;
    bindingId: string;
    sourceKey: string;
    content: string;
    occurredAt: Date;
  },
): Promise<
  { retentionId: string; created: boolean } | { error: MemoryRetentionDenial | "fence_lost" }
> {
  if (
    input.sourceKey === MEMORY_RETENTION_CONVERSATION_SOURCE_KEY ||
    !input.sourceKey ||
    !input.content.trim() ||
    utf8Length(input.content) > MEMORY_RETENTION_MAX_EXPLICIT_BYTES ||
    !Number.isFinite(input.occurredAt.getTime())
  ) {
    throw new Error("Invalid explicit memory retention");
  }
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const [run] = await tx.$queryRaw<RetentionRun[]>`
        SELECT id, "spaceId", "botId", "userId", "threadId", "sourceMessageId", "memorySelection"
        FROM runs
        WHERE id = ${input.runId}
          AND status = 'running'
          AND "leaseOwner" = ${input.leaseOwner}
          AND "leaseFence" = ${input.leaseFence}
        FOR UPDATE`;
      if (!run) return { error: "fence_lost" as const };
      const existing = await tx.memoryRetention.findUnique({
        where: { runId_sourceKey: { runId: input.runId, sourceKey: input.sourceKey } },
        select: { id: true },
      });
      if (existing) return { retentionId: existing.id, created: false };
      const authorized = await authorizeRetention(tx, run, input.bindingId);
      if (authorized !== "ok") return { error: authorized };
      const created = await tx.memoryRetention.create({
        data: {
          runId: input.runId,
          bindingId: input.bindingId,
          sourceKey: input.sourceKey,
          sourceKind: "durable",
          content: input.content,
          occurredAt: input.occurredAt,
          operationId: randomUUID(),
          state: "pending",
          attemptCount: 0,
          nextAttemptAt: input.occurredAt,
          createdAt: input.occurredAt,
        },
        select: { id: true },
      });
      return { retentionId: created.id, created: true };
    }),
  );
}

export interface ClaimedMemoryRetention {
  id: string;
  runId: string;
  bindingId: string;
  sourceKey: string;
  sourceKind: string;
  content: string | null;
  occurredAt: Date;
  operationId: string;
  acceptedAt: Date | null;
  state: string;
  attemptCount: number;
  createdAt: Date;
  claimToken: string;
  leaseUntil: Date;
  run: {
    spaceId: string;
    botId: string;
    userId: string;
    threadId: string;
    memorySelection: unknown;
  };
  binding: { botId: string; bankId: string; configId: string; provider: string; spaceId: string };
}

const ACTIVE_STATES = ["pending", "processing"];

function dueWhere(now: Date) {
  return {
    state: { in: ACTIVE_STATES },
    nextAttemptAt: { lte: now },
    OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
  };
}

export async function claimMemoryRetention(
  prisma: PrismaClient,
  input: { retentionId: string; now: Date; leaseMs: number },
): Promise<ClaimedMemoryRetention | null> {
  const claimToken = randomUUID();
  const leaseUntil = new Date(input.now.getTime() + input.leaseMs);
  const claimed = await prisma.memoryRetention.updateMany({
    where: { id: input.retentionId, ...dueWhere(input.now) },
    data: { claimToken, leaseUntil },
  });
  if (claimed.count !== 1) return null;
  const row = await prisma.memoryRetention.findFirst({
    where: { id: input.retentionId, claimToken },
    include: {
      run: {
        select: {
          spaceId: true,
          botId: true,
          userId: true,
          threadId: true,
          memorySelection: true,
        },
      },
      binding: {
        select: {
          botId: true,
          bankId: true,
          spaceMemoryConfigId: true,
          spaceMemoryConfig: { select: { provider: true, spaceId: true } },
        },
      },
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    runId: row.runId,
    bindingId: row.bindingId,
    sourceKey: row.sourceKey,
    sourceKind: row.sourceKind,
    content: row.content,
    occurredAt: row.occurredAt,
    operationId: row.operationId,
    acceptedAt: row.acceptedAt,
    state: row.state,
    attemptCount: row.attemptCount,
    createdAt: row.createdAt,
    claimToken,
    leaseUntil,
    run: row.run,
    binding: {
      botId: row.binding.botId,
      bankId: row.binding.bankId,
      configId: row.binding.spaceMemoryConfigId,
      provider: row.binding.spaceMemoryConfig.provider,
      spaceId: row.binding.spaceMemoryConfig.spaceId,
    },
  };
}

export async function memoryRetentionClaimCurrent(
  prisma: PrismaClient,
  input: { retentionId: string; claimToken: string; now: Date },
): Promise<boolean> {
  const current = await prisma.memoryRetention.count({
    where: {
      id: input.retentionId,
      claimToken: input.claimToken,
      state: { in: ACTIVE_STATES },
      leaseUntil: { gt: input.now },
    },
  });
  return current === 1;
}

export type MemoryRetentionSettlement =
  | { kind: "reschedule"; nextAttemptAt: Date; attemptCount: number }
  | { kind: "accept"; acceptedAt: Date; nextAttemptAt: Date }
  | { kind: "finish"; state: "completed" | "failed"; failureCode: string | null };

export async function settleMemoryRetention(
  prisma: PrismaClient,
  input: { retentionId: string; claimToken: string; settlement: MemoryRetentionSettlement },
): Promise<boolean> {
  const { settlement } = input;
  const claim = { claimToken: null, leaseUntil: null };
  if (settlement.kind === "accept") {
    const accepted = await prisma.memoryRetention.updateMany({
      where: {
        id: input.retentionId,
        claimToken: input.claimToken,
        state: "pending",
        acceptedAt: null,
      },
      data: {
        ...claim,
        state: "processing",
        acceptedAt: settlement.acceptedAt,
        content: null,
        attemptCount: 0,
        nextAttemptAt: settlement.nextAttemptAt,
      },
    });
    return accepted.count === 1;
  }
  const data =
    settlement.kind === "reschedule"
      ? {
          ...claim,
          attemptCount: settlement.attemptCount,
          nextAttemptAt: settlement.nextAttemptAt,
        }
      : {
          ...claim,
          state: settlement.state,
          failureCode: settlement.failureCode,
          content: null,
          nextAttemptAt: null,
        };
  const settled = await prisma.memoryRetention.updateMany({
    where: {
      id: input.retentionId,
      claimToken: input.claimToken,
      state: { in: ACTIVE_STATES },
    },
    data,
  });
  return settled.count === 1;
}

export async function listDueMemoryRetentions(
  prisma: PrismaClient,
  input: { now: Date; limit: number },
): Promise<string[]> {
  const rows = await prisma.memoryRetention.findMany({
    where: dueWhere(input.now),
    orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
    take: input.limit,
    select: { id: true },
  });
  return rows.map((row) => row.id);
}
