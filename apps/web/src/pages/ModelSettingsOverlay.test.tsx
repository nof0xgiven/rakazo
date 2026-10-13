// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { ThinkingLevel } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const models = vi.hoisted(() => ({
  list: vi.fn(),
  backups: vi.fn(async () => []),
  setBackups: vi.fn(async () => ({ ok: true })),
  credentials: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  setDefault: vi.fn(),
  probeOpenAiCompatible: vi.fn(),
  describeOpenAiCompatible: vi.fn(),
  beginOAuth: vi.fn(),
  cancelOAuth: vi.fn(),
  completeOAuth: vi.fn(),
  finishOAuth: vi.fn(),
  submitOAuthCode: vi.fn(),
}));

vi.mock("../lib/rpc", () => ({
  selectedSpaceId: () => "space-1",
  rpc: {
    models,
    me: vi.fn(),
  },
}));
vi.mock("../lib/localized-provider-hint", () => ({
  localizedProviderHint: () => "API key",
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce(
      (text, part, index) => `${text}${index > 0 ? String(values[index - 1]) : ""}${part}`,
      "",
    );
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children?: ReactNode }) => children,
    Plural: ({ one, other, value }: { one: string; other: string; value: number }) =>
      value === 1 ? one : other,
  };
});
vi.mock("@rakazo/ui-web", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    OpenAiCompatibleModelEditor: actual.OpenAiCompatibleModelEditor,
    AlertDialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
      open ? <div>{children}</div> : null,
    AlertDialogAction: ({
      children,
      onClick,
      disabled,
    }: {
      children?: ReactNode;
      onClick?: () => void;
      disabled?: boolean;
    }) => (
      <button type="button" disabled={disabled} onClick={onClick}>
        {children}
      </button>
    ),
    AlertDialogCancel: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
    AlertDialogContent: Pass,
    AlertDialogDescription: Pass,
    AlertDialogFooter: Pass,
    AlertDialogHeader: Pass,
    AlertDialogTitle: Pass,
    Button: ({
      children,
      onClick,
      disabled,
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
      <button type="button" disabled={disabled} onClick={onClick} {...props}>
        {children}
      </button>
    ),
    Dialog: Pass,
    DialogClose: Pass,
    DialogContent: Pass,
    DialogDescription: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  };
});

import { rpc } from "../lib/rpc";
import { ModelSettingsOverlay } from "./ModelSettingsOverlay";

const STORED_PLACEHOLDER = "Paste a replacement key";
const deepseekEntry = {
  provider: "deepseek",
  providerName: "DeepSeek",
  id: "deepseek-chat",
  label: "DeepSeek Chat",
  billing: "API key",
  auth: "api-key" as const,
  authHint: "API key",
};
const compatibleEntry = {
  provider: "openai-compatible",
  providerName: "OpenAI-compatible",
  id: "custom",
  label: "Custom model",
  billing: "Your server",
  auth: "api-key" as const,
  authHint: "Custom server",
  placeholder: true,
};

function account(provider: string, modelId: string) {
  return {
    userId: "user-1",
    email: "ada@example.test",
    name: "Ada",
    spaceId: "space-1",
    isDeploymentOwner: false,
    needsModel: false,
    defaultProvider: provider,
    defaultModel: modelId,
    hostCredentialProvider: null,
    hostCredentialSource: null,
    computerHost: null,
    canChooseHostComputer: false,
    sandboxProvider: "docker",
    avatarStyle: "robot" as const,
    billingEnabled: false,
    ticketBoardEnabled: false,
  };
}

function buttons(container: HTMLElement, text: string) {
  const found = [...container.querySelectorAll("button")].filter((entry) =>
    entry.textContent?.includes(text),
  );
  if (found.length === 0) throw new Error(`Missing button: ${text}`);
  return found;
}

function keyField(container: HTMLElement) {
  const input = container.querySelector("#model-api-key");
  if (!(input instanceof HTMLInputElement)) throw new Error("Missing API key field");
  return input;
}

