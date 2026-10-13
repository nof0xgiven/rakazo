import type {
  AdapterContext,
  BackgroundJob,
  JobPublisher,
  SemanticMemoryOperationStatus,
  SemanticMemoryProvider,
  SemanticMemoryResponse,
  SemanticMemorySaveRequest,
} from "@rakazo/adapter-kit";
import type { ClaimedMemoryRetention, MemoryRetentionSettlement, PrismaClient } from "@rakazo/db";
import {
  claimMemoryRetention,
  memoryRetentionClaimCurrent,
  settleMemoryRetention,
} from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryDispatchDeniedError,
  type MemoryProviderResolver,
  type MemoryResolveOptions,
} from "./memory-provider-factory.js";
import {
  createMemoryRetainHandler,
  prepareConversationRetention,
  prepareExplicitRetention,
  retentionDocumentId,
} from "./memory-retention.js";

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  claimMemoryRetention: vi.fn(),
  memoryRetentionClaimCurrent: vi.fn(),
  settleMemoryRetention: vi.fn(),
}));

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).byteLength;
const metadata = {
  space_id: "space-1",
  bot_id: "bot-1",
  thread_id: "thread-1",
  run_id: "run-1",
  source_kind: "conversation",
  source_key: "conversation",
};
const at = (minute: number) => new Date(Date.UTC(2026, 9, 13, 12, minute));

