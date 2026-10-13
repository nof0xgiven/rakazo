import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const { eligibleLinearTriggerWhere, lockLinearSources, recordLinearEvent } = vi.hoisted(() => ({
  eligibleLinearTriggerWhere: vi.fn((source: { connectionId: string }) => ({
    eligibleFor: source.connectionId,
  })),
  lockLinearSources: vi.fn(),
  recordLinearEvent: vi.fn(),
}));

vi.mock("@rakazo/adapters", () => ({
  LINEAR_PUBLIC_HOSTS: ["linear.app"],
  eligibleLinearTriggerWhere,
  lockLinearSources,
  recordLinearEvent,
}));

import {
  LINEAR_WEBHOOK_MAX_BODY_BYTES,
  LINEAR_WEBHOOK_RESPONSE_BUDGET_MS,
  type LinearWebhookDeps,
  linearWebhookPath,
  mountLinearWebhookHttpRoutes,
} from "./linear-webhook.js";

const SIGNING_SECRET = "lin_wh_synthetic_signing_secret_0001";
const CONNECTION_ID = "conn_linear_1";
const ORGANIZATION_ID = "org-synthetic-1";
const NOW_MS = Date.UTC(2026, 9, 13, 12, 0, 0, 0);
const ISSUE_CREATED_AT = "2026-10-13T11:58:00.123Z";
const ISSUE_UPDATED_AT = "2026-10-13T11:59:30.456Z";

type SourceRow = {
  connectionId: string;
  organizationId: string;
  generation: number;
  webhookRevision: number;
  connection: { connectorId: string; status: string; userId: string; spaceId: string };
  webhookSecret: {
    id: string;
    ciphertext: string;
    kind: string;
    userId: string;
    spaceId: string;
  } | null;
};

const SECRET_ROW = {
  id: "secret-wh-1",
  ciphertext: "cipher-wh-1",
  kind: "webhook",
  userId: "user-1",
  spaceId: "space-1",
};

function sourceRow(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    connectionId: CONNECTION_ID,
    organizationId: ORGANIZATION_ID,
    generation: 3,
    webhookRevision: 2,
    connection: {
      connectorId: "linear",
      status: "connected",
      userId: "user-1",
      spaceId: "space-1",
    },
    webhookSecret: SECRET_ROW,
    ...overrides,
  };
}

function lockedSource(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: CONNECTION_ID,
    organizationId: ORGANIZATION_ID,
    generation: 3,
    webhookRevision: 2,
    webhookSecretId: "secret-wh-1",
    errorCode: null,
    monitoringSince: new Date("2026-10-13T11:00:00.000Z"),
    connection: {
      id: CONNECTION_ID,
      spaceId: "space-1",
      userId: "user-1",
      status: "connected",
      secretId: "secret-key-1",
      displayName: "Synthetic",
    },
    ...overrides,
  };
}

type TransactionClient = {
  $executeRaw: Mock;
  $queryRaw: Mock;
  linearSource: { update: Mock };
  routineLinearTrigger: { findFirst: Mock };
};
type TransactionCallback = (client: TransactionClient) => Promise<unknown>;
type TransactionOptions = { maxWait: number; timeout: number };

