import type {
  Connection,
  LinearConnectionStatus,
  LinearOption,
  LinearTrigger,
} from "@rakazo/contracts";
import { LinearOptionsInputSchema } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { LinearRpc } from "./linear.js";
import {
  isNativeLinear,
  linearStatusLines,
  linearTriggerRows,
  loadLinearTriggerDetails,
  resolveLinearOptionNames,
} from "./linear.js";

const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const formatDate = (iso: string) => `<${iso}>`;

function status(partial: Partial<LinearConnectionStatus> = {}): LinearConnectionStatus {
  return {
    connectionId: "connection-1",
    revision: 3,
    organizationName: "Example org",
    viewerId: "viewer-1",
    connectionStatus: "connected",
    monitoring: "polling",
    webhookConfigured: false,
    webhookUrl: null,
    lastPolledAt: null,
    lastWebhookAt: null,
    lastEventAt: null,
    nextPollAt: null,
    nextSyncAt: null,
    rateLimitedUntil: null,
    errorCode: null,
    ...partial,
  };
}

const trigger: LinearTrigger = {
  connectionId: "connection-1",
  teamId: "team-1",
  events: ["issue.created", "comment.created"],
  projectId: "project-1",
  assigneeId: null,
  stateId: "state-gone",
  labelIds: ["label-1", "label-2"],
};

const connection: Connection = {
  id: "connection-1",
  connectorId: "linear",
  provider: "linear",
  displayName: "Work Linear",
  status: "connected",
  capabilities: ["automation_triggers"],
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("isNativeLinear", () => {
  it("matches only the native connector", () => {
    expect(isNativeLinear({ connectorId: "linear" })).toBe(true);
    expect(isNativeLinear({ connectorId: "composio" })).toBe(false);
  });
});

describe("linearStatusLines", () => {
  it("reports polling with successful poll and verified webhook dates", () => {
    expect(
      linearStatusLines(
        status({
          lastPolledAt: "2026-10-13T11:59:00.000Z",
          lastWebhookAt: "2026-10-13T11:58:00.000Z",
          nextSyncAt: "2026-10-13T12:01:00.000Z",
        }),
        NOW,
        formatDate,
      ),
    ).toEqual([
      "Polling",
      "Last successful poll <2026-10-13T11:59:00.000Z>",
      "Last verified webhook <2026-10-13T11:58:00.000Z>",
    ]);
  });

  it("reports idle sources as having no active automations", () => {
    expect(linearStatusLines(status({ monitoring: "idle" }), NOW, formatDate)).toEqual([
      "No active automations",
    ]);
  });

  it("asks to reconnect revoked or unauthorized accounts", () => {
    expect(
      linearStatusLines(status({ connectionStatus: "revoked", monitoring: "idle" }), NOW),
    ).toEqual(["Reconnect Linear"]);
    expect(
      linearStatusLines(
        status({ connectionStatus: "error", monitoring: "error", errorCode: "auth" }),
        NOW,
      ),
    ).toEqual(["Reconnect Linear"]);
  });

  it("shows the rate-limit deadline instead of the next sync", () => {
    expect(
      linearStatusLines(
        status({
          rateLimitedUntil: "2026-10-13T12:05:00.000Z",
          nextSyncAt: "2026-10-13T12:01:00.000Z",
        }),
        NOW,
        formatDate,
      ),
    ).toEqual(["Waiting for Linear until <2026-10-13T12:05:00.000Z>"]);
    expect(
      linearStatusLines(status({ monitoring: "error", errorCode: "rate_limit" }), NOW, formatDate),
    ).toEqual(["Waiting for Linear"]);
  });

  it("reports provider outages without upstream detail", () => {
    for (const errorCode of ["unavailable", "invalid_response"] as const) {
      expect(linearStatusLines(status({ monitoring: "error", errorCode }), NOW)).toEqual([
        "Linear is temporarily unavailable",
      ]);
    }
  });
});

describe("resolveLinearOptionNames", () => {
  it("follows every page until each id resolves", async () => {
    const loadPage = vi.fn(async (cursor: string | undefined) =>
      cursor === undefined
        ? { items: [{ id: "a", name: "Alpha" }], nextCursor: "page-2" }
        : cursor === "page-2"
          ? { items: [], nextCursor: "page-3" }
          : { items: [{ id: "c", name: "Gamma" }], nextCursor: "page-4" },
    );
    const names = await resolveLinearOptionNames(loadPage, ["a", "c"]);
    expect([...names]).toEqual([
      ["a", "Alpha"],
      ["c", "Gamma"],
    ]);
    expect(loadPage.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, "page-2", "page-3"]);
  });

  it("stops at the last page or a repeated cursor and makes no request for no ids", async () => {
    const repeating = vi.fn(async () => ({ items: [], nextCursor: "same" }));
    expect((await resolveLinearOptionNames(repeating, ["missing"])).size).toBe(0);
    expect(repeating).toHaveBeenCalledTimes(2);
    const none = vi.fn();
    expect((await resolveLinearOptionNames(none, [])).size).toBe(0);
    expect(none).not.toHaveBeenCalled();
  });
});

function fakeRpc(connections: Connection[], options: Record<string, LinearOption[]>) {
  const calls: Array<{ proc: string; body: unknown }> = [];
  const call: LinearRpc = async <T>(proc: string, body: unknown): Promise<T> => {
    calls.push({ proc, body });
    const result: unknown =
      proc === "connections/list"
        ? connections
        : { items: options[LinearOptionsInputSchema.parse(body).kind] ?? [], nextCursor: null };
    return result as T;
  };
  return { call, calls };
}

describe("Linear trigger details", () => {
  it("resolves names through options and keeps unresolved ids visible", async () => {
    const { call, calls } = fakeRpc([connection], {
      teams: [{ id: "team-1", name: "Platform" }],
      projects: [{ id: "project-1", name: "Launch" }],
      labels: [{ id: "label-1", name: "Bug" }],
    });
    const details = await loadLinearTriggerDetails(trigger, call);
    expect(calls).toContainEqual({
      proc: "linear/options",
      body: { connectionId: "connection-1", kind: "teams" },
    });
    expect(calls).toContainEqual({
      proc: "linear/options",
      body: { connectionId: "connection-1", kind: "states", teamId: "team-1" },
    });
    expect(
      calls.some(({ body }) => LinearOptionsInputSchema.safeParse(body).data?.kind === "assignees"),
    ).toBe(false);
    expect(linearTriggerRows(trigger, details)).toEqual([
      { label: "Account", value: "Work Linear" },
      { label: "Team", value: "Platform" },
      { label: "Events", value: "Issue created, Comment added" },
      { label: "Project", value: "Launch" },
      { label: "Status", value: "Unavailable (state-gone)" },
      { label: "Labels", value: "Bug, Unavailable (label-2)" },
    ]);
  });

  it("keeps the saved account label for a revoked connection without loading options", async () => {
    const { call, calls } = fakeRpc([{ ...connection, status: "revoked" }], {});
    const details = await loadLinearTriggerDetails(trigger, call);
    expect(calls.map(({ proc }) => proc)).toEqual(["connections/list"]);
    expect(linearTriggerRows(trigger, details).slice(0, 2)).toEqual([
      { label: "Account", value: "Work Linear" },
      { label: "Team", value: "Unavailable (team-1)" },
    ]);
  });

  it("shows a missing account by its id", () => {
    expect(linearTriggerRows(trigger, { accountLabel: null, names: new Map() })[0]).toEqual({
      label: "Account",
      value: "Unavailable (connection-1)",
    });
  });
});
