// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { Bot, ModelCatalogEntry, ModelCredential } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/rpc", () => ({
  rpc: {
    voice: { voices: vi.fn().mockResolvedValue([]) },
    models: {
      credentials: vi.fn().mockResolvedValue([]),
      list: vi.fn().mockResolvedValue([]),
    },
    me: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  Switch: ({
    onCheckedChange: _onCheckedChange,
    checked: _checked,
    ...props
  }: ComponentProps<"button"> & {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }) => <button type="button" {...props} />,
  Toggle: ({
    onPressedChange: _onPressedChange,
    pressed,
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & {
    variant?: string;
    size?: string;
    pressed?: boolean;
    onPressedChange?: (pressed: boolean) => void;
  }) => (
    <button type="button" aria-pressed={pressed} {...props}>
      {props.children}
    </button>
  ),
}));
vi.mock("./avatar-studio-popover", () => ({ AvatarStudioPopover: () => null }));
vi.mock("./bot-credentials", () => ({ BotCredentialsSection: () => null }));
vi.mock("../ScratchpadSection", () => ({ ScratchpadSection: () => null }));
vi.mock("../KnowledgeSection", () => ({ KnowledgeSection: () => null }));

import { rpc } from "../../lib/rpc";
import { BotSettings } from "./bot-panel";

const longInstructions = "I".repeat(4_000);

function bot(description = "Billing"): Bot {
  return {
    id: "bot-1",
    spaceId: "space-1",
    name: "Ada",
    title: "Helper",
    description,
    instructions: longInstructions,
    color: "ink",
    notifyOnFinish: true,
    pinned: false,
    sectionId: null,
    archivedAt: null,
    unread: false,
    parentBotId: null,
    memoryScope: null,
    threadId: "thread-1",
    preview: "",
    status: "idle",
    runErrorId: null,
    computerMode: "team",
    updatedAt: "2026-09-01T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    voiceId: null,
    autoSpeak: false,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    teamChatAmbientEnabled: false,
    teamChatRules: "",
    disabledBuiltinTools: [],
    webhookConfigured: false,
    spawnKey: null,
  };
}

let container: HTMLDivElement;
let root: Root;
const onSave = vi.fn(
  async (_patch: Parameters<ComponentProps<typeof BotSettings>["onSave"]>[0]) => undefined,
);

async function render(description = "Billing", current = bot(description)) {
  await act(async () => {
    root.render(
      <BotSettings
        bot={current}
        memoryProviderConfigured={false}
        onSkillsChange={() => undefined}
        onSave={onSave}
        onExport={async () => undefined}
        onClear={() => undefined}
      />,
    );
  });
}

function descriptionField(): HTMLTextAreaElement {
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("Missing description field");
  return textarea;
}

function saveButton(): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Save",
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error("Missing Save button");
  return found;
}

