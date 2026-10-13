// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Models from "../app/(settings)/models";

const mocks = vi.hoisted(() => ({
  credential: {} as Record<string, unknown>,
  calls: [] as { procedure: string; input: unknown }[],
  handlers: {} as Record<string, (input: unknown) => unknown>,
}));

vi.mock("./api", () => ({
  rpc: async (procedure: string, input: unknown) => {
    mocks.calls.push({ procedure, input });
    const handler = mocks.handlers[procedure];
    if (handler) return handler(input);
    if (procedure === "me")
      return {
        userId: "user-1",
        spaceId: "space-1",
        defaultProvider: "openai-compatible",
        defaultModel: "model-a",
      };
    if (procedure === "models/list")
      return ["model-a", "model-b"].map((id) => ({
        provider: "openai-compatible",
        providerName: "OpenAI-compatible",
        id,
        label: id,
        billing: "",
        thinkingLevels: ["off"],
        defaultThinkingLevel: null,
      }));
    if (procedure === "models/credentials") return [mocks.credential];
    if (procedure === "models/backups") return [];
    return {};
  },
  captureApiRequestContext: async () => ({}),
  selectedSpaceId: () => "space-1",
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: async () => undefined }));
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => (() => void) | undefined) => useEffect(effect, [effect]),
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
}));
vi.mock("react-native", () => {
  const view = ({
    children,
    accessibilityLabel,
    accessibilityRole,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityRole?: string;
  }) =>
    createElement("div", { "aria-label": accessibilityLabel, role: accessibilityRole }, children);
  return {
    AccessibilityInfo: { announceForAccessibility: () => undefined },
    ActivityIndicator: () => null,
    Alert: {
      alert: (
        _title: string,
        _message: string,
        buttons: { style?: string; onPress?: () => void }[],
      ) => buttons.find((button) => button.style === "destructive")?.onPress?.(),
    },
    Keyboard: { dismiss: () => undefined },
    Linking: { openURL: async () => undefined },
    Platform: { OS: "ios" },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    ScrollView: view,
    View: view,
    Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
    TextInput: ({
      accessibilityLabel,
      value,
      onChangeText,
      onSubmitEditing,
    }: {
      accessibilityLabel?: string;
      value?: string;
      onChangeText?: (text: string) => void;
      onSubmitEditing?: () => void;
    }) =>
      createElement("input", {
        "aria-label": accessibilityLabel,
        value: value ?? "",
        onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value),
        onKeyDown: (event: { key: string }) => {
          if (event.key === "Enter") onSubmitEditing?.();
        },
      }),
    Pressable: ({
      children,
      onPress,
      accessibilityLabel,
      disabled,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      accessibilityLabel?: string;
      disabled?: boolean;
    }) =>
      createElement(
        "button",
        { type: "button", onClick: onPress, "aria-label": accessibilityLabel, disabled },
        children,
      ),
  };
});
vi.mock("./native", () => ({
  native: {},
  useResolvedAppearance: () => "light",
  useThemedStyles: (createStyles: () => unknown) => createStyles(),
}));
vi.mock("./appearance", () => ({ mobileTokens: () => ({ destructive: "red" }) }));
vi.mock("./i18n", () => {
  const t = (text: string, values?: Record<string, string | number>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key] ?? ""));
  return { t, useI18n: () => ({ t }) };
});
vi.mock("./message-action-sheet", () => ({ presentMessageActionSheet: vi.fn() }));
vi.mock("./model-auth", () => ({
  cancelModelOAuthAttempt: () => undefined,
  finishModelOAuthAttempt: () => undefined,
  waitForModelOAuth: async () => undefined,
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    accessibilityLabel,
    onPress,
    disabled,
  }: {
    label?: string;
    accessibilityLabel?: string;
    onPress: () => void;
    disabled?: boolean;
  }) =>
    createElement(
      "button",
      { type: "button", "aria-label": accessibilityLabel ?? label, onClick: onPress, disabled },
      label,
    ),
}));
vi.mock("../components/native-switch", () => ({
  NativeSwitch: ({
    accessibilityLabel,
    value,
    disabled,
    onValueChange,
  }: {
    accessibilityLabel: string;
    value: boolean;
    disabled?: boolean;
    onValueChange: (value: boolean) => void;
  }) =>
    createElement("input", {
      type: "checkbox",
      "aria-label": accessibilityLabel,
      checked: value,
      disabled,
      onChange: (event: { target: { checked: boolean } }) => onValueChange(event.target.checked),
    }),
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/row-accessories", () => ({ Chevron: () => null, Checkmark: () => null }));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({ title, children }: { title: string; children: ReactNode }) =>
    createElement("section", { "data-menu": title }, children),
}));

