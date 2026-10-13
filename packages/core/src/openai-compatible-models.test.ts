import type {
  ModelConfigurationUsage,
  ModelCredential,
  OpenAiCompatibleModelCapabilities,
  OpenAiCompatibleModelConfig,
} from "@rakazo/contracts";
import { ModelConnectInputSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  addOpenAiCompatibleModel,
  applyDetectedOpenAiCompatibleSettings,
  applyOpenAiCompatibleModelSetup,
  cancelOpenAiCompatibleModelSetup,
  createOpenAiCompatibleModelDraft,
  filterOpenAiCompatibleModelRows,
  groupModelConfigurationUsages,
  isSavedOpenAiCompatibleEndpoint,
  mergeDiscoveredOpenAiCompatibleModels,
  modelConfigurationConflict,
  openAiCompatibleApiKeyInput,
  openAiCompatibleConnectInput,
  openAiCompatibleDraftBlockers,
  openAiCompatibleDraftConfigs,
  openAiCompatibleSetupIssues,
  PENDING_OPENAI_COMPATIBLE_MODEL_SETUP,
  reloadOpenAiCompatibleModelDraft,
  restoreBlockedOpenAiCompatibleModels,
  sameOpenAiCompatibleEndpoint,
  setOpenAiCompatibleEndpoint,
  toggleOpenAiCompatibleModel,
  updateOpenAiCompatibleModelSetup,
} from "./openai-compatible-models.js";

const capabilities: OpenAiCompatibleModelCapabilities = {
  thinkingLevels: ["off", "low", "high"],
  defaultThinkingLevel: null,
  contextWindow: 128_000,
  maxTokens: 4096,
  supportsImages: true,
};

function config(modelId: string, overrides: Partial<OpenAiCompatibleModelConfig> = {}) {
  return { modelId, ...capabilities, ...overrides };
}

function credential(overrides: Partial<ModelCredential> = {}): ModelCredential {
  return {
    id: "cred-1",
    provider: "openai-compatible",
    label: "Local",
    hasKey: true,
    isDefault: true,
    baseUrl: "http://127.0.0.1:8080/v1",
    enabledModelIds: ["model-a", "model-b"],
    models: [config("model-a"), config("model-b", { thinkingLevels: ["low", "medium"] })],
    configurationVersion: 3,
    ...overrides,
  };
}

function usage(modelId: string, spaceId = "space-1"): ModelConfigurationUsage {
  return {
    kind: "bot",
    spaceId,
    spaceName: spaceId === "space-1" ? "Home" : "Work",
    id: `bot-${modelId}`,
    name: `Bot ${modelId}`,
    modelId,
    thinkingLevel: null,
  };
}

