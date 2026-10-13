import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HINDSIGHT_CAPABILITIES } from "./hindsight-memory-provider.js";
import {
  createMemoryProvider,
  MemoryDispatchDeniedError,
  memoryProviderCapabilities,
  prepareMemoryProviderConnection,
  SpaceMemoryProviderResolver,
} from "./memory-provider-factory.js";
import { SERENITY_CAPABILITIES } from "./serenity-memory-provider.js";
import {
  assertSupermemoryLocalBaseUrl,
  SUPERMEMORY_CAPABILITIES,
} from "./supermemory-memory-provider.js";

const INPUT = { spaceId: "workspace-1", userId: "space-member", botId: "bot-1" };

function context(): AdapterContext {
  return {
    operationId: "op-1",
    traceId: "trace-1",
    spaceId: "workspace-1",
    userId: "space-member",
    signal: new AbortController().signal,
  };
}

function resolverFor(
  plaintext: string,
  options: {
    mode?: "cloud" | "local";
    ownerUserId?: string | null;
    baseUrl?: string;
    configured?: boolean;
    botScope?: string | null;
  } = {},
) {
  const state = { configured: options.configured ?? true, members: ["space-member"] };
  const config = {
    id: "config-1",
    spaceId: "workspace-1",
    userId: "config-author",
    provider: "supermemory",
    settings: {
      mode: options.mode ?? "cloud",
      baseUrl: options.baseUrl ?? "https://api.supermemory.ai",
    },
    defaultMemoryScope: "shared",
    secret: { id: "secret-1", ciphertext: "encrypted" },
  };
  const bot = {
    id: "bot-1",
    spaceId: "workspace-1",
    userId: "bot-owner",
    memoryScope: options.botScope ?? null,
    memoryBank: null,
  };
  const prisma = {
    spaceMemoryConfig: { findUnique: vi.fn(async () => (state.configured ? config : null)) },
    bot: { findFirst: vi.fn(async () => bot), findUnique: vi.fn(async () => bot) },
    botMemoryBank: { findUnique: vi.fn(async () => null) },
    spaceMember: {
      findUnique: vi.fn(async ({ where }: { where: { spaceId_userId: { userId: string } } }) =>
        state.members.includes(where.spaceId_userId.userId) ? { id: "member-1" } : null,
      ),
    },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({ ownerUserId: options.ownerUserId ?? null })),
    },
  };
  const secrets = { load: vi.fn(async () => plaintext) };
  return {
    resolver: new SpaceMemoryProviderResolver({
      prisma: prisma as never,
      secrets: secrets as never,
    }),
    secrets,
    prisma,
    state,
  };
}

const LEGACY_SELECTION = {
  kind: "legacy",
  configId: "config-1",
  provider: "supermemory",
  scope: "shared",
} as const;

afterEach(() => vi.unstubAllGlobals());

describe("memory provider registry", () => {
  it("exposes each provider's capabilities without credentials", () => {
    expect(memoryProviderCapabilities("hindsight")).toBe(HINDSIGHT_CAPABILITIES);
    expect(memoryProviderCapabilities("supermemory")).toBe(SUPERMEMORY_CAPABILITIES);
    expect(memoryProviderCapabilities("serenity")).toBe(SERENITY_CAPABILITIES);
    expect(memoryProviderCapabilities("unknown").banks).toBeUndefined();
  });
});

describe("legacy connection preparation", () => {
  const SUPERMEMORY = {
    provider: "supermemory",
    settings: { mode: "cloud" },
    credentials: { apiKey: "sm_test_key" },
  };

  it("runs the caller's guard before the probe and surfaces its error unchanged", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const denied = new Error("ownership changed");

    await expect(
      prepareMemoryProviderConnection(SUPERMEMORY, {
        beforeRequest: async () => {
          throw denied;
        },
      }),
    ).rejects.toBe(denied);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts the probe with the caller's signal", async () => {
    const controller = new AbortController();
    const signals: Array<AbortSignal | null | undefined> = [];
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      signals.push(init?.signal);
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      prepareMemoryProviderConnection(SUPERMEMORY, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });
});

