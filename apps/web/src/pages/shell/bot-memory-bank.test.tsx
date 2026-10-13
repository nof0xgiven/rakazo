// @vitest-environment jsdom

import { setTimeout as sleep } from "node:timers/promises";
import type { Bot, BotMemoryBank, SpaceMemoryConfig } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/rpc", () => ({
  rpc: {
    voice: { voices: vi.fn(async () => []) },
    models: {
      credentials: vi.fn(async () => []),
      list: vi.fn(async () => []),
    },
    me: vi.fn(async () => ({})),
    memory: {
      banks: vi.fn(),
      bank: vi.fn(),
      createBank: vi.fn(),
    },
  },
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => {
  const Passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const Block = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
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
      checked,
      onCheckedChange: _onCheckedChange,
      ...props
    }: ComponentProps<"button"> & {
      checked?: boolean;
      onCheckedChange?: (checked: boolean) => void;
    }) => <button type="button" role="switch" aria-checked={checked} {...props} />,
    Toggle: ({
      pressed: _pressed,
      onPressedChange: _onPressedChange,
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & {
      pressed?: boolean;
      onPressedChange?: (pressed: boolean) => void;
      variant?: string;
      size?: string;
    }) => <button type="button" {...props} />,
    Dialog: Passthrough,
    DialogContent: Block,
    Command: Block,
    CommandInput: ({
      onValueChange,
      ...props
    }: ComponentProps<"input"> & { onValueChange?: (value: string) => void }) => (
      <input {...props} onChange={(event) => onValueChange?.(event.target.value)} />
    ),
    CommandList: ({ children, label }: { children?: ReactNode; label?: string }) => (
      <div role="listbox" aria-label={label}>
        {children}
      </div>
    ),
    CommandItem: ({
      children,
      value: _value,
      onSelect,
      ...props
    }: ComponentProps<"div"> & { value?: string; onSelect?: (value: string) => void }) => (
      <div
        role="option"
        tabIndex={-1}
        {...props}
        onClick={() => onSelect?.("")}
        onKeyDown={(event) => {
          if (event.key === "Enter") onSelect?.("");
        }}
      >
        {children}
      </div>
    ),
    DialogHeader: Block,
    DialogTitle: Block,
    DialogDescription: Block,
    DialogFooter: Block,
    AlertDialog: Passthrough,
    AlertDialogContent: Block,
    AlertDialogHeader: Block,
    AlertDialogTitle: Block,
    AlertDialogDescription: Block,
    AlertDialogFooter: Block,
    AlertDialogCancel: ({ children }: { children?: ReactNode }) => (
      <button type="button">{children}</button>
    ),
    AlertDialogAction: ({ children, onClick }: ComponentProps<"button">) => (
      <button type="button" data-alert-action onClick={onClick}>
        {children}
      </button>
    ),
  };
});
vi.mock("../ScratchpadSection", () => ({ ScratchpadSection: () => null }));
vi.mock("../KnowledgeSection", () => ({ KnowledgeSection: () => null }));
vi.mock("./avatar-studio-popover", () => ({ AvatarStudioPopover: () => null }));
vi.mock("./bot-credentials", () => ({ BotCredentialsSection: () => null }));

import { rpc } from "../../lib/rpc";
import { BotSettings } from "./bot-panel";

const config: SpaceMemoryConfig = {
  id: "config-1",
  provider: "hindsight",
  settings: {},
  defaultMemoryScope: "isolated",
  capabilities: { banks: true, sharedScope: false },
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const baseBot = {
  id: "bot-1",
  spaceId: "space-1",
  name: "Ada",
  title: "Helper",
  description: "Helps",
  instructions: "Helps",
  color: "ink",
  notifyOnFinish: true,
  pinned: false,
  sectionId: null,
  archivedAt: null,
  unread: false,
  parentBotId: null,
  memoryScope: null,
  memoryBank: null,
  threadId: "thread-1",
  preview: "",
  status: "idle",
  runErrorId: null,
  computerMode: "team",
  updatedAt: "2026-10-01T00:00:00.000Z",
  createdAt: "2026-10-01T00:00:00.000Z",
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
} as Bot;

type SavePatch = Parameters<ComponentProps<typeof BotSettings>["onSave"]>[0];

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await sleep(0);
  });
}

function bankRow(name: string) {
  return [...container.querySelectorAll('[data-testid="memory-bank-list"] [role="option"]')].find(
    (option) => option.querySelector("span span")?.textContent === name,
  );
}

function buttons(text: string) {
  return [...container.querySelectorAll("button")].filter(
    (button) => button.textContent?.trim() === text,
  );
}

