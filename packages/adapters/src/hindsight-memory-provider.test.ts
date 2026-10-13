import type { AdapterContext, SemanticMemorySaveRequest } from "@rakazo/adapter-kit";
import type { MemorySelection } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { HINDSIGHT_CLOUD_ORIGIN } from "./hindsight-client.js";
import {
  createHindsightProvider,
  HINDSIGHT_CAPABILITIES,
  MemoryDispatchDeniedError,
  MemoryProviderConnectionError,
} from "./hindsight-memory-provider.js";
import {
  createMemoryBankDirectory,
  prepareMemoryProviderConnection,
  SpaceMemoryProviderResolver,
} from "./memory-provider-factory.js";

const KEY = "hsk_test_fixture+/= key";
const KEY_FORMS = [
  KEY,
  Buffer.from(KEY).toString("base64"),
  Buffer.from(KEY).toString("base64url"),
  encodeURIComponent(KEY),
];
const OPERATION_ID = "6f1c2a4e-8b3d-4f5a-9c7e-1d2b3c4d5e6f";
const SETTINGS = { baseUrl: HINDSIGHT_CLOUD_ORIGIN };

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function leak(status: number): Response {
  return json({ detail: `upstream rejected ${KEY}` }, status);
}

interface FakeCloud {
  fetch: typeof globalThis.fetch;
  calls: Call[];
  banks: Map<string, string>;
}

function fakeCloud(
  options: {
    banks?: string[];
    listStatus?: number;
    putStatus?: number;
    deniedBanks?: string[];
    operationStatus?: string;
  } = {},
): FakeCloud {
  const banks = new Map((options.banks ?? []).map((id) => [id, `Bank ${id}`]));
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(HINDSIGHT_CLOUD_ORIGIN);
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    const method = init.method ?? "GET";
    const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const fields: Record<string, unknown> =
      typeof body === "object" && body !== null ? { ...body } : {};
    calls.push({ method, path: url.pathname, query: url.searchParams, body });
    const [id, ...rest] = url.pathname.split("/").slice(4).map(decodeURIComponent);
    const route = `${method} ${rest.join("/")}`;
    if (id === undefined) {
      if (options.listStatus) return leak(options.listStatus);
      const all = [...banks].map(([bank_id, name]) => ({ bank_id, name }));
      return json({ banks: all, total: all.length });
    }
    if (options.deniedBanks?.includes(id)) return leak(403);
    if (route === "GET profile") {
      const name = banks.get(id);
      return name === undefined ? leak(404) : json({ bank_id: id, name });
    }
    if (route === "PUT ") {
      if (options.putStatus) return leak(options.putStatus);
      banks.set(id, String(fields.name));
      return json({ bank_id: id, name: banks.get(id) });
    }
    if (route === "POST memories/recall") {
      return json({
        results: [
          {
            id: "fact-1",
            text: "The user likes marigolds.",
            document_id: "rakazo-doc-1",
            metadata: { run_id: "run-0", owner: "ignored" },
          },
        ],
      });
    }
    if (route === "POST memories") {
      const operation = String(fields.operation_id);
      return json({
        success: true,
        bank_id: id,
        items_count: 1,
        async: true,
        operation_id: operation,
      });
    }
    if (method === "GET" && rest[0] === "operations") {
      return json({ operation_id: rest[1], status: options.operationStatus ?? "processing" });
    }
    return leak(500);
  };
  return { fetch, calls, banks };
}

function context(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    operationId: "op-1",
    traceId: "trace-1",
    spaceId: "space-1",
    userId: "user-1",
    botId: "bot-1",
    runId: "run-1",
    signal: new AbortController().signal,
    ...overrides,
  };
}

function expectNoKey(value: unknown) {
  const text = JSON.stringify(value, (_key, nested) =>
    nested instanceof Error ? { name: nested.name, message: nested.message } : nested,
  );
  for (const form of KEY_FORMS) expect(text).not.toContain(form);
}

interface StoredBinding {
  id: string;
  botId: string;
  spaceMemoryConfigId: string;
  bankId: string;
}

interface StoredConfig {
  id: string;
  spaceId: string;
  userId: string;
  provider: string;
  settings: Record<string, string>;
  defaultMemoryScope: string;
  secret: { id: string; ciphertext: string };
}

