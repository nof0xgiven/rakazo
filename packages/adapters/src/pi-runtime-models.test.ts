import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { ThinkingLevel } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { modelAcceptsImageInput } from "./model-vision.js";
import { listPiCatalog } from "./pi-models.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./pi-openai-compatible-provider.js";
import { modelsForRequest, resolveRuntimeModel } from "./pi-runtime.js";

function requestModel(id: string, baseUrl: string): Pick<AgentRunRequest, "model"> {
  return { model: { provider: OPENAI_COMPATIBLE_PROVIDER_ID, id, baseUrl } };
}

describe("request model catalogs", () => {
  it.each([
    ["openrouter", "openai/gpt-5.6-luna"],
    ["openai-codex", "gpt-6-astra"],
    ["openai-codex", "gpt-6-luna"],
    ["openai-codex", "gpt-6-sol"],
    ["anthropic", "claude-fable-5-1"],
    ["anthropic", "claude-opus-5-5"],
  ])("offers and resolves %s/%s with vision", (provider, id) => {
    const entry = listPiCatalog().find((model) => model.provider === provider && model.id === id);
    expect(entry).toBeDefined();
    const model = modelsForRequest({ model: { provider, id } }, provider).getModel(provider, id);
    expect(model).toBeDefined();
    expect(model?.input).toContain("image");
    expect(modelAcceptsImageInput(provider, id)).toBe(true);
    expect(entry?.thinkingLevels).toEqual(getSupportedThinkingLevels(model!));
    if (provider === "openai-codex") {
      expect(entry?.signIn).toBe("device-code");
      expect(entry?.thinkingLevels).toContain("max");
    }
    if (provider === "anthropic") {
      expect(entry?.signIn).toBe("auth-url");
      expect(entry?.thinkingLevels).toContain("max");
    }
  });

  it("isolates concurrent OpenAI-compatible endpoint registrations", () => {
    const first = modelsForRequest(
      requestModel("first-model", "http://127.0.0.1:8001/v1"),
      OPENAI_COMPATIBLE_PROVIDER_ID,
    );
    const second = modelsForRequest(
      requestModel("second-model", "http://127.0.0.1:8002/v1"),
      OPENAI_COMPATIBLE_PROVIDER_ID,
    );

    expect(first).not.toBe(second);
    expect(first.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "first-model")?.baseUrl).toBe(
      "http://127.0.0.1:8001/v1",
    );
    expect(first.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "second-model")).toBeUndefined();
    expect(second.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "second-model")?.baseUrl).toBe(
      "http://127.0.0.1:8002/v1",
    );
  });

  it("applies a connected model's image capability to the runtime model", () => {
    const models = modelsForRequest(
      {
        model: {
          provider: OPENAI_COMPATIBLE_PROVIDER_ID,
          id: "vision-model",
          baseUrl: "http://127.0.0.1:8000/v1",
          acceptsImages: true,
        },
      },
      OPENAI_COMPATIBLE_PROVIDER_ID,
    );

    expect(models.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "vision-model")?.input).toContain(
      "image",
    );
  });
});

it.each<{ thinkingLevels: ThinkingLevel[] }>([
  { thinkingLevels: ["off"] },
  { thinkingLevels: ["low", "medium"] },
  { thinkingLevels: ["off", "low", "high", "xhigh"] },
  { thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
])(
  "runs a saved model with exactly its configured levels $thinkingLevels",
  ({ thinkingLevels }) => {
    const model = modelsForRequest(
      {
        model: {
          provider: OPENAI_COMPATIBLE_PROVIDER_ID,
          id: "same-model",
          baseUrl: "http://localhost:8000/v1",
          thinkingLevels,
          acceptsImages: false,
          contextWindow: 32_000,
          maxTokens: 4_000,
        },
      },
      OPENAI_COMPATIBLE_PROVIDER_ID,
    ).getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "same-model")!;
    expect(model.reasoning).toBe(thinkingLevels.some((level) => level !== "off"));
    expect(getSupportedThinkingLevels(model)).toEqual(thinkingLevels);
    expect(Object.keys(model.thinkingLevelMap ?? {})).toHaveLength(7);
    expect(model.api).toBe("openai-completions");
    expect(model.baseUrl).toBe("http://localhost:8000/v1");
    expect({ contextWindow: model.contextWindow, maxTokens: model.maxTokens }).toEqual({
      contextWindow: 32_000,
      maxTokens: 4_000,
    });
  },
);

describe("resolveRuntimeModel", () => {
  it("does not treat a stringified null as a catalog model", () => {
    const resolved = resolveRuntimeModel({ provider: "anthropic", id: "null" });
    expect(resolved.modelId).toBe("");
    expect(resolved.model).toBeUndefined();
    expect(resolved.provider).toBe("anthropic");
  });
});
