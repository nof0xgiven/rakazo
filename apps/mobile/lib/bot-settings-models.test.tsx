// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BotSettingsScreen from "../app/bot-settings";

const mocks = vi.hoisted(() => ({
  bot: {} as Record<string, unknown>,
  me: {} as Record<string, unknown>,
  catalog: [] as unknown[],
  metadataError: null as Error | null,
  updates: [] as unknown[],
  back: vi.fn(),
}));

vi.mock("./bot-voices", () => ({
  voiceLabel: () => "",
  deviceVoices: async () => [],
  voiceForBot: async () => undefined,
  setVoiceForBot: async () => undefined,
}));
vi.mock("./device-voice", () => ({ loadDeviceVoiceEnabled: async () => false }));
vi.mock("./voice", () => ({ stopVoicePlayback: vi.fn() }));
vi.mock("./api", () => ({
  apiScopeKey: () => "scope-fixture",
  captureApiRequestContext: async () => ({ apiBase: "http://fixture", headers: {} }),
  rpc: async (procedure: string, input: unknown) => {
    if (procedure === "bots/get") return mocks.bot;
    if (procedure === "bots/update") {
      mocks.updates.push(input);
      return {};
    }
    if (procedure === "memory/providerConfig") return null;
    if (mocks.metadataError) throw mocks.metadataError;
    if (procedure === "me") return mocks.me;
    if (procedure === "models/list") return mocks.catalog;
    if (procedure === "models/credentials")
      return [
        {
          id: "credential-1",
          provider: "openai-compatible",
          label: "Lab server",
          hasKey: false,
          isDefault: true,
        },
      ];
    return [];
  },
}));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ back: mocks.back }),
  useLocalSearchParams: () => ({ botId: "bot-fixture" }),
  useFocusEffect: (effect: () => (() => void) | undefined) => useEffect(effect, [effect]),
}));
vi.mock("react-native", () => {
  const view = ({
    children,
    accessibilityLabel,
    accessibilityValue,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityValue?: { text: string };
  }) =>
    createElement(
      "div",
      { "aria-label": accessibilityLabel, "aria-valuetext": accessibilityValue?.text },
      children,
    );
  return {
    Platform: { OS: "ios" },
    StyleSheet: { create: (styles: unknown) => styles },
    ScrollView: view,
    View: view,
    Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
    TextInput: () => null,
    Pressable: ({
      children,
      onPress,
      accessibilityLabel,
    }: {
      children?: ReactNode;
      onPress: () => void;
      accessibilityLabel?: string;
    }) =>
      createElement(
        "button",
        { type: "button", onClick: onPress, "aria-label": accessibilityLabel },
        children,
      ),
  };
});
vi.mock("./native", () => ({
  native: { tertiaryLabel: "muted", fill: "fill" },
  useMobileTokens: () => ({ mutedForeground: "muted", foreground: "ink", destructive: "error" }),
  useResolvedAppearance: () => "light",
  useThemedStyles: (createStyles: () => unknown) => createStyles(),
}));
vi.mock("./i18n", () => {
  const t = (text: string, values?: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => values?.[key] ?? "");
  return { t, useI18n: () => ({ t }) };
});
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("../components/computer-mode-picker", () => ({ ComputerModePicker: () => null }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement("button", { type: "button", "data-action": label, onClick: onPress }, label),
}));
vi.mock("../components/native-switch", () => ({ NativeSwitch: () => null }));
vi.mock("../components/row-accessories", () => ({ Chevron: () => null }));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({
    title,
    actions,
    onPressAction,
    children,
  }: {
    title: string;
    actions: { id: string; title: string; state: string; attributes?: { disabled?: boolean } }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children: ReactNode;
  }) =>
    createElement(
      "section",
      { "data-menu": title },
      children,
      ...actions.map((action) =>
        createElement(
          "button",
          {
            type: "button",
            key: action.id,
            "data-state": action.state,
            disabled: action.attributes?.disabled === true,
            onClick: () => onPressAction({ nativeEvent: { event: action.id } }),
          },
          action.title,
        ),
      ),
    ),
}));

function compatibleRow(id: string, thinkingLevels: string[], defaultThinkingLevel: string | null) {
  return {
    provider: "openai-compatible",
    providerName: "Lab server",
    id,
    label: id,
    billing: "",
    thinkingLevels,
    defaultThinkingLevel,
  };
}

