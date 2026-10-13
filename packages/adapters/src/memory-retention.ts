import { createHash } from "node:crypto";
import type {
  AdapterContext,
  JobPublisher,
  SemanticMemoryOperationStatus,
  SemanticMemoryResponse,
} from "@rakazo/adapter-kit";
import { memoryRetainJob } from "@rakazo/adapter-kit";
import { MemorySelectionSchema } from "@rakazo/contracts";
import {
  type ClaimedMemoryRetention,
  claimMemoryRetention,
  listDueMemoryRetentions,
  MEMORY_RETENTION_MAX_CONVERSATION_BYTES,
  MEMORY_RETENTION_MAX_EXPLICIT_BYTES,
  MEMORY_RETENTION_MAX_SOURCES,
  type MemoryRetentionSettlement,
  memoryRetentionClaimCurrent,
  type PrismaClient,
  settleMemoryRetention,
} from "@rakazo/db";
import { getLogger, type Logger } from "@rakazo/logging";
import { HINDSIGHT_MAX_REQUEST_BYTES, type HindsightRetainContext } from "./hindsight-client.js";
import {
  MemoryDispatchDeniedError,
  type MemoryProviderResolver,
} from "./memory-provider-factory.js";

const USER_MAX_BYTES = 4 * 1024;
const ASSISTANT_MAX_BYTES = 16 * 1024;
const MIN_TEXT_BYTES = 64;
const TRUNCATED = "\n[truncated]";
const STEERING_OMITTED = "[earlier steering omitted]";
const DOCUMENT_ID_PLACEHOLDER = `rakazo-${"0".repeat(64)}`;
const OPERATION_ID_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";

const LEASE_MS = 120_000;
const PENDING_TTL_MS = 24 * 60 * 60_000;
const PROCESSING_TTL_MS = 48 * 60 * 60_000;
const TRANSIENT_DELAYS_MS = [5_000, 30_000, 120_000, 300_000, 300_000];
const RECONCILE_LIMIT = 100;
const TRANSIENT_CODES: Record<string, true> = {
  timeout: true,
  unavailable: true,
  rate_limited: true,
};
const OPERATION_FAILURES: Record<
  Exclude<SemanticMemoryOperationStatus, "pending" | "processing" | "completed">,
  string
> = {
  failed: "operation_failed",
  cancelled: "operation_cancelled",
  not_found: "operation_unknown",
};

const encoder = new TextEncoder();

function utf8Length(text: string): number {
  return encoder.encode(text).byteLength;
}

function crop(text: string, maxBytes: number): string {
  if (utf8Length(text) <= maxBytes) return text;
  const budget = Math.max(maxBytes - utf8Length(TRUNCATED), 0);
  const { read } = encoder.encodeInto(text, new Uint8Array(budget));
  const kept = text.slice(0, read).trimEnd() || String.fromCodePoint(text.codePointAt(0) ?? 0x20);
  return `${kept}${TRUNCATED}`;
}

function requestBytes(
  content: string,
  context: HindsightRetainContext,
  timestamp: string,
  metadata: Record<string, string>,
): number {
  return utf8Length(
    JSON.stringify({
      items: [
        {
          content,
          document_id: DOCUMENT_ID_PLACEHOLDER,
          timestamp,
          context,
          metadata,
          update_mode: "replace",
        },
      ],
      async: true,
      operation_id: OPERATION_ID_PLACEHOLDER,
    }),
  );
}

export interface RetentionUserSource {
  id: string;
  createdAt: Date;
  text: string;
}

