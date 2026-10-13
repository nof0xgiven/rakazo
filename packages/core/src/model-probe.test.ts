import type { OpenAiCompatibleDiscoveredModel } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { createModelDescription, createModelProbe, initialModelProbeState } from "./model-probe.js";

type Discovery = { models: OpenAiCompatibleDiscoveredModel[] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const known: OpenAiCompatibleDiscoveredModel = {
  modelId: "current-model",
  capabilities: {
    thinkingLevels: ["off", "low", "high"],
    defaultThinkingLevel: null,
    contextWindow: 128_000,
    maxTokens: 4096,
    supportsImages: true,
  },
};

function setup() {
  const onChange = vi.fn();
  const onSuccess = vi.fn();
  const onError = vi.fn();
  const controller = createModelProbe(onChange);
  const input = {
    baseUrl: " https://models.example.test/v1 ",
    apiKey: "fake-key",
    onSuccess,
    onError,
  };
  return { controller, input, onChange, onSuccess, onError };
}

describe("model probe lifecycle", () => {
  it("trims the URL and treats an empty catalog as a successful manual-entry probe", async () => {
    const { controller, input, onChange, onSuccess } = setup();
    const request = vi.fn().mockResolvedValue({ models: [] });
    await controller.probe({ ...input, credentialId: "cred-1", request });
    expect(request).toHaveBeenCalledWith({
      baseUrl: "https://models.example.test/v1",
      apiKey: "fake-key",
      credentialId: "cred-1",
    });
    expect(onChange.mock.calls).toEqual([
      [{ models: [], baseUrl: null, probing: true }],
      [{ models: [], baseUrl: "https://models.example.test/v1", probing: false }],
    ]);
    expect(onSuccess).toHaveBeenCalledWith([]);
  });

  it("omits an absent key but passes an explicit keyless request through", async () => {
    const { controller, input } = setup();
    const request = vi.fn().mockResolvedValue({ models: [] });
    await controller.probe({ ...input, apiKey: undefined, request });
    expect(request).toHaveBeenLastCalledWith({ baseUrl: "https://models.example.test/v1" });
    await controller.probe({ ...input, apiKey: "", request });
    expect(request).toHaveBeenLastCalledWith({
      baseUrl: "https://models.example.test/v1",
      apiKey: "",
    });
  });

  it.each(["provider", "key", "URL"])("ignores a result after the %s changes", async () => {
    const { controller, input, onChange, onSuccess, onError } = setup();
    const pending = deferred<Discovery>();
    const probe = controller.probe({ ...input, request: () => pending.promise });
    controller.reset();
    pending.resolve({ models: [{ modelId: "old-model", capabilities: null }] });
    await probe;
    expect(onChange).toHaveBeenLastCalledWith(initialModelProbeState);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not report errors or update state after unmount", async () => {
    const { controller, input, onChange, onError } = setup();
    const pending = deferred<Discovery>();
    const probe = controller.probe({ ...input, request: () => pending.promise });
    controller.invalidate();
    pending.reject(new Error("old failure"));
    await probe;
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not let an older request finish a newer request", async () => {
    const { controller, input, onChange, onSuccess } = setup();
    const old = deferred<Discovery>();
    const current = deferred<Discovery>();
    const first = controller.probe({ ...input, request: () => old.promise });
    const second = controller.probe({ ...input, request: () => current.promise });
    old.resolve({ models: [{ modelId: "old-model", capabilities: null }] });
    await first;
    expect(onChange).toHaveBeenLastCalledWith({ models: [], baseUrl: null, probing: true });
    expect(onSuccess).not.toHaveBeenCalled();
    current.resolve({ models: [known] });
    await second;
    expect(onSuccess).toHaveBeenCalledExactlyOnceWith([known]);
  });

  it("clears probing after failure", async () => {
    const { controller, input, onChange, onError } = setup();
    const error = new Error("unreachable");
    await controller.probe({ ...input, request: vi.fn().mockRejectedValue(error) });
    expect(onChange).toHaveBeenLastCalledWith(initialModelProbeState);
    expect(onError).toHaveBeenCalledWith(error);
  });
});

describe("manual model description", () => {
  it("describes one exact id and reports unknown ids without capabilities", async () => {
    const onBusy = vi.fn();
    const onSuccess = vi.fn();
    const request = vi.fn().mockResolvedValue({ models: [] });
    await createModelDescription(onBusy).describe({
      baseUrl: " https://models.example.test ",
      credentialId: "cred-1",
      modelId: " vendor/model ",
      request,
      onSuccess,
      onError: vi.fn(),
    });
    expect(request).toHaveBeenCalledWith({
      baseUrl: "https://models.example.test",
      credentialId: "cred-1",
      modelIds: ["vendor/model"],
    });
    expect(onSuccess).toHaveBeenCalledWith({ modelId: "vendor/model", capabilities: null });
    expect(onBusy.mock.calls).toEqual([[true], [false]]);
  });

  it("lets only the latest description report", async () => {
    const onSuccess = vi.fn();
    const describer = createModelDescription(vi.fn());
    const old = deferred<Discovery>();
    const base = { baseUrl: "https://models.example.test", onSuccess, onError: vi.fn() };
    const first = describer.describe({ ...base, modelId: "old", request: () => old.promise });
    await describer.describe({
      ...base,
      modelId: "current-model",
      request: async () => ({ models: [known] }),
    });
    old.resolve({ models: [{ modelId: "old", capabilities: null }] });
    await first;
    expect(onSuccess).toHaveBeenCalledExactlyOnceWith(known);
  });
});
