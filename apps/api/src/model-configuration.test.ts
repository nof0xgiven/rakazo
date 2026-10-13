import { RPCHandler } from "@orpc/server/fetch";
import { serializeModelSecret } from "@rakazo/adapters";
import type { Actor, OpenAiCompatibleModelConfig, ThinkingLevel } from "@rakazo/contracts";
import { MODEL_CONFIGURATION_CONFLICT_MESSAGES } from "@rakazo/contracts";
import type { CompatibleModelReference, DefaultFollowerBot, SpacePrimaryEffort } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { compatibleConfigurationConflict, defaultFollowerConflict } from "./model-configuration.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
} satisfies Actor;

const LEGACY_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

function config(
  modelId: string,
  overrides: Partial<OpenAiCompatibleModelConfig> = {},
): OpenAiCompatibleModelConfig {
  return {
    modelId,
    thinkingLevels: ["off", "low", "high"],
    defaultThinkingLevel: null,
    contextWindow: 32768,
    maxTokens: 4096,
    supportsImages: false,
    ...overrides,
  };
}

function reference(
  kind: CompatibleModelReference["kind"],
  id: string,
  modelId: string,
  thinkingLevel: ThinkingLevel | null = null,
): CompatibleModelReference {
  return { kind, spaceId: "space-1", spaceName: "Home", id, name: id, modelId, thinkingLevel };
}

const bound = (credentialId: string | null) => ({ credentialId, preferenceThinkingLevel: null });

