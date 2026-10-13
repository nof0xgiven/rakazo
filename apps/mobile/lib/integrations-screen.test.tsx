// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Integrations from "../app/(settings)/integrations";
import { ConnectorIcon } from "../components/connector-icon";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  current: true,
  scope: vi.fn(),
  persisted: vi.fn(),
  focused: true,
}));
vi.mock("expo-router", () => ({
  useFocusEffect: (callback: () => undefined | (() => void)) => {
    useEffect(() => {
      if (state.focused) return callback();
    }, [callback, state.focused]);
  },
}));
vi.mock("./api", () => ({ rpc: state.rpc }));
vi.mock("./integrations-cache", () => ({
  integrationsCacheScope: state.scope,
  persistedIntegrationsCacheScope: state.persisted,
  isIntegrationsScopeCurrent: () => state.current,
  readIntegrationsCache: state.read,
  writeIntegrationsCache: state.write,
}));
vi.mock("./last-bot", () => ({ loadLastBotId: async () => "" }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({ destructive: "red" }) }));
vi.mock("./native", () => ({ native: {}, useThemedStyles: (factory: () => unknown) => factory() }));
vi.mock("./i18n", () => ({
  t: (text: string) => text,
  useI18n: () => ({ t: (text: string) => text }),
  dateLocaleForUi: () => "en-US",
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock("../components/row-accessories", () => ({ Chevron: () => null }));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("react-native-svg", () => ({
  SvgUri: ({ uri, onError }: { uri: string; onError: () => void }) =>
    createElement("svg", { "data-uri": uri, onClick: onError }),
}));
vi.mock("react-native", () => {
  const View = ({ children, testID }: { children?: ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  );
  return {
    View,
    ScrollView: View,
    Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
    Pressable: ({
      children,
      onPress,
      accessibilityLabel,
    }: {
      children: ReactNode;
      onPress: () => void;
      accessibilityLabel?: string;
    }) => (
      <button type="button" aria-label={accessibilityLabel} onClick={onPress}>
        {children}
      </button>
    ),
    TextInput: ({
      placeholder,
      value,
      onChangeText,
      onEndEditing,
      secureTextEntry,
      autoCorrect,
      autoCapitalize,
      importantForAutofill,
    }: {
      placeholder?: string;
      value?: string;
      onChangeText?: (value: string) => void;
      onEndEditing?: () => void;
      secureTextEntry?: boolean;
      autoCorrect?: boolean;
      autoCapitalize?: string;
      importantForAutofill?: string;
    }) => (
      <input
        data-autocapitalize={autoCapitalize}
        data-autocorrect={autoCorrect === undefined ? undefined : String(autoCorrect)}
        data-autofill={importantForAutofill}
        onBlur={onEndEditing}
        placeholder={placeholder}
        type={secureTextEntry ? "password" : "text"}
        value={value}
        onChange={(event) => onChangeText?.(event.target.value)}
      />
    ),
    Image: ({ source, onError }: { source: { uri: string }; onError: () => void }) =>
      createElement("img", { src: source.uri, onError }),
    StyleSheet: { create: (styles: unknown) => styles },
    useWindowDimensions: () => ({ width: 390 }),
    Alert: { alert: vi.fn() },
    Linking: { openURL: vi.fn() },
  };
});

const item = {
  connectorId: "test",
  slug: "example",
  name: "Example app",
  logo: "https://example.test/logo.svg",
  connected: true,
  noAuth: false,
};
const account = {
  id: "account-a",
  connectorId: "test",
  provider: "example",
  displayName: "Example",
  status: "connected",
  capabilities: [],
  createdAt: "2026-01-01",
};
let root: Root;
let container: HTMLDivElement;
let resolveCatalog: (items: (typeof item)[]) => void;
let rejectCatalog: (error: Error) => void;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.current = true;
  state.focused = true;
  state.scope.mockReset().mockResolvedValue({ userId: "user-a", spaceId: "space-a" });
  state.persisted.mockReset().mockResolvedValue(null);
  state.read.mockReset().mockReturnValue(null);
  state.write.mockReset();
  const pending = new Promise<(typeof item)[]>((resolve, reject) => {
    resolveCatalog = resolve;
    rejectCatalog = reject;
  });
  state.rpc
    .mockReset()
    .mockImplementation((proc: string) =>
      proc === "connections/catalog"
        ? pending
        : Promise.resolve(proc === "connections/list" ? [account] : []),
    );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
async function render(node: ReactNode = <Integrations />) {
  await act(async () => root.render(node));
}

it("keeps Search visible and shows rows on a cold load until the first success", async () => {
  await render();
  expect(container.querySelector('input[placeholder="Search apps"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="integrations-loading"]')?.children).toHaveLength(8);
  await act(async () => resolveCatalog([item]));
  expect(container.querySelector('[data-testid="integrations-loading"]')).toBeNull();
  expect(container.textContent).toContain("Example appAdded");
  expect(state.write).toHaveBeenCalledWith(expect.anything(), {
    catalog: [item],
    connections: [account],
  });
});
it("paints the cached list and Added state before replacing it in the background", async () => {
  state.read.mockReturnValue({ catalog: [item], connections: [account] });
  await render();
  expect(container.textContent).toContain("Example appAdded");
  expect(container.querySelector('[data-testid="integrations-loading"]')).toBeNull();
  await act(async () => resolveCatalog([{ ...item, name: "Refreshed app" }]));
  expect(container.textContent).toContain("Refreshed appAdded");
});
it("keeps cached rows after a refresh failure and offers Retry", async () => {
  state.read.mockReturnValue({ catalog: [item], connections: [account] });
  await render();
  await act(async () => rejectCatalog(new Error("Unavailable")));
  expect(container.textContent).toContain("Example appAdded");
  const retry = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry",
  );
  expect(retry).toBeDefined();
  state.rpc.mockImplementation((proc: string) =>
    Promise.resolve(
      proc === "connections/catalog" ? [item] : proc === "connections/list" ? [account] : [],
    ),
  );
  await act(async () => retry?.click());
  expect(container.textContent).not.toContain("Retry");
});
it("offers Retry on a cold failure without leaving a loading placeholder", async () => {
  await render();
  await act(async () => rejectCatalog(new Error("Unavailable")));
  expect(container.textContent).toContain("Retry");
  expect(container.querySelector('[data-testid="integrations-loading"]')).toBeNull();
});
it("ignores a refresh after its scope changes", async () => {
  await render();
  state.current = false;
  state.scope.mockRejectedValue(new Error("session changed"));
  await act(async () => resolveCatalog([item]));
  expect(container.textContent).not.toContain("Example app");
  expect(state.write).not.toHaveBeenCalled();
});
it.each(["https://example.test/logo.svg?version=1", "https://example.test/logo.SVG#icon"])(
  "renders SVG catalog artwork with SvgUri: %s",
  async (logo) => {
    await render(<ConnectorIcon name="Example" logo={logo} size={32} />);
    expect(container.querySelector("svg")?.getAttribute("data-uri")).toBe(logo);
    expect(container.querySelector("img")).toBeNull();
    await act(async () =>
      container.querySelector("svg")?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(container.textContent).toBe("E");
    await render(<ConnectorIcon name="Example" logo="https://example.test/new.svg" />);
    expect(container.querySelector("svg")).not.toBeNull();
  },
);
it("renders raster artwork with Image and falls back after failure", async () => {
  await render(<ConnectorIcon name="Example" logo="https://example.test/logo.png" />);
  expect(container.querySelector("img")?.getAttribute("src")).toContain("logo.png");
  await act(async () => container.querySelector("img")?.dispatchEvent(new Event("error")));
  expect(container.textContent).toBe("E");
});
it("falls back for absent logos and empty names", async () => {
  await render(<ConnectorIcon name=" example" logo={null} />);
  expect(container.textContent).toBe("E");
  await render(<ConnectorIcon name=" " />);
  expect(container.textContent).toBe("?");
});

it("persists a rename before a pending stale refresh can overwrite it", async () => {
  state.read.mockReturnValue({ catalog: [item], connections: [account] });
  await render();
  const added = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Added",
  );
  await act(async () => added?.click());
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "Renamed",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  state.rpc.mockImplementation((proc: string) =>
    proc === "connections/rename"
      ? Promise.resolve({ ...account, displayName: "Renamed" })
      : Promise.resolve([]),
  );
  await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(state.write).toHaveBeenLastCalledWith(expect.anything(), {
    catalog: [item],
    connections: [{ ...account, displayName: "Renamed" }],
  });
  await act(async () => resolveCatalog([item]));
  expect(container.querySelector("input")?.value).toBe("Renamed");
  expect(state.write).toHaveBeenCalledTimes(1);
});

it.each(["Remove", "Uninstall"])(
  "persists revoked Added state after %s even if the following refresh fails",
  async (action) => {
    state.read.mockReturnValue({ catalog: [item], connections: [account] });
    await render();
    const added = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Added",
    );
    await act(async () => added?.click());
    state.rpc.mockImplementation((proc: string) =>
      proc === "connections/catalog"
        ? Promise.reject(new Error("Unavailable"))
        : Promise.resolve([]),
    );
    const remove = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === action,
    );
    await act(async () => remove?.click());
    expect(state.write).toHaveBeenLastCalledWith(expect.anything(), {
      catalog: [{ ...item, connected: false }],
      connections: [{ ...account, status: "revoked" }],
    });
  },
);

it("persists a completed connection before refreshing", async () => {
  state.read.mockReturnValue({ catalog: [{ ...item, connected: false }], connections: [] });
  await render();
  state.rpc.mockImplementation((proc: string) => {
    if (proc === "connections/begin")
      return Promise.resolve({ connectionId: account.id, authorizationUrl: null });
    if (proc === "connections/complete") return Promise.resolve(account);
    if (proc === "connections/catalog") return Promise.reject(new Error("Unavailable"));
    return Promise.resolve([]);
  });
  const add = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Add",
  );
  await act(async () => add?.click());
  expect(state.write).toHaveBeenLastCalledWith(expect.anything(), {
    catalog: [item],
    connections: [account],
  });
  expect(container.textContent).toContain("Example appAdded");
});

