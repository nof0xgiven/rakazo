// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { ModelCatalogEntry, ModelCredential, Routine } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const modelsApi = vi.hoisted(() => ({ credentials: vi.fn(), list: vi.fn() }));

vi.mock("../lib/rpc", () => ({ rpc: { models: modelsApi } }));
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  }),
  Trans: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
      <button type="button" {...props} />
    ),
    DropdownMenu: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuItem: Pass,
    DropdownMenuSub: Pass,
    DropdownMenuSubContent: Pass,
    DropdownMenuSubTrigger: Pass,
    DropdownMenuTrigger: Pass,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
    Popover: Pass,
    PopoverContent: Pass,
    PopoverTrigger: Pass,
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  };
});
vi.mock("./RoutineRunHistory", () => ({ RoutineRunHistory: () => null }));
vi.mock("./RoutineSchedule", () => ({ RoutineSchedule: () => null }));

import {
  draftFromRoutine,
  emptyRoutineDraft,
  type RoutineDraftState,
  RoutineEditor,
  type RoutineModelPatch,
  routineModelPatch,
} from "./RoutineEditor";

const credentials: ModelCredential[] = [
  {
    id: "compatible",
    provider: "openai-compatible",
    label: "Server",
    hasKey: true,
    isDefault: true,
    modelId: "saved-only",
    enabledModelIds: ["model-a", "low-high", "saved-only"],
  },
];

const catalog: ModelCatalogEntry[] = [
  {
    provider: "openai-compatible",
    providerName: "Server",
    id: "model-a",
    label: "model-a",
    billing: "",
    thinkingLevels: ["off", "minimal", "low", "medium", "high"],
    defaultThinkingLevel: null,
  },
  {
    provider: "openai-compatible",
    providerName: "Server",
    id: "low-high",
    label: "low-high",
    billing: "",
    thinkingLevels: ["low", "high"],
    defaultThinkingLevel: null,
  },
];

let container: HTMLDivElement;
let root: Root;
const onChange = vi.fn();