function createHarness(
  options: {
    source?: SourceRow | null;
    findError?: Error;
    findUnique?: () => Promise<SourceRow | null>;
    load?: (
      ciphertext: string,
      context: { recordId: string; signal: AbortSignal },
    ) => Promise<string>;
    membership?: boolean;
    subscription?: boolean;
    locked?: Record<string, unknown> | null;
    transactionError?: Error;
    transaction?: (
      fn: TransactionCallback,
      transactionOptions: TransactionOptions,
      tx: TransactionClient,
    ) => Promise<unknown>;
    enqueue?: () => Promise<void>;
  } = {},
) {
  const update = vi.fn(async () => ({}));
  const executeRaw = vi.fn(async () => 1);
  const queryRaw = vi.fn(async () => (options.membership === false ? [] : [{ locked: 1 }]));
  const findFirst = vi.fn(async () =>
    options.subscription === false ? null : { routineId: "routine-1" },
  );
  const tx: TransactionClient = {
    $executeRaw: executeRaw,
    $queryRaw: queryRaw,
    linearSource: { update },
    routineLinearTrigger: { findFirst },
  };
  const findUnique = vi.fn(
    options.findUnique ??
      (async () => {
        if (options.findError) throw options.findError;
        return options.source === undefined ? sourceRow() : options.source;
      }),
  );
  const transaction = vi.fn(
    async (fn: TransactionCallback, transactionOptions: TransactionOptions) => {
      if (options.transaction) return options.transaction(fn, transactionOptions, tx);
      if (options.transactionError) throw options.transactionError;
      return fn(tx);
    },
  );
  const load = vi.fn(options.load ?? (async () => SIGNING_SECRET));
  const enqueue = vi.fn(options.enqueue ?? (async () => undefined));
  lockLinearSources.mockImplementation(async () => {
    const locked = options.locked === undefined ? lockedSource() : options.locked;
    return new Map(locked ? [[CONNECTION_ID, locked]] : []);
  });
  const deps = {
    prisma: { linearSource: { findUnique }, $transaction: transaction },
    secrets: { load, onChange: () => () => undefined },
    jobs: { enqueue },
  } as unknown as LinearWebhookDeps;
  const app = new Hono();
  mountLinearWebhookHttpRoutes(app, deps);
  return { app, findUnique, transaction, load, enqueue, update, queryRaw, executeRaw, findFirst };
}

function sign(raw: Uint8Array | string, secret = SIGNING_SECRET): string {
  return createHmac("sha256", secret).update(raw).digest("hex");
}

function issueData(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    identifier: "SYN-1",
    title: "Synthetic issue",
    description: "Synthetic description",
    createdAt: ISSUE_CREATED_AT,
    updatedAt: ISSUE_CREATED_AT,
    teamId: "team-1",
    projectId: null,
    stateId: "state-1",
    labelIds: ["label-b", "label-a"],
    ...overrides,
  };
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    action: "create",
    type: "Issue",
    organizationId: ORGANIZATION_ID,
    webhookTimestamp: NOW_MS - 1_500,
    webhookId: "webhook-1",
    url: "https://linear.app/synthetic/issue/SYN-1/synthetic-issue",
    createdAt: "2026-10-13T11:59:58.500Z",
    data: issueData(),
    ...overrides,
  };
}