interface StoredState {
  config: StoredConfig | null;
  binding: StoredBinding | null;
  bot: { id: string; spaceId: string; userId: string; memoryScope: string | null };
  members: string[];
}

function memoryState() {
  const state: StoredState = {
    config: {
      id: "config-1",
      spaceId: "space-1",
      userId: "owner-1",
      provider: "hindsight",
      settings: { ...SETTINGS },
      defaultMemoryScope: "isolated",
      secret: { id: "secret-1", ciphertext: "encrypted" },
    },
    binding: {
      id: "binding-1",
      botId: "bot-1",
      spaceMemoryConfigId: "config-1",
      bankId: "bank-a",
    },
    bot: { id: "bot-1", spaceId: "space-1", userId: "user-1", memoryScope: null },
    members: ["user-1"],
  };
  const prisma = {
    spaceMemoryConfig: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; spaceId?: string } }) => {
        const config = state.config;
        if (!config) return null;
        if (where.id !== undefined && where.id !== config.id) return null;
        if (where.spaceId !== undefined && where.spaceId !== config.spaceId) return null;
        return config;
      }),
    },
    bot: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; spaceId: string } }) =>
        state.bot.id === where.id && state.bot.spaceId === where.spaceId
          ? {
              ...state.bot,
              memoryBank: state.binding?.botId === state.bot.id ? state.binding : null,
            }
          : null,
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        state.bot.id === where.id ? state.bot : null,
      ),
    },
    botMemoryBank: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        state.binding?.id === where.id ? state.binding : null,
      ),
    },
    spaceMember: {
      findUnique: vi.fn(
        async ({ where }: { where: { spaceId_userId: { spaceId: string; userId: string } } }) =>
          where.spaceId_userId.spaceId === "space-1" &&
          state.members.includes(where.spaceId_userId.userId)
            ? { id: "member-1" }
            : null,
      ),
    },
    deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: null })) },
  };
  const secrets = { load: vi.fn(async () => JSON.stringify({ apiKey: KEY })) };
  return { state, prisma, secrets };
}

function resolverFor(cloud: FakeCloud) {
  const memory = memoryState();
  const resolver = new SpaceMemoryProviderResolver({
    prisma: memory.prisma as never,
    secrets: memory.secrets as never,
    memoryTransport: { fetch: cloud.fetch },
  });
  return { ...memory, resolver };
}

const INPUT = { spaceId: "space-1", userId: "user-1", botId: "bot-1" };

const SAVE: SemanticMemorySaveRequest = {
  content: "User 2026-10-13T00:00:00.000Z:\nI like marigolds.",
  scope: "isolated",
  botId: "bot-1",
  source: { kind: "conversation" },
  delivery: {
    documentId: "rakazo-doc-1",
    operationId: OPERATION_ID,
    timestamp: "2026-10-13T00:00:00.000Z",
    threadId: "thread-1",
    sourceKey: "conversation",
  },
};