it("paints persisted cached rows while identity is pending or offline", async () => {
  state.persisted.mockResolvedValue({ userId: "user-a", spaceId: "space-a" });
  state.read.mockReturnValue({ catalog: [item], connections: [account] });
  let rejectIdentity!: (error: Error) => void;
  state.scope.mockReturnValue(
    new Promise((_, reject) => {
      rejectIdentity = reject;
    }),
  );
  await render();
  expect(container.textContent).toContain("Example appAdded");
  expect(state.rpc).not.toHaveBeenCalled();
  await act(async () => rejectIdentity(new Error("offline")));
  expect(container.textContent).toContain("Example appAdded");
  expect(container.textContent).toContain("Retry");
});

it("rebuilds a stale space and continues refreshing while the screen stays open", async () => {
  state.read.mockReturnValue({ catalog: [item], connections: [account] });
  await render();
  state.current = false;
  state.scope.mockImplementation(async () => {
    state.current = true;
    return { userId: "user-a", spaceId: "space-b" };
  });
  state.read.mockReturnValue(null);
  state.rpc.mockImplementation((proc: string) =>
    Promise.resolve(
      proc === "connections/catalog" ? [{ ...item, name: "Recovered app", connected: false }] : [],
    ),
  );
  await act(async () => resolveCatalog([item]));
  expect(state.scope).toHaveBeenCalledTimes(2);
  expect(container.textContent).not.toContain("Example app");
  expect(container.textContent).toContain("Recovered appAdd");
  expect(state.write).toHaveBeenLastCalledWith(
    { userId: "user-a", spaceId: "space-b" },
    {
      catalog: [{ ...item, name: "Recovered app", connected: false }],
      connections: [],
    },
  );
});