describe("bot settings model and reasoning effort", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.updates = [];
    mocks.metadataError = null;
    mocks.bot = {
      id: "bot-fixture",
      name: "Fixture",
      title: "",
      color: "#000000",
      computerMode: "team",
      autoSpeak: false,
      modelProvider: "openai-compatible",
      modelId: "model-a",
      thinkingLevel: null,
    };
    mocks.me = { defaultProvider: "openai-compatible", defaultModel: "model-b" };
    mocks.catalog = [
      compatibleRow("model-a", ["off", "low", "high"], null),
      compatibleRow("model-b", ["low", "medium"], "low"),
      compatibleRow("model-c", ["off"], null),
    ];
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  async function open() {
    await act(async () => root.render(<BotSettingsScreen />));
    const advanced = [...container.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === "Advanced",
    )!;
    await act(async () => advanced.click());
  }
  const menu = (title: string) => container.querySelector(`[data-menu="${title}"]`);
  const actions = (title: string) =>
    [...(menu(title)?.querySelectorAll(":scope > button") ?? [])] as HTMLButtonElement[];
  const titles = (title: string) => actions(title).map((action) => action.textContent);
  const choose = async (title: string, label: string) =>
    act(async () =>
      actions(title)
        .find((action) => action.textContent === label)!
        .click(),
    );
  const save = async () =>
    act(async () => (container.querySelector('[data-action="Save"]') as HTMLElement).click());

  it("offers only the selected model's levels with its effective default", async () => {
    await open();
    expect(titles("Reasoning effort")).toEqual(["Default (High)", "Off", "Low", "High"]);

    await choose("Reasoning effort", "Low");
    await choose("Model", "Lab server · model-b");
    expect(titles("Reasoning effort")).toEqual(["Default (Low)", "Low", "Medium"]);
    expect(actions("Reasoning effort")[0]!.dataset.state).toBe("on");

    await save();
    expect(mocks.updates).toEqual([
      {
        botId: "bot-fixture",
        modelProvider: "openai-compatible",
        modelId: "model-b",
        thinkingLevel: null,
      },
    ]);
  });

  it("hides effort for a nonreasoning model and saves it with no effort", async () => {
    await open();
    await choose("Model", "Lab server · model-c");
    expect(menu("Reasoning effort")).toBeNull();
    await save();
    expect(mocks.updates).toEqual([
      {
        botId: "bot-fixture",
        modelProvider: "openai-compatible",
        modelId: "model-c",
        thinkingLevel: null,
      },
    ]);
  });

  it("follows the Space default model's own levels", async () => {
    mocks.bot = { ...mocks.bot, modelProvider: null, modelId: null };
    await open();
    expect(actions("Model")[0]!.dataset.state).toBe("on");
    expect(titles("Reasoning effort")).toEqual(["Default (Low)", "Low", "Medium"]);
  });

  it("shows a saved unsupported effort as unavailable and omits it on unrelated saves", async () => {
    mocks.bot = { ...mocks.bot, thinkingLevel: "xhigh" };
    await open();
    expect(titles("Reasoning effort")).toEqual([
      "Default (High)",
      "Off",
      "Low",
      "High",
      "Extra high (unavailable)",
    ]);
    expect(actions("Reasoning effort")[4]!.dataset.state).toBe("on");
    expect(actions("Reasoning effort").map((action) => action.disabled)).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
    await choose("Reasoning effort", "Extra high (unavailable)");
    await save();
    expect(mocks.updates).toEqual([]);

    await choose("Reasoning effort", "High");
    expect(titles("Reasoning effort")).toEqual(["Default (High)", "Off", "Low", "High"]);
    await save();
    expect(mocks.updates).toEqual([{ botId: "bot-fixture", thinkingLevel: "high" }]);
  });

  it("keeps model and effort out of reach when model settings fail to load", async () => {
    mocks.metadataError = new Error("Could not load model settings");
    await open();
    expect(menu("Model")).toBeNull();
    expect(menu("Reasoning effort")).toBeNull();
    expect(container.textContent).toContain("Could not load model settings");
    await save();
    expect(mocks.updates).toEqual([]);
    expect(mocks.back).toHaveBeenCalled();
  });
});