function compatibleKeyField(container: HTMLElement) {
  const input = [...container.querySelectorAll("input")].find(
    (entry) => entry.getAttribute("aria-label") === "API key",
  );
  if (!(input instanceof HTMLInputElement)) throw new Error("Missing compatible API key field");
  return input;
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function renderSettings() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ModelSettingsOverlay embedded onClose={() => undefined} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return {
    container,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

beforeEach(() => {
  i18n.load("en", {});
  i18n.activate("en");
  models.probeOpenAiCompatible.mockReset();
  models.describeOpenAiCompatible.mockReset();
  models.setDefault.mockReset().mockResolvedValue({ ok: true });
  models.connect.mockReset();
  vi.mocked(rpc.me).mockResolvedValue(account("deepseek", "deepseek-chat"));
  models.list.mockResolvedValue([deepseekEntry]);
  models.credentials.mockResolvedValue([]);
  models.connect.mockResolvedValue({});
  models.disconnect.mockResolvedValue(undefined);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

it("shows a stored BYOK key when provider settings reopen", async () => {
  models.credentials.mockResolvedValue([
    {
      id: "cred-deepseek",
      provider: "deepseek",
      label: "DeepSeek",
      hasKey: true,
      isDefault: true,
      modelId: "deepseek-chat",
    },
  ]);

  const view = await renderSettings();
  try {
    const input = keyField(view.container);
    expect(input.value).toBe("");
    expect(input.placeholder).toBe(STORED_PLACEHOLDER);
    expect(input.type).toBe("password");
    expect(view.container.textContent).not.toContain("sk-");

    await typeInto(input, "sk-replacement-key");
    expect(keyField(view.container).value).toBe("sk-replacement-key");

    await typeInto(keyField(view.container), "");
    expect(keyField(view.container).value).toBe("");
    expect(keyField(view.container).placeholder).toBe(STORED_PLACEHOLDER);

    await typeInto(keyField(view.container), "sk-replacement-key");
    await act(async () => {
      buttons(view.container, "Replace API key")[0]?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(models.connect).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "deepseek", apiKey: "sk-replacement-key" }),
    );
    expect(keyField(view.container).value).toBe("");
    expect(keyField(view.container).placeholder).toBe(STORED_PLACEHOLDER);

    models.credentials.mockResolvedValue([]);
    await act(async () => {
      buttons(view.container, "Disconnect")[0]?.click();
    });
    const confirm = buttons(view.container, "Disconnect");
    await act(async () => {
      confirm[confirm.length - 1]?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(models.disconnect).toHaveBeenCalledWith({ provider: "deepseek" });
    expect(keyField(view.container).value).toBe("");
    expect(keyField(view.container).placeholder).toBe("sk-…");
  } finally {
    await view.unmount();
  }
});

it("leaves the key field empty until a key is saved", async () => {
  const view = await renderSettings();
  try {
    const input = keyField(view.container);
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("sk-…");
    expect(view.container.textContent).not.toContain(STORED_PLACEHOLDER);
  } finally {
    await view.unmount();
  }
});

it("shows Cloudflare account and gateway fields for a new and a saved connection", async () => {
  const entry = {
    provider: "cloudflare-ai-gateway",
    providerName: "Cloudflare AI Gateway",
    id: "workers-ai/@cf/meta/llama-3.1-8b-instruct",
    label: "Llama",
    billing: "API key",
    auth: "api-key" as const,
    authHint: "API key",
  };
  vi.mocked(rpc.me).mockResolvedValue(account(entry.provider, entry.id));
  models.list.mockResolvedValue([entry]);
  models.credentials.mockResolvedValue([]);

  const fresh = await renderSettings();
  try {
    const accountId = fresh.container.querySelector("#cloudflare-account-id");
    const gatewayId = fresh.container.querySelector("#cloudflare-gateway-id");
    expect(accountId).toBeInstanceOf(HTMLInputElement);
    expect(gatewayId).toBeInstanceOf(HTMLInputElement);
    expect((accountId as HTMLInputElement).value).toBe("");
    expect((gatewayId as HTMLInputElement).value).toBe("");
    expect(fresh.container.textContent).toContain("Account ID");
    expect(fresh.container.textContent).toContain("Gateway ID");
  } finally {
    await fresh.unmount();
  }

  models.credentials.mockResolvedValue([
    {
      id: "cred-cf",
      provider: entry.provider,
      label: "Cloudflare AI Gateway",
      hasKey: true,
      isDefault: true,
      accountId: "acct1234",
      gatewayId: "gateway-1",
      modelId: entry.id,
    },
  ]);
  const saved = await renderSettings();
  try {
    expect(
      (saved.container.querySelector("#cloudflare-account-id") as HTMLInputElement).value,
    ).toBe("acct1234");
    expect(
      (saved.container.querySelector("#cloudflare-gateway-id") as HTMLInputElement).value,
    ).toBe("gateway-1");
  } finally {
    await saved.unmount();
  }
});

it("shows a stored OpenAI-compatible key and stays empty when none is saved", async () => {
  vi.mocked(rpc.me).mockResolvedValue(account("openai-compatible", "deepseek-chat"));
  models.list.mockResolvedValue([compatibleEntry]);
  models.credentials.mockResolvedValue([
    {
      id: "cred-compatible",
      provider: "openai-compatible",
      label: "DeepSeek",
      hasKey: true,
      isDefault: true,
      baseUrl: "https://api.deepseek.com/v1",
      modelId: "deepseek-chat",
    },
  ]);

  const stored = await renderSettings();
  try {
    const input = compatibleKeyField(stored.container);
    expect(input.value).toBe("");
    expect(input.placeholder).toBe(STORED_PLACEHOLDER);
  } finally {
    await stored.unmount();
  }

  models.credentials.mockResolvedValue([
    {
      id: "cred-compatible",
      provider: "openai-compatible",
      label: "Local",
      hasKey: false,
      isDefault: true,
      baseUrl: "http://127.0.0.1:8000/v1",
      modelId: "local-model",
    },
  ]);
  const empty = await renderSettings();
  try {
    const input = compatibleKeyField(empty.container);
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Optional");
  } finally {
    await empty.unmount();
  }
});

const ENDPOINT = "http://127.0.0.1:8000/v1";
const knownCapabilities = {
  thinkingLevels: ["off", "low", "high"] as ThinkingLevel[],
  defaultThinkingLevel: null,
  contextWindow: 128_000,
  maxTokens: 4096,
  supportsImages: true,
};

function compatibleModelConfig(modelId: string, levels: ThinkingLevel[] = ["low", "medium"]) {
  return { modelId, ...knownCapabilities, thinkingLevels: levels };
}

function compatibleCredential(overrides: Record<string, unknown> = {}) {
  return {
    id: "cred-compatible",
    provider: "openai-compatible",
    label: "Local",
    hasKey: true,
    isDefault: true,
    baseUrl: ENDPOINT,
    modelId: "model-a",
    enabledModelIds: ["model-a", "model-b"],
    models: [compatibleModelConfig("model-a"), compatibleModelConfig("model-b")],
    configurationVersion: 3,
    ...overrides,
  };
}

function catalogRow(id: string) {
  return { ...compatibleEntry, id, label: id, placeholder: undefined };
}

function usage(modelId: string, spaceName: string) {
  return {
    kind: "bot" as const,
    spaceId: `space-${spaceName}`,
    spaceName,
    id: `bot-${modelId}`,
    name: `Bot ${modelId}`,
    modelId,
    thinkingLevel: null,
  };
}

function conflictError(data: unknown) {
  return Object.assign(new Error("Conflict"), { code: "CONFLICT", status: 409, data });
}

function modelRow(container: HTMLElement, modelId: string) {
  const row = [...container.querySelectorAll("li")].find((entry) =>
    [...entry.querySelectorAll("label")].some((label) => label.textContent === modelId),
  );
  if (!row) throw new Error(`Missing model row: ${modelId}`);
  return row;
}

function modelCheckbox(container: HTMLElement, modelId: string) {
  const checkbox = modelRow(container, modelId).querySelector('[role="checkbox"]');
  if (!(checkbox instanceof HTMLElement)) throw new Error(`Missing checkbox: ${modelId}`);
  return checkbox;
}

function isChecked(container: HTMLElement, modelId: string) {
  return modelCheckbox(container, modelId).getAttribute("aria-checked") === "true";
}

function visibleModelIds(container: HTMLElement) {
  return [...container.querySelectorAll("li label")]
    .map((label) => label.textContent ?? "")
    .filter((text) => text.startsWith("model-") || text === "mystery");
}

function inputByLabel(container: HTMLElement, label: string) {
  const input = [...container.querySelectorAll("input")].find(
    (entry) => entry.getAttribute("aria-label") === label,
  );
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input: ${label}`);
  return input;
}

function saveButton(container: HTMLElement) {
  const found = buttons(container, "Save").find((entry) => entry.textContent === "Save");
  if (!found) throw new Error("Missing Save");
  return found;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function chooseOption(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function setUpCompatible() {
  vi.mocked(rpc.me).mockResolvedValue(account("openai-compatible", "model-a"));
  models.list.mockResolvedValue([catalogRow("model-a"), catalogRow("model-b")]);
  models.credentials.mockResolvedValue([compatibleCredential()]);
}

it("keeps model checks through search, a failed probe and the post-save reload", async () => {
  setUpCompatible();
  const view = await renderSettings();
  try {
    expect(isChecked(view.container, "model-a")).toBe(true);
    expect(isChecked(view.container, "model-b")).toBe(true);
    await click(modelCheckbox(view.container, "model-b"));

    models.probeOpenAiCompatible.mockRejectedValueOnce(new Error("connection refused"));
    await click(buttons(view.container, "Find models")[0]!);
    expect(view.container.textContent).toContain("connection refused");
    expect(isChecked(view.container, "model-a")).toBe(true);
    expect(isChecked(view.container, "model-b")).toBe(false);

    models.probeOpenAiCompatible.mockResolvedValueOnce({
      models: [
        { modelId: "model-a", capabilities: null },
        { modelId: "model-c", capabilities: knownCapabilities },
      ],
    });
    await click(buttons(view.container, "Find models")[0]!);
    expect(models.probeOpenAiCompatible).toHaveBeenLastCalledWith({
      baseUrl: ENDPOINT,
      credentialId: "cred-compatible",
    });
    expect(isChecked(view.container, "model-c")).toBe(false);

    await typeInto(inputByLabel(view.container, "Search models"), "model-c");
    expect(visibleModelIds(view.container)).toEqual(["model-c"]);
    await click(modelCheckbox(view.container, "model-c"));
    await typeInto(inputByLabel(view.container, "Search models"), "");
    expect(visibleModelIds(view.container)).toEqual(["model-a", "model-b", "model-c"]);
    expect(isChecked(view.container, "model-b")).toBe(false);

    models.connect.mockResolvedValueOnce(compatibleCredential());
    models.credentials.mockResolvedValue([
      compatibleCredential({
        enabledModelIds: ["model-a", "model-c"],
        models: [compatibleModelConfig("model-a"), { modelId: "model-c", ...knownCapabilities }],
        configurationVersion: 4,
      }),
    ]);
    await click(saveButton(view.container));
    expect(models.connect).toHaveBeenCalledExactlyOnceWith({
      provider: "openai-compatible",
      baseUrl: ENDPOINT,
      credentialId: "cred-compatible",
      expectedConfigurationVersion: 3,
      label: "OpenAI-compatible",
      models: [compatibleModelConfig("model-a"), { modelId: "model-c", ...knownCapabilities }],
    });
    expect(isChecked(view.container, "model-a")).toBe(true);
    expect(isChecked(view.container, "model-b")).toBe(false);
    expect(isChecked(view.container, "model-c")).toBe(true);
    expect(models.probeOpenAiCompatible).toHaveBeenCalledTimes(2);
  } finally {
    await view.unmount();
  }
});

it("requires Apply before an unknown model can be saved", async () => {
  setUpCompatible();
  models.probeOpenAiCompatible.mockResolvedValue({
    models: [{ modelId: "mystery", capabilities: null }],
  });
  const view = await renderSettings();
  try {
    await click(buttons(view.container, "Find models")[0]!);
    await click(modelCheckbox(view.container, "mystery"));
    expect(view.container.textContent).toContain("Needs setup");
    expect(saveButton(view.container).disabled).toBe(true);

    await click(buttons(modelRow(view.container, "mystery"), "Cancel")[0]!);
    expect(isChecked(view.container, "mystery")).toBe(false);

    await click(modelCheckbox(view.container, "mystery"));
    await click(buttons(modelRow(view.container, "mystery"), "Apply")[0]!);
    expect(saveButton(view.container).disabled).toBe(false);
    await click(saveButton(view.container));
    expect(models.connect.mock.calls[0]?.[0].models).toContainEqual({
      modelId: "mystery",
      thinkingLevels: ["off"],
      defaultThinkingLevel: null,
      contextWindow: 32_768,
      maxTokens: 4096,
      supportsImages: false,
    });
  } finally {
    await view.unmount();
  }
});

it("describes an Other model id locally and accepts its detected settings", async () => {
  setUpCompatible();
  models.describeOpenAiCompatible.mockResolvedValue({
    models: [{ modelId: "vendor/known", capabilities: knownCapabilities }],
  });
  const view = await renderSettings();
  try {
    await click(buttons(view.container, "Other model…")[0]!);
    const field = [...view.container.querySelectorAll("label")]
      .find((label) => label.textContent?.startsWith("Model id"))
      ?.querySelector("input");
    await typeInto(field as HTMLInputElement, " vendor/known ");
    await click(buttons(view.container, "Add").find((entry) => entry.textContent === "Add")!);
    expect(models.describeOpenAiCompatible).toHaveBeenCalledWith({
      baseUrl: ENDPOINT,
      credentialId: "cred-compatible",
      modelIds: ["vendor/known"],
    });
    expect(
      modelRow(view.container, "vendor/known")
        .querySelector('[role="checkbox"]')
        ?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(saveButton(view.container).disabled).toBe(false);
    expect(models.probeOpenAiCompatible).not.toHaveBeenCalled();
  } finally {
    await view.unmount();
  }
});

it("restores only blocked saved rows after a same-endpoint removal conflict", async () => {
  setUpCompatible();
  models.probeOpenAiCompatible.mockResolvedValue({
    models: [{ modelId: "model-c", capabilities: knownCapabilities }],
  });
  const view = await renderSettings();
  try {
    await click(buttons(view.container, "Find models")[0]!);
    await click(modelCheckbox(view.container, "model-c"));
    await click(modelCheckbox(view.container, "model-a"));
    await click(modelCheckbox(view.container, "model-b"));
    await typeInto(compatibleKeyField(view.container), "sk-new-key-1234");
    models.connect.mockRejectedValueOnce(
      conflictError({
        reason: "models_in_use",
        usages: [usage("model-b", "Home"), { ...usage("model-b", "Work"), kind: "default" }],
      }),
    );
    await click(saveButton(view.container));
    expect(isChecked(view.container, "model-a")).toBe(false);
    expect(isChecked(view.container, "model-b")).toBe(true);
    expect(isChecked(view.container, "model-c")).toBe(true);
    expect(compatibleKeyField(view.container).value).toBe("sk-new-key-1234");
    const alert = [...view.container.querySelectorAll('[role="alert"]')].find((entry) =>
      entry.textContent?.includes("Reassign models before disabling them."),
    );
    expect(alert?.textContent).toContain("Home");
    expect(alert?.textContent).toContain("Work");
    expect(alert?.textContent).toContain("Bot model-b");
    expect(saveButton(view.container).disabled).toBe(false);
  } finally {
    await view.unmount();
  }
});

it("reloads persisted settings after a stale save without retrying", async () => {
  setUpCompatible();
  const view = await renderSettings();
  try {
    await click(modelCheckbox(view.container, "model-b"));
    await typeInto(compatibleKeyField(view.container), "sk-new-key-1234");
    models.connect.mockRejectedValueOnce(conflictError({ reason: "model_configuration_changed" }));
    await click(saveButton(view.container));
    expect(view.container.textContent).toContain("Model settings changed; reload before saving.");
    expect(saveButton(view.container).disabled).toBe(true);

    models.credentials.mockResolvedValue([
      compatibleCredential({
        enabledModelIds: ["model-a", "model-b", "model-d"],
        models: [
          compatibleModelConfig("model-a"),
          compatibleModelConfig("model-b"),
          compatibleModelConfig("model-d"),
        ],
        configurationVersion: 4,
      }),
    ]);
    await click(buttons(view.container, "Reload")[0]!);
    expect(models.connect).toHaveBeenCalledTimes(1);
    expect(isChecked(view.container, "model-b")).toBe(true);
    expect(isChecked(view.container, "model-d")).toBe(true);
    expect(compatibleKeyField(view.container).value).toBe("");
    expect(view.container.textContent).not.toContain("reload before saving");

    models.connect.mockResolvedValueOnce(compatibleCredential());
    await click(saveButton(view.container));
    expect(models.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedConfigurationVersion: 4 }),
    );
    expect(models.connect.mock.calls[1]?.[0]).not.toHaveProperty("apiKey");
  } finally {
    await view.unmount();
  }
});

it("sends an empty key only after Remove saved key", async () => {
  setUpCompatible();
  const view = await renderSettings();
  try {
    await click(buttons(view.container, "Remove saved key")[0]!);
    expect(compatibleKeyField(view.container).disabled).toBe(true);
    await click(saveButton(view.container));
    expect(models.connect.mock.calls[0]?.[0]).toMatchObject({ apiKey: "" });
  } finally {
    await view.unmount();
  }
});

it("offers only checked, configured models as a new connection's default", async () => {
  vi.mocked(rpc.me).mockResolvedValue(account("openai-compatible", ""));
  models.list.mockResolvedValue([compatibleEntry]);
  models.credentials.mockResolvedValue([]);
  models.probeOpenAiCompatible.mockResolvedValue({
    models: [
      { modelId: "model-known", capabilities: knownCapabilities },
      { modelId: "model-unknown", capabilities: null },
      { modelId: "model-unused", capabilities: knownCapabilities },
    ],
  });
  const view = await renderSettings();
  try {
    await typeInto(inputByLabel(view.container, "OpenAI-compatible server URL"), ENDPOINT);
    await click(buttons(view.container, "Find models")[0]!);
    expect(models.probeOpenAiCompatible).toHaveBeenCalledWith({ baseUrl: ENDPOINT });
    await click(modelCheckbox(view.container, "model-known"));
    await click(modelCheckbox(view.container, "model-unknown"));
    const select = [...view.container.querySelectorAll("label")]
      .find((label) => label.textContent?.startsWith("Default model"))
      ?.querySelector("select") as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(["", "model-known"]);
    expect(select.value).toBe("model-known");

    await click(buttons(modelRow(view.container, "model-unknown"), "Apply")[0]!);
    expect([...select.options].map((option) => option.value)).toEqual([
      "",
      "model-known",
      "model-unknown",
    ]);
    await chooseOption(select, "model-unknown");
    await click(saveButton(view.container));
    expect(models.connect.mock.calls[0]?.[0]).toMatchObject({
      baseUrl: ENDPOINT,
      modelId: "model-unknown",
    });
    expect(models.connect.mock.calls[0]?.[0]).not.toHaveProperty("credentialId");
  } finally {
    await view.unmount();
  }
});

it("sets an existing connection's default only from persisted models and shows blockers", async () => {
  setUpCompatible();
  models.probeOpenAiCompatible.mockResolvedValue({
    models: [{ modelId: "model-c", capabilities: knownCapabilities }],
  });
  const view = await renderSettings();
  try {
    await click(buttons(view.container, "Find models")[0]!);
    await click(modelCheckbox(view.container, "model-c"));
    const select = view.container.querySelector("#compatible-default-model") as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(["", "model-a", "model-b"]);
    await chooseOption(select, "model-b");
    models.setDefault.mockRejectedValueOnce(
      conflictError({
        reason: "model_effort_in_use",
        usages: [{ ...usage("model-b", "Home"), thinkingLevel: "xhigh" }],
      }),
    );
    await click(buttons(view.container, "Use this model")[0]!);
    expect(models.setDefault).toHaveBeenCalledWith({
      provider: "openai-compatible",
      modelId: "model-b",
    });
    expect(view.container.textContent).toContain(
      "Change bot reasoning effort before changing the default model.",
    );
    expect(isChecked(view.container, "model-c")).toBe(true);
  } finally {
    await view.unmount();
  }
});