describe("OpenAI-compatible model draft", () => {
  it("starts from persisted rows with saved configurations checked", () => {
    const draft = createOpenAiCompatibleModelDraft(credential());
    expect(draft.rows.map((row) => [row.modelId, row.checked, row.persisted])).toEqual([
      ["model-a", true, true],
      ["model-b", true, true],
    ]);
    expect(openAiCompatibleDraftConfigs(draft).map((model) => model.modelId)).toEqual([
      "model-a",
      "model-b",
    ]);
  });

  it("treats an enabled id without readable configuration as pending setup", () => {
    const draft = createOpenAiCompatibleModelDraft(credential({ models: [] }));
    expect(openAiCompatibleDraftBlockers(draft, { requireDefault: false })).toEqual([
      { kind: "setup_pending", modelIds: ["model-a", "model-b"] },
    ]);
  });

  it("unions discovery by exact id without changing checks or configurations", () => {
    const draft = mergeDiscoveredOpenAiCompatibleModels(
      createOpenAiCompatibleModelDraft(credential()),
      [
        { modelId: "model-a", capabilities: { ...capabilities, contextWindow: 9_999 } },
        { modelId: "Model-A", capabilities: null },
        { modelId: "model-c", capabilities },
      ],
    );
    expect(draft.rows.map((row) => [row.modelId, row.checked])).toEqual([
      ["model-a", true],
      ["model-b", true],
      ["Model-A", false],
      ["model-c", false],
    ]);
    expect(draft.rows[0]?.config?.contextWindow).toBe(128_000);
    expect(draft.rows[0]?.suggestion?.contextWindow).toBe(9_999);
  });

  it("accepts a known model's suggestion snapshot when checked", () => {
    let draft = mergeDiscoveredOpenAiCompatibleModels(createOpenAiCompatibleModelDraft(), [
      { modelId: "known", capabilities },
    ]);
    draft = toggleOpenAiCompatibleModel(draft, "known", true);
    expect(openAiCompatibleDraftConfigs(draft)).toEqual([config("known")]);
    expect(draft.defaultModelId).toBe("known");
    expect(openAiCompatibleDraftBlockers(draft, { requireDefault: true })).toEqual([]);
  });

  it("requires Apply for an unknown model and Cancel restores it unchecked", () => {
    let draft = mergeDiscoveredOpenAiCompatibleModels(createOpenAiCompatibleModelDraft(), [
      { modelId: "unknown", capabilities: null },
    ]);
    draft = toggleOpenAiCompatibleModel(draft, "unknown", true);
    expect(draft.rows[0]?.setup).toEqual(PENDING_OPENAI_COMPATIBLE_MODEL_SETUP);
    expect(openAiCompatibleDraftConfigs(draft)).toEqual([]);
    expect(openAiCompatibleDraftBlockers(draft, { requireDefault: true })).toEqual([
      { kind: "setup_pending", modelIds: ["unknown"] },
      { kind: "missing_default" },
    ]);
    const cancelled = cancelOpenAiCompatibleModelSetup(draft, "unknown");
    expect(cancelled.rows[0]?.checked).toBe(false);
    const applied = applyOpenAiCompatibleModelSetup(draft, "unknown");
    expect(openAiCompatibleDraftConfigs(applied)).toEqual([
      {
        modelId: "unknown",
        thinkingLevels: ["off"],
        defaultThinkingLevel: null,
        contextWindow: 32_768,
        maxTokens: 4096,
        supportsImages: false,
      },
    ]);
    expect(applied.defaultModelId).toBe("unknown");
  });

  it("requires a non-off level when thinking is on and drops a default it no longer supports", () => {
    let draft = addOpenAiCompatibleModel(createOpenAiCompatibleModelDraft(), {
      modelId: "manual",
      capabilities: null,
    });
    draft = updateOpenAiCompatibleModelSetup(draft, "manual", {
      thinking: true,
      thinkingLevels: ["off"],
    });
    expect(openAiCompatibleSetupIssues(draft.rows[0]!.setup!)).toEqual(["thinking_levels"]);
    expect(applyOpenAiCompatibleModelSetup(draft, "manual")).toBe(draft);
    draft = updateOpenAiCompatibleModelSetup(draft, "manual", {
      thinkingLevels: ["high", "off", "low"],
      defaultThinkingLevel: "high",
    });
    draft = updateOpenAiCompatibleModelSetup(draft, "manual", { thinkingLevels: ["off", "low"] });
    expect(draft.rows[0]?.setup?.defaultThinkingLevel).toBeNull();
    draft = applyOpenAiCompatibleModelSetup(draft, "manual");
    expect(draft.rows[0]?.config?.thinkingLevels).toEqual(["off", "low"]);
  });

  it("reports invalid limits separately and never applies them", () => {
    let draft = addOpenAiCompatibleModel(createOpenAiCompatibleModelDraft(), {
      modelId: "manual",
      capabilities: null,
    });
    draft = updateOpenAiCompatibleModelSetup(draft, "manual", {
      contextWindow: "4096",
      maxTokens: "4096",
    });
    expect(openAiCompatibleDraftBlockers(draft, { requireDefault: false })).toEqual([
      { kind: "invalid_limits", modelIds: ["manual"] },
    ]);
    draft = updateOpenAiCompatibleModelSetup(draft, "manual", {
      supportsImages: true,
      maxImagesPerPrompt: "0",
      maxTokens: "100",
    });
    expect(openAiCompatibleSetupIssues(draft.rows[0]!.setup!)).toEqual(["max_images"]);
  });

  it("keeps saved configuration authoritative until Use detected settings", () => {
    let draft = mergeDiscoveredOpenAiCompatibleModels(
      createOpenAiCompatibleModelDraft(credential()),
      [{ modelId: "model-b", capabilities }],
    );
    draft = toggleOpenAiCompatibleModel(draft, "model-b", false);
    draft = toggleOpenAiCompatibleModel(draft, "model-b", true);
    expect(draft.rows[1]?.config?.thinkingLevels).toEqual(["low", "medium"]);
    draft = applyDetectedOpenAiCompatibleSettings(draft, "model-b");
    expect(draft.rows[1]?.config).toEqual(config("model-b"));
  });

  it("restores only blocked saved rows and keeps other edits", () => {
    let draft = mergeDiscoveredOpenAiCompatibleModels(
      createOpenAiCompatibleModelDraft(credential()),
      [{ modelId: "model-c", capabilities }],
    );
    draft = toggleOpenAiCompatibleModel(draft, "model-a", false);
    draft = toggleOpenAiCompatibleModel(draft, "model-b", false);
    draft = toggleOpenAiCompatibleModel(draft, "model-c", true);
    draft = restoreBlockedOpenAiCompatibleModels(draft, [usage("model-b"), usage("model-c")]);
    expect(draft.rows.map((row) => [row.modelId, row.checked])).toEqual([
      ["model-a", false],
      ["model-b", true],
      ["model-c", true],
    ]);
    expect(draft.rows[1]?.config?.thinkingLevels).toEqual(["low", "medium"]);
  });

  it("filters by search without changing checks", () => {
    const draft = mergeDiscoveredOpenAiCompatibleModels(
      createOpenAiCompatibleModelDraft(credential()),
      [{ modelId: "other", capabilities: null }],
    );
    expect(
      filterOpenAiCompatibleModelRows(draft.rows, " MODEL-B ").map((row) => row.modelId),
    ).toEqual(["model-b"]);
    expect(filterOpenAiCompatibleModelRows(draft.rows, " ")).toBe(draft.rows);
  });

  it("clears endpoint-derived rows on endpoint change and restores them on return", () => {
    const draft = createOpenAiCompatibleModelDraft(credential());
    const moved = setOpenAiCompatibleEndpoint(draft, "https://other.example.test");
    expect(moved.rows).toEqual([]);
    expect(isSavedOpenAiCompatibleEndpoint(moved)).toBe(false);
    const back = setOpenAiCompatibleEndpoint(moved, "HTTP://127.0.0.1:8080/");
    expect(isSavedOpenAiCompatibleEndpoint(back)).toBe(true);
    expect(back.rows.map((row) => row.modelId)).toEqual(["model-a", "model-b"]);
    expect(sameOpenAiCompatibleEndpoint("https://x.test:443/api", "https://x.test/api/v1/")).toBe(
      true,
    );
    expect(sameOpenAiCompatibleEndpoint("https://x.test/v2", "https://x.test/v1")).toBe(false);
  });

  it("reloads persisted state, discarding local rows only on stale reload", () => {
    let draft = mergeDiscoveredOpenAiCompatibleModels(
      createOpenAiCompatibleModelDraft(credential()),
      [{ modelId: "model-c", capabilities }],
    );
    draft = toggleOpenAiCompatibleModel(draft, "model-a", false);
    const latest = credential({
      enabledModelIds: ["model-b"],
      models: [config("model-b")],
      configurationVersion: 4,
    });
    const stale = reloadOpenAiCompatibleModelDraft(draft, latest, { discardLocal: true });
    expect(stale.rows.map((row) => [row.modelId, row.checked, row.suggestion])).toEqual([
      ["model-b", true, null],
    ]);
    expect(stale.connection?.configurationVersion).toBe(4);
    const saved = reloadOpenAiCompatibleModelDraft(draft, latest, { discardLocal: false });
    expect(saved.rows.map((row) => [row.modelId, row.checked, row.persisted])).toEqual([
      ["model-b", true, true],
      ["model-a", false, false],
      ["model-c", false, false],
    ]);
  });

  it("builds edit and create inputs that satisfy the connect contract", () => {
    const edit = openAiCompatibleConnectInput(createOpenAiCompatibleModelDraft(credential()), {
      apiKey: undefined,
    });
    expect(edit).toMatchObject({ credentialId: "cred-1", expectedConfigurationVersion: 3 });
    expect(edit).not.toHaveProperty("apiKey");
    expect(edit).not.toHaveProperty("modelId");
    expect(ModelConnectInputSchema.safeParse(edit).success).toBe(true);
    let draft = setOpenAiCompatibleEndpoint(
      createOpenAiCompatibleModelDraft(),
      "http://127.0.0.1:1234",
    );
    draft = addOpenAiCompatibleModel(draft, { modelId: "known", capabilities });
    const create = openAiCompatibleConnectInput(draft, { apiKey: "" });
    expect(create).toMatchObject({ modelId: "known", apiKey: "" });
    expect(create).not.toHaveProperty("credentialId");
    expect(ModelConnectInputSchema.safeParse(create).success).toBe(true);
  });

  it("sends an empty key only for explicit removal", () => {
    expect(openAiCompatibleApiKeyInput("   ", false)).toBeUndefined();
    expect(openAiCompatibleApiKeyInput(" sk-test ", false)).toBe("sk-test");
    expect(openAiCompatibleApiKeyInput("sk-test", true)).toBe("");
  });
});

