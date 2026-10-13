import type { SecretStore } from "@rakazo/adapter-kit";
import type { prepareMemoryProviderConnection } from "@rakazo/adapters";
import {
  MemoryProviderConnectionError,
  MemoryProviderDeploymentOwnerRequiredError,
} from "@rakazo/adapters";
import { MEMORY_FAILURE_MESSAGES } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disconnectMemoryProvider,
  persistMemoryProviderConfig,
  updateMemoryProviderDefaultScope,
} from "./memory-provider-config.js";

const actor = {
  userId: "user-1",
  spaceId: "ws-1",
  email: "a@b.com",
  isDeploymentOwner: false,
};
const deploymentOwner = { ...actor, isDeploymentOwner: true };

type ConfigRow = {
  id: string;
  spaceId: string;
  userId: string;
  provider: string;
  settings: Record<string, string>;
  secretId: string;
  defaultMemoryScope: string;
  createdAt: Date;
  updatedAt: Date;
};
type SecretRow = { id: string; userId: string; spaceId: string; kind: string; ciphertext: string };
type BindingRow = { id: string; botId: string; spaceMemoryConfigId: string; bankId: string };
type State = {
  roles: Record<string, string>;
  configs: ConfigRow[];
  secrets: SecretRow[];
  bindings: BindingRow[];
};
type PrepareConnection = typeof prepareMemoryProviderConnection;

function fakeSecretStore() {
  let next = 0;
  return {
    describe: () => ({
      id: "fake",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { rotate: false },
    }),
    put: vi.fn(async () => {
      next += 1;
      return {
        id: `secret-new-${next}`,
        ref: `cipher-new-${next}`,
        ciphertext: `cipher-new-${next}`,
      };
    }),
    load: vi.fn(async () => "{}"),
    delete: vi.fn(async () => {}),
    redact: (value: string) => value,
    onChange: () => () => {},
    start: async () => {},
    close: async () => {},
  } satisfies SecretStore;
}

function makeDeps(
  overrides: {
    existing?: { provider: string; defaultMemoryScope?: string } | null;
    memberRole?: string | null;
  } = {},
) {
  const state: State = {
    roles: overrides.memberRole === null ? {} : { "user-1": overrides.memberRole ?? "owner" },
    configs: [],
    secrets: [],
    bindings: [],
  };
  if (overrides.existing) {
    state.secrets.push({
      id: "secret-old",
      userId: "user-1",
      spaceId: "ws-1",
      kind: "memory-provider",
      ciphertext: "cipher-old",
    });
    state.configs.push({
      id: "cfg-old",
      spaceId: "ws-1",
      userId: "user-1",
      provider: overrides.existing.provider,
      settings: {},
      secretId: "secret-old",
      defaultMemoryScope: overrides.existing.defaultMemoryScope ?? "isolated",
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    state.bindings.push({
      id: "binding-old",
      botId: "bot-1",
      spaceMemoryConfigId: "cfg-old",
      bankId: "bank-old",
    });
  }
  let nextConfig = 0;
  const removeConfig = (id: string) => {
    state.configs = state.configs.filter((row) => row.id !== id);
    state.bindings = state.bindings.filter((row) => row.spaceMemoryConfigId !== id);
  };
  const client = {
    spaceMember: {
      findUnique: async ({
        where,
      }: {
        where: { spaceId_userId: { spaceId: string; userId: string } };
      }) => {
        const role = state.roles[where.spaceId_userId.userId];
        return role ? { role } : null;
      },
    },
    spaceMemoryConfig: {
      findUnique: async ({ where }: { where: { id?: string; spaceId?: string } }) =>
        state.configs.find((row) =>
          where.id !== undefined ? row.id === where.id : row.spaceId === where.spaceId,
        ) ?? null,
      create: async ({ data }: { data: Omit<ConfigRow, "id" | "createdAt" | "updatedAt"> }) => {
        if (state.configs.some((row) => row.spaceId === data.spaceId)) {
          throw new Error("unique constraint: spaceId");
        }
        nextConfig += 1;
        const now = new Date(`2026-09-0${nextConfig}T00:00:00.000Z`);
        const row = { ...data, id: `cfg-new-${nextConfig}`, createdAt: now, updatedAt: now };
        state.configs.push(row);
        return row;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const row = state.configs.find((config) => config.id === where.id);
        if (!row) throw new Error("record not found");
        removeConfig(row.id);
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; spaceId: string };
        data: Partial<ConfigRow>;
      }) => {
        const rows = state.configs.filter(
          (row) => row.id === where.id && row.spaceId === where.spaceId,
        );
        for (const row of rows) {
          Object.assign(row, data, { updatedAt: new Date("2026-09-20T00:00:00.000Z") });
        }
        return { count: rows.length };
      },
    },
    secret: {
      create: async ({ data }: { data: SecretRow }) => {
        state.secrets.push({ ...data });
        return data;
      },
      deleteMany: async ({ where }: { where: { id: string } }) => {
        const removed = state.secrets.filter((row) => row.id === where.id);
        state.secrets = state.secrets.filter((row) => row.id !== where.id);
        for (const config of state.configs.filter((row) => row.secretId === where.id)) {
          removeConfig(config.id);
        }
        return { count: removed.length };
      },
      count: async ({ where }: { where: { ciphertext: string } }) =>
        state.secrets.filter((row) => row.ciphertext === where.ciphertext).length,
    },
    botSecret: { count: async () => 0 },
    integrationProviderConfig: { count: async () => 0 },
  };
  const commitFailures: unknown[] = [];
  const transaction = vi.fn(
    async (callback: (tx: typeof client) => Promise<unknown>, _options?: unknown) => {
      const snapshot = structuredClone(state);
      try {
        const result = await callback(client);
        const failure = commitFailures.shift();
        if (failure) throw failure;
        return result;
      } catch (error) {
        Object.assign(state, snapshot);
        throw error;
      }
    },
  );
  const secrets = fakeSecretStore();
  const deps = {
    prisma: { ...client, $transaction: transaction } as unknown as PrismaClient,
    secrets,
  };
  return { deps, state, secrets, transaction, commitFailures };
}