async function deliver(
  app: Hono,
  body: unknown,
  options: {
    raw?: Uint8Array<ArrayBuffer> | string;
    signature?: string;
    event?: string | null;
    delivery?: string | null;
    headers?: Record<string, string>;
  } = {},
) {
  const raw = options.raw ?? JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "linear-signature": options.signature ?? sign(raw),
    ...options.headers,
  };
  const event =
    options.event === undefined ? (body as { type?: string } | undefined)?.type : options.event;
  if (event) headers["linear-event"] = event;
  const delivery = options.delivery === undefined ? "delivery-1" : options.delivery;
  if (delivery !== null) headers["linear-delivery"] = delivery;
  return app.request(linearWebhookPath(CONNECTION_ID), { method: "POST", headers, body: raw });
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW_MS, toFake: ["Date"] });
  lockLinearSources.mockReset();
  recordLinearEvent.mockReset();
  recordLinearEvent.mockResolvedValue("accepted");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Linear webhook ingress", () => {
  it("records a signed Issue/create seed without raw envelope data and enqueues sync", async () => {
    const h = createHarness();
    const res = await deliver(h.app, envelope());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(h.load).toHaveBeenCalledWith("cipher-wh-1", {
      recordId: "secret-wh-1",
      signal: expect.any(AbortSignal),
    });
    expect(h.executeRaw).toHaveBeenCalledOnce();
    expect(h.queryRaw).toHaveBeenCalledOnce();
    expect(lockLinearSources).toHaveBeenCalledWith(expect.anything(), [CONNECTION_ID]);
    expect(recordLinearEvent).toHaveBeenCalledWith(expect.anything(), lockedSource(), {
      transport: "webhook",
      deliveryId: "delivery-1",
      receivedAt: new Date(NOW_MS),
      seed: {
        kind: "issue.created",
        entityId: "issue-1",
        issueId: "issue-1",
        occurredAt: "2026-10-13T11:58:00.123Z",
        issue: {
          id: "issue-1",
          identifier: "SYN-1",
          title: "Synthetic issue",
          description: "Synthetic description",
          url: "https://linear.app/synthetic/issue/SYN-1/synthetic-issue",
          createdAt: "2026-10-13T11:58:00.123Z",
          updatedAt: "2026-10-13T11:58:00.123Z",
          teamId: "team-1",
          projectId: null,
          assigneeId: null,
          stateId: "state-1",
          labelIds: ["label-b", "label-a"],
        },
      },
    });
    expect(h.update).toHaveBeenCalledWith({
      where: { connectionId: CONNECTION_ID },
      data: { lastWebhookAt: new Date(NOW_MS) },
    });
    expect(h.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { connectionId: CONNECTION_ID },
        replaceKey: `linear.sync:${CONNECTION_ID}`,
      }),
    );
  });

  it("uses updatedAt for Issue/update occurrences at millisecond precision", async () => {
    const h = createHarness();
    const res = await deliver(
      h.app,
      envelope({
        action: "update",
        data: issueData({ updatedAt: "2026-10-13T13:59:30.456+02:00" }),
        updatedFrom: { stateId: "state-0", updatedAt: ISSUE_CREATED_AT },
      }),
    );

    expect(res.status).toBe(200);
    const [, , input] = recordLinearEvent.mock.calls[0] ?? [];
    expect(input.seed).toMatchObject({
      kind: "issue.updated",
      entityId: "issue-1",
      occurredAt: ISSUE_UPDATED_AT,
      issue: { updatedAt: ISSUE_UPDATED_AT, createdAt: ISSUE_CREATED_AT },
    });
    expect(input.seed).not.toHaveProperty("updatedFrom");
  });

  it("ignores Issue/update whose updatedAt equals createdAt", async () => {
    const h = createHarness();
    const res = await deliver(
      h.app,
      envelope({
        action: "update",
        data: issueData({
          createdAt: "2026-10-13T11:58:00.123Z",
          updatedAt: "2026-10-13T13:58:00.123+02:00",
        }),
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, ignored: true });
    expect(h.transaction).not.toHaveBeenCalled();
    expect(recordLinearEvent).not.toHaveBeenCalled();
  });

  it("records Comment/create using comment creation time", async () => {
    const h = createHarness();
    const res = await deliver(
      h.app,
      envelope({
        type: "Comment",
        url: "https://linear.app/synthetic/issue/SYN-1#comment-1",
        data: {
          id: "comment-1",
          body: "Synthetic comment",
          issueId: "issue-1",
          userId: "user-linear-1",
          createdAt: "2026-10-13T11:59:00Z",
          updatedAt: "2026-10-13T11:59:00Z",
        },
      }),
    );

    expect(res.status).toBe(200);
    const [, , input] = recordLinearEvent.mock.calls[0] ?? [];
    expect(input.seed).toEqual({
      kind: "comment.created",
      entityId: "comment-1",
      issueId: "issue-1",
      occurredAt: "2026-10-13T11:59:00.000Z",
      comment: {
        id: "comment-1",
        body: "Synthetic comment",
        url: "https://linear.app/synthetic/issue/SYN-1#comment-1",
        createdAt: "2026-10-13T11:59:00.000Z",
        authorId: "user-linear-1",
      },
    });
  });

  it("drops non-Linear URLs from the seed", async () => {
    const h = createHarness();
    await deliver(h.app, envelope({ url: "https://linear.app.evil.example/issue/SYN-1" }));
    const [, , input] = recordLinearEvent.mock.calls[0] ?? [];
    expect(input.seed.issue.url).toBeNull();
  });

  it.each([
    ["Issue", "remove", issueData()],
    [
      "Comment",
      "update",
      { id: "comment-1", body: "x", issueId: "issue-1", createdAt: ISSUE_CREATED_AT },
    ],
    [
      "Comment",
      "remove",
      { id: "comment-1", body: "x", issueId: "issue-1", createdAt: ISSUE_CREATED_AT },
    ],
    [
      "Comment",
      "create",
      {
        id: "comment-2",
        body: "x",
        issueId: null,
        projectUpdateId: "pu-1",
        createdAt: ISSUE_CREATED_AT,
      },
    ],
    ["Project", "create", { id: "project-1", name: "Synthetic" }],
    ["IssueLabel", "update", { id: "label-1" }],
  ])("acknowledges unsupported %s/%s deliveries without recording", async (type, action, data) => {
    const h = createHarness();
    const res = await deliver(h.app, envelope({ type, action, data }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, ignored: true });
    expect(recordLinearEvent).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("ignores correctly signed deliveries older than the tolerance", async () => {
    const h = createHarness();
    const res = await deliver(h.app, envelope({ webhookTimestamp: NOW_MS - 60_001 }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, ignored: true });
    expect(h.transaction).not.toHaveBeenCalled();
    expect(recordLinearEvent).not.toHaveBeenCalled();
  });

  it("accepts timestamps exactly at the tolerance boundary", async () => {
    const h = createHarness();
    expect((await deliver(h.app, envelope({ webhookTimestamp: NOW_MS - 60_000 }))).status).toBe(
      200,
    );
    expect((await deliver(h.app, envelope({ webhookTimestamp: NOW_MS + 60_000 }))).status).toBe(
      200,
    );
    expect(recordLinearEvent).toHaveBeenCalledTimes(2);
  });

  it("rejects future timestamps beyond the tolerance", async () => {
    const h = createHarness();
    const res = await deliver(h.app, envelope({ webhookTimestamp: NOW_MS + 60_001 }));
    expect(res.status).toBe(401);
    expect(recordLinearEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["string", String(NOW_MS)],
    ["missing", undefined],
    ["null", null],
  ])("rejects a %s webhookTimestamp", async (_label, value) => {
    const h = createHarness();
    const res = await deliver(h.app, envelope({ webhookTimestamp: value }));
    expect(res.status).toBe(400);
    expect(recordLinearEvent).not.toHaveBeenCalled();
  });

  it("does not trust the unsigned timestamp header", async () => {
    const h = createHarness();
    const res = await deliver(h.app, envelope({ webhookTimestamp: NOW_MS - 120_000 }), {
      headers: { "linear-timestamp": String(NOW_MS) },
    });
    await expect(res.json()).resolves.toEqual({ ok: true, ignored: true });
    expect(recordLinearEvent).not.toHaveBeenCalled();
  });

  it("rejects a bad HMAC", async () => {
    const h = createHarness();
    const raw = JSON.stringify(envelope());
    const res = await deliver(h.app, undefined, {
      raw,
      event: "Issue",
      signature: sign(raw, "lin_wh_wrong_secret"),
    });
    expect(res.status).toBe(401);
    expect(recordLinearEvent).not.toHaveBeenCalled();
  });

  it("rejects a GitHub-style sha256= prefixed signature", async () => {
    const h = createHarness();
    const raw = JSON.stringify(envelope());
    const res = await deliver(h.app, undefined, {
      raw,
      event: "Issue",
      signature: `sha256=${sign(raw)}`,
    });
    expect(res.status).toBe(401);
    expect(recordLinearEvent).not.toHaveBeenCalled();
  });

  it("rejects signatures that are not exactly 64 hex characters", async () => {
    const h = createHarness();
    const raw = JSON.stringify(envelope());
    for (const signature of [sign(raw).slice(0, 63), `${sign(raw)}0`, "", "z".repeat(64)]) {
      const res = await deliver(h.app, undefined, { raw, event: "Issue", signature });
      expect(res.status).toBe(401);
    }
    expect(recordLinearEvent).not.toHaveBeenCalled();
  });

  it("verifies the signature over exact raw bytes", async () => {
    const h = createHarness();
    const raw = `${JSON.stringify(envelope({ data: issueData({ title: "Synthétique ✓" }) }), null, 2)}\n`;
    const res = await deliver(h.app, undefined, { raw, event: "Issue" });
    expect(res.status).toBe(200);
    const [, , input] = recordLinearEvent.mock.calls[0] ?? [];
    expect(input.seed.issue.title).toBe("Synthétique ✓");

    const tampered = raw.replace("Synthétique", "Synthetique");
    const rejected = await deliver(h.app, undefined, {
      raw: tampered,
      event: "Issue",
      signature: sign(raw),
    });
    expect(rejected.status).toBe(401);
  });

  it("rejects a signed delivery for another organization", async () => {
    const h = createHarness();
    const res = await deliver(h.app, envelope({ organizationId: "org-synthetic-2" }));
    expect(res.status).toBe(401);
    expect(recordLinearEvent).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies before looking up the source", async () => {
    const h = createHarness();
    const raw = new Uint8Array(LINEAR_WEBHOOK_MAX_BODY_BYTES + 1).fill(0x20);
    const res = await deliver(h.app, undefined, { raw, event: "Issue", signature: sign(raw) });
    expect(res.status).toBe(413);
    expect(h.findUnique).not.toHaveBeenCalled();
    expect(recordLinearEvent).not.toHaveBeenCalled();

    const declared = await deliver(h.app, envelope(), {
      headers: { "content-length": String(LINEAR_WEBHOOK_MAX_BODY_BYTES + 1) },
    });
    expect(declared.status).toBe(413);
    expect(h.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ["missing teamId", { teamId: undefined }],
    ["missing labelIds", { labelIds: undefined }],
    ["non-string label", { labelIds: ["label-a", 7] }],
    ["missing identifier", { identifier: undefined }],
    ["missing title", { title: undefined }],
    ["unparseable createdAt", { createdAt: "yesterday" }],
    ["date-only createdAt", { createdAt: "2026-10-13" }],
    ["missing updatedAt", { updatedAt: undefined }],
    ["overlong id", { id: "i".repeat(101) }],
    ["non-string projectId", { projectId: 12 }],
    ["non-string description", { description: { text: "x" } }],
  ])("rejects partial issue data (%s)", async (_label, patch) => {
    const h = createHarness();
    const res = await deliver(h.app, envelope({ data: issueData(patch) }));
    expect(res.status).toBe(400);
    expect(recordLinearEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["missing body", { id: "comment-1", issueId: "issue-1", createdAt: ISSUE_CREATED_AT }],
    ["missing createdAt", { id: "comment-1", body: "x", issueId: "issue-1" }],
    ["missing id", { body: "x", issueId: "issue-1", createdAt: ISSUE_CREATED_AT }],
    ["non-string issueId", { id: "comment-1", body: "x", issueId: 5, createdAt: ISSUE_CREATED_AT }],
  ])("rejects partial comment data (%s)", async (_label, data) => {
    const h = createHarness();
    const res = await deliver(h.app, envelope({ type: "Comment", data }));
    expect(res.status).toBe(400);
    expect(recordLinearEvent).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and non-object bodies after verifying the signature", async () => {
    const h = createHarness();
    for (const raw of ["{", "[]", "null"]) {
      const res = await deliver(h.app, undefined, { raw, event: "Issue" });
      expect(res.status).toBe(400);
    }
    const invalidUtf8 = new Uint8Array([0x7b, 0xff, 0x7d]);
    const res = await deliver(h.app, undefined, { raw: invalidUtf8, event: "Issue" });
    expect(res.status).toBe(400);
    expect(recordLinearEvent).not.toHaveBeenCalled();
  });

  it("rejects a Linear-Event header that does not match the body type", async () => {
    const h = createHarness();
    expect((await deliver(h.app, envelope(), { event: "Comment" })).status).toBe(400);
    expect((await deliver(h.app, envelope(), { event: null })).status).toBe(400);
    expect(recordLinearEvent).not.toHaveBeenCalled();
  });

  it("requires a nonempty Linear-Delivery of at most 200 characters", async () => {
    const h = createHarness();
    expect((await deliver(h.app, envelope(), { delivery: null })).status).toBe(400);
    expect((await deliver(h.app, envelope(), { delivery: "d".repeat(201) })).status).toBe(400);
    expect(recordLinearEvent).not.toHaveBeenCalled();
    expect((await deliver(h.app, envelope(), { delivery: "d".repeat(200) })).status).toBe(200);
  });

  it.each([
    ["unknown", null],
    ["revoked", sourceRow({ connection: { ...sourceRow().connection, status: "revoked" } })],
    ["unconfigured", sourceRow({ webhookSecret: null })],
    [
      "non-native",
      sourceRow({ connection: { ...sourceRow().connection, connectorId: "composio" } }),
    ],
    ["foreign secret", sourceRow({ webhookSecret: { ...SECRET_ROW, userId: "user-2" } })],
    ["wrong secret kind", sourceRow({ webhookSecret: { ...SECRET_ROW, kind: "connector" } })],
  ])("returns 404 for %s sources", async (_label, source) => {
    const h = createHarness({ source });
    const res = await deliver(h.app, envelope());
    expect(res.status).toBe(404);
    expect(h.load).not.toHaveBeenCalled();
    expect(recordLinearEvent).not.toHaveBeenCalled();
  });

  it("returns 503 when lookup or decryption fails", async () => {
    const lookup = createHarness({ findError: new Error("db down") });
    expect((await deliver(lookup.app, envelope())).status).toBe(503);
    const decrypt = createHarness({
      load: async () => {
        throw new Error("Encrypted secret is malformed");
      },
    });
    expect((await deliver(decrypt.app, envelope())).status).toBe(503);
    expect(recordLinearEvent).not.toHaveBeenCalled();
  });

  it("returns 503 when the transaction fails", async () => {
    const h = createHarness({ transactionError: new Error("db down") });
    const res = await deliver(h.app, envelope());
    expect(res.status).toBe(503);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ["rotated secret", { webhookSecretId: "secret-wh-2" }],
    ["webhook revision", { webhookRevision: 3 }],
    ["generation", { generation: 4 }],
    ["organization", { organizationId: "org-synthetic-2" }],
  ])("returns 503 when the %s changed before commit", async (_label, patch) => {
    const h = createHarness({ locked: lockedSource(patch) });
    const res = await deliver(h.app, envelope());
    expect(res.status).toBe(503);
    expect(recordLinearEvent).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it("returns 404 when the source was revoked or unconfigured before commit", async () => {
    const removed = createHarness({ locked: lockedSource({ webhookSecretId: null }) });
    expect((await deliver(removed.app, envelope())).status).toBe(404);
    const revoked = createHarness({
      locked: lockedSource({ connection: { ...lockedSource().connection, status: "revoked" } }),
    });
    expect((await deliver(revoked.app, envelope())).status).toBe(404);
    const gone = createHarness({ locked: null });
    expect((await deliver(gone.app, envelope())).status).toBe(404);
    expect(recordLinearEvent).not.toHaveBeenCalled();
  });

  it.each([
    [
      "auth-error source",
      {
        locked: lockedSource({
          errorCode: "auth",
          connection: { ...lockedSource().connection, status: "error" },
        }),
      },
    ],
    ["missing membership", { membership: false }],
  ])("verifies then ignores deliveries for a %s", async (_label, options) => {
    const h = createHarness(options);
    const res = await deliver(h.app, envelope());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, ignored: true });
    expect(recordLinearEvent).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();

    const forged = await deliver(h.app, envelope(), { signature: "0".repeat(64) });
    expect(forged.status).toBe(401);
  });

  it("ignores deliveries the event ledger itself declines", async () => {
    recordLinearEvent.mockResolvedValue("ignored");
    const h = createHarness();
    const res = await deliver(h.app, envelope());
    await expect(res.json()).resolves.toEqual({ ok: true, ignored: true });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("checks for an eligible subscription of the event kind activated before the occurrence", async () => {
    const h = createHarness();
    await deliver(h.app, envelope());
    expect(eligibleLinearTriggerWhere).toHaveBeenCalledWith({
      connectionId: CONNECTION_ID,
      spaceId: "space-1",
      userId: "user-1",
    });
    expect(h.findFirst).toHaveBeenCalledWith({
      where: {
        AND: [
          { eligibleFor: CONNECTION_ID },
          { events: { has: "issue.created" }, activatedAt: { lt: new Date(ISSUE_CREATED_AT) } },
        ],
      },
      select: { routineId: true },
    });
  });

  it("ignores a replayed delivery after every subscription is paused", async () => {
    recordLinearEvent.mockResolvedValue("duplicate");
    const h = createHarness({ subscription: false });
    const res = await deliver(h.app, envelope(), { delivery: "delivery-replay" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, ignored: true });
    expect(recordLinearEvent).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ["idle source", null],
    ["occurrence before monitoring", new Date(ISSUE_CREATED_AT)],
  ])("ignores deliveries for an %s", async (_label, monitoringSince) => {
    recordLinearEvent.mockResolvedValue("duplicate");
    const h = createHarness({ locked: lockedSource({ monitoringSince }) });
    const res = await deliver(h.app, envelope());
    await expect(res.json()).resolves.toEqual({ ok: true, ignored: true });
    expect(h.findFirst).not.toHaveBeenCalled();
    expect(recordLinearEvent).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("acknowledges duplicates and records webhook receipt time without enqueueing", async () => {
    recordLinearEvent.mockResolvedValue("duplicate");
    const h = createHarness();
    const res = await deliver(h.app, envelope(), { delivery: "delivery-replay" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(h.update).toHaveBeenCalledOnce();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("does not wait for or fail on the sync enqueue", async () => {
    const pending = createHarness({ enqueue: () => new Promise<void>(() => undefined) });
    expect((await deliver(pending.app, envelope())).status).toBe(200);
    const failing = createHarness({
      enqueue: async () => {
        throw new Error("queue down");
      },
    });
    expect((await deliver(failing.app, envelope())).status).toBe(200);
  });

  it("decrypts the signing secret once across deliveries", async () => {
    const h = createHarness();
    await deliver(h.app, envelope(), { delivery: "delivery-a" });
    await deliver(h.app, envelope(), { delivery: "delivery-b" });
    expect(h.load).toHaveBeenCalledOnce();
  });
});

describe("Linear webhook response budget", () => {
  const conflict = () => Object.assign(new Error("serialization conflict"), { code: "P2034" });

  it("keeps the whole ingress budget under five seconds", () => {
    expect(LINEAR_WEBHOOK_RESPONSE_BUDGET_MS).toBeLessThan(5_000);
  });

  it("answers 503 by the deadline and cancels a stalled upload", async () => {
    vi.useFakeTimers({ now: NOW_MS, toFake: ["Date", "setTimeout", "clearTimeout"] });
    const h = createHarness();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"action":"create",'));
      },
      cancel() {
        cancelled = true;
      },
    });
    let settled = false;
    const pending = Promise.resolve(
      h.app.request(linearWebhookPath(CONNECTION_ID), {
        method: "POST",
        headers: { "linear-signature": "0".repeat(64), "linear-event": "Issue" },
        body,
        duplex: "half",
      } as RequestInit),
    ).then((res) => {
      settled = true;
      return res;
    });
    await vi.advanceTimersByTimeAsync(LINEAR_WEBHOOK_RESPONSE_BUDGET_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe(503);
    expect(cancelled).toBe(true);
    expect(h.findUnique).not.toHaveBeenCalled();
  });

  it("answers 503 at the deadline when the source lookup stalls", async () => {
    vi.useFakeTimers({ now: NOW_MS, toFake: ["Date", "setTimeout", "clearTimeout"] });
    const h = createHarness({ findUnique: () => new Promise<SourceRow | null>(() => undefined) });
    let settled = false;
    const pending = deliver(h.app, envelope()).then((res) => {
      settled = true;
      return res;
    });
    await vi.advanceTimersByTimeAsync(LINEAR_WEBHOOK_RESPONSE_BUDGET_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe(503);
    expect(h.load).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("aborts a stalled decrypt at the deadline and retries it on the next delivery", async () => {
    vi.useFakeTimers({ now: NOW_MS, toFake: ["Date", "setTimeout", "clearTimeout"] });
    const signals: AbortSignal[] = [];
    const h = createHarness({
      load: (_ciphertext, context) => {
        signals.push(context.signal);
        return new Promise<string>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    });
    const first = deliver(h.app, envelope());
    await vi.advanceTimersByTimeAsync(LINEAR_WEBHOOK_RESPONSE_BUDGET_MS);
    expect((await first).status).toBe(503);
    expect(signals[0]?.aborted).toBe(true);
    expect(h.transaction).not.toHaveBeenCalled();

    const second = deliver(h.app, envelope({ webhookTimestamp: Date.now() }));
    await vi.advanceTimersByTimeAsync(LINEAR_WEBHOOK_RESPONSE_BUDGET_MS);
    expect((await second).status).toBe(503);
    expect(h.load).toHaveBeenCalledTimes(2);
    expect(signals[1]?.aborted).toBe(true);
  });

  it("returns 503 after exhausting transaction conflict retries", async () => {
    const h = createHarness({ transactionError: conflict() });
    const res = await deliver(h.app, envelope());
    expect(res.status).toBe(503);
    expect(h.transaction).toHaveBeenCalledTimes(3);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("stops retrying once the remaining budget is spent", async () => {
    const budgets: number[] = [];
    const h = createHarness({
      transaction: async (_fn, transactionOptions) => {
        budgets.push(transactionOptions.maxWait + transactionOptions.timeout);
        vi.setSystemTime(Date.now() + 2_000);
        throw conflict();
      },
    });
    const res = await deliver(h.app, envelope());
    expect(res.status).toBe(503);
    expect(h.transaction).toHaveBeenCalledTimes(2);
    expect(budgets).toEqual([
      LINEAR_WEBHOOK_RESPONSE_BUDGET_MS - 250,
      LINEAR_WEBHOOK_RESPONSE_BUDGET_MS - 250 - 2_000,
    ]);
  });

  it("bounds statements and lock waits by the transaction timeout", async () => {
    let timeout = 0;
    const h = createHarness({
      transaction: async (fn, transactionOptions, tx) => {
        timeout = transactionOptions.timeout;
        return fn(tx);
      },
    });
    expect((await deliver(h.app, envelope())).status).toBe(200);
    expect(timeout).toBeGreaterThan(0);
    expect(h.executeRaw.mock.calls[0]?.slice(1)).toEqual([String(timeout), String(timeout)]);
  });

  it("rolls back work that finishes past the deadline instead of committing it", async () => {
    recordLinearEvent.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + LINEAR_WEBHOOK_RESPONSE_BUDGET_MS);
      return "accepted";
    });
    let rolledBack = false;
    const h = createHarness({
      transaction: async (fn, _transactionOptions, tx) => {
        try {
          return await fn(tx);
        } catch (error) {
          rolledBack = true;
          throw error;
        }
      },
    });
    const res = await deliver(h.app, envelope());
    expect(res.status).toBe(503);
    expect(rolledBack).toBe(true);
    expect(h.transaction).toHaveBeenCalledOnce();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
