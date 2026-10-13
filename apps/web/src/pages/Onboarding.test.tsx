// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const rpcMock = vi.hoisted(() => ({
  me: vi.fn(),
  models: {
    list: vi.fn(),
    credentials: vi.fn(),
    connect: vi.fn(),
    setDefault: vi.fn(),
    probeOpenAiCompatible: vi.fn(),
    describeOpenAiCompatible: vi.fn(),
    probeCatalog: vi.fn(),
    beginOAuth: vi.fn(),
    cancelOAuth: vi.fn(),
    completeOAuth: vi.fn(),
    finishOAuth: vi.fn(),
    submitOAuthCode: vi.fn(),
  },
  integrationSetup: { get: vi.fn() },
}));

vi.mock("../lib/rpc", () => ({ rpc: rpcMock, selectedSpaceId: () => "space-1" }));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../components/integrations/IntegrationSetup", () => ({
  IntegrationSetup: () => <p>Integrations step</p>,
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
      (value === 1 ? one : other).replace("#", String(value)),
  };
});

import { OnboardingPage } from "./Onboarding";

const ENDPOINT = "http://127.0.0.1:8000/v1";
const capabilities = {
  thinkingLevels: ["off", "low", "high"] as ("off" | "low" | "high")[],
  defaultThinkingLevel: null,
  contextWindow: 128_000,
  maxTokens: 4096,
  supportsImages: false,
};

function credential(configurationVersion: number) {
  return {
    id: "cred-compatible",
    provider: "openai-compatible",
    label: "Local",
    hasKey: false,
    isDefault: false,
    baseUrl: ENDPOINT,
    enabledModelIds: ["model-a", "model-b"],
    models: [
      { modelId: "model-a", ...capabilities },
      { modelId: "model-b", ...capabilities },
    ],
    configurationVersion,
  };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
  await settle();
}

function button(container: HTMLElement, text: string) {
  const found = [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent === text,
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
  rpcMock.me.mockResolvedValue({
    needsModel: true,
    defaultProvider: "openai-compatible",
    defaultModel: null,
  });
  rpcMock.models.list.mockResolvedValue([
    {
      provider: "openai-compatible",
      providerName: "OpenAI-compatible",
      id: "model-a",
      label: "model-a",
      billing: "Your server",
      auth: "api-key",
    },
  ]);
  rpcMock.integrationSetup.get.mockResolvedValue({ needsSetup: true });
  rpcMock.models.credentials.mockResolvedValue([credential(3)]);
  rpcMock.models.connect.mockResolvedValue({});
});

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

it("saves an existing connection's models, then selects its default separately and retries", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<OnboardingPage />);
  });
  await settle();
  try {
    const select = [...container.querySelectorAll("label")]
      .find((label) => label.textContent?.startsWith("Default model"))
      ?.querySelector("select") as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(["", "model-a", "model-b"]);
    expect(button(container, "Continue").disabled).toBe(true);
    await act(async () => {
      select.value = "model-b";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    rpcMock.models.credentials.mockResolvedValue([credential(4)]);
    rpcMock.models.setDefault.mockRejectedValueOnce(new Error("Default model is unavailable"));
    await click(button(container, "Continue"));
    expect(rpcMock.models.connect).toHaveBeenCalledExactlyOnceWith({
      provider: "openai-compatible",
      baseUrl: ENDPOINT,
      credentialId: "cred-compatible",
      expectedConfigurationVersion: 3,
      label: "OpenAI-compatible",
      models: [
        { modelId: "model-a", ...capabilities },
        { modelId: "model-b", ...capabilities },
      ],
    });
    expect(rpcMock.models.setDefault).toHaveBeenCalledWith({
      provider: "openai-compatible",
      modelId: "model-b",
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    expect(container.textContent).not.toContain("Integrations step");

    rpcMock.models.setDefault.mockResolvedValueOnce({ ok: true });
    await click(button(container, "Continue"));
    expect(rpcMock.models.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedConfigurationVersion: 4 }),
    );
    expect(rpcMock.models.setDefault).toHaveBeenLastCalledWith({
      provider: "openai-compatible",
      modelId: "model-b",
    });
    expect(container.textContent).toContain("Integrations step");
  } finally {
    await act(async () => {
      root.unmount();
    });
  }
});
