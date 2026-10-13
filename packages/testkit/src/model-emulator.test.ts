import { afterEach, describe, expect, it } from "vitest";
import { startModelEmulator } from "./model-emulator.js";

const servers: Array<Awaited<ReturnType<typeof startModelEmulator>>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function post(server: Awaited<ReturnType<typeof startModelEmulator>>, overrides = {}) {
  return fetch(`${server.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer local", "content-type": "application/json" },
    body: JSON.stringify({
      model: server.model.id,
      stream: true,
      messages: [{ role: "user", content: "fixture" }],
      ...overrides,
    }),
  });
}

describe("model HTTP emulator contract", () => {
  it("fails locally when a request assertion fails, even if the caller ignores the HTTP error", async () => {
    const server = await startModelEmulator({
      steps: [
        {
          expect(request) {
            expect(request.messages.at(-1)?.content).toBe("required task");
          },
          response: { type: "text", text: "must not be returned" },
        },
      ],
    });
    servers.push(server);
    const response = await post(server);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("must not be returned");
    expect(() => server.assertComplete()).toThrow(/required task/);
  });

  it("rejects incomplete scenarios and unexpected extra model requests", async () => {
    const server = await startModelEmulator({
      steps: [{ expect() {}, response: { type: "text", text: "fixture" } }],
    });
    servers.push(server);
    expect(() => server.assertComplete()).toThrow(/Not all model fixture steps/);
    expect((await post(server)).status).toBe(200);
    server.assertComplete();
    expect((await post(server)).status).toBe(400);
    expect(() => server.assertComplete()).toThrow(/Unexpected model request 2/);
  });

  it("rejects a request routed to the wrong model", async () => {
    const server = await startModelEmulator({ steps: [] });
    servers.push(server);
    expect((await post(server, { model: "wrong-model" })).status).toBe(400);
    expect(() => server.assertComplete()).toThrow(/Model routing changed/);
  });

  it("requires argument fragments to faithfully represent the scripted tool arguments", async () => {
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "bad-fragments",
            name: "write_file",
            arguments: { path: "file" },
            argumentChunks: ["{}"],
          },
        },
      ],
    });
    servers.push(server);
    expect((await post(server)).status).toBe(400);
    expect(() => server.assertComplete()).toThrow();
  });

  it("keeps rejecting listings when no models are configured", async () => {
    const server = await startModelEmulator({ steps: [] });
    servers.push(server);
    const response = await fetch(`${server.baseUrl}/models`, {
      headers: { authorization: "Bearer local" },
    });
    expect(response.status).toBe(400);
    expect(() => server.assertComplete()).toThrow(/Expected a model POST request/);
  });

  it("lists configured models without consuming a completion step", async () => {
    const server = await startModelEmulator({
      models: [{ id: "model-a", owned_by: "openai" }, { id: "model-b" }],
      steps: [{ expect() {}, response: { type: "text", text: "fixture" } }],
    });
    servers.push(server);
    expect(server.model.id).toBe("model-a");
    const response = await fetch(`${server.baseUrl}/models`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      object: "list",
      data: [
        { id: "model-a", object: "model", owned_by: "openai" },
        { id: "model-b", object: "model" },
      ],
    });
    expect(server.listRequests).toEqual([{ authorization: undefined }]);
    expect(server.requests).toEqual([]);
    expect(() => server.assertComplete()).toThrow(/Not all model fixture steps/);
    expect((await post(server)).status).toBe(200);
    server.assertComplete();
  });

  it("requires the configured API key on listings and completions", async () => {
    const server = await startModelEmulator({
      apiKey: "fixture-key",
      models: [{ id: "model-a" }],
      steps: [{ expect() {}, response: { type: "text", text: "fixture" } }],
    });
    servers.push(server);
    const listed = await fetch(`${server.baseUrl}/models`, {
      headers: { authorization: "Bearer fixture-key" },
    });
    expect(listed.status).toBe(200);
    expect((await fetch(`${server.baseUrl}/models`)).status).toBe(400);
    const wrongKey = await fetch(`${server.baseUrl}/models`, {
      headers: { authorization: "Bearer other-key" },
    });
    expect(wrongKey.status).toBe(400);
    expect(server.listRequests.map((entry) => entry.authorization)).toEqual([
      "Bearer fixture-key",
      undefined,
      "Bearer other-key",
    ]);
    expect((await post(server)).status).toBe(400);
    expect(server.requests).toEqual([]);
    expect(() => server.assertComplete()).toThrow(/wrong API key/);
  });

  it("routes completions to any listed model and enforces a step's named model", async () => {
    const server = await startModelEmulator({
      models: [{ id: "model-a" }, { id: "model-b" }],
      steps: [
        { model: "model-b", expect() {}, response: { type: "text", text: "b" } },
        { expect() {}, response: { type: "text", text: "a" } },
        { model: "model-a", expect() {}, response: { type: "text", text: "wrong" } },
      ],
    });
    servers.push(server);
    const routed = await post(server, { model: "model-b" });
    expect(routed.status).toBe(200);
    expect(await routed.text()).toContain('"model":"model-b"');
    expect((await post(server, { model: "model-a" })).status).toBe(200);
    expect((await post(server, { model: "model-b" })).status).toBe(400);
    expect((await post(server, { model: "model-c" })).status).toBe(400);
    expect(() => server.assertComplete()).toThrow(/Model routing changed/);
  });

  it("rejects a default model id outside the listed models", async () => {
    await expect(
      startModelEmulator({ modelId: "model-c", models: [{ id: "model-a" }], steps: [] }),
    ).rejects.toThrow(/listed models/);
  });

  it("records each completion's model and reasoning effort, including its absence", async () => {
    const server = await startModelEmulator({
      models: [{ id: "model-a" }, { id: "model-b" }],
      steps: [
        { expect() {}, response: { type: "text", text: "1" } },
        { expect() {}, response: { type: "text", text: "2" } },
        { expect() {}, response: { type: "text", text: "3" } },
      ],
    });
    servers.push(server);
    expect((await post(server, { model: "model-a", reasoning_effort: "xhigh" })).status).toBe(200);
    expect((await post(server, { model: "model-b", reasoning_effort: "none" })).status).toBe(200);
    expect((await post(server, { model: "model-b" })).status).toBe(200);
    server.assertComplete();
    expect(server.completions).toEqual([
      { model: "model-a", hasReasoningEffort: true, reasoningEffort: "xhigh" },
      { model: "model-b", hasReasoningEffort: true, reasoningEffort: "none" },
      { model: "model-b", hasReasoningEffort: false, reasoningEffort: undefined },
    ]);
    expect(server.requests.map((request) => request.reasoning_effort)).toEqual([
      "xhigh",
      "none",
      undefined,
    ]);
  });
});