it("keeps sources loading when a rename cancels the catalog refresh", async () => {
  state.read.mockReturnValue({ catalog: [item], connections: [account] });
  let resolveSources!: (value: unknown[]) => void;
  const sources = new Promise<unknown[]>((resolve) => {
    resolveSources = resolve;
  });
  const original = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((proc: string) =>
    proc === "capabilities/list" ? sources : original(proc),
  );
  await render();
  await act(async () =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === "Added")?.click(),
  );
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "Renamed",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  state.rpc.mockImplementation((proc: string) =>
    proc === "connections/rename"
      ? Promise.resolve({ ...account, displayName: "Renamed" })
      : original(proc),
  );
  await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  await act(async () => resolveCatalog([item]));
  await act(async () =>
    resolveSources([
      { id: "source-a", name: "Installed source", kind: "mcp", source: "https://example.test/mcp" },
    ]),
  );
  await act(async () =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === "Back")?.click(),
  );
  await act(async () =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === "Advanced")?.click(),
  );
  expect(container.textContent).toContain("Installed source");
  expect(container.textContent).not.toContain("No custom sources installed.");
  expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Remove")).toBe(
    true,
  );
});

it("refreshes a different space on focus return and rejects the blurred refresh", async () => {
  state.read.mockReturnValue({ catalog: [item], connections: [account] });
  await render();
  state.focused = false;
  await render();
  await act(async () => resolveCatalog([{ ...item, name: "Late old app" }]));
  expect(container.textContent).not.toContain("Late old app");
  state.current = false;
  state.scope.mockImplementation(async () => {
    state.current = true;
    return { userId: "user-a", spaceId: "space-b" };
  });
  state.read.mockReturnValue(null);
  let resolveNew!: (items: (typeof item)[]) => void;
  const pending = new Promise<(typeof item)[]>((resolve) => {
    resolveNew = resolve;
  });
  state.rpc.mockImplementation((proc: string) =>
    proc === "connections/catalog" ? pending : Promise.resolve([]),
  );
  state.focused = true;
  await render();
  expect(container.textContent).not.toContain("Example app");
  expect(container.querySelector('[data-testid="integrations-loading"]')).not.toBeNull();
  await act(async () => resolveNew([{ ...item, name: "New space app", connected: false }]));
  expect(container.textContent).toContain("New space appAdd");
  expect(state.scope).toHaveBeenCalledTimes(2);
});