function connectionInput(mode: "cloud" | "local", baseUrl?: string) {
  return {
    provider: "supermemory",
    settings: { mode, ...(baseUrl ? { baseUrl } : {}) },
    credentials: { apiKey: "sm_test_key_12345" },
    defaultMemoryScope: "isolated" as const,
    expectedConfigId: null,
  };
}

function hindsightInput(expectedConfigId: string | null) {
  return {
    provider: "hindsight",
    settings: {},
    credentials: { apiKey: "hsk_test_fixture" },
    defaultMemoryScope: "shared" as const,
    expectedConfigId,
  };
}

const hindsightSettings = { baseUrl: "https://api.hindsight.vectorize.io" };

function preparedHindsight(): PrepareConnection {
  return vi.fn<PrepareConnection>(async () => ({
    provider: "hindsight",
    settings: hindsightSettings,
    credentials: { apiKey: "hsk_test_fixture" },
  }));
}

const passthroughClassify = async (_provider: string, settings: Record<string, string>) => settings;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("persistMemoryProviderConfig", () => {
  it("rejects unknown providers as bad requests without probing or writing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { deps, transaction } = makeDeps();
    await expect(
      persistMemoryProviderConfig(deps, actor, {
        ...connectionInput("cloud"),
        provider: "unknown-provider",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each(["#", "?action=delete", "?"])(
    "rejects ambiguous local URLs even for the deployment owner: %s",
    async (suffix) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const { deps, transaction } = makeDeps();
      await expect(
        persistMemoryProviderConfig(
          deps,
          deploymentOwner,
          connectionInput("local", `http://127.0.0.1:8123/internal-action${suffix}`),
        ),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    "http://127.0.0.1:8123/internal-action#",
    "http://localhost:6767",
    "http://10.0.0.8:6767",
    "http://supermemory:6767",
  ])("rejects ordinary Space owners before any local probe or write: %s", async (baseUrl) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]"));
    vi.stubGlobal("fetch", fetchMock);
    const { deps, transaction } = makeDeps();
    await expect(
      persistMemoryProviderConfig(deps, actor, connectionInput("local", baseUrl)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deps.secrets.put).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("still requires Space ownership for a deployment owner", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { deps, transaction } = makeDeps({ memberRole: "member" });
    await expect(
      persistMemoryProviderConfig(
        deps,
        deploymentOwner,
        connectionInput("local", "http://localhost:6767"),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects non-owners before probing or writing Space configuration", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { deps, state } = makeDeps({ memberRole: null });
    await expect(
      persistMemoryProviderConfig(deps, actor, connectionInput("cloud")),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.configs).toEqual([]);
  });

  it("rejects local mode without a baseUrl, without touching the database", async () => {
    const { deps, transaction } = makeDeps();
    await expect(
      persistMemoryProviderConfig(deps, deploymentOwner, connectionInput("local")),
    ).rejects.toThrow(/baseUrl/);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects a metadata baseUrl in local mode without probing or touching the database", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { deps, transaction } = makeDeps();
    await expect(
      persistMemoryProviderConfig(
        deps,
        deploymentOwner,
        connectionInput("local", "http://169.254.169.254/latest/meta-data/"),
      ),
    ).rejects.toThrow(/blocked address/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects a public HTTP base URL in local mode without probing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { deps, transaction } = makeDeps();
    await expect(
      persistMemoryProviderConfig(
        deps,
        deploymentOwner,
        connectionInput("local", "http://203.0.113.10:6767"),
      ),
    ).rejects.toThrow(/private-network/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("accepts a private-network base URL in local mode for the deployment owner", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { deps, state } = makeDeps();

    await persistMemoryProviderConfig(
      deps,
      deploymentOwner,
      connectionInput("local", "http://10.0.0.8:6767"),
    );

    expect(fetchMock.mock.calls[0]![0]).toBe("http://10.0.0.8:6767/v3/container-tags/list");
    expect(state.configs).toEqual([
      expect.objectContaining({ settings: { mode: "local", baseUrl: "http://10.0.0.8:6767" } }),
    ]);
  });

  it("probes before persisting, and rejects (without writing) when the probe fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    const { deps, state } = makeDeps();
    await expect(
      persistMemoryProviderConfig(deps, deploymentOwner, {
        ...connectionInput("local", "http://localhost:6767"),
        credentials: { apiKey: "sm_bad_key" },
      }),
    ).rejects.toThrow();
    expect(deps.secrets.put).not.toHaveBeenCalled();
    expect(state.configs).toEqual([]);
    expect(state.secrets).toEqual([]);
  });

  it("accepts a bracketed IPv6 loopback base URL in local mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { deps, state } = makeDeps();

    await persistMemoryProviderConfig(
      deps,
      deploymentOwner,
      connectionInput("local", "http://[::1]:6767"),
    );

    expect(fetchMock.mock.calls[0]![0]).toBe("http://[::1]:6767/v3/container-tags/list");
    expect(state.configs).toHaveLength(1);
  });

  it("checks current ownership before the legacy probe sends any request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { deps, state } = makeDeps({ existing: { provider: "supermemory" } });
    const before = structuredClone(state);
    const members = deps.prisma.spaceMember as unknown as {
      findUnique: (args: { where: { spaceId_userId: { userId: string } } }) => Promise<unknown>;
    };
    const findOwner = members.findUnique;
    let ownerChecks = 0;
    members.findUnique = async (args) => {
      ownerChecks += 1;
      if (ownerChecks > 1) state.roles = {};
      return findOwner(args);
    };
    await expect(
      persistMemoryProviderConfig(deps, actor, {
        ...connectionInput("cloud"),
        expectedConfigId: "cfg-old",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deps.secrets.put).not.toHaveBeenCalled();
    expect({ ...state, roles: before.roles }).toEqual(before);
  });

  it("aborts the legacy probe with the request signal", async () => {
    const controller = new AbortController();
    let probeAborted: boolean | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        controller.abort();
        probeAborted = init?.signal?.aborted;
        return new Response("[]", { status: 200 });
      }),
    );
    const { deps } = makeDeps();
    await persistMemoryProviderConfig(
      deps,
      actor,
      connectionInput("cloud"),
      controller.signal,
    ).catch(() => undefined);
    expect(probeAborted).toBe(true);
  });

  it("connects cloud mode, defaulting the base URL, and returns the serialized config", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { status: 200 })));
    const { deps, state } = makeDeps();
    const result = await persistMemoryProviderConfig(deps, actor, connectionInput("cloud"));
    expect(result).toEqual({
      id: state.configs[0]!.id,
      provider: "supermemory",
      settings: { mode: "cloud", baseUrl: "https://api.supermemory.ai" },
      defaultMemoryScope: "isolated",
      capabilities: { banks: false, sharedScope: true },
      updatedAt: state.configs[0]!.updatedAt.toISOString(),
    });
    expect(state.secrets).toEqual([
      expect.objectContaining({ id: "secret-new-1", ciphertext: "cipher-new-1" }),
    ]);
    expect(deps.secrets.delete).not.toHaveBeenCalled();
  });

  it("returns CONFLICT before probing when the loaded connection is stale", async () => {
    const prepareConnection = preparedHindsight();
    for (const [existing, expectedConfigId] of [
      [{ provider: "supermemory" }, null],
      [{ provider: "supermemory" }, "cfg-elsewhere"],
      [null, "cfg-old"],
    ] as const) {
      const { deps, state, transaction } = makeDeps({ existing });
      const before = structuredClone(state);
      await expect(
        persistMemoryProviderConfig(
          { ...deps, prepareConnection, classifySettings: passthroughClassify },
          actor,
          hindsightInput(expectedConfigId),
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(transaction).not.toHaveBeenCalled();
      expect(deps.secrets.put).not.toHaveBeenCalled();
      expect(state).toEqual(before);
    }
    expect(prepareConnection).not.toHaveBeenCalled();
  });

  it("replaces a connection with a fresh identity and secret, dropping old bindings", async () => {
    const { deps, state } = makeDeps({ existing: { provider: "supermemory" } });
    const result = await persistMemoryProviderConfig(
      { ...deps, prepareConnection: preparedHindsight(), classifySettings: passthroughClassify },
      actor,
      hindsightInput("cfg-old"),
    );
    expect(result.id).not.toBe("cfg-old");
    expect(result).toMatchObject({
      provider: "hindsight",
      settings: hindsightSettings,
      defaultMemoryScope: "isolated",
      capabilities: { banks: true, sharedScope: false },
    });
    expect(state.configs).toEqual([
      expect.objectContaining({ id: result.id, secretId: "secret-new-1" }),
    ]);
    expect(state.secrets.map((row) => row.id)).toEqual(["secret-new-1"]);
    expect(state.bindings).toEqual([]);
    expect(deps.secrets.delete).not.toHaveBeenCalled();
  });

  it("passes the request signal and a live ownership check to the probe", async () => {
    const controller = new AbortController();
    const prepareConnection = vi.fn<PrepareConnection>(async (_input, options) => {
      expect(options?.signal).toBe(controller.signal);
      await options?.beforeRequest?.();
      return {
        provider: "hindsight",
        settings: hindsightSettings,
        credentials: { apiKey: "hsk_test_fixture" },
      };
    });
    const { deps, state } = makeDeps();
    await persistMemoryProviderConfig(
      { ...deps, prepareConnection, classifySettings: passthroughClassify },
      actor,
      hindsightInput(null),
      controller.signal,
    );
    expect(prepareConnection).toHaveBeenCalledOnce();
    expect(state.configs).toHaveLength(1);
  });

  it("stops the probe when ownership is revoked mid-connect, keeping the previous connection", async () => {
    const { deps, state } = makeDeps({ existing: { provider: "supermemory" } });
    const before = structuredClone(state);
    const sent = vi.fn();
    const prepareConnection = vi.fn<PrepareConnection>(async (_input, options) => {
      state.roles = {};
      await options?.beforeRequest?.();
      sent();
      throw new Error("unreachable");
    });
    await expect(
      persistMemoryProviderConfig(
        { ...deps, prepareConnection, classifySettings: passthroughClassify },
        actor,
        hindsightInput("cfg-old"),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(sent).not.toHaveBeenCalled();
    expect(deps.secrets.put).not.toHaveBeenCalled();
    expect({ ...state, roles: before.roles }).toEqual(before);
  });

  it("maps provider connection failures to a safe reason without writing", async () => {
    const { deps, state } = makeDeps({ existing: { provider: "supermemory" } });
    const before = structuredClone(state);
    const prepareConnection = vi.fn<PrepareConnection>(async () => {
      throw new MemoryProviderConnectionError("bank_id_required");
    });
    const error = await persistMemoryProviderConfig(
      { ...deps, prepareConnection, classifySettings: passthroughClassify },
      actor,
      hindsightInput("cfg-old"),
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "BAD_REQUEST",
      message: MEMORY_FAILURE_MESSAGES.bank_id_required,
      data: { reason: "bank_id_required" },
    });
    expect(deps.secrets.put).not.toHaveBeenCalled();
    expect(state).toEqual(before);
  });

  it("keeps the prepared secret across a retried serializable commit", async () => {
    const { deps, state, transaction, commitFailures } = makeDeps({
      existing: { provider: "supermemory" },
    });
    commitFailures.push(Object.assign(new Error("serialization failure"), { code: "P2034" }));
    const result = await persistMemoryProviderConfig(
      { ...deps, prepareConnection: preparedHindsight(), classifySettings: passthroughClassify },
      actor,
      hindsightInput("cfg-old"),
    );
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(deps.secrets.put).toHaveBeenCalledOnce();
    expect(deps.secrets.delete).not.toHaveBeenCalled();
    expect(state.configs).toEqual([
      expect.objectContaining({ id: result.id, secretId: "secret-new-1" }),
    ]);
    expect(state.secrets.map((row) => row.ciphertext)).toEqual(["cipher-new-1"]);
  });

  it("rolls back and removes only the unused prepared secret when a competing replacement wins", async () => {
    const { deps, state } = makeDeps({ existing: { provider: "supermemory" } });
    const prepareConnection = vi.fn<PrepareConnection>(async () => {
      state.configs[0]!.id = "cfg-competitor";
      state.bindings[0]!.spaceMemoryConfigId = "cfg-competitor";
      return {
        provider: "hindsight",
        settings: hindsightSettings,
        credentials: { apiKey: "hsk_test_fixture" },
      };
    });
    await expect(
      persistMemoryProviderConfig(
        { ...deps, prepareConnection, classifySettings: passthroughClassify },
        actor,
        hindsightInput("cfg-old"),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(state.configs.map((row) => row.id)).toEqual(["cfg-competitor"]);
    expect(state.secrets.map((row) => row.id)).toEqual(["secret-old"]);
    expect(state.bindings).toEqual([
      expect.objectContaining({ id: "binding-old", spaceMemoryConfigId: "cfg-competitor" }),
    ]);
    expect(deps.secrets.delete).toHaveBeenCalledOnce();
    expect(deps.secrets.delete).toHaveBeenCalledWith("cipher-new-1", "secret-new-1");
  });

  it("rejects non-deployment-owners for public-looking Serenity hostnames that resolve private, without probing", async () => {
    const prepareConnection = vi.fn<PrepareConnection>();
    const { deps, transaction } = makeDeps();
    await expect(
      persistMemoryProviderConfig(
        {
          ...deps,
          classifySettings: async () => ({
            endpoint: "https://serenity.example.test/mcp",
            endpointTrust: "private",
          }),
          prepareConnection,
        },
        actor,
        {
          provider: "serenity",
          settings: { endpoint: "https://serenity.example.test/mcp", allowWrites: "false" },
          credentials: { token: "serenity_test_token" },
          defaultMemoryScope: "isolated",
          expectedConfigId: null,
        },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(prepareConnection).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects non-owners when prepare reclassifies a hostname as private before probing", async () => {
    const prepareConnection = vi.fn<PrepareConnection>(async () => {
      throw new MemoryProviderDeploymentOwnerRequiredError();
    });
    const { deps, transaction } = makeDeps();
    await expect(
      persistMemoryProviderConfig(
        {
          ...deps,
          classifySettings: async () => ({
            endpoint: "https://serenity.example.test/mcp",
          }),
          prepareConnection,
        },
        actor,
        {
          provider: "serenity",
          settings: { endpoint: "https://serenity.example.test/mcp", allowWrites: "false" },
          credentials: { token: "serenity_test_token" },
          defaultMemoryScope: "isolated",
          expectedConfigId: null,
        },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(prepareConnection).toHaveBeenCalledWith(
      expect.objectContaining({ allowPrivateEndpoint: false }),
      expect.anything(),
    );
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("disconnectMemoryProvider", () => {
  it("rejects non-owners before opening a transaction", async () => {
    const { deps, transaction, state } = makeDeps({
      existing: { provider: "supermemory" },
      memberRole: "member",
    });
    await expect(
      disconnectMemoryProvider(deps, actor, { configId: "cfg-old" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(transaction).not.toHaveBeenCalled();
    expect(state.configs).toHaveLength(1);
  });

  it("removes the connection, its secret and its bindings, and repeats safely", async () => {
    const { deps, state } = makeDeps({ existing: { provider: "hindsight" } });
    await expect(disconnectMemoryProvider(deps, actor, { configId: "cfg-old" })).resolves.toEqual({
      ok: true,
    });
    expect(state.configs).toEqual([]);
    expect(state.secrets).toEqual([]);
    expect(state.bindings).toEqual([]);
    await expect(disconnectMemoryProvider(deps, actor, { configId: "cfg-old" })).resolves.toEqual({
      ok: true,
    });
  });

  it("refuses to remove a different current connection", async () => {
    const { deps, state } = makeDeps({ existing: { provider: "hindsight" } });
    const before = structuredClone(state);
    await expect(
      disconnectMemoryProvider(deps, actor, { configId: "cfg-stale" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(state).toEqual(before);
  });
});

describe("updateMemoryProviderDefaultScope", () => {
  it("accepts owners with additional Better Auth roles", async () => {
    const { deps, state } = makeDeps({
      existing: { provider: "supermemory" },
      memberRole: "owner,admin",
    });
    await updateMemoryProviderDefaultScope(deps, actor, {
      configId: "cfg-old",
      defaultMemoryScope: "shared",
    });
    expect(state.configs[0]!.defaultMemoryScope).toBe("shared");
  });

  it("updates only the generic scope setting and retains the connection identity and secret", async () => {
    const { deps, state } = makeDeps({ existing: { provider: "supermemory" } });
    const result = await updateMemoryProviderDefaultScope(deps, actor, {
      configId: "cfg-old",
      defaultMemoryScope: "shared",
    });
    expect(result).toMatchObject({ id: "cfg-old", defaultMemoryScope: "shared" });
    expect(state.configs).toEqual([
      expect.objectContaining({ id: "cfg-old", secretId: "secret-old" }),
    ]);
    expect(state.secrets.map((row) => row.id)).toEqual(["secret-old"]);
    expect(deps.secrets.put).not.toHaveBeenCalled();
  });

  it("rejects non-owners without updating provider configuration", async () => {
    const { deps, state } = makeDeps({
      existing: { provider: "supermemory" },
      memberRole: null,
    });
    await expect(
      updateMemoryProviderDefaultScope(deps, actor, {
        configId: "cfg-old",
        defaultMemoryScope: "shared",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.configs[0]!.defaultMemoryScope).toBe("isolated");
  });

  it("rejects a stale connection identity", async () => {
    const { deps, state } = makeDeps({ existing: { provider: "supermemory" } });
    await expect(
      updateMemoryProviderDefaultScope(deps, actor, {
        configId: "cfg-stale",
        defaultMemoryScope: "shared",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(state.configs[0]!.defaultMemoryScope).toBe("isolated");
  });

  it("rejects a scope change for a connection without shared scope", async () => {
    const { deps, state } = makeDeps({ existing: { provider: "hindsight" } });
    await expect(
      updateMemoryProviderDefaultScope(deps, actor, {
        configId: "cfg-old",
        defaultMemoryScope: "shared",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(state.configs[0]!.defaultMemoryScope).toBe("isolated");
  });
});
