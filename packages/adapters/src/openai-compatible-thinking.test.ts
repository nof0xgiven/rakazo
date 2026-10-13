import { getSupportedThinkingLevels, type Model, Type } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ThinkingLevel } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerOpenAiCompatibleRuntime } from "./pi-openai-compatible-provider.js";

const modelId = "arbitrary-model";
const baseUrl = "http://127.0.0.1:8090/v1";
const LEGACY_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type Payload = {
  model: string;
  stream: boolean;
  messages: Array<{ role: string }>;
  tools: Array<{ function: { name: string } }>;
  max_tokens?: number;
  max_completion_tokens?: number;
  chat_template_kwargs?: Record<string, unknown>;
  reasoning_effort?: string;
};

function fixtureResponse(): Response {
  const deltas = [
    { reasoning_content: "Check the fixture." },
    { content: "Ready." },
    {
      tool_calls: [
        {
          index: 0,
          id: "call_test",
          type: "function",
          function: { name: "lookup", arguments: '{"value":' },
        },
      ],
    },
    { tool_calls: [{ index: 0, function: { arguments: "42}" } }] },
  ];
  const chunks = [...deltas, {}].map((delta, index) => ({
    id: "fixture",
    object: "chat.completion.chunk",
    created: 1,
    model: modelId,
    choices: [{ index: 0, delta, finish_reason: index === deltas.length ? "tool_calls" : null }],
  }));
  return new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

describe("OpenAI-compatible standard thinking transport", () => {
  const provider = "openai-compatible";
  async function capture(
    reasoning: ThinkingLevel | undefined,
    runtime: {
      id?: string;
      thinkingLevels?: ThinkingLevel[];
      reasoning?: boolean;
      maxTokens?: number;
    } = { thinkingLevels: LEGACY_LEVELS },
  ) {
    const id = runtime.id ?? modelId;
    let payload: Payload | undefined;
    const mockFetch = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(`${baseUrl}/chat/completions`);
      payload = JSON.parse(String(init?.body)) as Payload;
      return fixtureResponse();
    });
    vi.stubGlobal("fetch", mockFetch);
    const models = registerOpenAiCompatibleRuntime(builtinModels(), {
      modelId: id,
      baseUrl,
      thinkingLevels: runtime.thinkingLevels,
      reasoning: runtime.reasoning,
      maxTokens: runtime.maxTokens,
    });
    const model = models.getModel(provider, id) as Model<"openai-completions">;
    const stream = models.streamSimple(
      model,
      {
        systemPrompt: "Use the fixture.",
        messages: [{ role: "user", content: "Look it up.", timestamp: 1 }],
        tools: [
          {
            name: "lookup",
            description: "Look up a fixture",
            parameters: Type.Object({ value: Type.Number() }),
          },
        ],
      },
      { reasoning: reasoning === "off" ? undefined : reasoning, fetch: mockFetch },
    );
    const events = [];
    for await (const event of stream) events.push(event.type);
    const result = await stream.result();
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(result.stopReason).toBe("toolUse");
    return { payload: payload!, result, events, model };
  }

  it.each(["minimal", "low", "medium", "high"] as const)(
    "sends standard effort %s unchanged",
    async (level) => {
      const { payload } = await capture(level);
      expect(payload.reasoning_effort).toBe(level);
      expect(payload.chat_template_kwargs).toBeUndefined();
    },
  );

  it("builds a complete seven-level map from the model's own levels", async () => {
    const { model } = await capture("high", { thinkingLevels: ["off", "low", "high", "xhigh"] });
    expect(model.thinkingLevelMap).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: "xhigh",
      max: null,
    });
    expect(getSupportedThinkingLevels(model)).toEqual(["off", "low", "high", "xhigh"]);
  });

  it.each(["xhigh", "max"] as const)("preserves supported %s on the wire", async (level) => {
    const { payload } = await capture(level, { thinkingLevels: ["low", "high", level] });
    expect(payload.reasoning_effort).toBe(level);
  });

  it("clamps a legacy raw xhigh to high on an off-through-high model", async () => {
    const { payload } = await capture("xhigh");
    expect(payload.reasoning_effort).toBe("high");
  });

  it("runs distinct models on one endpoint with their own levels", async () => {
    const a = await capture("xhigh", { id: "model-a", thinkingLevels: ["off", "low", "xhigh"] });
    const b = await capture("xhigh", { id: "model-b", thinkingLevels: ["low", "medium"] });
    expect(a.payload).toMatchObject({ model: "model-a", reasoning_effort: "xhigh" });
    expect(b.payload).toMatchObject({ model: "model-b", reasoning_effort: "medium" });
  });

  it("sends the configured maximum output-token limit", async () => {
    const { payload } = await capture("medium", { thinkingLevels: LEGACY_LEVELS, maxTokens: 8192 });
    expect(payload.max_tokens ?? payload.max_completion_tokens).toBe(8192);
  });

  it("sends none when thinking is explicitly off", async () => {
    const { payload } = await capture("off");
    expect(payload.reasoning_effort).toBe("none");
    expect(payload.chat_template_kwargs).toBeUndefined();
  });

  it("does not send reasoning fields for a nonreasoning model, even for the same model ID", async () => {
    await capture("high");
    const { payload } = await capture("high", { thinkingLevels: ["off"] });
    expect(payload.reasoning_effort).toBeUndefined();
    expect(payload.chat_template_kwargs).toBeUndefined();
  });

  it("derives the old endpoint-wide levels only for a request without saved levels", async () => {
    const reasoning = await capture("xhigh", { reasoning: true });
    expect(getSupportedThinkingLevels(reasoning.model)).toEqual(LEGACY_LEVELS);
    expect(reasoning.payload.reasoning_effort).toBe("high");
    const plain = await capture("high", {});
    expect(plain.payload.reasoning_effort).toBeUndefined();
  });

  it("streams system-role requests, reasoning, text and fragmented tool arguments", async () => {
    const { payload, result, events } = await capture("medium");
    expect(payload.messages[0]?.role).toBe("system");
    expect(payload.stream).toBe(true);
    expect(payload.tools[0]?.function.name).toBe("lookup");
    expect(events).toEqual(
      expect.arrayContaining(["thinking_delta", "text_delta", "toolcall_delta", "done"]),
    );
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "thinking", thinking: "Check the fixture." }),
        expect.objectContaining({ type: "text", text: "Ready." }),
        expect.objectContaining({ type: "toolCall", name: "lookup", arguments: { value: 42 } }),
      ]),
    );
  });
});
