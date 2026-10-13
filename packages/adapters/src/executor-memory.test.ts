import type {
  AgentRunRequest,
  SemanticMemoryCapabilities,
  SemanticMemoryProvider,
  SemanticMemoryRecallRequest,
  SemanticMemoryResponse,
  SemanticMemoryResult,
} from "@rakazo/adapter-kit";
import { memoryRetainJob } from "@rakazo/adapter-kit";
import type { MemorySelection } from "@rakazo/contracts";
import { RECALLED_MEMORY_PREFIX } from "@rakazo/core";
import type * as DbModule from "@rakazo/db";
import { insertExplicitMemoryRetention, loadRetentionSourceMessages } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import type { MemoryResolution } from "./memory-provider-factory.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  insertExplicitMemoryRetention: vi.fn(),
  loadRetentionSourceMessages: vi.fn(),
}));

const BANK_CAPABILITIES: SemanticMemoryCapabilities = {
  recall: true,
  save: true,
  purgeHistory: false,
  sharedScope: false,
  banks: true,
  automaticRecall: true,
  conversationRetention: true,
  forget: false,
};

const LEGACY_CAPABILITIES: SemanticMemoryCapabilities = {
  recall: true,
  save: true,
  purgeHistory: true,
  sharedScope: true,
};

const BANK_SELECTION: MemorySelection = {
  kind: "bank",
  configId: "config-1",
  provider: "hindsight",
  bindingId: "binding-1",
  bankId: "bank-1",
};

const LEGACY_SELECTION: MemorySelection = {
  kind: "legacy",
  configId: "config-1",
  provider: "supermemory",
  scope: "isolated",
};

type ToolCall = { name: string; args: Record<string, unknown>; executionId: string };