async function click(element: Element | undefined) {
  if (!element) throw new Error("Missing element");
  await act(async () => {
    (element as HTMLElement).click();
  });
  await flush();
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function bindingFor(patch: SavePatch): BotMemoryBank | null {
  const change = patch.memoryBank;
  if (!change?.bankId) return null;
  return {
    id: `binding-${change.bankId}`,
    configId: change.configId,
    bankId: change.bankId,
    name: change.bankId.toUpperCase(),
  };
}

async function renderSettings(options: {
  bot?: Bot;
  onSave: (patch: SavePatch) => Promise<Bot>;
  onMemoryRefresh?: () => Promise<void>;
}) {
  await act(async () => {
    root.render(
      <BotSettings
        bot={options.bot ?? baseBot}
        memoryConfig={{ status: "ready", config }}
        onMemoryConfigReload={async () => undefined}
        onMemoryRefresh={options.onMemoryRefresh ?? (async () => undefined)}
        onSkillsChange={() => undefined}
        onSave={options.onSave}
        onExport={async () => undefined}
        onClear={() => undefined}
      />,
    );
  });
  await flush();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(rpc.memory.banks).mockReset();
  vi.mocked(rpc.memory.bank).mockReset();
  vi.mocked(rpc.memory.createBank).mockReset();
  vi.mocked(rpc.memory.banks).mockResolvedValue({
    banks: [
      { bankId: "alpha", name: "Alpha" },
      { bankId: "beta", name: "Beta" },
    ],
    nextOffset: null,
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("Bot memory bank selection", () => {
  it("binds a bank and confirms a rebind using the binding from the last save", async () => {
    const onSave = vi.fn(async (patch: SavePatch) => ({
      ...baseBot,
      memoryBank: bindingFor(patch),
    }));
    await renderSettings({ onSave });

    await click(buttons("Change")[0]);
    await click(bankRow("Alpha"));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0].memoryBank).toEqual({
      configId: "config-1",
      expectedBindingId: null,
      bankId: "alpha",
    });

    await click(buttons("Change")[0]);
    await click(bankRow("Beta"));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(
      "Existing memories stay in their current bank; processing already started may finish.",
    );

    await click(container.querySelector("[data-alert-action]") ?? undefined);
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1]?.[0].memoryBank).toEqual({
      configId: "config-1",
      expectedBindingId: "binding-alpha",
      bankId: "beta",
    });
  });

  it("restores the committed bank and refetches after a conflicting save", async () => {
    const bound: Bot = {
      ...baseBot,
      memoryBank: { id: "binding-alpha", configId: "config-1", bankId: "alpha", name: "Alpha" },
    };
    const onMemoryRefresh = vi.fn(async () => undefined);
    const onSave = vi.fn(async (_patch: SavePatch): Promise<Bot> => {
      throw Object.assign(new Error("conflict"), { code: "CONFLICT" });
    });
    await renderSettings({ bot: bound, onSave, onMemoryRefresh });

    await click(buttons("Change")[0]);
    await click(bankRow("Built-in"));
    await click(container.querySelector("[data-alert-action]") ?? undefined);

    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      memoryBank: { configId: "config-1", expectedBindingId: "binding-alpha", bankId: null },
    });
    expect(onMemoryRefresh).toHaveBeenCalled();
    const field = container.querySelector('[data-testid="bot-memory-bank"]');
    expect(field?.textContent).toContain("Alpha");
    expect(field?.textContent).not.toContain("Built-in");
    expect(container.textContent).toContain("Memory settings changed. Review and try again.");
  });

  it("keeps direct ID and creation when the key can't list banks, reusing the create request", async () => {
    vi.mocked(rpc.memory.banks).mockRejectedValue(
      Object.assign(new Error("forbidden"), {
        code: "BAD_REQUEST",
        data: { reason: "bank_list_forbidden" },
      }),
    );
    vi.mocked(rpc.memory.createBank)
      .mockRejectedValueOnce(
        Object.assign(new Error("unavailable"), {
          code: "BAD_REQUEST",
          data: { reason: "unavailable" },
        }),
      )
      .mockResolvedValueOnce({ bankId: "rakazo-new", name: "Notes" });
    const onSave = vi.fn(async (patch: SavePatch) => ({
      ...baseBot,
      memoryBank: bindingFor(patch),
    }));
    await renderSettings({ onSave });

    await click(buttons("Change")[0]);
    expect(container.textContent).toContain("This key can't list banks. Use bank ID.");
    expect(buttons("Retry")).toHaveLength(0);
    expect(buttons("Load more")).toHaveLength(0);
    expect(buttons("Use bank ID")).toHaveLength(1);

    await click(buttons("Create bank")[0]);
    const nameInput = [...container.querySelectorAll("label")]
      .find((label) => label.textContent?.startsWith("Bank name"))
      ?.querySelector("input");
    if (!nameInput) throw new Error("Missing bank name input");
    await type(nameInput, "Notes");
    await click(buttons("Create")[0]);
    expect(container.textContent).toContain("Hindsight Cloud is temporarily unavailable.");
    expect(onSave).not.toHaveBeenCalled();

    await click(buttons("Create")[0]);
    const calls = vi.mocked(rpc.memory.createBank).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0].requestId).toBe(calls[1]?.[0].requestId);
    expect(calls[0]?.[0]).toMatchObject({ botId: "bot-1", configId: "config-1", name: "Notes" });
    expect(onSave.mock.calls[0]?.[0].memoryBank).toEqual({
      configId: "config-1",
      expectedBindingId: null,
      bankId: "rakazo-new",
    });
  });
});