async function setDescription(value: string) {
  const textarea = descriptionField();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      textarea,
      value,
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function clickSave() {
  const before = onSave.mock.calls.length;
  await act(async () => {
    saveButton().click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  if (onSave.mock.calls.length === before) throw new Error("save did not run");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onSave.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("BotSettings model choices", () => {
  it("submits DeepSeek API ids and does not offer a display label", async () => {
    vi.mocked(rpc.models.credentials).mockResolvedValueOnce([
      {
        id: "cred-deepseek",
        provider: "deepseek",
        label: "DeepSeek",
        hasKey: true,
        isDefault: true,
        modelId: "DeepSeek-V4.1-Flash",
      },
    ]);
    vi.mocked(rpc.models.list).mockResolvedValueOnce([
      {
        provider: "deepseek",
        providerName: "DeepSeek",
        id: "deepseek-flash",
        label: "DeepSeek V4.1 Flash",
        billing: "",
      },
      {
        provider: "deepseek",
        providerName: "DeepSeek",
        id: "deepseek-v4-pro",
        label: "DeepSeek V4 Pro",
        billing: "",
      },
    ]);
    await render();
    await act(async () => {
      await Promise.resolve();
    });
    const model = container.querySelector("select");
    if (!(model instanceof HTMLSelectElement)) throw new Error("Missing model select");
    const values = [...model.options].map((option) => option.value);
    expect(values).toContain("deepseek::deepseek-flash");
    expect(values).toContain("deepseek::deepseek-v4-pro");
    expect(values).not.toContain("deepseek::DeepSeek-V4.1-Flash");
    expect(values.some((value) => value.includes("DeepSeek"))).toBe(false);
  });
});

const compatibleCredentials: ModelCredential[] = [
  {
    id: "cred-a",
    provider: "openai-compatible",
    label: "Server",
    hasKey: true,
    isDefault: true,
    modelId: "shadowed",
    enabledModelIds: ["model-a", "model-b", "low-high", "plain", "shadowed"],
  },
  {
    id: "cred-b",
    provider: "openai-compatible",
    label: "Other server",
    hasKey: false,
    isDefault: false,
    enabledModelIds: ["model-b"],
  },
];

function compatibleRow(
  id: string,
  thinkingLevels: ModelCatalogEntry["thinkingLevels"],
  defaultThinkingLevel: ModelCatalogEntry["defaultThinkingLevel"] = null,
): ModelCatalogEntry {
  return {
    provider: "openai-compatible",
    providerName: "Server",
    id,
    label: id,
    billing: "",
    thinkingLevels,
    defaultThinkingLevel,
  };
}

const compatibleCatalog: ModelCatalogEntry[] = [
  compatibleRow("model-a", ["off", "low", "high", "xhigh"]),
  compatibleRow("model-b", ["low", "medium"], "low"),
  compatibleRow("low-high", ["low", "high"]),
  compatibleRow("plain", ["off"]),
];

function selectById(suffix: string): HTMLSelectElement | null {
  return container.querySelector<HTMLSelectElement>(`select[id$="-${suffix}"]`);
}

async function choose(select: HTMLSelectElement | null, value: string) {
  if (!select) throw new Error("Missing select");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function effortOptions(): { value: string; label: string; disabled: boolean }[] {
  return [...(selectById("thinking")?.options ?? [])].map((option) => ({
    value: option.value,
    label: option.textContent ?? "",
    disabled: option.disabled,
  }));
}

async function renderCompatible(current: Bot) {
  vi.mocked(rpc.models.credentials).mockResolvedValueOnce(compatibleCredentials);
  vi.mocked(rpc.models.list).mockResolvedValueOnce(compatibleCatalog);
  await render("Billing", current);
  await act(async () => {
    await Promise.resolve();
  });
}

describe("BotSettings reasoning effort", () => {
  beforeEach(() => {
    i18n.load("en", {});
    i18n.activate("en");
  });

  it("offers each model its own levels and the Default the runtime executes", async () => {
    await renderCompatible(bot());
    const values = [...(selectById("model")?.options ?? [])].map((option) => option.value);
    expect(values).toEqual([
      "",
      "openai-compatible::model-a",
      "openai-compatible::model-b",
      "openai-compatible::low-high",
      "openai-compatible::plain",
    ]);

    await choose(selectById("model"), "openai-compatible::model-b");
    expect(effortOptions()).toEqual([
      { value: "", label: "Default (Low)", disabled: false },
      { value: "low", label: "Low", disabled: false },
      { value: "medium", label: "Medium", disabled: false },
    ]);

    await choose(selectById("model"), "openai-compatible::low-high");
    expect(effortOptions().map((option) => option.label)).toEqual([
      "Default (High)",
      "Low",
      "High",
    ]);

    await choose(selectById("model"), "openai-compatible::plain");
    expect(selectById("thinking")).toBeNull();

    await choose(selectById("model"), "openai-compatible::model-a");
    expect(effortOptions().map((option) => option.value)).toEqual([
      "",
      "off",
      "low",
      "high",
      "xhigh",
    ]);
    await choose(selectById("thinking"), "xhigh");
    await clickSave();
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      modelProvider: "openai-compatible",
      modelId: "model-a",
      thinkingLevel: "xhigh",
    });

    await choose(selectById("model"), "openai-compatible::plain");
    await clickSave();
    expect(onSave.mock.calls[1]?.[0]).toMatchObject({
      modelProvider: "openai-compatible",
      modelId: "plain",
      thinkingLevel: null,
    });
  });

  it("keeps an explicit Off choice instead of clearing it", async () => {
    await renderCompatible(bot());
    await choose(selectById("model"), "openai-compatible::model-a");
    await choose(selectById("thinking"), "off");
    await clickSave();
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ modelId: "model-a", thinkingLevel: "off" });
  });

  it("shows a saved unsupported effort as unavailable and preserves it on unrelated saves", async () => {
    await renderCompatible({
      ...bot(),
      modelProvider: "openai-compatible",
      modelId: "model-b",
      thinkingLevel: "xhigh",
    });
    expect(selectById("thinking")?.value).toBe("xhigh");
    expect(effortOptions()).toEqual([
      { value: "", label: "Default (Low)", disabled: false },
      { value: "xhigh", label: "Extra high (unavailable)", disabled: true },
      { value: "low", label: "Low", disabled: false },
      { value: "medium", label: "Medium", disabled: false },
    ]);

    await clickSave();
    const unrelated = onSave.mock.calls[0]?.[0];
    expect(unrelated).not.toHaveProperty("modelProvider");
    expect(unrelated).not.toHaveProperty("modelId");
    expect(unrelated).not.toHaveProperty("thinkingLevel");

    await choose(selectById("thinking"), "");
    await clickSave();
    expect(onSave.mock.calls[1]?.[0]).toMatchObject({ thinkingLevel: null });
    expect(onSave.mock.calls[1]?.[0]).not.toHaveProperty("modelId");
  });

  it("offers effort for a hosted Space default that runs without a user credential", async () => {
    vi.mocked(rpc.models.credentials).mockResolvedValueOnce([]);
    vi.mocked(rpc.models.list).mockResolvedValueOnce([
      {
        provider: "anthropic",
        providerName: "Anthropic",
        id: "claude-host",
        label: "Claude host",
        billing: "",
        reasoning: true,
        thinkingLevels: ["off", "low", "medium", "high"],
      },
      compatibleRow("model-b", ["low", "medium"], "low"),
    ]);
    vi.mocked(rpc.me).mockResolvedValueOnce({
      defaultProvider: "anthropic",
      defaultModel: "claude-host",
    } as never);
    await render("Billing", bot());
    await act(async () => {
      await Promise.resolve();
    });
    expect(effortOptions().map((option) => option.label)).toEqual([
      "Default (Medium)",
      "Off",
      "Low",
      "Medium",
      "High",
    ]);
    expect([...(selectById("model")?.options ?? [])].map((option) => option.value)).toEqual([""]);
    await choose(selectById("thinking"), "high");
    await clickSave();
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ thinkingLevel: "high" });
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("modelId");
  });

  it("hides effort for a compatible Space default the actor cannot use", async () => {
    vi.mocked(rpc.models.credentials).mockResolvedValueOnce([]);
    vi.mocked(rpc.models.list).mockResolvedValueOnce([
      compatibleRow("model-b", ["low", "medium"], "low"),
    ]);
    vi.mocked(rpc.me).mockResolvedValueOnce({
      defaultProvider: "openai-compatible",
      defaultModel: "model-b",
    } as never);
    await render("Billing", bot());
    await act(async () => {
      await Promise.resolve();
    });
    expect(selectById("thinking")).toBeNull();
  });

  it("lists compatible models only from the authorized catalog", async () => {
    await renderCompatible(bot());
    const values = [...(selectById("model")?.options ?? [])].map((option) => option.value);
    expect(values).not.toContain("openai-compatible::shadowed");
  });

  it("disables model and effort edits without clearing them when metadata fails", async () => {
    vi.mocked(rpc.models.list).mockRejectedValueOnce(new Error("offline"));
    await render("Billing", {
      ...bot(),
      modelProvider: "openai-compatible",
      modelId: "model-b",
      thinkingLevel: "medium",
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(selectById("model")?.disabled).toBe(true);
    expect(selectById("model")?.value).toBe("openai-compatible::model-b");
    expect(selectById("thinking")).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not load model settings",
    );
    await clickSave();
    const patch = onSave.mock.calls[0]?.[0];
    expect(patch).not.toHaveProperty("modelId");
    expect(patch).not.toHaveProperty("thinkingLevel");
  });
});