describe("compatibleConfigurationConflict", () => {
  const enabled = (models: OpenAiCompatibleModelConfig[]) => ({
    enabledModelIds: models.map((model) => model.modelId),
    configs: new Map(models.map((model) => [model.modelId, model])),
  });
  const base = {
    credentialId: "cred-a",
    followers: [] as DefaultFollowerBot[],
    primaryEfforts: [] as SpacePrimaryEffort[],
    endpointChanged: false,
  };

  it("blocks removing an enabled model that a reference uses and names it", () => {
    const conflict = compatibleConfigurationConflict({
      ...base,
      references: [reference("bot", "Researcher", "model-b"), reference("bot", "Other", "model-b")],
      bindings: [bound("cred-a"), bound("cred-other")],
      before: enabled([config("model-a"), config("model-b")]),
      after: enabled([config("model-a")]),
    });
    expect(conflict).toMatchObject({
      reason: "models_in_use",
      message: MODEL_CONFIGURATION_CONFLICT_MESSAGES.models_in_use,
      usages: [expect.objectContaining({ kind: "bot", id: "Researcher", modelId: "model-b" })],
    });
    expect(conflict?.usages).toHaveLength(1);
  });

  it("accepts canonical adoption of an equal legacy set with a raw unsupported effort", () => {
    const legacy = config("model-a", {
      thinkingLevels: LEGACY_LEVELS,
      defaultThinkingLevel: "high",
    });
    expect(
      compatibleConfigurationConflict({
        ...base,
        references: [reference("bot", "Legacy", "model-a", "xhigh")],
        bindings: [bound("cred-a")],
        before: enabled([legacy]),
        after: enabled([{ ...legacy, defaultThinkingLevel: null }]),
      }),
    ).toBeNull();
  });

  it("blocks dropping the level an in-use effort executed with", () => {
    const legacy = config("model-a", { thinkingLevels: LEGACY_LEVELS });
    expect(
      compatibleConfigurationConflict({
        ...base,
        references: [reference("bot", "Legacy", "model-a", "xhigh")],
        bindings: [bound("cred-a")],
        before: enabled([legacy]),
        after: enabled([config("model-a", { thinkingLevels: ["off", "low", "medium"] })]),
      }),
    ).toMatchObject({
      reason: "model_effort_in_use",
      message: MODEL_CONFIGURATION_CONFLICT_MESSAGES.model_effort_in_use,
      usages: [expect.objectContaining({ id: "Legacy", thinkingLevel: "xhigh" })],
    });
  });

  it("allows reducing levels that no reference executes", () => {
    expect(
      compatibleConfigurationConflict({
        ...base,
        references: [reference("routine", "Nightly", "model-a", "low")],
        bindings: [bound("cred-a")],
        before: enabled([config("model-a")]),
        after: enabled([config("model-a", { thinkingLevels: ["off", "low"] })]),
      }),
    ).toBeNull();
  });

  it("checks explicit efforts of bots following an affected space default", () => {
    const conflict = compatibleConfigurationConflict({
      ...base,
      references: [reference("default", "pref-1", "model-a")],
      bindings: [bound("cred-a")],
      followers: [
        {
          spaceId: "space-1",
          spaceName: "Home",
          id: "bot-1",
          name: "Helper",
          thinkingLevel: "high",
        },
      ],
      before: enabled([config("model-a")]),
      after: enabled([config("model-a", { thinkingLevels: ["off", "low"] })]),
    });
    expect(conflict?.reason).toBe("model_effort_in_use");
    expect(conflict?.usages.map((usage) => [usage.kind, usage.id])).toEqual([
      ["default", "pref-1"],
      ["bot", "bot-1"],
    ]);
  });

  it("treats an endpoint replacement as replacing every enabled model", () => {
    expect(
      compatibleConfigurationConflict({
        ...base,
        endpointChanged: true,
        references: [reference("backup", "model-a", "model-a")],
        bindings: [bound("cred-a")],
        before: enabled([config("model-a")]),
        after: enabled([config("model-a")]),
      }),
    ).toMatchObject({ reason: "model_connection_in_use" });
  });

  it("blocks dropping the level a backup runs with when it inherits a primary's effort", () => {
    const conflict = compatibleConfigurationConflict({
      ...base,
      primaryEfforts: [{ spaceId: "space-1", thinkingLevel: "xhigh" }],
      references: [reference("backup", "model-a", "model-a")],
      bindings: [bound("cred-a")],
      before: enabled([config("model-a", { thinkingLevels: ["off", "low", "medium", "high"] })]),
      after: enabled([config("model-a", { thinkingLevels: ["off", "low", "medium"] })]),
    });
    expect(conflict).toMatchObject({
      reason: "model_effort_in_use",
      usages: [expect.objectContaining({ kind: "backup", id: "model-a" })],
    });
  });

  it("lets a backup's own default decide its effort instead of inherited primaries", () => {
    expect(
      compatibleConfigurationConflict({
        ...base,
        primaryEfforts: [{ spaceId: "space-1", thinkingLevel: "xhigh" }],
        references: [reference("backup", "model-a", "model-a")],
        bindings: [bound("cred-a")],
        before: enabled([
          config("model-a", {
            thinkingLevels: ["off", "low", "medium", "high"],
            defaultThinkingLevel: "low",
          }),
        ]),
        after: enabled([config("model-a", { thinkingLevels: ["off", "low", "medium"] })]),
      }),
    ).toBeNull();
  });

  it("ignores never-enabled legacy references", () => {
    expect(
      compatibleConfigurationConflict({
        ...base,
        references: [reference("run", "run-1", "never-enabled")],
        bindings: [bound("cred-a")],
        before: enabled([config("model-a")]),
        after: enabled([config("model-b")]),
      }),
    ).toBeNull();
  });
});

describe("defaultFollowerConflict", () => {
  it("rejects a default whose model does not support a follower's explicit effort", () => {
    expect(
      defaultFollowerConflict(
        [
          {
            spaceId: "space-1",
            spaceName: "Home",
            id: "bot-1",
            name: "Helper",
            thinkingLevel: "xhigh",
          },
          {
            spaceId: "space-1",
            spaceName: "Home",
            id: "bot-2",
            name: "Fine",
            thinkingLevel: "off",
          },
        ],
        { modelId: "model-a", thinkingLevels: ["off", "low"] },
      ),
    ).toMatchObject({
      reason: "model_effort_in_use",
      message: MODEL_CONFIGURATION_CONFLICT_MESSAGES.model_default_effort_in_use,
      usages: [expect.objectContaining({ kind: "bot", id: "bot-1", modelId: "model-a" })],
    });
  });
});