describe("Hindsight memory resolution", () => {
  it("keeps an unbound bot native without loading credentials or calling Cloud", async () => {
    const cloud = fakeCloud({ banks: ["bank-a"] });
    const { resolver, state, secrets } = resolverFor(cloud);
    state.binding = null;

    const selection = await resolver.select(INPUT);

    expect(selection).toEqual({ kind: "native" });
    await expect(resolver.resolve({ ...INPUT, selection })).resolves.toEqual({ kind: "native" });
    expect(secrets.load).not.toHaveBeenCalled();
    expect(cloud.calls).toHaveLength(0);
  });

  it("recalls from the pinned bank and registers every encoded form of the key", async () => {
    const cloud = fakeCloud({ banks: ["bank-a"] });
    const { resolver } = resolverFor(cloud);
    const registered: string[] = [];

    const selection = await resolver.select(INPUT);
    expect(selection).toEqual({
      kind: "bank",
      configId: "config-1",
      provider: "hindsight",
      bindingId: "binding-1",
      bankId: "bank-a",
    });
    const resolution = await resolver.resolve(
      { ...INPUT, selection },
      { registerSecrets: (values) => registered.push(...values) },
    );
    if (resolution.kind !== "configured") throw new Error(`unexpected ${resolution.kind}`);
    expect(resolution.capabilities).toEqual(HINDSIGHT_CAPABILITIES);
    expect(resolution.provider.describe().capabilities).toBe(HINDSIGHT_CAPABILITIES);
    expect(resolution.provider.purgeHistory).toBeUndefined();
    expect(resolution.provider.forget).toBeUndefined();
    expect(registered).toEqual(expect.arrayContaining(KEY_FORMS));

    const recalled = await resolution.provider.recall(
      { query: "flowers", scope: "shared", botId: "bot-1", historyGeneration: 3, limit: 5 },
      context(),
    );

    expect(recalled).toEqual({
      ok: true,
      value: [{ memory: "The user likes marigolds.", id: "fact-1", provenance: "run:run-0" }],
    });
    expect(cloud.calls).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/v1/default/banks/bank-a/memories/recall",
        body: { query: "flowers", budget: "low", max_tokens: 1024 },
      }),
    ]);
  });

  it("does not call Cloud for an empty sanitized recall query", async () => {
    const cloud = fakeCloud({ banks: ["bank-a"] });
    const provider = createHindsightProvider(
      SETTINGS,
      { apiKey: KEY },
      {
        bankId: "bank-a",
        memoryTransport: { fetch: cloud.fetch },
      },
    );

    await expect(
      provider.recall({ query: "   ", scope: "isolated", botId: "bot-1", limit: 5 }, context()),
    ).resolves.toEqual({ ok: true, value: [] });
    expect(cloud.calls).toHaveLength(0);
  });

  it("redacts a key that crosses the query byte bound before truncating", async () => {
    const cloud = fakeCloud({ banks: ["bank-a"] });
    const provider = createHindsightProvider(
      SETTINGS,
      { apiKey: KEY },
      { bankId: "bank-a", memoryTransport: { fetch: cloud.fetch } },
    );

    await provider.recall(
      { query: `${"a".repeat(440)} ${KEY} trailing`, scope: "isolated", botId: "bot-1", limit: 5 },
      context(),
    );

    const sent = JSON.stringify(cloud.calls[0]?.body);
    expect(Buffer.byteLength(JSON.parse(sent).query)).toBeLessThanOrEqual(450);
    expect(sent).not.toContain(KEY.slice(0, 4));
  });

  it("resolves a retired binding as unavailable without credentials or HTTP", async () => {
    const cloud = fakeCloud({ banks: ["bank-a", "bank-b"] });
    const { resolver, state, secrets } = resolverFor(cloud);
    const selection = await resolver.select(INPUT);
    state.binding = {
      id: "binding-2",
      botId: "bot-1",
      spaceMemoryConfigId: "config-1",
      bankId: "bank-b",
    };

    const resolution = await resolver.resolve({ ...INPUT, selection });

    expect(resolution).toEqual({
      kind: "unavailable",
      capabilities: HINDSIGHT_CAPABILITIES,
      code: "binding_retired",
      error: "The memory connection changed. Choose a bank again.",
    });
    expect(secrets.load).not.toHaveBeenCalled();
    expect(cloud.calls).toHaveLength(0);
  });

  it("rechecks the binding and membership before every request", async () => {
    const cloud = fakeCloud({ banks: ["bank-a"] });
    const { resolver, state } = resolverFor(cloud);
    const selection = await resolver.select(INPUT);
    const resolution = await resolver.resolve({ ...INPUT, selection });
    if (resolution.kind !== "configured") throw new Error(`unexpected ${resolution.kind}`);

    state.members = [];
    await expect(
      resolution.provider.recall(
        { query: "flowers", scope: "isolated", botId: "bot-1", limit: 5 },
        context(),
      ),
    ).resolves.toMatchObject({ ok: false, code: "forbidden" });

    state.members = ["user-1"];
    state.binding = null;
    await expect(resolution.provider.save(SAVE, context())).resolves.toMatchObject({
      ok: false,
      code: "binding_retired",
    });
    expect(cloud.calls).toHaveLength(0);
  });

  it("maps a caller dispatch denial to a failure without HTTP", async () => {
    const cloud = fakeCloud({ banks: ["bank-a"] });
    const { resolver } = resolverFor(cloud);
    const selection = await resolver.select(INPUT);
    const beforeRequest = vi.fn(async () => {
      throw new MemoryDispatchDeniedError("forbidden");
    });
    const resolution = await resolver.resolve({ ...INPUT, selection }, { beforeRequest });
    if (resolution.kind !== "configured") throw new Error(`unexpected ${resolution.kind}`);

    const status = await resolution.provider.operationStatus?.(OPERATION_ID, context());

    expect(status).toEqual({
      ok: false,
      code: "forbidden",
      error: "This key cannot access this bank.",
    });
    expect(beforeRequest).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1" }));
    expect(cloud.calls).toHaveLength(0);
  });

  it("treats malformed snapshots and unreadable credentials as unavailable, never native", async () => {
    const cloud = fakeCloud({ banks: ["bank-a"] });
    const { resolver, secrets } = resolverFor(cloud);
    const bank = await resolver.select(INPUT);
    if (bank.kind !== "bank") throw new Error(`unexpected ${bank.kind}`);
    const malformed: MemorySelection[] = [
      { ...bank, bankId: ".." },
      { kind: "legacy", configId: "config-1", provider: "hindsight", scope: "isolated" },
      { kind: "bank", configId: "config-1", provider: "unknown", bindingId: "b", bankId: "x" },
      { kind: "elsewhere" } as never,
    ];
    for (const selection of malformed) {
      const resolution = await resolver.resolve({ ...INPUT, selection });
      expect(resolution).toMatchObject({ kind: "unavailable", code: "invalid_request" });
    }

    secrets.load.mockRejectedValueOnce(new Error(`cannot decrypt ${KEY}`));
    const failed = await resolver.resolve({ ...INPUT, selection: bank });
    expect(failed).toMatchObject({
      kind: "unavailable",
      code: "unavailable",
      capabilities: HINDSIGHT_CAPABILITIES,
    });
    expectNoKey(failed);
    expect(cloud.calls).toHaveLength(0);
  });
});

