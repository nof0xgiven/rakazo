import { OpenAiCompatibleModelCapabilitiesSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  discoverOpenAiCompatibleModels,
  sameOpenAiCompatibleEndpoint,
  suggestOpenAiCompatibleCapabilities,
} from "./openai-compatible-discovery.js";
import { OPENAI_COMPATIBLE_CATALOG_MODEL_ID } from "./pi-openai-compatible-provider.js";

describe("exact-catalog capability suggestions", () => {
  it("accepts an exact id whose native entries all agree", () => {
    const suggestion = suggestOpenAiCompatibleCapabilities("gpt-4o");
    expect(suggestion).toEqual({
      thinkingLevels: ["off"],
      defaultThinkingLevel: null,
      contextWindow: 128000,
      maxTokens: 4096,
      supportsImages: true,
    });
    expect(OpenAiCompatibleModelCapabilitiesSchema.safeParse(suggestion).success).toBe(true);
  });

  it("uses owned_by only when it names a registry provider listing the exact id", () => {
    expect(suggestOpenAiCompatibleCapabilities("claude-sonnet-4-5")).toBeNull();
    expect(suggestOpenAiCompatibleCapabilities("claude-sonnet-4-5", "opencode")).toMatchObject({
      contextWindow: 200000,
    });
    expect(suggestOpenAiCompatibleCapabilities("claude-sonnet-4-5", "anthropic")).toMatchObject({
      contextWindow: 1000000,
    });
    expect(suggestOpenAiCompatibleCapabilities("claude-sonnet-4-5", "someone-else")).toBeNull();
    expect(suggestOpenAiCompatibleCapabilities("o3", "openai")).toMatchObject({
      thinkingLevels: ["low", "medium", "high"],
      defaultThinkingLevel: null,
    });
    expect(suggestOpenAiCompatibleCapabilities("o3")).toBeNull();
  });

  it("never matches by case, prefix, suffix or placeholder", () => {
    for (const modelId of [
      "GPT-4o",
      "vendor/gpt-4o",
      "gpt-4o-2099-01-01",
      "unknown-model",
      "pt-4o",
      OPENAI_COMPATIBLE_CATALOG_MODEL_ID,
    ]) {
      expect(suggestOpenAiCompatibleCapabilities(modelId, "openai")).toBeNull();
    }
  });
});

describe("enriched discovery", () => {
  it("drops the owned_by hint when duplicate ids disagree", async () => {
    let requests = 0;
    const respond = (data: unknown[]) => async () => {
      requests += 1;
      return new Response(JSON.stringify({ data }));
    };
    await expect(
      discoverOpenAiCompatibleModels(
        { baseUrl: "http://127.0.0.1:8000/v1" },
        respond([
          { id: "claude-sonnet-4-5", owned_by: "opencode" },
          { id: "claude-sonnet-4-5", owned_by: "opencode" },
          { id: "local-only" },
        ]),
      ),
    ).resolves.toEqual([
      {
        modelId: "claude-sonnet-4-5",
        capabilities: expect.objectContaining({ contextWindow: 200000 }),
      },
      { modelId: "local-only", capabilities: null },
    ]);
    await expect(
      discoverOpenAiCompatibleModels(
        { baseUrl: "http://127.0.0.1:8000/v1" },
        respond([
          { id: "claude-sonnet-4-5", owned_by: "opencode" },
          { id: "claude-sonnet-4-5", owned_by: "anthropic" },
        ]),
      ),
    ).resolves.toEqual([{ modelId: "claude-sonnet-4-5", capabilities: null }]);
    expect(requests).toBe(2);
  });
});

describe("saved endpoint identity", () => {
  it("compares normalized endpoints exactly", () => {
    expect(sameOpenAiCompatibleEndpoint("http://127.0.0.1:8000", "http://127.0.0.1:8000/v1/")).toBe(
      true,
    );
    expect(
      sameOpenAiCompatibleEndpoint("http://127.0.0.1:8000/v1?x=1", "http://127.0.0.1:8000/v1"),
    ).toBe(true);
    expect(
      sameOpenAiCompatibleEndpoint("http://127.0.0.1:8001/v1", "http://127.0.0.1:8000/v1"),
    ).toBe(false);
    expect(
      sameOpenAiCompatibleEndpoint("http://127.0.0.1:8000/v2", "http://127.0.0.1:8000/v1"),
    ).toBe(false);
    expect(sameOpenAiCompatibleEndpoint("not a url", "http://127.0.0.1:8000/v1")).toBe(false);
  });
});