describe("model configuration conflicts", () => {
  it("decodes only schema-valid 409 CONFLICT data", () => {
    const data = { reason: "models_in_use", usages: [usage("model-a")] };
    expect(modelConfigurationConflict({ code: "CONFLICT", status: 409, data })).toEqual(data);
    expect(modelConfigurationConflict({ code: "CONFLICT", status: 400, data })).toBeNull();
    expect(modelConfigurationConflict({ code: "BAD_REQUEST", status: 409, data })).toBeNull();
    expect(
      modelConfigurationConflict({
        code: "CONFLICT",
        status: 409,
        data: { reason: "models_in_use", usages: [] },
      }),
    ).toBeNull();
    expect(
      modelConfigurationConflict({
        code: "CONFLICT",
        status: 409,
        data: { reason: "model_configuration_changed" },
      }),
    ).toEqual({ reason: "model_configuration_changed" });
    expect(modelConfigurationConflict(new Error("CONFLICT"))).toBeNull();
  });

  it("groups usages by space in server order", () => {
    const groups = groupModelConfigurationUsages([
      usage("model-a"),
      usage("model-b", "space-2"),
      usage("model-c"),
    ]);
    expect(
      groups.map((group) => [group.spaceName, group.usages.map((item) => item.modelId)]),
    ).toEqual([
      ["Home", ["model-a", "model-c"]],
      ["Work", ["model-b"]],
    ]);
  });
});