it.each(["rename", "revoke", "uninstall", "connect"])(
  "rejects a late %s result after an in-place space recovery",
  async (action) => {
    state.read.mockReturnValue({ catalog: [item], connections: [account] });
    await render();
    await act(async () =>
      [...container.querySelectorAll("button")].find((b) => b.textContent === "Added")?.click(),
    );
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const original = state.rpc.getMockImplementation()!;
    state.rpc.mockImplementation((proc: string) => {
      if (
        proc === "connections/rename" ||
        proc === "connections/revoke" ||
        proc === "connections/complete"
      )
        return pending;
      if (proc === "connections/begin")
        return Promise.resolve({ connectionId: account.id, authorizationUrl: null });
      return original(proc);
    });
    if (action === "rename") {
      const input = container.querySelector("input")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          "Old space rename",
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    } else {
      const label =
        action === "revoke" ? "Remove" : action === "uninstall" ? "Uninstall" : "Add another";
      await act(async () =>
        [...container.querySelectorAll("button")].find((b) => b.textContent === label)?.click(),
      );
    }
    expect(state.rpc).toHaveBeenCalledWith(
      action === "rename"
        ? "connections/rename"
        : action === "connect"
          ? "connections/complete"
          : "connections/revoke",
      expect.anything(),
    );
    state.current = false;
    state.scope.mockImplementation(async () => {
      state.current = true;
      return { userId: "user-a", spaceId: "space-b" };
    });
    state.read.mockReturnValue(null);
    state.rpc.mockImplementation((proc: string) =>
      Promise.resolve(
        proc === "connections/catalog"
          ? [{ ...item, name: "New space app", connected: false }]
          : [],
      ),
    );
    await act(async () => resolveCatalog([item]));
    expect(container.textContent).toContain("New space appAdd");
    const writes = state.write.mock.calls.length;
    await act(async () => finish({ ...account, displayName: "Old space rename" }));
    expect(state.write).toHaveBeenCalledTimes(writes);
    expect(state.write).toHaveBeenLastCalledWith(
      { userId: "user-a", spaceId: "space-b" },
      {
        catalog: [{ ...item, name: "New space app", connected: false }],
        connections: [],
      },
    );
    expect(container.textContent).not.toContain("Old space rename");
  },
);