type MockState = {
  credentials: Array<Record<string, unknown>>;
  preferences: Array<Record<string, unknown>>;
  explicitBots: Array<Record<string, unknown>>;
  followerBots: Array<Record<string, unknown>>;
  secrets: Record<string, string>;
};

const stamp = new Date("2026-01-01T00:00:00.000Z");
const compatibleCredential = {
  id: "cred-a",
  userId: actor.userId,
  provider: "openai-compatible",
  label: "Local",
  secretId: "secret-a",
  supportsImages: false,
  enabledModelIds: ["model-a"],
  modelConfigurationVersion: 2,
  createdAt: stamp,
  updatedAt: stamp,
};

function mockDeps(state: MockState) {
  const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const upsert = vi.fn().mockResolvedValue({ id: "pref" });
  const write = vi.fn().mockResolvedValue(compatibleCredential);
  const withCredential = (preference: Record<string, unknown>) => ({
    ...preference,
    credential: state.credentials.find((credential) => credential.id === preference.credentialId),
  });
  const client = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: actor.userId }]),
    spaceMember: {
      findMany: vi.fn().mockResolvedValue([{ spaceId: actor.spaceId, space: { name: "Home" } }]),
    },
    userModelCredential: {
      findMany: vi.fn(async () => state.credentials),
      findFirst: vi.fn(
        async (args: { where: { id?: string } }) =>
          state.credentials.find(
            (credential) => !args.where.id || credential.id === args.where.id,
          ) ?? null,
      ),
      count: vi.fn().mockResolvedValue(0),
      deleteMany,
      update: write,
      create: write,
    },
    spaceModelPreference: {
      findMany: vi.fn(async (args: { where: { isDefault?: boolean } }) =>
        state.preferences
          .filter((preference) => !args.where.isDefault || preference.isDefault)
          .map(withCredential),
      ),
      findUnique: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      upsert,
      deleteMany,
    },
    bot: {
      findMany: vi.fn(async (args: { where: { modelProvider?: string } }) =>
        args.where.modelProvider ? state.explicitBots : state.followerBots,
      ),
    },
    routine: { findMany: vi.fn().mockResolvedValue([]) },
    spaceBackupModel: { findMany: vi.fn().mockResolvedValue([]), deleteMany },
    run: { findMany: vi.fn().mockResolvedValue([]) },
    steeringMessage: { findMany: vi.fn().mockResolvedValue([]) },
    secret: {
      findFirst: vi.fn(async (args: { where: { id: string } }) =>
        state.secrets[args.where.id]
          ? { id: args.where.id, ciphertext: `cipher-${args.where.id}` }
          : null,
      ),
      count: vi.fn().mockResolvedValue(0),
      deleteMany,
      create: write,
    },
    botSecret: { count: vi.fn().mockResolvedValue(0) },
    integrationProviderConfig: { count: vi.fn().mockResolvedValue(0) },
    userVoiceCredential: { count: vi.fn().mockResolvedValue(0) },
  };
  const prisma = {
    ...client,
    $transaction: vi.fn(async (fn: (tx: typeof client) => unknown) => fn(client)),
  };
  const deps = {
    prisma,
    secrets: {
      load: vi.fn(async (_ciphertext: string, secretId: string) => state.secrets[secretId]),
      put: vi.fn().mockResolvedValue({ id: "secret-new", ciphertext: "cipher-new" }),
    },
    oauthLogins: { cancelProvider: vi.fn() },
    env: {
      agentRuntime: "pi",
      defaultProvider: "fake",
      defaultModel: "fake-model",
      deploymentModelConfigured: true,
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
  } as unknown as RouterDeps;
  const handler = new RPCHandler(createRouter(deps));
  const call = async (path: string, body: unknown) => {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: body }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    if (!response) throw new Error("No response");
    return {
      status: response.status,
      body: (await response.json()) as { json: Record<string, unknown> },
    };
  };
  return { deps, deleteMany, upsert, write, call };
}

const canonicalSecret = (models: OpenAiCompatibleModelConfig[]) =>
  serializeModelSecret({
    kind: "openai_compatible",
    format: "canonical",
    baseUrl: "http://127.0.0.1:8000/v1",
    models,
  });