function fixture(
  options: {
    memory?: "bank" | "legacy" | "native" | "unavailable";
    recall?: SemanticMemoryResponse<SemanticMemoryResult[]>;
    sourceText?: string;
    messageCount?: number;
    historyCompactedUpToSeq?: number | null;
    resolvedSecrets?: string[];
    calls?: ToolCall[];
  } = {},
) {
  const runId = "run-1";
  const memoryKind = options.memory ?? "bank";
  const messageCount = options.messageCount ?? 1;
  const sourceSeq = messageCount - 1;
  const sourceText = options.sourceText ?? "Which code name did we pick?";
  const createdAt = new Date("2026-10-13T09:00:00.000Z");
  const messages = Array.from({ length: messageCount }, (_, index) => ({
    id: `message-${index}`,
    threadId: "thread-1",
    seq: index,
    role: index % 2 === 0 || index === sourceSeq ? "user" : "bot",
    botId: null,
    runId: null,
    blocks: [{ kind: "text", text: index === sourceSeq ? sourceText : `earlier ${index}` }],
    createdAt,
    replyToMessageId: null,
    replyQuote: null,
    replyTo: null,
  }));
  const run: Record<string, unknown> = {
    id: runId,
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: "user",
    leaseFence: 0,
    sourceMessageId: `message-${sourceSeq}`,
  };
  const prisma = {
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      findFirst: vi.fn(async () => run),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: "bot-1",
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: "thread-1",
        groupId: null,
        nextMessageSeq: messageCount,
        historyCompactedUpToSeq: options.historyCompactedUpToSeq ?? null,
        historyCompactionSummary: null,
        historyCompactionGeneration: 0,
      })),
    },
    message: {
      findMany: vi.fn(async () => [...messages].reverse()),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          messages.find((message) => message.id === where.id) ?? null,
      ),
    },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({ id: "task-1", prompt: "Synthetic task prompt" })),
    },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "scripted",
        defaultModelId: "scripted",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSecret: { findMany: vi.fn(async () => []) },
    botSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    actionApprovalRule: { findMany: vi.fn(async () => []) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => ({ enabled: false })) },
    externalEffect: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        id: "effect-1",
      })),
      update: vi.fn(async () => undefined),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  const recall = vi.fn(
    async (_request: SemanticMemoryRecallRequest): Promise<SemanticMemoryResponse<SemanticMemoryResult[]>> =>
      options.recall ?? { ok: true, value: [] },
  );
  const save = vi.fn(async (): Promise<SemanticMemoryResponse> => ({ ok: true, value: undefined }));
  const capabilities = memoryKind === "legacy" ? LEGACY_CAPABILITIES : BANK_CAPABILITIES;
  const provider: SemanticMemoryProvider = {
    describe: () => ({
      id: "test-memory",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities,
    }),
    recall,
    save,
  };
  const selection: MemorySelection =
    memoryKind === "native"
      ? { kind: "native" }
      : memoryKind === "legacy"
        ? LEGACY_SELECTION
        : BANK_SELECTION;
  const memoryProviders = {
    select: vi.fn(async () => selection),
    resolve: vi.fn(
      async (
        input: { selection: MemorySelection },
        resolveOptions?: { registerSecrets?: (values: string[]) => void },
      ): Promise<MemoryResolution> => {
        resolveOptions?.registerSecrets?.(options.resolvedSecrets ?? []);
        if (input.selection.kind === "native") return { kind: "native" };
        if (memoryKind === "unavailable") {
          return {
            kind: "unavailable",
            capabilities,
            code: "binding_retired",
            error: "The memory connection changed. Choose a bank again.",
          };
        }
        return {
          kind: "configured",
          provider,
          capabilities,
          defaultScope: "isolated",
          selection: input.selection,
        };
      },
    ),
  };
  const finalizeRun = vi.fn(async (_input: Record<string, unknown>) => ({
    continuationRunId: null,
    memoryRetentionId: _input.memoryRetention ? "retention-auto" : null,
  }));
  const enqueue = vi.fn(async () => undefined);
  const requests: AgentRunRequest[] = [];
  const results: unknown[] = [];
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    requests.push(request);
    for (const call of options.calls ?? []) {
      results.push(await request.executeTool!(call.name, call.args, call.executionId));
    }
    yield { type: "done" as const, text: "MARIGOLD-773 it is." };
  });
  const executor = createRunExecutor({
    prisma,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector: {
      discoverTools: async () => [],
      resolveCall: async () => undefined,
      execute: async function* () {},
    },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: {
      describe: () => ({ capabilities: {} }),
      read: async () => ({ documents: [] }),
      search: async () => [],
      commit: vi.fn(async () => ({ revision: "rev-1" })),
      exportMarkdown: async function* () {},
    },
    memoryProviders,
    events: { append: vi.fn(async () => undefined), finalizeRun },
    jobs: { enqueue },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  return {
    prisma,
    recall,
    save,
    memoryProviders,
    finalizeRun,
    enqueue,
    requests,
    results,
    async run() {
      await executor.continueRun(runId, "worker-1");
      expect(runtimeRun).toHaveBeenCalledOnce();
    },
  };
}

function isRecalledBlock(message: AgentRunRequest["history"][number]) {
  return typeof message.content === "string" && message.content.startsWith(RECALLED_MEMORY_PREFIX);
}

function recalledBlocks(request: AgentRunRequest | undefined) {
  return (request?.history ?? []).filter(isRecalledBlock);
}

function conversationHistory(request: AgentRunRequest | undefined) {
  return (request?.history ?? []).filter((message) => !isRecalledBlock(message));
}

beforeEach(() => {
  vi.mocked(insertExplicitMemoryRetention).mockReset();
  vi.mocked(loadRetentionSourceMessages).mockReset();
  vi.mocked(loadRetentionSourceMessages).mockResolvedValue([]);
});

describe("executor bank memory", () => {
  it("recalls the source message before the first reply without compaction", async () => {
    const f = fixture({
      recall: { ok: true, value: [{ memory: "The project code name is MARIGOLD-773." }] },
    });

    await f.run();

    expect(f.recall).toHaveBeenCalledWith(
      expect.objectContaining({ query: "Which code name did we pick?" }),
      expect.any(Object),
    );
    const [recalled] = recalledBlocks(f.requests[0]);
    expect(recalled?.content).toContain("The project code name is MARIGOLD-773.");
  });

  it("redacts the resolved memory credential from the outgoing recall query", async () => {
    const f = fixture({
      sourceText: "Is hsk_test_fixture still valid?",
      resolvedSecrets: ["hsk_test_fixture"],
    });

    await f.run();

    expect(f.recall).toHaveBeenCalledOnce();
    expect(f.recall.mock.calls[0]?.[0].query).not.toContain("hsk_test_fixture");
  });

  const failedOrEmpty: Array<[string, SemanticMemoryResponse<SemanticMemoryResult[]>]> = [
    [
      "fails",
      { ok: false, error: "Hindsight Cloud is temporarily unavailable.", code: "unavailable" },
    ],
    ["returns no facts", { ok: true, value: [] }],
  ];
  it.each(failedOrEmpty)("keeps the full history when recall %s", async (_label, recall) => {
    const f = fixture({ recall, messageCount: 60, historyCompactedUpToSeq: 5 });

    await f.run();

    expect(f.recall).toHaveBeenCalledOnce();
    expect(recalledBlocks(f.requests[0])).toHaveLength(0);
    expect(conversationHistory(f.requests[0]).length).toBeGreaterThan(50);
    expect(f.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
  });

  it("narrows the compacted history only after a recalled fact is injected", async () => {
    const f = fixture({
      recall: { ok: true, value: [{ memory: "Prefers short answers." }] },
      messageCount: 60,
      historyCompactedUpToSeq: 5,
    });

    await f.run();

    expect(recalledBlocks(f.requests[0])).toHaveLength(1);
    expect(conversationHistory(f.requests[0]).length).toBeLessThanOrEqual(50);
  });

  it("offers recall and queued save, never forget or native remember", async () => {
    const f = fixture();

    await f.run();

    const names = f.requests[0]?.tools.map((tool) => tool.name) ?? [];
    expect(names).toEqual(expect.arrayContaining(["recall_memory", "save_memory"]));
    expect(names).not.toContain("forget_memory");
    expect(names).not.toContain("remember");
  });

  it("queues an explicit save under the canonical effect key", async () => {
    vi.mocked(insertExplicitMemoryRetention).mockResolvedValue({
      retentionId: "retention-explicit",
      created: true,
    });
    const args = { content: "Prefers tea over coffee." };
    const f = fixture({ calls: [{ name: "save_memory", args, executionId: "call_0" }] });

    await f.run();

    const effectKey = f.prisma.externalEffect.create.mock.calls[0]?.[0]?.data.idempotencyKey;
    expect(typeof effectKey).toBe("string");
    expect(insertExplicitMemoryRetention).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: "run-1",
        bindingId: "binding-1",
        sourceKey: effectKey,
        content: expect.stringContaining("Prefers tea over coffee."),
      }),
    );
    expect(f.enqueue).toHaveBeenCalledWith(memoryRetainJob("retention-explicit"));
    expect(f.save).not.toHaveBeenCalled();
  });

  it("redacts known secrets from a save before recording its effect or intent", async () => {
    vi.mocked(insertExplicitMemoryRetention).mockResolvedValue({
      retentionId: "retention-secret",
      created: true,
    });
    const f = fixture({
      resolvedSecrets: ["hsk_test_fixture"],
      calls: [
        {
          name: "save_memory",
          args: { content: "Deploy key is hsk_test_fixture." },
          executionId: "call_0",
        },
      ],
    });

    await f.run();

    expect(f.results[0]).toEqual({ ok: true, value: { status: "queued" } });
    const effect = f.prisma.externalEffect.create.mock.calls[0]?.[0]?.data;
    expect(JSON.stringify(effect?.request)).not.toContain("hsk_test_fixture");
    expect(insertExplicitMemoryRetention).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceKey: effect?.idempotencyKey,
        content: expect.not.stringContaining("hsk_test_fixture"),
      }),
    );
  });

  it("records a successful exchange with its reply and enqueues it after commit", async () => {
    vi.mocked(loadRetentionSourceMessages).mockResolvedValue([
      {
        id: "message-0",
        seq: 0,
        createdAt: new Date("2026-10-13T09:00:00.000Z"),
        text: "Which code name did we pick?",
      },
    ]);
    const f = fixture();

    await f.run();

    expect(loadRetentionSourceMessages).toHaveBeenCalledWith(expect.anything(), {
      runId: "run-1",
      threadId: "thread-1",
      messageIds: ["message-0"],
    });
    expect(f.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "completed",
        memoryRetention: expect.objectContaining({
          bindingId: "binding-1",
          sourceMessageIds: ["message-0"],
          content: expect.stringMatching(/Which code name did we pick\?[\s\S]*MARIGOLD-773 it is\./),
        }),
      }),
    );
    expect(f.enqueue).toHaveBeenCalledWith(memoryRetainJob("retention-auto"));
  });

  it("fails memory tools safely without contacting the provider when the pin is unavailable", async () => {
    const f = fixture({
      memory: "unavailable",
      calls: [{ name: "recall_memory", args: { query: "anything" }, executionId: "call_0" }],
    });

    await f.run();

    expect(f.results[0]).toMatchObject({ ok: false, code: "binding_retired" });
    expect(f.recall).not.toHaveBeenCalled();
    expect(f.finalizeRun.mock.calls[0]?.[0]).not.toHaveProperty("memoryRetention");
  });
});

describe("executor legacy and native memory", () => {
  it("keeps legacy recall gated on compaction", async () => {
    const f = fixture({ memory: "legacy" });

    await f.run();

    expect(f.recall).not.toHaveBeenCalled();
    expect(f.requests[0]?.tools.map((tool) => tool.name)).toContain("forget_memory");
  });

  it("keeps synchronous legacy saves", async () => {
    const f = fixture({
      memory: "legacy",
      calls: [{ name: "save_memory", args: { content: "Uses metric units." }, executionId: "c" }],
    });

    await f.run();

    expect(f.save).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Uses metric units.", source: { kind: "durable" } }),
      expect.any(Object),
    );
    expect(insertExplicitMemoryRetention).not.toHaveBeenCalled();
  });

  it("keeps native remember for an unbound bot without provider calls", async () => {
    const f = fixture({ memory: "native" });

    await f.run();

    const names = f.requests[0]?.tools.map((tool) => tool.name) ?? [];
    expect(names).toContain("remember");
    expect(names).not.toContain("recall_memory");
    expect(f.recall).not.toHaveBeenCalled();
    expect(loadRetentionSourceMessages).not.toHaveBeenCalled();
  });
});