export function prepareConversationRetention(input: {
  userSources: RetentionUserSource[];
  assistantText: string;
  completedAt: Date;
  metadata: Record<string, string>;
}): { content: string; sourceMessageIds: string[] } | null {
  const seen = new Set<string>();
  const sources: RetentionUserSource[] = [];
  for (const source of input.userSources) {
    const text = source.text.trim();
    if (!text || seen.has(source.id)) continue;
    seen.add(source.id);
    sources.push({ ...source, text });
  }
  const assistant = input.assistantText.trim();
  const [original, ...rest] = sources;
  if (!original || !assistant) return null;
  let steering = rest.slice(-(MEMORY_RETENTION_MAX_SOURCES - 1));
  let omitted = steering.length < rest.length;
  let originalMax = USER_MAX_BYTES;
  let assistantMax = ASSISTANT_MAX_BYTES;
  const completedAt = input.completedAt.toISOString();
  for (;;) {
    const entries = [
      `User ${original.createdAt.toISOString()}:\n${crop(original.text, originalMax)}`,
    ];
    if (omitted) entries.push(STEERING_OMITTED);
    for (const item of steering) {
      entries.push(`User ${item.createdAt.toISOString()}:\n${crop(item.text, USER_MAX_BYTES)}`);
    }
    entries.push(`Assistant ${completedAt}:\n${crop(assistant, assistantMax)}`);
    const content = entries.join("\n\n");
    if (
      utf8Length(content) <= MEMORY_RETENTION_MAX_CONVERSATION_BYTES &&
      requestBytes(content, "Rakazo conversation", completedAt, input.metadata) <=
        HINDSIGHT_MAX_REQUEST_BYTES
    ) {
      return { content, sourceMessageIds: [original.id, ...steering.map((item) => item.id)] };
    }
    if (steering.length > 0) {
      steering = steering.slice(1);
      omitted = true;
    } else if (assistantMax > MIN_TEXT_BYTES) {
      assistantMax = Math.max(MIN_TEXT_BYTES, Math.floor(assistantMax / 2));
    } else if (originalMax > MIN_TEXT_BYTES) {
      originalMax = Math.max(MIN_TEXT_BYTES, Math.floor(originalMax / 2));
    } else {
      return null;
    }
  }
}

export function prepareExplicitRetention(
  content: string,
  metadata: Record<string, string>,
): { ok: true; content: string } | { ok: false; reason: "too_large" | "empty" } {
  if (!content.trim()) return { ok: false, reason: "empty" };
  if (
    utf8Length(content) > MEMORY_RETENTION_MAX_EXPLICIT_BYTES ||
    requestBytes(content, "Rakazo saved memory", new Date().toISOString(), metadata) >
      HINDSIGHT_MAX_REQUEST_BYTES
  ) {
    return { ok: false, reason: "too_large" };
  }
  return { ok: true, content };
}

export function retentionDocumentId(
  configId: string,
  botId: string,
  runId: string,
  sourceKey: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([configId, botId, runId, sourceKey]))
    .digest("hex");
  return `rakazo-${digest}`;
}

function pollDelayMs(acceptedAgeMs: number): number {
  if (acceptedAgeMs < 2 * 60_000) return 30_000;
  if (acceptedAgeMs < 10 * 60_000) return 60_000;
  if (acceptedAgeMs < 60 * 60_000) return 300_000;
  return 600_000;
}

export interface MemoryRetainHandlerDeps {
  prisma: PrismaClient;
  resolver: MemoryProviderResolver;
  jobs: JobPublisher;
  now?: () => Date;
  logger?: Logger;
}