it("ignores an old focus identity error after the new focus succeeds", async () => {
  let failIdentity!: (reason: Error) => void;
  const pending = new Promise((_, reject) => {
    failIdentity = reject;
  });
  state.scope.mockReturnValueOnce(pending);
  await render();
  state.focused = false;
  await render();
  state.scope.mockResolvedValue({ userId: "user-a", spaceId: "space-b" });
  state.rpc.mockImplementation((proc: string) =>
    Promise.resolve(
      proc === "connections/catalog" ? [{ ...item, name: "New space app", connected: false }] : [],
    ),
  );
  state.focused = true;
  await render();
  expect(container.textContent).toContain("New space appAdd");
  await act(async () => failIdentity(new Error("Old focus failed")));
  expect(container.textContent).not.toContain("Old focus failed");
  expect(container.textContent).not.toContain("Retry");
  expect(container.textContent).toContain("New space appAdd");
});

const linearItem = {
  connectorId: "linear",
  slug: "linear",
  name: "Linear automations",
  logo: null,
  connected: false,
  noAuth: false,
};
const linearAccount = {
  id: "linear-a",
  connectorId: "linear",
  provider: "linear",
  displayName: "Linear automations",
  status: "connected",
  capabilities: ["automation_triggers"],
  createdAt: "2026-01-01",
};
const linearStatus = {
  connectionId: "linear-a",
  revision: 3,
  organizationName: "Example org",
  viewerId: "viewer-1",
  connectionStatus: "connected",
  monitoring: "polling",
  webhookConfigured: false,
  webhookUrl: null as string | null,
  lastPolledAt: null,
  lastWebhookAt: null,
  lastEventAt: null,
  nextPollAt: null,
  nextSyncAt: null,
  rateLimitedUntil: null,
  errorCode: null,
};
const linearRequest = { signal: expect.any(AbortSignal), timeoutMs: 30_000 };