async function render(draft: RoutineDraftState) {
  await act(async () => {
    root.render(
      <RoutineEditor
        draft={draft}
        onChange={onChange}
        editing={null}
        timezone="UTC"
        webhook={{ path: "/hook", secret: null, configured: false }}
        githubPath="/github"
        messageProviders={[]}
        saving={false}
        running={false}
        error={null}
        onBack={() => undefined}
        onClose={() => undefined}
        onSave={() => undefined}
        onTestRun={() => undefined}
        onDelete={() => undefined}
        onEnsureWebhook={async () => undefined}
        linearConnectionsTick={0}
        onConnectLinear={() => undefined}
      />,
    );
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function select(suffix: string): HTMLSelectElement | null {
  return container.querySelector<HTMLSelectElement>(`select[id$="-${suffix}"]`);
}

function options(suffix: string) {
  return [...(select(suffix)?.options ?? [])].map((option) => ({
    value: option.value,
    label: option.textContent ?? "",
    disabled: option.disabled,
  }));
}

function routine(overrides: Partial<Routine>): Routine {
  return {
    id: "routine-1",
    botId: "bot-1",
    name: "Daily",
    prompt: "Check in.",
    crons: ["0 9 * * *"],
    timezone: "UTC",
    active: true,
    notify: true,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    linearTrigger: null,
    lastRunAt: null,
    nextRunAt: "2026-10-14T09:00:00.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

const savedPatches: RoutineModelPatch[] = [];

function SavingEditor({ editing }: { editing: Routine }) {
  const [draft, setDraft] = useState(() => draftFromRoutine(editing));
  return (
    <RoutineEditor
      draft={draft}
      onChange={setDraft}
      editing={editing}
      timezone="UTC"
      webhook={{ path: "/hook", secret: null, configured: false }}
      githubPath="/github"
      messageProviders={[]}
      saving={false}
      running={false}
      error={null}
      onBack={() => undefined}
      onClose={() => undefined}
      onSave={() => savedPatches.push(routineModelPatch(draft, editing))}
      onTestRun={() => undefined}
      onDelete={() => undefined}
      onEnsureWebhook={async () => undefined}
      linearConnectionsTick={0}
      onConnectLinear={() => undefined}
    />
  );
}

async function renderSaving(editing: Routine) {
  await act(async () => {
    root.render(<SavingEditor editing={editing} />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function setValue(element: HTMLInputElement | HTMLSelectElement | null, value: string) {
  if (!element) throw new Error("Missing field");
  const prototype =
    element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
}

async function clickSave() {
  const save = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Save",
  );
  if (!save) throw new Error("Missing Save button");
  await act(async () => save.click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
  modelsApi.credentials.mockReset().mockResolvedValue(credentials);
  modelsApi.list.mockReset().mockResolvedValue(catalog);
  onChange.mockReset();
  savedPatches.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("RoutineEditor model and reasoning effort", () => {
  it("offers the pinned model's own levels with the Default it executes", async () => {
    await render({ ...emptyRoutineDraft(), modelKey: "openai-compatible::low-high" });
    expect(options("model").map((option) => option.value)).toEqual([
      "",
      "openai-compatible::model-a",
      "openai-compatible::low-high",
    ]);
    expect(options("thinking")).toEqual([
      { value: "", label: "Default (High)", disabled: false },
      { value: "low", label: "Low", disabled: false },
      { value: "high", label: "High", disabled: false },
    ]);
  });

  it("clears the staged effort when the model changes", async () => {
    await render({
      ...emptyRoutineDraft(),
      modelKey: "openai-compatible::model-a",
      thinkingLevel: "minimal",
    });
    const model = select("model");
    if (!model) throw new Error("Missing model select");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(
        model,
        "openai-compatible::low-high",
      );
      model.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ modelKey: "openai-compatible::low-high", thinkingLevel: "" }),
    );
  });

  it("shows a saved unsupported effort as unavailable without changing the draft", async () => {
    await render({
      ...emptyRoutineDraft(),
      modelKey: "openai-compatible::model-a",
      thinkingLevel: "max",
    });
    expect(select("thinking")?.value).toBe("max");
    expect(options("thinking").slice(0, 3)).toEqual([
      { value: "", label: "Default (Medium)", disabled: false },
      { value: "max", label: "Max (unavailable)", disabled: true },
      { value: "off", label: "Off", disabled: false },
    ]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("follows the bot's model without an effort selector", async () => {
    await render(emptyRoutineDraft());
    expect(select("model")?.value).toBe("");
    expect(select("thinking")).toBeNull();
  });

  it("disables model edits and keeps the saved choice when metadata fails", async () => {
    modelsApi.list.mockRejectedValueOnce(new Error("offline"));
    await render({
      ...emptyRoutineDraft(),
      modelKey: "openai-compatible::model-a",
      thinkingLevel: "low",
    });
    expect(select("model")?.disabled).toBe(true);
    expect(select("model")?.value).toBe("openai-compatible::model-a");
    expect(select("thinking")).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not load model settings",
    );
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("RoutineEditor model saves", () => {
  it("omits a bot-following routine's untouched leftover effort on an unrelated save", async () => {
    await renderSaving(routine({ thinkingLevel: "high" }));
    await setValue(container.querySelector<HTMLInputElement>('input[id$="-name"]'), "Renamed");
    await clickSave();
    expect(savedPatches).toEqual([{}]);
  });

  it("omits an untouched legacy unsupported effort and sends only an explicit change", async () => {
    await renderSaving(
      routine({ modelProvider: "openai-compatible", modelId: "model-a", thinkingLevel: "max" }),
    );
    await clickSave();
    expect(savedPatches).toEqual([{}]);

    await setValue(select("thinking"), "");
    await clickSave();
    expect(savedPatches[1]).toEqual({ thinkingLevel: null });

    await setValue(select("thinking"), "off");
    await clickSave();
    expect(savedPatches[2]).toEqual({ thinkingLevel: "off" });
  });

  it("sends the model with a cleared effort when the model changes", async () => {
    await renderSaving(
      routine({ modelProvider: "openai-compatible", modelId: "model-a", thinkingLevel: "low" }),
    );
    await setValue(select("model"), "openai-compatible::low-high");
    await clickSave();
    expect(savedPatches).toEqual([
      { modelProvider: "openai-compatible", modelId: "low-high", thinkingLevel: null },
    ]);
  });

  it("sends the full model choice when creating", () => {
    expect(routineModelPatch(emptyRoutineDraft(), null)).toEqual({
      modelProvider: null,
      modelId: null,
      thinkingLevel: null,
    });
    expect(
      routineModelPatch({ modelKey: "openai-compatible::Model/A::1", thinkingLevel: "high" }, null),
    ).toEqual({ modelProvider: "openai-compatible", modelId: "Model/A::1", thinkingLevel: "high" });
  });
});