function modelConfig(modelId: string) {
  return {
    modelId,
    thinkingLevels: ["off"],
    defaultThinkingLevel: null,
    contextWindow: 32768,
    maxTokens: 4096,
    supportsImages: false,
  };
}

function conflict(data: unknown) {
  return Object.assign(new Error("Conflict"), { code: "CONFLICT", status: 409, data });
}

describe("native OpenAI-compatible model setup", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.calls = [];
    mocks.handlers = {};
    mocks.credential = {
      id: "cred-1",
      provider: "openai-compatible",
      label: "Lab server",
      hasKey: false,
      isDefault: true,
      baseUrl: "http://127.0.0.1:8000/v1",
      modelId: "model-a",
      enabledModelIds: ["model-a", "model-b"],
      models: [modelConfig("model-a"), modelConfig("model-b")],
      configurationVersion: 3,
    };
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  const byLabel = (label: string) =>
    container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | null;
  const enabled = (modelId: string) => byLabel(`Enable ${modelId}`)?.checked;
  const click = async (label: string) => act(async () => byLabel(label)!.click());
  async function type(label: string, value: string) {
    const input = byLabel(label)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  const connectCalls = () => mocks.calls.filter((call) => call.procedure === "models/connect");

  async function render() {
    await act(async () => root.render(<Models />));
  }

  it("keeps enabled switches through search and a failed probe", async () => {
    mocks.handlers["models/probeOpenAiCompatible"] = () => {
      throw new Error("Could not reach this model server");
    };
    await render();
    expect([enabled("model-a"), enabled("model-b")]).toEqual([true, true]);

    await type("Search models", "model-b");
    expect(byLabel("Enable model-a")).toBeNull();
    expect(enabled("model-b")).toBe(true);
    await type("Search models", "");
    expect([enabled("model-a"), enabled("model-b")]).toEqual([true, true]);

    await click("Find models");
    expect(container.textContent).toContain("Could not reach this model server");
    expect([enabled("model-a"), enabled("model-b")]).toEqual([true, true]);
    expect(byLabel("Save")!.disabled).toBe(false);
  });

  it("clears probe feedback on same-endpoint key edits while keeping models", async () => {
    mocks.credential = { ...mocks.credential, hasKey: true };
    mocks.handlers["models/probeOpenAiCompatible"] = () => {
      throw new Error("Could not reach this model server");
    };
    await render();
    const apiKeyDisclosure = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "API key",
    )!;
    await act(async () => apiKeyDisclosure.click());

    await click("Find models");
    expect(container.textContent).toContain("Could not reach this model server");
    await type("API key", "fake-replacement-key");
    expect(container.textContent).not.toContain("Could not reach this model server");
    expect([enabled("model-a"), enabled("model-b")]).toEqual([true, true]);

    await click("Find models");
    expect(container.textContent).toContain("Could not reach this model server");
    await click("Remove saved key");
    expect(container.textContent).not.toContain("Could not reach this model server");
    expect(byLabel("API key")!.value).toBe("");
    expect([enabled("model-a"), enabled("model-b")]).toEqual([true, true]);
  });

  it("requires Apply before an unknown model can be saved", async () => {
    mocks.handlers["models/describeOpenAiCompatible"] = () => ({
      models: [{ modelId: "custom-x", capabilities: null }],
    });
    await render();
    await click("Other model…");
    await type("Model id", "custom-x");
    await click("Add");

    expect(enabled("custom-x")).toBe(true);
    expect(byLabel("Apply settings for custom-x")).not.toBeNull();
    expect(byLabel("Save")!.disabled).toBe(true);
    await click("Save");
    expect(connectCalls()).toEqual([]);

    await click("Apply settings for custom-x");
    expect(byLabel("Save")!.disabled).toBe(false);
    await click("Save");
    expect(connectCalls().map((call) => call.input)).toEqual([
      {
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:8000/v1",
        models: [modelConfig("model-a"), modelConfig("model-b"), modelConfig("custom-x")],
        label: "OpenAI-compatible",
        credentialId: "cred-1",
        expectedConfigurationVersion: 3,
      },
    ]);
  });

  it("cancels unknown setup back to unchecked", async () => {
    mocks.handlers["models/describeOpenAiCompatible"] = () => ({
      models: [{ modelId: "custom-x", capabilities: null }],
    });
    await render();
    await click("Other model…");
    await type("Model id", "custom-x");
    await click("Add");
    await click("Cancel changes for custom-x");
    expect(enabled("custom-x")).toBe(false);
    expect(byLabel("Save")!.disabled).toBe(false);
  });

  it("recovers an enabled model without readable configuration through Advanced and Apply", async () => {
    mocks.credential = { ...mocks.credential, models: [modelConfig("model-a")] };
    await render();
    expect(enabled("model-b")).toBe(true);
    expect(byLabel("Save")!.disabled).toBe(true);

    await click("Advanced settings for model-b");
    await click("Apply settings for model-b");
    expect(byLabel("Save")!.disabled).toBe(false);
    await click("Save");
    expect(connectCalls().map((call) => call.input)).toEqual([
      {
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:8000/v1",
        models: [modelConfig("model-a"), modelConfig("model-b")],
        label: "OpenAI-compatible",
        credentialId: "cred-1",
        expectedConfigurationVersion: 3,
      },
    ]);
  });

  it("shows conflict blockers by space and restores only the blocked model", async () => {
    mocks.handlers["models/connect"] = () => {
      throw conflict({
        reason: "models_in_use",
        usages: [
          {
            kind: "routine",
            spaceId: "space-1",
            spaceName: "Home",
            id: "routine-1",
            name: "Nightly",
            modelId: "model-b",
            thinkingLevel: null,
          },
        ],
      });
    };
    await render();
    await act(async () => byLabel("Enable model-b")!.click());
    expect(enabled("model-b")).toBe(false);
    await click("Save");

    expect(container.textContent).toContain("Reassign models before disabling them.");
    expect(container.textContent).toContain("Home");
    expect(container.textContent).toContain("Routine · Nightly · model-b");
    expect(container.textContent).toContain("Change this routine on the web.");
    expect(enabled("model-b")).toBe(true);
    expect(enabled("model-a")).toBe(true);
  });

  it("disables Save after a stale conflict until Reload replaces the draft", async () => {
    mocks.handlers["models/connect"] = () => {
      throw conflict({ reason: "model_configuration_changed" });
    };
    await render();
    await act(async () => byLabel("Enable model-b")!.click());
    await click("Save");

    expect(container.textContent).toContain("Model settings changed; reload before saving.");
    expect(byLabel("Save")!.disabled).toBe(true);
    expect(connectCalls()).toHaveLength(1);

    mocks.credential = {
      ...mocks.credential,
      enabledModelIds: ["model-a"],
      models: [modelConfig("model-a")],
      configurationVersion: 4,
    };
    await click("Reload");
    expect(connectCalls()).toHaveLength(1);
    expect(enabled("model-a")).toBe(true);
    expect(byLabel("Enable model-b")).toBeNull();
    expect(byLabel("Save")!.disabled).toBe(false);
  });

  it("keeps the connection when Disconnect is blocked", async () => {
    mocks.handlers["models/disconnect"] = () => {
      throw conflict({
        reason: "models_in_use",
        usages: [
          {
            kind: "backup",
            spaceId: "space-2",
            spaceName: "Work",
            id: "backup-1",
            name: "model-a",
            modelId: "model-a",
            thinkingLevel: null,
          },
        ],
      });
    };
    await render();
    await click("Disconnect");

    expect(container.textContent).toContain("Reassign models before disabling them.");
    expect(container.textContent).toContain("Work");
    expect(container.textContent).toContain("Backup model · model-a · model-a");
    expect(enabled("model-a")).toBe(true);
  });
});