function findButton(label: string) {
  return [...container.querySelectorAll("button")].find(
    (button) => button.textContent === label || button.getAttribute("aria-label") === label,
  );
}
async function press(label: string) {
  const button = findButton(label);
  expect(button, label).toBeDefined();
  await act(async () => button?.click());
}
function field(placeholder: string) {
  return container.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`);
}
async function enter(input: HTMLInputElement | null, value: string) {
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("connects native Linear with a secure API key instead of OAuth", async () => {
  state.read.mockReturnValue({ catalog: [linearItem], connections: [] });
  await render();
  state.rpc.mockImplementation((proc: string) => {
    if (proc === "linear/connect") return Promise.resolve(linearAccount);
    if (proc === "connections/catalog")
      return Promise.resolve([{ ...linearItem, connected: true }]);
    if (proc === "connections/list") return Promise.resolve([linearAccount]);
    return Promise.resolve([]);
  });
  await press("Add");
  const key = field("API key");
  expect(key?.type).toBe("password");
  expect(key?.dataset.autocorrect).toBe("false");
  expect(key?.dataset.autocapitalize).toBe("none");
  expect(key?.dataset.autofill).toBe("no");
  expect(field("Account label")?.value).toBe("Linear automations");
  await enter(key, "lin_api_synthetic");
  await press("Connect");
  expect(state.rpc).toHaveBeenCalledWith(
    "linear/connect",
    { apiKey: "lin_api_synthetic", displayName: "Linear automations" },
    linearRequest,
  );
  expect(state.rpc.mock.calls.map(([proc]) => proc)).not.toContain("connections/begin");
  expect(state.rpc.mock.calls.map(([proc]) => proc)).not.toContain("connections/tools");
  expect(field("API key")).toBeNull();
  expect(container.innerHTML).not.toContain("lin_api_synthetic");
  expect(state.write).toHaveBeenCalledWith(expect.anything(), {
    catalog: [{ ...linearItem, connected: true }],
    connections: [linearAccount],
  });
});

it("reconnects a revoked native Linear account with its current revision", async () => {
  const revoked = { ...linearAccount, status: "revoked" };
  state.read.mockReturnValue({ catalog: [linearItem], connections: [revoked] });
  await render();
  state.rpc.mockImplementation((proc: string) => {
    if (proc === "linear/status")
      return Promise.resolve({
        ...linearStatus,
        revision: 7,
        connectionStatus: "revoked",
        monitoring: "idle",
      });
    if (proc === "linear/connect") return Promise.resolve(linearAccount);
    return Promise.resolve([]);
  });
  await press("Add");
  expect(findButton("Remove")).toBeUndefined();
  await press("Reconnect");
  expect(field("Account label")?.value).toBe("Linear automations");
  await enter(field("API key"), "lin_api_replacement");
  await press("Connect");
  expect(state.rpc).toHaveBeenCalledWith(
    "linear/connect",
    {
      apiKey: "lin_api_replacement",
      displayName: "Linear automations",
      connectionId: "linear-a",
      expectedRevision: 7,
    },
    linearRequest,
  );
  expect(field("API key")).toBeNull();
});

it("saves and removes a Linear webhook signing secret without keeping it", async () => {
  state.read.mockReturnValue({
    catalog: [{ ...linearItem, connected: true }],
    connections: [linearAccount],
  });
  await render();
  let current = {
    ...linearStatus,
    webhookUrl: "https://api.example.test/api/integrations/linear/linear-a/webhook",
  };
  state.rpc.mockImplementation((proc: string, body: { signingSecret?: string | null } = {}) => {
    if (proc === "linear/status") return Promise.resolve(current);
    if (proc === "linear/configureWebhook") {
      current = {
        ...current,
        revision: current.revision + 1,
        webhookConfigured: body.signingSecret !== null,
      };
      return Promise.resolve(current);
    }
    return Promise.resolve([]);
  });
  await press("Added");
  await press("Details");
  expect(container.textContent).toContain("Polling");
  await press("Webhooks");
  expect(container.textContent).toContain(current.webhookUrl);
  expect(field("Signing secret")?.type).toBe("password");
  await enter(field("Signing secret"), "whsec_synthetic");
  await press("Save");
  expect(state.rpc).toHaveBeenCalledWith(
    "linear/configureWebhook",
    { connectionId: "linear-a", expectedRevision: 3, signingSecret: "whsec_synthetic" },
    linearRequest,
  );
  expect(field("Signing secret")?.value).toBe("");
  await press("Remove webhook");
  expect(state.rpc).toHaveBeenLastCalledWith(
    "linear/configureWebhook",
    { connectionId: "linear-a", expectedRevision: 4, signingSecret: null },
    linearRequest,
  );
  expect(findButton("Remove webhook")).toBeUndefined();
});

it("explains webhooks need a public HTTPS API URL on loopback installs", async () => {
  state.read.mockReturnValue({
    catalog: [{ ...linearItem, connected: true }],
    connections: [linearAccount],
  });
  await render();
  state.rpc.mockImplementation((proc: string) =>
    Promise.resolve(
      proc === "linear/status"
        ? { ...linearStatus, rateLimitedUntil: "2999-01-01T00:00:00.000Z" }
        : [],
    ),
  );
  await press("Added");
  await press("Details");
  expect(container.textContent).toContain("Waiting for Linear until");
  expect(container.textContent).toContain("Webhooks require a public HTTPS API URL.");
  expect(findButton("Webhooks")).toBeUndefined();
});

it("drops a late Linear connect after leaving the sheet and clears the key", async () => {
  state.read.mockReturnValue({ catalog: [linearItem], connections: [] });
  await render();
  let finish!: (row: unknown) => void;
  const late = new Promise((resolve) => {
    finish = resolve;
  });
  state.rpc.mockImplementation((proc: string) =>
    proc === "linear/connect" ? late : Promise.resolve([]),
  );
  await press("Add");
  await enter(field("API key"), "lin_api_synthetic");
  await press("Connect");
  const request = state.rpc.mock.calls.find(([proc]) => proc === "linear/connect");
  const writes = state.write.mock.calls.length;
  state.focused = false;
  await render();
  expect(request?.[2].signal.aborted).toBe(true);
  await act(async () => finish(linearAccount));
  expect(state.write).toHaveBeenCalledTimes(writes);
  expect(field("API key")).toBeNull();
  expect(container.innerHTML).not.toContain("lin_api_synthetic");
});