describe("SpaceMemoryProviderResolver", () => {
  it("selects native when the Space has no external memory", async () => {
    const { resolver, secrets } = resolverFor("sm_fake_key", { configured: false });

    await expect(resolver.select(INPUT)).resolves.toEqual({ kind: "native" });
    expect(secrets.load).not.toHaveBeenCalled();
  });

  it("selects legacy memory with the bot's effective scope", async () => {
    const { resolver } = resolverFor("sm_fake_key", { botScope: "isolated" });

    await expect(resolver.select(INPUT)).resolves.toEqual({
      kind: "legacy",
      configId: "config-1",
      provider: "supermemory",
      scope: "isolated",
    });
  });

  it.each([null, "another-user"])(
    "disables saved local configurations without current deployment-owner authorization: %s",
    async (ownerUserId) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const { resolver, secrets } = resolverFor("sm_fake_key", {
        mode: "local",
        baseUrl: "http://127.0.0.1:8123/internal-action#",
        ownerUserId,
      });

      await expect(resolver.select(INPUT)).resolves.toEqual({ kind: "native" });
      await expect(
        resolver.resolve({ ...INPUT, selection: LEGACY_SELECTION }),
      ).resolves.toMatchObject({
        kind: "unavailable",
        code: "forbidden",
        capabilities: SUPERMEMORY_CAPABILITIES,
      });
      expect(secrets.load).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("retains deployment-owner-configured local memory for Space members", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { resolver } = resolverFor("sm_fake_key", {
      mode: "local",
      baseUrl: "http://localhost:6767/memory/",
      ownerUserId: "config-author",
    });
    const selection = await resolver.select(INPUT);
    const configured = await resolver.resolve({ ...INPUT, selection });
    if (configured.kind !== "configured") throw new Error(`unexpected ${configured.kind}`);

    await configured.provider.recall(
      { query: "project", scope: "isolated", botId: "bot-1", limit: 1 },
      context(),
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:6767/memory/v4/search");
  });

  it("rejects ambiguous persisted URLs even when the deployment owner configured them", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { resolver } = resolverFor("sm_fake_key", {
      mode: "local",
      baseUrl: "http://127.0.0.1:8123/internal-action#",
      ownerUserId: "config-author",
    });

    await expect(
      resolver.resolve({ ...INPUT, selection: LEGACY_SELECTION }),
    ).resolves.toMatchObject({ kind: "unavailable", code: "invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads generic JSON credential payloads and registers the key", async () => {
    const { resolver, prisma } = resolverFor(JSON.stringify({ apiKey: "sm_json_key" }));
    const registered: string[] = [];

    const configured = await resolver.resolve(
      { ...INPUT, selection: LEGACY_SELECTION },
      { registerSecrets: (values) => registered.push(...values) },
    );

    expect(configured).toMatchObject({
      kind: "configured",
      capabilities: SUPERMEMORY_CAPABILITIES,
      defaultScope: "shared",
      selection: LEGACY_SELECTION,
    });
    if (configured.kind !== "configured") throw new Error(`unexpected ${configured.kind}`);
    expect(configured.provider.describe().id).toBe("supermemory");
    expect(registered).toContain("sm_json_key");
    expect(prisma.deploymentSettings.findUnique).not.toHaveBeenCalled();
  });

  it("keeps legacy raw Supermemory credentials usable after the schema migration", async () => {
    const { resolver } = resolverFor("sm_legacy_key");

    const configured = await resolver.resolve({ ...INPUT, selection: LEGACY_SELECTION });

    expect(configured.kind === "configured" && configured.provider.describe().id).toBe(
      "supermemory",
    );
  });

  it("stops legacy requests when the captured connection or membership changes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { resolver, state } = resolverFor("sm_fake_key");
    const configured = await resolver.resolve({ ...INPUT, selection: LEGACY_SELECTION });
    if (configured.kind !== "configured") throw new Error(`unexpected ${configured.kind}`);
    const recall = () =>
      configured.provider.recall(
        { query: "project", scope: "shared", botId: "bot-1", limit: 1 },
        context(),
      );

    state.members = [];
    await expect(recall()).resolves.toMatchObject({ ok: false, code: "forbidden" });
    state.members = ["space-member"];
    state.configured = false;
    await expect(recall()).resolves.toMatchObject({ ok: false, code: "binding_retired" });
    await expect(
      resolver.resolve({ ...INPUT, selection: LEGACY_SELECTION }),
    ).resolves.toMatchObject({ kind: "unavailable", code: "binding_retired" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("applies the caller's dispatch guard to legacy providers", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { resolver } = resolverFor("sm_fake_key");
    const configured = await resolver.resolve(
      { ...INPUT, selection: LEGACY_SELECTION },
      {
        beforeRequest: async () => {
          throw new MemoryDispatchDeniedError("binding_retired");
        },
      },
    );
    if (configured.kind !== "configured") throw new Error(`unexpected ${configured.kind}`);

    await expect(
      configured.provider.save(
        { content: "fact", scope: "shared", botId: "bot-1", source: { kind: "durable" } },
        context(),
      ),
    ).resolves.toMatchObject({ ok: false, code: "binding_retired" });
    expect(configured.provider.purgeHistory).toBeTypeOf("function");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("revalidates persisted provider endpoints before using decrypted credentials", async () => {
    const { resolver, secrets } = resolverFor("sm_fake_key", {
      mode: "local",
      baseUrl: "http://203.0.113.10:6767",
      ownerUserId: "config-author",
    });
    await expect(
      resolver.resolve({ ...INPUT, selection: LEGACY_SELECTION }),
    ).resolves.toMatchObject({ kind: "unavailable", code: "invalid_request" });
    expect(secrets.load).not.toHaveBeenCalled();

    await expect(
      assertSupermemoryLocalBaseUrl("https://memory.example.com", {
        allowPrivateEndpoint: true,
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
      }),
    ).rejects.toThrow(/private-network/);
    await expect(
      assertSupermemoryLocalBaseUrl("http://example.com:6767", {
        allowPrivateEndpoint: true,
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
      }),
    ).rejects.toThrow(/private-network/);

    expect(() =>
      createMemoryProvider(
        "supermemory",
        { mode: "local", baseUrl: "http://203.0.113.10:6767" },
        { apiKey: "sm_test_key" },
      ),
    ).toThrow(/private-network/);

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = createMemoryProvider(
      "supermemory",
      { mode: "cloud", baseUrl: "https://memory.example.com" },
      { apiKey: "sm_test_key" },
    );

    await provider.recall(
      { query: "project", scope: "isolated", botId: "bot-1", limit: 1 },
      { ...context(), userId: "user-1" },
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.supermemory.ai/v4/search");
  });
});