describe("Hindsight saves", () => {
  function provider(cloud: FakeCloud) {
    return createHindsightProvider(
      SETTINGS,
      { apiKey: KEY },
      { bankId: "bank-a", memoryTransport: { fetch: cloud.fetch } },
    );
  }

  it("checks the bank profile, submits one async replace and reports the operation", async () => {
    const cloud = fakeCloud({ banks: ["bank-a"], operationStatus: "completed" });
    const hindsight = provider(cloud);

    await expect(hindsight.save(SAVE, context())).resolves.toEqual({
      ok: true,
      value: { status: "pending", operationId: OPERATION_ID },
    });
    await expect(hindsight.operationStatus?.(OPERATION_ID, context())).resolves.toEqual({
      ok: true,
      value: "completed",
    });

    expect(cloud.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /v1/default/banks/bank-a/profile",
      "POST /v1/default/banks/bank-a/memories",
      `GET /v1/default/banks/bank-a/operations/${OPERATION_ID}`,
    ]);
    expect(cloud.calls[1]?.body).toEqual({
      items: [
        {
          content: SAVE.content,
          document_id: "rakazo-doc-1",
          timestamp: "2026-10-13T00:00:00.000Z",
          context: "Rakazo conversation",
          metadata: {
            space_id: "space-1",
            bot_id: "bot-1",
            thread_id: "thread-1",
            run_id: "run-1",
            source_kind: "conversation",
            source_key: "conversation",
          },
          update_mode: "replace",
        },
      ],
      async: true,
      operation_id: OPERATION_ID,
    });
  });

  it("labels explicit saves as saved memory", async () => {
    const cloud = fakeCloud({ banks: ["bank-a"] });

    await provider(cloud).save(
      { ...SAVE, source: { kind: "durable" }, delivery: { ...SAVE.delivery!, sourceKey: "e1" } },
      context(),
    );

    expect(cloud.calls[1]?.body).toMatchObject({
      items: [
        {
          context: "Rakazo saved memory",
          metadata: { source_kind: "durable", source_key: "e1" },
        },
      ],
    });
  });

  it("rejects history, missing delivery and missing run without HTTP", async () => {
    const cloud = fakeCloud({ banks: ["bank-a"] });
    const hindsight = provider(cloud);
    const { delivery: _delivery, ...withoutDelivery } = SAVE;

    for (const [request, ctx] of [
      [{ ...SAVE, source: { kind: "history", generation: 1 } }, context()],
      [withoutDelivery, context()],
      [SAVE, context({ runId: undefined })],
    ] as Array<[SemanticMemorySaveRequest, AdapterContext]>) {
      await expect(hindsight.save(request, ctx)).resolves.toMatchObject({
        ok: false,
        code: "invalid_request",
      });
    }
    expect(cloud.calls).toHaveLength(0);
  });

  it("does not retain into a bank whose profile is gone and never echoes provider text", async () => {
    const cloud = fakeCloud();

    const result = await provider(cloud).save(SAVE, context());

    expect(result).toEqual({ ok: false, code: "not_found", error: "This bank is unavailable." });
    expect(cloud.calls.map((call) => call.method)).toEqual(["GET"]);
    expectNoKey(result);
  });
});