describe("prepareConversationRetention", () => {
  it("labels the original turn and reply in order", () => {
    expect(
      prepareConversationRetention({
        userSources: [
          { id: "m1", createdAt: at(0), text: "  I prefer tea.  " },
          { id: "m1", createdAt: at(0), text: "I prefer tea." },
          { id: "m2", createdAt: at(1), text: "Green, please." },
          { id: "m3", createdAt: at(2), text: "   " },
        ],
        assistantText: "Noted.",
        completedAt: at(3),
        metadata,
      }),
    ).toEqual({
      content:
        "User 2026-10-13T12:00:00.000Z:\nI prefer tea.\n\nUser 2026-10-13T12:01:00.000Z:\nGreen, please.\n\nAssistant 2026-10-13T12:03:00.000Z:\nNoted.",
      sourceMessageIds: ["m1", "m2"],
    });
  });

  it("learns nothing without both a human turn and a reply", () => {
    const user = [{ id: "m1", createdAt: at(0), text: "Hi" }];
    expect(
      prepareConversationRetention({
        userSources: user,
        assistantText: " ",
        completedAt: at(1),
        metadata,
      }),
    ).toBeNull();
    expect(
      prepareConversationRetention({
        userSources: [],
        assistantText: "Hi",
        completedAt: at(1),
        metadata,
      }),
    ).toBeNull();
  });

  it("keeps the original plus the latest fifteen steering messages", () => {
    const sources = Array.from({ length: 20 }, (_, index) => ({
      id: `m${index}`,
      createdAt: at(index),
      text: `turn ${index}`,
    }));
    const prepared = prepareConversationRetention({
      userSources: sources,
      assistantText: "Done.",
      completedAt: at(30),
      metadata,
    });
    expect(prepared?.sourceMessageIds).toEqual([
      "m0",
      ...sources.slice(5).map((source) => source.id),
    ]);
    expect(prepared?.content).toContain("turn 0\n\n[earlier steering omitted]\n\nUser");
    expect(prepared?.content).not.toContain("turn 4\n");
  });

  it("crops each turn on a code point boundary within its byte budget", () => {
    const prepared = prepareConversationRetention({
      userSources: [{ id: "m1", createdAt: at(0), text: "🙂".repeat(3000) }],
      assistantText: "é".repeat(20_000),
      completedAt: at(1),
      metadata,
    });
    const [user, assistant] = (prepared?.content ?? "").split("\n\nAssistant ");
    const userText = user!.slice(user!.indexOf("\n") + 1);
    const assistantText = assistant!.slice(assistant!.indexOf("\n") + 1);
    expect(bytes(userText)).toBeLessThanOrEqual(4 * 1024);
    expect(bytes(assistantText)).toBeLessThanOrEqual(16 * 1024);
    expect(userText.endsWith("\n[truncated]")).toBe(true);
    expect(assistantText.endsWith("\n[truncated]")).toBe(true);
    expect(userText).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });

  it("drops steering, then shortens the reply, to fit the escaped request bound", () => {
    const escaped = "\u0001".repeat(5000);
    const heavyMetadata = Object.fromEntries(
      Object.keys(metadata).map((key) => [key, "\u0001".repeat(256)]),
    );
    const prepared = prepareConversationRetention({
      userSources: Array.from({ length: 16 }, (_, index) => ({
        id: `m${index}`,
        createdAt: at(index),
        text: escaped,
      })),
      assistantText: "\u0001".repeat(20_000),
      completedAt: at(20),
      metadata: heavyMetadata,
    });
    expect(prepared).not.toBeNull();
    const body = JSON.stringify({
      items: [
        {
          content: prepared!.content,
          document_id: retentionDocumentId("c", "b", "r", "conversation"),
          timestamp: at(20).toISOString(),
          context: "Rakazo conversation",
          metadata: heavyMetadata,
          update_mode: "replace",
        },
      ],
      async: true,
      operation_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(bytes(body)).toBeLessThanOrEqual(128 * 1024);
    expect(prepared!.sourceMessageIds).toEqual(["m0"]);
    expect(prepared!.content).toContain("[earlier steering omitted]");
    expect(prepared!.content.endsWith("\u0001\n[truncated]")).toBe(true);
  });
});

describe("prepareExplicitRetention", () => {
  it("never crops an explicit save", () => {
    const content = "  keep me exactly  ";
    expect(prepareExplicitRetention(content, metadata)).toEqual({ ok: true, content });
    expect(prepareExplicitRetention(" \n", metadata)).toEqual({ ok: false, reason: "empty" });
    expect(prepareExplicitRetention("a".repeat(16 * 1024 + 1), metadata)).toEqual({
      ok: false,
      reason: "too_large",
    });
  });
});

describe("retentionDocumentId", () => {
  it("is stable per configuration, bot, run and source", () => {
    const id = retentionDocumentId("config-1", "bot-1", "run-1", "conversation");
    expect(id).toMatch(/^rakazo-[0-9a-f]{64}$/);
    expect(retentionDocumentId("config-1", "bot-1", "run-1", "conversation")).toBe(id);
    expect(retentionDocumentId("config-2", "bot-1", "run-1", "conversation")).not.toBe(id);
  });
});

describe("createMemoryRetainHandler", () => {
  const createdAt = new Date("2026-10-13T12:00:00.000Z");
  let now = createdAt;
  let settlements: MemoryRetentionSettlement[];
  let enqueued: BackgroundJob[];
  let claimCurrent: boolean;
  const save = vi.fn<SemanticMemoryProvider["save"]>();
  const operationStatus =
    vi.fn<(id: string) => Promise<SemanticMemoryResponse<SemanticMemoryOperationStatus>>>();
  const resolve = vi.fn<MemoryProviderResolver["resolve"]>();

  const row = (overrides: Partial<ClaimedMemoryRetention> = {}): ClaimedMemoryRetention => ({
    id: "retention-1",
    runId: "run-1",
    bindingId: "binding-1",
    sourceKey: "conversation",
    sourceKind: "conversation",
    content: "User …",
    occurredAt: createdAt,
    operationId: "11111111-1111-4111-8111-111111111111",
    acceptedAt: null,
    state: "pending",
    attemptCount: 0,
    createdAt,
    claimToken: "claim-1",
    leaseUntil: new Date(createdAt.getTime() + 120_000),
    run: {
      spaceId: "space-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: "thread-1",
      memorySelection: {
        kind: "bank",
        configId: "config-1",
        provider: "hindsight",
        bindingId: "binding-1",
        bankId: "bank-a",
      },
    },
    binding: {
      botId: "bot-1",
      bankId: "bank-a",
      configId: "config-1",
      provider: "hindsight",
      spaceId: "space-1",
    },
    ...overrides,
  });

  const processing = (acceptedMinutesAgo: number, attemptCount = 0) =>
    row({
      state: "processing",
      content: null,
      acceptedAt: new Date(now.getTime() - acceptedMinutesAgo * 60_000),
      attemptCount,
    });

  const jobs: JobPublisher = {
    enqueue: async (job) => {
      enqueued.push(job);
    },
    cancel: async () => undefined,
    close: async () => undefined,
  };
  const handler = createMemoryRetainHandler({
    prisma: {} as PrismaClient,
    resolver: { select: vi.fn(), resolve },
    jobs,
    now: () => now,
  });
  const run = async (claimed: ClaimedMemoryRetention) => {
    vi.mocked(claimMemoryRetention).mockResolvedValueOnce(claimed);
    await handler({ retentionId: claimed.id });
    return settlements.at(-1);
  };
  const later = (ms: number) => new Date(now.getTime() + ms);

  beforeEach(() => {
    now = createdAt;
    settlements = [];
    enqueued = [];
    claimCurrent = true;
    save.mockReset();
    operationStatus.mockReset();
    resolve.mockReset();
    vi.mocked(claimMemoryRetention).mockReset();
    vi.mocked(memoryRetentionClaimCurrent).mockImplementation(async () => claimCurrent);
    vi.mocked(settleMemoryRetention).mockImplementation(async (_prisma, input) => {
      settlements.push(input.settlement);
      return true;
    });
    resolve.mockImplementation(async (input, options?: MemoryResolveOptions) => {
      if (input.selection.kind === "native") return { kind: "native" };
      const guard = async (context: AdapterContext) => {
        try {
          await options?.beforeRequest?.(context);
          return null;
        } catch (error) {
          const code = error instanceof MemoryDispatchDeniedError ? error.code : "unavailable";
          return { ok: false as const, error: "denied", code };
        }
      };
      const provider = {
        describe: vi.fn(),
        recall: vi.fn(),
        save: async (request: SemanticMemorySaveRequest, context: AdapterContext) =>
          (await guard(context)) ?? save(request, context),
        operationStatus: async (id: string, context: AdapterContext) =>
          (await guard(context)) ?? operationStatus(id),
      } as unknown as SemanticMemoryProvider;
      return {
        kind: "configured",
        provider,
        capabilities: { recall: true, save: true, purgeHistory: false, sharedScope: false },
        defaultScope: "isolated",
        selection: input.selection,
      };
    });
  });

  it("submits pending content with stable identifiers and schedules the first status poll", async () => {
    save.mockResolvedValue({
      ok: true,
      value: { status: "pending", operationId: "11111111-1111-4111-8111-111111111111" },
    });

    expect(await run(row())).toEqual({
      kind: "accept",
      acceptedAt: now,
      nextAttemptAt: later(30_000),
    });
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ spaceId: "space-1", userId: "user-1", botId: "bot-1" }),
      expect.anything(),
    );
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      content: "User …",
      source: { kind: "conversation" },
      delivery: {
        documentId: retentionDocumentId("config-1", "bot-1", "run-1", "conversation"),
        operationId: "11111111-1111-4111-8111-111111111111",
        timestamp: createdAt.toISOString(),
        threadId: "thread-1",
        sourceKey: "conversation",
      },
    });
    expect(enqueued).toEqual([
      expect.objectContaining({
        name: "memory.retain",
        payload: { retentionId: "retention-1" },
        availableAt: later(30_000),
      }),
    ]);
  });

  it("backs off transient failures and saturates the attempt count", async () => {
    const delays: number[] = [];
    let attemptCount = 0;
    save.mockResolvedValue({ ok: false, error: "", code: "unavailable" });
    for (let index = 0; index < 7; index++) {
      const settlement = await run(row({ attemptCount }));
      if (settlement?.kind !== "reschedule") throw new Error("expected reschedule");
      delays.push((settlement.nextAttemptAt.getTime() - now.getTime()) / 1000);
      attemptCount = settlement.attemptCount;
    }
    expect(delays).toEqual([5, 30, 120, 300, 300, 300, 300]);
    expect(attemptCount).toBe(5);
  });

  it("lets Retry-After raise but never shorten the delay", async () => {
    save.mockResolvedValueOnce({
      ok: false,
      error: "",
      code: "rate_limited",
      retryAfterMs: 90_000,
    });
    expect(await run(row())).toMatchObject({ nextAttemptAt: later(90_000) });
    save.mockResolvedValueOnce({ ok: false, error: "", code: "rate_limited", retryAfterMs: 1_000 });
    expect(await run(row({ attemptCount: 2 }))).toMatchObject({ nextAttemptAt: later(120_000) });
  });

  it("terminates on authorization, quota, input and protocol failures", async () => {
    for (const code of ["unauthorized", "quota", "invalid_request", "forbidden"] as const) {
      save.mockResolvedValueOnce({ ok: false, error: "", code });
      expect(await run(row())).toEqual({ kind: "finish", state: "failed", failureCode: code });
    }
    save.mockResolvedValueOnce({ ok: true, value: undefined });
    expect(await run(row())).toEqual({
      kind: "finish",
      state: "failed",
      failureCode: "invalid_response",
    });
    save.mockResolvedValueOnce({
      ok: true,
      value: { status: "pending", operationId: "22222222-2222-4222-8222-222222222222" },
    });
    expect(await run(row())).toMatchObject({ state: "failed", failureCode: "invalid_response" });
    expect(enqueued).toEqual([]);
  });

  it("polls accepted work on the age schedule and never resubmits", async () => {
    operationStatus.mockResolvedValue({ ok: true, value: "processing" });
    const intervals: number[] = [];
    for (const minutes of [1, 5, 30, 120, 30 * 60]) {
      const settlement = await run(processing(minutes, 3));
      if (settlement?.kind !== "reschedule") throw new Error("expected reschedule");
      expect(settlement.attemptCount).toBe(0);
      intervals.push((settlement.nextAttemptAt.getTime() - now.getTime()) / 1000);
    }
    expect(intervals).toEqual([30, 60, 300, 600, 600]);
    expect(save).not.toHaveBeenCalled();
  });

  it("uses the longer of backoff and polling interval while processing", async () => {
    operationStatus.mockResolvedValueOnce({ ok: false, error: "", code: "timeout" });
    expect(await run(processing(120))).toMatchObject({
      attemptCount: 1,
      nextAttemptAt: later(600_000),
    });
    operationStatus.mockResolvedValueOnce({ ok: false, error: "", code: "timeout" });
    expect(await run(processing(1, 2))).toMatchObject({
      attemptCount: 3,
      nextAttemptAt: later(120_000),
    });
  });

  it("keeps the polling floor when resolution is unavailable for accepted work", async () => {
    resolve.mockResolvedValue({
      kind: "unavailable",
      capabilities: { recall: true, save: true, purgeHistory: false, sharedScope: false },
      code: "unavailable",
      error: "",
    });
    expect(await run(processing(120))).toMatchObject({
      kind: "reschedule",
      attemptCount: 1,
      nextAttemptAt: later(600_000),
    });
    expect(await run(row())).toMatchObject({ attemptCount: 1, nextAttemptAt: later(5_000) });
    expect(operationStatus).not.toHaveBeenCalled();
  });

  it("maps terminal receipts and treats an unknown receipt as failure", async () => {
    const cases: Array<[SemanticMemoryOperationStatus, string, string | null]> = [
      ["completed", "completed", null],
      ["failed", "failed", "operation_failed"],
      ["cancelled", "failed", "operation_cancelled"],
      ["not_found", "failed", "operation_unknown"],
    ];
    for (const [status, state, failureCode] of cases) {
      operationStatus.mockResolvedValueOnce({ ok: true, value: status });
      expect(await run(processing(3))).toEqual({ kind: "finish", state, failureCode });
    }
    expect(enqueued).toEqual([]);
  });

  it("expires pending work after a day and accepted work after two days without HTTP", async () => {
    now = new Date(createdAt.getTime() + 24 * 60 * 60_000);
    expect(await run(row())).toEqual({
      kind: "finish",
      state: "failed",
      failureCode: "operation_timeout",
    });
    operationStatus.mockResolvedValueOnce({ ok: true, value: "processing" });
    expect(await run(processing(30 * 60))).toMatchObject({ kind: "reschedule" });
    expect(await run(processing(48 * 60))).toEqual({
      kind: "finish",
      state: "failed",
      failureCode: "operation_timeout",
    });
    expect(save).not.toHaveBeenCalled();
    expect(operationStatus).toHaveBeenCalledOnce();
  });

  it("fails retired pins locally and writes nothing after losing its claim", async () => {
    expect(await run(row({ binding: { ...row().binding, bankId: "bank-b" } }))).toEqual({
      kind: "finish",
      state: "failed",
      failureCode: "binding_retired",
    });
    expect(await run(row({ run: { ...row().run, memorySelection: { kind: "bank" } } }))).toEqual({
      kind: "finish",
      state: "failed",
      failureCode: "invalid_request",
    });
    expect(resolve).not.toHaveBeenCalled();

    claimCurrent = false;
    settlements = [];
    await run(row());
    expect(save).not.toHaveBeenCalled();
    expect(settlements).toEqual([]);
    expect(enqueued).toEqual([]);
  });
});