describe("model configuration RPCs", () => {
  it("rejects a save against a stale configuration version with structured conflict data", async () => {
    const { call, deps } = mockDeps({
      credentials: [compatibleCredential],
      preferences: [],
      explicitBots: [],
      followerBots: [],
      secrets: { "secret-a": canonicalSecret([config("model-a")]) },
    });
    const response = await call("models/connect", {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:8000/v1",
      credentialId: "cred-a",
      expectedConfigurationVersion: 1,
      models: [config("model-a")],
    });
    expect(response.status).toBe(409);
    expect(response.body.json).toMatchObject({
      code: "CONFLICT",
      message: MODEL_CONFIGURATION_CONFLICT_MESSAGES.model_configuration_changed,
      data: { reason: "model_configuration_changed" },
    });
    expect(deps.secrets.put).not.toHaveBeenCalled();
  });

  it("blocks removing an in-use model without writing anything", async () => {
    const { call, write } = mockDeps({
      credentials: [{ ...compatibleCredential, enabledModelIds: ["model-a", "model-b"] }],
      preferences: [],
      explicitBots: [
        {
          id: "bot-1",
          spaceId: actor.spaceId,
          name: "Researcher",
          modelId: "model-b",
          thinkingLevel: null,
        },
      ],
      followerBots: [],
      secrets: { "secret-a": canonicalSecret([config("model-a"), config("model-b")]) },
    });
    const response = await call("models/connect", {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:8000/v1",
      credentialId: "cred-a",
      expectedConfigurationVersion: 2,
      models: [config("model-a")],
    });
    expect(response.status).toBe(409);
    expect(response.body.json).toMatchObject({
      data: {
        reason: "models_in_use",
        usages: [
          {
            kind: "bot",
            spaceId: actor.spaceId,
            spaceName: "Home",
            id: "bot-1",
            name: "Researcher",
            modelId: "model-b",
            thinkingLevel: null,
          },
        ],
      },
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("adopts an equal legacy set canonically without touching preferences", async () => {
    const legacySecret = JSON.stringify({
      kind: "openai_compatible",
      baseUrl: "http://127.0.0.1:8000/v1",
      reasoning: true,
    });
    const { call, write, upsert } = mockDeps({
      credentials: [compatibleCredential],
      preferences: [
        {
          id: "pref-a",
          spaceId: actor.spaceId,
          credentialId: "cred-a",
          modelId: "model-a",
          thinkingLevel: null,
          isDefault: true,
          updatedAt: stamp,
        },
      ],
      explicitBots: [
        {
          id: "bot-1",
          spaceId: actor.spaceId,
          name: "Legacy",
          modelId: "model-a",
          thinkingLevel: "xhigh",
        },
      ],
      followerBots: [],
      secrets: { "secret-a": legacySecret },
    });
    const response = await call("models/connect", {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:8000/v1",
      credentialId: "cred-a",
      expectedConfigurationVersion: 2,
      models: [config("model-a", { thinkingLevels: ["off", "minimal", "low", "medium", "high"] })],
    });
    expect(response.status).toBe(200);
    expect(write).toHaveBeenCalledWith({
      where: { id: "cred-a" },
      data: expect.objectContaining({
        enabledModelIds: ["model-a"],
        modelConfigurationVersion: { increment: 1 },
      }),
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("refuses to disconnect while a bot uses an enabled model", async () => {
    const { call, deleteMany } = mockDeps({
      credentials: [compatibleCredential],
      preferences: [
        {
          id: "pref-a",
          spaceId: actor.spaceId,
          credentialId: "cred-a",
          modelId: "model-a",
          thinkingLevel: null,
          isDefault: true,
          updatedAt: stamp,
        },
      ],
      explicitBots: [
        {
          id: "bot-1",
          spaceId: actor.spaceId,
          name: "Researcher",
          modelId: "model-a",
          thinkingLevel: null,
        },
      ],
      followerBots: [],
      secrets: {},
    });
    const response = await call("models/disconnect", { provider: "openai-compatible" });
    expect(response.status).toBe(409);
    expect(response.body.json).toMatchObject({
      data: {
        reason: "models_in_use",
        usages: [expect.objectContaining({ kind: "bot", id: "bot-1" })],
      },
    });
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("disconnects a connection used only by the space default", async () => {
    const { call, deleteMany } = mockDeps({
      credentials: [compatibleCredential],
      preferences: [
        {
          id: "pref-a",
          spaceId: actor.spaceId,
          credentialId: "cred-a",
          modelId: "model-a",
          thinkingLevel: null,
          isDefault: true,
          updatedAt: stamp,
        },
      ],
      explicitBots: [],
      followerBots: [
        { id: "bot-2", spaceId: actor.spaceId, name: "Follower", thinkingLevel: "high" },
      ],
      secrets: {},
    });
    const response = await call("models/disconnect", { provider: "openai-compatible" });
    expect(response.status).toBe(200);
    expect(deleteMany).toHaveBeenCalled();
  });

  it("blocks a default change that a following bot's explicit effort does not support", async () => {
    const { call, upsert } = mockDeps({
      credentials: [{ ...compatibleCredential, enabledModelIds: ["model-a", "model-b"] }],
      preferences: [
        {
          id: "pref-a",
          spaceId: actor.spaceId,
          credentialId: "cred-a",
          modelId: "model-a",
          thinkingLevel: null,
          isDefault: true,
          updatedAt: stamp,
        },
      ],
      explicitBots: [],
      followerBots: [
        { id: "bot-2", spaceId: actor.spaceId, name: "Follower", thinkingLevel: "high" },
      ],
      secrets: {
        "secret-a": canonicalSecret([
          config("model-a"),
          config("model-b", { thinkingLevels: ["off", "low"] }),
        ]),
      },
    });
    const response = await call("models/setDefault", {
      provider: "openai-compatible",
      modelId: "model-b",
    });
    expect(response.status).toBe(409);
    expect(response.body.json).toMatchObject({
      message: MODEL_CONFIGURATION_CONFLICT_MESSAGES.model_default_effort_in_use,
      data: {
        reason: "model_effort_in_use",
        usages: [
          expect.objectContaining({
            kind: "bot",
            id: "bot-2",
            modelId: "model-b",
            thinkingLevel: "high",
          }),
        ],
      },
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("keeps Off as an explicit default effort for a compatible model", async () => {
    const { call, upsert } = mockDeps({
      credentials: [{ ...compatibleCredential, enabledModelIds: ["model-a", "model-b"] }],
      preferences: [
        {
          id: "pref-a",
          spaceId: actor.spaceId,
          credentialId: "cred-a",
          modelId: "model-a",
          thinkingLevel: null,
          isDefault: true,
          updatedAt: stamp,
        },
      ],
      explicitBots: [],
      followerBots: [],
      secrets: { "secret-a": canonicalSecret([config("model-a"), config("model-b")]) },
    });
    const response = await call("models/setDefault", {
      provider: "openai-compatible",
      modelId: "model-b",
      thinkingLevel: "off",
    });
    expect(response.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { modelId: "model-b", isDefault: true, thinkingLevel: "off" },
      }),
    );
  });

  it("reports setup as needed when the selected compatible default is not enabled", async () => {
    const { deps, call } = mockDeps({
      credentials: [],
      preferences: [],
      explicitBots: [],
      followerBots: [],
      secrets: {},
    });
    Object.assign(deps.prisma, {
      user: {
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValue({ email: actor.email, name: "User", avatarStyle: "robot" }),
      },
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    });
    Object.assign(deps.prisma.spaceModelPreference, {
      findFirst: vi.fn().mockResolvedValue({
        isDefault: true,
        modelId: "removed-model",
        thinkingLevel: null,
        credential: compatibleCredential,
      }),
    });
    const response = await call("me", null);
    expect(response.status).toBe(200);
    expect(response.body.json).toMatchObject({
      needsModel: true,
      defaultProvider: "openai-compatible",
      defaultModel: "removed-model",
    });
  });
});
