import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  IssueTrackerIdentity,
  IssueTrackerOption,
  IssueTrackerProvider,
  Page,
} from "@rakazo/adapter-kit";
import { IssueTrackerError } from "@rakazo/adapter-kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import { sessionCookieHeader } from "./index.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
type AppHandles = Awaited<ReturnType<typeof createApp>>;
type CatalogItem = { connectorId: string; slug: string; name: string; connected: boolean };
type ConnectionRow = {
  id: string;
  connectorId: string;
  status: string;
  displayName: string;
  capabilities: string[];
};

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe : describe.skip;

const VALID_KEY = "lin_api_synthetic_valid";
const IDENTITY: IssueTrackerIdentity = {
  organizationId: "org-synthetic",
  organizationName: "Synthetic Org",
  viewerId: "viewer-synthetic",
};

const provider: IssueTrackerProvider = {
  async identity(credential) {
    if (credential !== VALID_KEY) throw new IssueTrackerError({ code: "auth", retryAt: null });
    return IDENTITY;
  },
  async options(credential, input): Promise<Page<IssueTrackerOption>> {
    if (credential !== VALID_KEY) throw new IssueTrackerError({ code: "auth", retryAt: null });
    return input.kind === "teams"
      ? { items: [{ id: "team-1", name: "Team One" }], nextCursor: "next-page" }
      : { items: [], nextCursor: null };
  },
  async changes() {
    return { items: [], nextCursor: null };
  },
  async hydrate() {
    return null;
  },
  async close() {},
};

describeWithDatabase("Native Linear connection RPCs", () => {
  let handles: AppHandles;
  let app: App;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-linear-connections-"));

  beforeAll(async () => {
    // The app reads WAKEUP_DRIVER/SANDBOX_PROVIDER at load, so it must load after the overrides above.
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      encryptionKey: "offline-linear-connection-test-key",
      signupsEnabled: "true",
      apiUrl: "http://127.0.0.1:3100",
      linearProvider: provider,
    });
    app = handles.app;
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("lists native Linear without a broker and honors catalog filters", async () => {
    const cookie = await signup(app, `linear-catalog-${stamp}@rakazo.test`);
    const linear = { connectorId: "linear", slug: "linear", name: "Linear automations" };
    expect(await rpc<CatalogItem[]>(app, cookie, "connections/catalog", {})).toContainEqual(
      expect.objectContaining({ ...linear, connected: false }),
    );
    expect(
      await rpc<CatalogItem[]>(app, cookie, "connections/catalog", { connectorId: "linear" }),
    ).toEqual([expect.objectContaining(linear)]);
    expect(
      await rpc<CatalogItem[]>(app, cookie, "connections/catalog", { query: "Automations" }),
    ).toContainEqual(expect.objectContaining(linear));
    expect(
      await rpc<CatalogItem[]>(app, cookie, "connections/catalog", { query: "github" }),
    ).not.toContainEqual(expect.objectContaining(linear));
    expect(
      await rpc<CatalogItem[]>(app, cookie, "connections/catalog", { connectorId: "composio" }),
    ).not.toContainEqual(expect.objectContaining(linear));
  });

  it("connects with an API key and keeps native rows out of the OAuth and tool paths", async () => {
    const cookie = await signup(app, `linear-connect-${stamp}@rakazo.test`);
    const begin = await raw(app, cookie, "connections/begin", {
      connectorId: "linear",
      provider: "linear",
      displayName: "Work",
    });
    expect(begin.status).toBe(400);
    expect(await begin.text()).toContain("Use an API key to connect Linear");

    const invalid = await raw(app, cookie, "linear/connect", {
      apiKey: "lin_api_wrong",
      displayName: "Work",
    });
    expect(invalid.status).toBe(400);
    const invalidText = await invalid.text();
    expect(invalidText).toContain("Check your Linear API key");
    expect(invalidText).not.toContain("lin_api_wrong");

    const connection = await rpc<ConnectionRow>(app, cookie, "linear/connect", {
      apiKey: `  ${VALID_KEY}  `,
      displayName: "Work",
    });
    expect(connection).toMatchObject({
      connectorId: "linear",
      status: "connected",
      capabilities: ["automation_triggers"],
    });
    expect(await rpc<ConnectionRow[]>(app, cookie, "connections/list")).toContainEqual(
      expect.objectContaining({ id: connection.id, capabilities: ["automation_triggers"] }),
    );
    expect(
      await rpc<CatalogItem[]>(app, cookie, "connections/catalog", { connectorId: "linear" }),
    ).toEqual([expect.objectContaining({ connected: true })]);

    const complete = await raw(app, cookie, "connections/complete", {
      connectionId: connection.id,
    });
    expect(complete.status).toBe(400);
    expect(await complete.text()).toContain("Use an API key to connect Linear");
    expect(
      await rpc<unknown[]>(app, cookie, "connections/tools", {
        connectorId: "linear",
        provider: "linear",
      }),
    ).toEqual([]);

    const status = await rpc<Record<string, unknown>>(app, cookie, "linear/status", {
      connectionId: connection.id,
    });
    expect(status).toMatchObject({
      connectionId: connection.id,
      organizationName: "Synthetic Org",
      viewerId: "viewer-synthetic",
      connectionStatus: "connected",
      monitoring: "idle",
      webhookConfigured: false,
      webhookUrl: null,
      errorCode: null,
    });
    expect(Object.keys(status).sort()).toEqual(
      [
        "connectionId",
        "revision",
        "organizationName",
        "viewerId",
        "connectionStatus",
        "monitoring",
        "webhookConfigured",
        "webhookUrl",
        "lastPolledAt",
        "lastWebhookAt",
        "lastEventAt",
        "nextPollAt",
        "nextSyncAt",
        "rateLimitedUntil",
        "errorCode",
      ].sort(),
    );
    expect(
      await rpc(app, cookie, "linear/options", { connectionId: connection.id, kind: "teams" }),
    ).toEqual({ items: [{ id: "team-1", name: "Team One" }], nextCursor: "next-page" });
    const loopbackWebhook = await raw(app, cookie, "linear/configureWebhook", {
      connectionId: connection.id,
      expectedRevision: status.revision,
      signingSecret: "whsec_synthetic",
    });
    expect(loopbackWebhook.status).toBe(400);

    const renamed = await rpc<ConnectionRow>(app, cookie, "connections/rename", {
      connectionId: connection.id,
      displayName: "Renamed",
    });
    expect(renamed).toMatchObject({ displayName: "Renamed", capabilities: ["automation_triggers"] });

    expect(
      await rpc(app, cookie, "connections/revoke", { connectionId: connection.id }),
    ).toEqual({ ok: true });
    expect(
      await rpc(app, cookie, "linear/status", { connectionId: connection.id }),
    ).toMatchObject({ connectionStatus: "revoked", monitoring: "idle" });
    const revokedSecrets = await handles.prisma.connection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    expect(revokedSecrets.secretId).toBeNull();
  });
});

async function signup(app: App, email: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ email, password: "password12", name: "Linear tester" }),
  });
  if (!response.ok) throw new Error(`signup failed ${response.status}: ${await response.text()}`);
  return sessionCookieHeader(response);
}

async function raw(app: App, cookie: string, procedure: string, body: unknown = {}) {
  return app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ json: body }),
  });
}

async function rpc<T>(app: App, cookie: string, procedure: string, body: unknown = {}): Promise<T> {
  const response = await raw(app, cookie, procedure, body);
  const text = await response.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (!response.ok || parsed.error) {
    throw new Error(`${procedure} ${response.status}: ${parsed.error?.message ?? text}`);
  }
  return parsed.json as T;
}