export function createMemoryRetainHandler(
  deps: MemoryRetainHandlerDeps,
): (payload: { retentionId: string }) => Promise<void> {
  const clock = deps.now ?? (() => new Date());

  const finish = (
    state: "completed" | "failed",
    failureCode: string | null = null,
  ): MemoryRetentionSettlement => ({ kind: "finish", state, failureCode });

  const failure = (
    row: ClaimedMemoryRetention,
    code: string | undefined,
    retryAfterMs: number | undefined,
    floorMs = 0,
  ): MemoryRetentionSettlement => {
    if (code !== undefined && !TRANSIENT_CODES[code]) return finish("failed", code);
    const attemptCount = Math.min(row.attemptCount + 1, TRANSIENT_DELAYS_MS.length);
    const delay = Math.max(
      TRANSIENT_DELAYS_MS[attemptCount - 1] ?? 0,
      floorMs,
      retryAfterMs ?? 0,
    );
    return {
      kind: "reschedule",
      attemptCount,
      nextAttemptAt: new Date(clock().getTime() + delay),
    };
  };

  const advance = async (
    row: ClaimedMemoryRetention,
  ): Promise<MemoryRetentionSettlement | null> => {
    const parsed = MemorySelectionSchema.safeParse(row.run.memorySelection);
    if (!parsed.success) return finish("failed", "invalid_request");
    const selection = parsed.data;
    if (
      selection.kind !== "bank" ||
      selection.bindingId !== row.bindingId ||
      selection.configId !== row.binding.configId ||
      selection.bankId !== row.binding.bankId ||
      selection.provider !== row.binding.provider ||
      row.binding.botId !== row.run.botId
    ) {
      return finish("failed", "binding_retired");
    }
    const pending = row.state === "pending";
    if (pending ? row.content === null : row.acceptedAt === null) {
      return finish("failed", "invalid_request");
    }
    const startedAt = clock().getTime();
    const deadline = pending
      ? row.createdAt.getTime() + PENDING_TTL_MS
      : (row.acceptedAt?.getTime() ?? 0) + PROCESSING_TTL_MS;
    if (startedAt >= deadline) return finish("failed", "operation_timeout");

    let claimLost = false;
    const resolution = await deps.resolver.resolve(
      {
        spaceId: row.run.spaceId,
        userId: row.run.userId,
        botId: row.run.botId,
        selection,
      },
      {
        beforeRequest: async () => {
          if (
            await memoryRetentionClaimCurrent(deps.prisma, {
              retentionId: row.id,
              claimToken: row.claimToken,
              now: clock(),
            })
          ) {
            return;
          }
          claimLost = true;
          throw new MemoryDispatchDeniedError("binding_retired");
        },
      },
    );
    if (resolution.kind === "native") return finish("failed", "binding_retired");
    if (resolution.kind === "unavailable") {
      return failure(
        row,
        resolution.code,
        undefined,
        pending ? 0 : pollDelayMs(clock().getTime() - (row.acceptedAt?.getTime() ?? 0)),
      );
    }
    const { provider } = resolution;
    const context: AdapterContext = {
      operationId: `memory.retain:${row.id}`,
      traceId: `memory.retain:${row.id}`,
      spaceId: row.run.spaceId,
      userId: row.run.userId,
      botId: row.run.botId,
      runId: row.runId,
      signal: new AbortController().signal,
    };

    if (pending) {
      const response = await provider
        .save(
          {
            content: row.content ?? "",
            scope: resolution.defaultScope,
            botId: row.run.botId,
            source:
              row.sourceKind === "conversation" ? { kind: "conversation" } : { kind: "durable" },
            delivery: {
              documentId: retentionDocumentId(
                row.binding.configId,
                row.run.botId,
                row.runId,
                row.sourceKey,
              ),
              operationId: row.operationId,
              timestamp: row.occurredAt.toISOString(),
              threadId: row.run.threadId,
              sourceKey: row.sourceKey,
            },
          },
          context,
        )
        .catch(
          (): SemanticMemoryResponse<never> => ({ ok: false, error: "", code: "unavailable" }),
        );
      if (claimLost) return null;
      if (!response.ok) return failure(row, response.code, response.retryAfterMs);
      const receipt = response.value;
      if (!receipt || receipt.operationId !== row.operationId) {
        return finish("failed", "invalid_response");
      }
      if (receipt.status === "completed") return finish("completed");
      const acceptedAt = clock();
      return {
        kind: "accept",
        acceptedAt,
        nextAttemptAt: new Date(acceptedAt.getTime() + pollDelayMs(0)),
      };
    }

    if (!provider.operationStatus) return finish("failed", "invalid_response");
    const response = await provider
      .operationStatus(row.operationId, context)
      .catch((): SemanticMemoryResponse<never> => ({ ok: false, error: "", code: "unavailable" }));
    if (claimLost) return null;
    const now = clock().getTime();
    const interval = pollDelayMs(now - (row.acceptedAt?.getTime() ?? now));
    if (!response.ok) return failure(row, response.code, response.retryAfterMs, interval);
    const status = response.value;
    if (status === "completed") return finish("completed");
    if (status === "pending" || status === "processing") {
      return { kind: "reschedule", attemptCount: 0, nextAttemptAt: new Date(now + interval) };
    }
    return finish("failed", OPERATION_FAILURES[status]);
  };

  return async ({ retentionId }) => {
    const row = await claimMemoryRetention(deps.prisma, {
      retentionId,
      now: clock(),
      leaseMs: LEASE_MS,
    });
    if (!row) return;
    const settlement = await advance(row);
    if (!settlement) return;
    const settled = await settleMemoryRetention(deps.prisma, {
      retentionId,
      claimToken: row.claimToken,
      settlement,
    });
    if (!settled) return;
    if (settlement.kind === "finish") {
      if (settlement.state === "failed") {
        (deps.logger ?? getLogger()).warn("memory retention failed", {
          retentionId,
          failureCode: settlement.failureCode,
        });
      }
      return;
    }
    await deps.jobs
      .enqueue(memoryRetainJob(retentionId, settlement.nextAttemptAt))
      .catch(() =>
        (deps.logger ?? getLogger()).error("memory.retain enqueue error", { retentionId }),
      );
  };
}

export function createMemoryRetentionReconciler(deps: {
  prisma: PrismaClient;
  jobs: JobPublisher;
  now?: () => Date;
}): () => Promise<void> {
  return async () => {
    const ids = await listDueMemoryRetentions(deps.prisma, {
      now: deps.now?.() ?? new Date(),
      limit: RECONCILE_LIMIT,
    });
    await Promise.all(ids.map((id) => deps.jobs.enqueue(memoryRetainJob(id))));
  };
}