describe("Hindsight connection preparation", () => {
  it("verifies with a one-item list and accepts a valid empty page", async () => {
    const cloud = fakeCloud();
    const beforeRequest = vi.fn(async () => undefined);

    const prepared = await prepareMemoryProviderConnection(
      { provider: "hindsight", settings: SETTINGS, credentials: { apiKey: `  ${KEY}  ` } },
      { beforeRequest, memoryTransport: { fetch: cloud.fetch } },
    );

    expect(prepared).toEqual({
      provider: "hindsight",
      settings: SETTINGS,
      credentials: { apiKey: KEY },
    });
    expect(cloud.calls).toHaveLength(1);
    expect(cloud.calls[0]?.path).toBe("/v1/default/banks");
    expect(Object.fromEntries(cloud.calls[0]!.query)).toEqual({ limit: "1", offset: "0" });
    expect(beforeRequest).toHaveBeenCalledTimes(1);
  });

  it("asks for a bank ID when the key cannot list banks", async () => {
    const cloud = fakeCloud({ listStatus: 403, banks: ["bank-a"] });

    const error = await prepareMemoryProviderConnection(
      { provider: "hindsight", settings: SETTINGS, credentials: { apiKey: KEY } },
      { memoryTransport: { fetch: cloud.fetch } },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MemoryProviderConnectionError);
    expect(error).toMatchObject({ reason: "bank_id_required" });
    expectNoKey(error);
  });

  it("verifies a scoped key through the bank profile and drops the verification bank", async () => {
    const cloud = fakeCloud({ listStatus: 403, banks: ["bank-a"] });

    const prepared = await prepareMemoryProviderConnection(
      {
        provider: "hindsight",
        settings: { ...SETTINGS, verificationBankId: "bank-a" },
        credentials: { apiKey: KEY },
      },
      { memoryTransport: { fetch: cloud.fetch } },
    );

    expect(prepared.settings).toEqual(SETTINGS);
    expect(cloud.calls.map((call) => call.path)).toEqual([
      "/v1/default/banks",
      "/v1/default/banks/bank-a/profile",
    ]);

    const denied = await prepareMemoryProviderConnection(
      {
        provider: "hindsight",
        settings: { ...SETTINGS, verificationBankId: "bank-b" },
        credentials: { apiKey: KEY },
      },
      { memoryTransport: { fetch: fakeCloud({ listStatus: 403, deniedBanks: ["bank-b"] }).fetch } },
    ).catch((caught: unknown) => caught);
    expect(denied).toMatchObject({ reason: "forbidden" });
  });

  it("rejects other endpoints, unknown settings and extra credentials before any request", async () => {
    const cloud = fakeCloud();
    for (const [settings, credentials] of [
      [{ baseUrl: `${HINDSIGHT_CLOUD_ORIGIN}/` }, { apiKey: KEY }],
      [{ baseUrl: "https://hindsight.example.com" }, { apiKey: KEY }],
      [{ ...SETTINGS, mode: "cloud" }, { apiKey: KEY }],
      [SETTINGS, { apiKey: KEY, token: "extra" }],
      [SETTINGS, { apiKey: "  " }],
    ] as Array<[Record<string, string>, Record<string, string>]>) {
      const error = await prepareMemoryProviderConnection(
        { provider: "hindsight", settings, credentials },
        { memoryTransport: { fetch: cloud.fetch } },
      ).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ reason: "invalid_request" });
    }
    expect(cloud.calls).toHaveLength(0);
  });

  it("maps a rejected key to a fixed message", async () => {
    const cloud = fakeCloud({ listStatus: 401 });

    const error = await prepareMemoryProviderConnection(
      { provider: "hindsight", settings: SETTINGS, credentials: { apiKey: KEY } },
      { memoryTransport: { fetch: cloud.fetch } },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      reason: "unauthorized",
      message: "Hindsight Cloud rejected this API key.",
    });
    expectNoKey(error);
  });
});