describe("BotSettings description saves", () => {
  it("leaves instructions off a save that does not edit the description", async () => {
    await render();
    await clickSave();
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("description");
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("instructions");
  });

  it("does not resend instructions when the bot prop stays on the old description", async () => {
    await render();
    await setDescription("Invoices");
    await clickSave();
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      description: "Invoices",
      instructions: "Invoices",
    });

    // The parent still passes the description from when the panel opened.
    await render();
    await clickSave();
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1]?.[0]).not.toHaveProperty("description");
    expect(onSave.mock.calls[1]?.[0]).not.toHaveProperty("instructions");
  });

  it("still saves a description edited back to the stale prop value", async () => {
    await render();
    await setDescription("Invoices");
    await clickSave();
    await render();
    await setDescription("Billing");
    await clickSave();
    expect(onSave.mock.calls[1]?.[0]).toMatchObject({
      description: "Billing",
      instructions: "Billing",
    });
  });

  it("keeps the previous description as the baseline when a save fails", async () => {
    onSave.mockRejectedValueOnce(new Error("offline"));
    await render();
    await setDescription("Invoices");
    await clickSave();
    await clickSave();
    expect(onSave.mock.calls[1]?.[0]).toMatchObject({
      description: "Invoices",
      instructions: "Invoices",
    });
  });
});