describe("Hindsight bank directory", () => {
  async function directoryFor(cloud: FakeCloud) {
    const memory = memoryState();
    const result = await createMemoryBankDirectory(
      {
        prisma: memory.prisma as never,
        secrets: memory.secrets as never,
        memoryTransport: { fetch: cloud.fetch },
      },
      { configId: "config-1", spaceId: "space-1" },
    );
    if (!("directory" in result)) throw new Error(result.error);
    return result.directory;
  }

  it("lists a page and reports a key that cannot list banks", async () => {
    const listed = fakeCloud({ banks: ["bank-a", "bank-b"] });
    await expect(
      (await directoryFor(listed)).list({ q: "bank", offset: 0, limit: 50 }, context()),
    ).resolves.toEqual({
      ok: true,
      value: {
        banks: [
          { bankId: "bank-a", name: "Bank bank-a" },
          { bankId: "bank-b", name: "Bank bank-b" },
        ],
        nextOffset: null,
      },
    });
    expect(Object.fromEntries(listed.calls[0]!.query)).toEqual({
      q: "bank",
      limit: "50",
      offset: "0",
    });

    const forbidden = await (await directoryFor(fakeCloud({ listStatus: 403 }))).list(
      { offset: 0, limit: 50 },
      context(),
    );
    expect(forbidden).toEqual({
      ok: false,
      code: "bank_list_forbidden",
      error: "This key can't list banks. Use bank ID.",
    });
  });

  it("returns an existing bank without writing it", async () => {
    const cloud = fakeCloud({ banks: ["rakazo-existing"] });

    const created = await (await directoryFor(cloud)).create(
      { bankId: "rakazo-existing", name: "Renamed" },
      context(),
    );

    expect(created).toEqual({
      ok: true,
      value: { bankId: "rakazo-existing", name: "Bank rakazo-existing" },
    });
    expect(cloud.calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("creates a missing bank with only its name and reads it back", async () => {
    const cloud = fakeCloud();

    const created = await (await directoryFor(cloud)).create(
      { bankId: "rakazo-new", name: "Research" },
      context(),
    );

    expect(created).toEqual({ ok: true, value: { bankId: "rakazo-new", name: "Research" } });
    expect(cloud.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /v1/default/banks/rakazo-new/profile",
      "PUT /v1/default/banks/rakazo-new",
      "GET /v1/default/banks/rakazo-new/profile",
    ]);
    expect(cloud.calls[1]?.body).toEqual({ name: "Research" });
  });

  it("reports denied creation without creating anything", async () => {
    const cloud = fakeCloud({ putStatus: 403 });

    const created = await (await directoryFor(cloud)).create(
      { bankId: "rakazo-new", name: "Research" },
      context(),
    );

    expect(created).toEqual({
      ok: false,
      code: "bank_create_forbidden",
      error: "This key can't create banks.",
    });
    expect(cloud.banks.size).toBe(0);
    expectNoKey(created);
  });

  it("refuses a configuration from another Space or a provider without banks", async () => {
    const memory = memoryState();
    const deps = { prisma: memory.prisma as never, secrets: memory.secrets as never };
    await expect(
      createMemoryBankDirectory(deps, { configId: "config-1", spaceId: "space-2" }),
    ).resolves.toEqual({ error: "binding_retired" });
    memory.state.config!.provider = "supermemory";
    await expect(
      createMemoryBankDirectory(deps, { configId: "config-1", spaceId: "space-1" }),
    ).resolves.toEqual({ error: "invalid_request" });
    expect(memory.secrets.load).not.toHaveBeenCalled();
  });
});
