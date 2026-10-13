import { randomUUID } from "node:crypto";
import type {
  BackgroundJob,
  IssueTrackerIdentity,
  IssueTrackerOption,
  IssueTrackerProvider,
  JobPublisher,
  Page,
} from "@rakazo/adapter-kit";
import { IssueTrackerError, linearSyncJobKey, runJobKey } from "@rakazo/adapter-kit";
import type { LinearTrigger } from "@rakazo/contracts";
import { createDb, IsolationError, type PrismaClient } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LINEAR_MESSAGES, LinearServiceError, createLinearService } from "./linear-service.js";
import { withSecretPersistence } from "./secret-persistence.js";
import { EncryptedSecretStore } from "./secrets.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

const WORKSPACE: IssueTrackerIdentity = {
  organizationId: "org-synthetic",
  organizationName: "Synthetic Org",
  viewerId: "viewer-synthetic",
};

type OptionsCall = Parameters<IssueTrackerProvider["options"]>[1];

class FakeLinear implements IssueTrackerProvider {
  readonly identities = new Map<string, IssueTrackerIdentity>();
  readonly catalog: Record<string, IssueTrackerOption[]> = {
    teams: [{ id: "team-1", name: "Team One" }],
    projects: [{ id: "project-1", name: "Project One" }],
    assignees: [{ id: "viewer-synthetic", name: "Viewer" }],
    states: [{ id: "state-1", name: "Todo" }],
    labels: [
      { id: "label-1", name: "Bug" },
      { id: "label-2", name: "Feature" },
    ],
  };
  readonly optionCalls: OptionsCall[] = [];
  failure: IssueTrackerError | null = null;
  beforeOptions: (() => Promise<void>) | null = null;

  async identity(credential: string): Promise<IssueTrackerIdentity> {
    const identity = this.identities.get(credential);
    if (!identity) throw new IssueTrackerError({ code: "auth", retryAt: null });
    return identity;
  }

  async options(credential: string, input: OptionsCall): Promise<Page<IssueTrackerOption>> {
    this.optionCalls.push(input);
    if (!this.identities.has(credential)) {
      throw new IssueTrackerError({ code: "auth", retryAt: null });
    }
    if (this.failure) throw this.failure;
    await this.beforeOptions?.();
    const items = this.catalog[input.kind] ?? [];
    return {
      items: input.ids ? items.filter((item) => input.ids?.includes(item.id)) : items,
      nextCursor: null,
    };
  }

  async changes(): Promise<never> {
    throw new Error("unused");
  }

  async hydrate(): Promise<null> {
    return null;
  }

  async close(): Promise<void> {}
}

describePostgres("Linear connection service (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  const store = new EncryptedSecretStore("linear-service-test-key-0123456789abcdef");
  const users: string[] = [];

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = withSecretPersistence(db.prisma, store);
  });

  afterAll(async () => {
    if (!db) return;
    await db.prisma.organization.deleteMany({ where: { id: { in: users } } });
    await db.prisma.user.deleteMany({ where: { id: { in: users } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  async function createOwner() {
    const id = randomUUID();
    users.push(id);
    await db.prisma.user.create({
      data: { id, name: "Linear test", email: `${id}@example.test`, emailVerified: true },
    });
    await db.prisma.organization.create({
      data: { id, name: "Linear test", slug: id, createdAt: new Date() },
    });
    await db.prisma.space.create({
      data: { id, organizationId: id, name: "Linear test", isDefault: true },
    });
    await db.prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    return { userId: id, spaceId: id };
  }

  async function setup(apiUrl = "http://127.0.0.1:3100") {
    const actor = await createOwner();
    const provider = new FakeLinear();
    const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);
    const cancel = vi.fn(async (_key: string) => undefined);
    const jobs: JobPublisher = { enqueue, cancel, close: async () => undefined };
    const service = createLinearService({
      prisma,
      secrets: store,
      provider,
      jobs,
      apiUrl,
      signal: new AbortController().signal,
      events: { notify: vi.fn(async () => undefined) },
    });
    const signal = new AbortController().signal;
    const key = `lin_api_${randomUUID()}`;
    provider.identities.set(key, WORKSPACE);
    const connect = () =>
      service.connect(actor, { apiKey: key, displayName: "Work" }, signal);
    const source = (connectionId: string) =>
      db.prisma.linearSource.findUniqueOrThrow({
        where: { connectionId },
        include: { connection: true },
      });
    const secretsOf = () =>
      db.prisma.secret.findMany({ where: { userId: actor.userId }, orderBy: { id: "asc" } });
    return { actor, provider, service, jobs, enqueue, cancel, signal, key, connect, source, secretsOf };
  }

  async function attachActiveRoutine(actor: { userId: string; spaceId: string }, connectionId: string) {
    const bot = await db.prisma.bot.create({
      data: { spaceId: actor.spaceId, userId: actor.userId, name: "Linear bot", color: "test-color" },
    });
    const routine = await db.prisma.routine.create({
      data: {
        spaceId: actor.spaceId,
        botId: bot.id,
        userId: actor.userId,
        name: "Triage",
        prompt: "Triage the issue",
        crons: [],
        active: true,
      },
    });
    const activatedAt = new Date(Date.now() - 60 * 60 * 1000);
    await db.prisma.routineLinearTrigger.create({
      data: {
        routineId: routine.id,
        connectionId,
        teamId: "team-1",
        events: ["issue.created"],
        labelIds: [],
        activatedAt,
      },
    });
    const occurredAt = new Date(Date.now() - 30 * 60 * 1000);
    const event = await db.prisma.linearEvent.create({
      data: {
        connectionId,
        sourceGeneration: 1,
        eventKey: `issue.created:${randomUUID()}`,
        kind: "issue.created",
        entityId: "issue-1",
        issueId: "issue-1",
        occurredAt,
        receivedAt: occurredAt,
        transport: "poll",
        status: "pending",
        nextAttemptAt: occurredAt,
        snapshot: { synthetic: true },
      },
    });
    const thread = await db.prisma.thread.create({
      data: { spaceId: actor.spaceId, userId: actor.userId, botId: bot.id },
    });
    const task = await db.prisma.task.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: bot.id,
        threadId: thread.id,
        prompt: "Linear event",
        status: "queued",
      },
    });
    const run = await db.prisma.run.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "queued",
        trigger: "linear",
        routineId: routine.id,
        linearEventId: event.id,
      },
    });
    return { routine, event, run, task, activatedAt };
  }

  function trigger(connectionId: string, overrides: Partial<LinearTrigger> = {}): LinearTrigger {
    return {
      connectionId,
      teamId: "team-1",
      events: ["issue.created"],
      projectId: null,
      assigneeId: null,
      stateId: null,
      labelIds: [],
      ...overrides,
    };
  }

  async function expectServiceError(promise: Promise<unknown>, code: string, message: string) {
    const error = await promise.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LinearServiceError);
    expect(error).toMatchObject({ code, message });
  }

  it("connects a verified key into encrypted storage without starting work", async () => {
    const h = await setup();
    const connection = await h.connect();
    expect(connection).toMatchObject({
      connectorId: "linear",
      provider: "linear",
      displayName: "Work",
      status: "connected",
      capabilities: ["automation_triggers"],
    });
    const row = await h.source(connection.id);
    expect(row).toMatchObject({
      organizationId: WORKSPACE.organizationId,
      viewerId: WORKSPACE.viewerId,
      revision: 1,
      generation: 1,
      monitoringSince: null,
      nextSyncAt: null,
    });
    const [secret] = await h.secretsOf();
    expect(secret).toMatchObject({ id: row.connection.secretId, kind: "connector" });
    expect(secret?.ciphertext).not.toContain(h.key);
    expect(h.enqueue).not.toHaveBeenCalled();
    const status = await h.service.status(h.actor, { connectionId: connection.id });
    expect(status).toMatchObject({
      connectionId: connection.id,
      organizationName: "Synthetic Org",
      connectionStatus: "connected",
      monitoring: "idle",
      webhookConfigured: false,
      webhookUrl: null,
      errorCode: null,
    });
    expect(JSON.stringify(status)).not.toContain(h.key);
  });

  it("rejects an invalid key before any write", async () => {
    const h = await setup();
    await expectServiceError(
      h.service.connect(h.actor, { apiKey: "lin_api_invalid", displayName: "Bad" }, h.signal),
      "BAD_REQUEST",
      LINEAR_MESSAGES.checkKey,
    );
    expect(await db.prisma.connection.count({ where: { userId: h.actor.userId } })).toBe(0);
    expect(await h.secretsOf()).toEqual([]);
  });

  it("leaves the working key and configuration intact when a reconnect fails", async () => {
    const h = await setup();
    const connection = await h.connect();
    const before = await h.source(connection.id);
    const secretsBefore = await h.secretsOf();

    await expectServiceError(
      h.service.connect(
        h.actor,
        {
          apiKey: "lin_api_invalid",
          displayName: "Work",
          connectionId: connection.id,
          expectedRevision: before.revision,
        },
        h.signal,
      ),
      "BAD_REQUEST",
      LINEAR_MESSAGES.checkKey,
    );

    const otherViewer = `lin_api_${randomUUID()}`;
    h.provider.identities.set(otherViewer, { ...WORKSPACE, viewerId: "viewer-other" });
    await expectServiceError(
      h.service.connect(
        h.actor,
        {
          apiKey: otherViewer,
          displayName: "Work",
          connectionId: connection.id,
          expectedRevision: before.revision,
        },
        h.signal,
      ),
      "BAD_REQUEST",
      LINEAR_MESSAGES.differentAccount,
    );

    const otherOrg = `lin_api_${randomUUID()}`;
    h.provider.identities.set(otherOrg, { ...WORKSPACE, organizationId: "org-other" });
    await expectServiceError(
      h.service.connect(
        h.actor,
        {
          apiKey: otherOrg,
          displayName: "Work",
          connectionId: connection.id,
          expectedRevision: before.revision,
        },
        h.signal,
      ),
      "BAD_REQUEST",
      LINEAR_MESSAGES.differentAccount,
    );

    await expectServiceError(
      h.service.connect(
        h.actor,
        {
          apiKey: h.key,
          displayName: "Work",
          connectionId: connection.id,
          expectedRevision: before.revision + 1,
        },
        h.signal,
      ),
      "CONFLICT",
      LINEAR_MESSAGES.changed,
    );

    const after = await h.source(connection.id);
    expect(after.connection.secretId).toBe(before.connection.secretId);
    expect(after.connection.status).toBe("connected");
    expect(after.revision).toBe(before.revision);
    expect(after.generation).toBe(before.generation);
    expect(await h.secretsOf()).toEqual(secretsBefore);
  });

  it("rejects a stale revision that changes between verification and commit", async () => {
    const h = await setup();
    const connection = await h.connect();
    const before = await h.source(connection.id);
    const racing = `lin_api_${randomUUID()}`;
    h.provider.identities.set(racing, WORKSPACE);
    const identity = h.provider.identity.bind(h.provider);
    h.provider.identity = async (credential) => {
      await db.prisma.linearSource.update({
        where: { connectionId: connection.id },
        data: { revision: { increment: 1 } },
      });
      return identity(credential);
    };
    await expectServiceError(
      h.service.connect(
        h.actor,
        {
          apiKey: racing,
          displayName: "Work",
          connectionId: connection.id,
          expectedRevision: before.revision,
        },
        h.signal,
      ),
      "CONFLICT",
      LINEAR_MESSAGES.changed,
    );
    const after = await h.source(connection.id);
    expect(after.connection.secretId).toBe(before.connection.secretId);
    expect(after.generation).toBe(before.generation);
    expect((await h.secretsOf()).map((secret) => secret.id)).toEqual([before.connection.secretId]);
  });

  it("reconnects the same identity with a fresh baseline and cancels in-flight runs", async () => {
    const h = await setup("https://api.example.com");
    const connection = await h.connect();
    await h.service.configureWebhook(h.actor, {
      connectionId: connection.id,
      expectedRevision: (await h.source(connection.id)).revision,
      signingSecret: "whsec_synthetic_one",
    });
    const fixture = await attachActiveRoutine(h.actor, connection.id);
    const before = await h.source(connection.id);
    const replacement = `lin_api_${randomUUID()}`;
    h.provider.identities.set(replacement, WORKSPACE);

    const updated = await h.service.connect(
      h.actor,
      {
        apiKey: replacement,
        displayName: "Work renamed",
        connectionId: connection.id,
        expectedRevision: before.revision,
      },
      h.signal,
    );

    expect(updated).toMatchObject({ id: connection.id, displayName: "Work renamed" });
    const after = await h.source(connection.id);
    expect(after.connection.secretId).not.toBe(before.connection.secretId);
    expect(after.generation).toBe(before.generation + 1);
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.webhookSecretId).toBe(before.webhookSecretId);
    expect(after.monitoringSince).not.toBeNull();
    expect(after.nextSyncAt).not.toBeNull();
    const secretIds = (await h.secretsOf()).map((secret) => secret.id).sort();
    expect(secretIds).toEqual([after.connection.secretId, after.webhookSecretId].sort());

    const triggerRow = await db.prisma.routineLinearTrigger.findUniqueOrThrow({
      where: { routineId: fixture.routine.id },
    });
    expect(triggerRow.activatedAt!.getTime()).toBeGreaterThan(fixture.activatedAt.getTime());
    expect(triggerRow.revision).toBe(2);
    expect(
      await db.prisma.linearEvent.findUniqueOrThrow({ where: { id: fixture.event.id } }),
    ).toMatchObject({ status: "discarded", seed: null, snapshot: null });
    expect(await db.prisma.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject(
      { status: "cancelled" },
    );
    expect(
      await db.prisma.task.findUniqueOrThrow({ where: { id: fixture.task.id } }),
    ).toMatchObject({ status: "cancelled" });
    expect(h.cancel).toHaveBeenCalledWith(runJobKey(fixture.run.id));
    expect(h.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "linear.sync", payload: { connectionId: connection.id } }),
    );
    expect(await h.service.status(h.actor, { connectionId: connection.id })).toMatchObject({
      monitoring: "polling",
      webhookConfigured: true,
    });
  });

  it("rotates and removes the webhook secret without changing the source generation", async () => {
    const h = await setup("https://api.example.com");
    const connection = await h.connect();
    const initial = await h.source(connection.id);
    await db.prisma.linearSource.update({
      where: { connectionId: connection.id },
      data: { leaseToken: "lease-1", leaseExpiresAt: new Date(Date.now() + 60_000) },
    });

    const first = await h.service.configureWebhook(h.actor, {
      connectionId: connection.id,
      expectedRevision: initial.revision,
      signingSecret: "whsec_synthetic_one",
    });
    expect(first).toMatchObject({
      webhookConfigured: true,
      webhookUrl: `https://api.example.com/api/integrations/linear/${connection.id}/webhook`,
      revision: initial.revision + 1,
    });
    const configured = await h.source(connection.id);
    expect(configured).toMatchObject({
      generation: initial.generation,
      webhookRevision: initial.webhookRevision + 1,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    const firstSecret = await db.prisma.secret.findUniqueOrThrow({
      where: { id: configured.webhookSecretId! },
    });
    expect(firstSecret.kind).toBe("webhook");
    expect(await store.load(firstSecret.ciphertext, { recordId: firstSecret.id })).toBe(
      "whsec_synthetic_one",
    );

    await expectServiceError(
      h.service.configureWebhook(h.actor, {
        connectionId: connection.id,
        expectedRevision: initial.revision,
        signingSecret: "whsec_synthetic_stale",
      }),
      "CONFLICT",
      LINEAR_MESSAGES.changed,
    );
    expect((await h.source(connection.id)).webhookSecretId).toBe(firstSecret.id);

    await h.service.configureWebhook(h.actor, {
      connectionId: connection.id,
      expectedRevision: first.revision,
      signingSecret: "whsec_synthetic_two",
    });
    const rotated = await h.source(connection.id);
    expect(rotated.webhookSecretId).not.toBe(firstSecret.id);
    expect(rotated.webhookRevision).toBe(configured.webhookRevision + 1);
    expect(await db.prisma.secret.findUnique({ where: { id: firstSecret.id } })).toBeNull();

    const removed = await h.service.configureWebhook(h.actor, {
      connectionId: connection.id,
      expectedRevision: rotated.revision,
      signingSecret: null,
    });
    expect(removed.webhookConfigured).toBe(false);
    const cleared = await h.source(connection.id);
    expect(cleared.webhookSecretId).toBeNull();
    expect(cleared.generation).toBe(initial.generation);
    expect((await h.secretsOf()).map((secret) => secret.kind)).toEqual(["connector"]);
  });

  it("refuses webhook secrets without a public HTTPS API URL", async () => {
    const h = await setup("http://127.0.0.1:3100");
    const connection = await h.connect();
    await expectServiceError(
      h.service.configureWebhook(h.actor, {
        connectionId: connection.id,
        expectedRevision: (await h.source(connection.id)).revision,
        signingSecret: "whsec_synthetic_one",
      }),
      "BAD_REQUEST",
      LINEAR_MESSAGES.webhookOrigin,
    );
    expect((await h.source(connection.id)).webhookSecretId).toBeNull();
    expect((await h.secretsOf()).map((secret) => secret.kind)).toEqual(["connector"]);
  });

  it("revokes locally: deletes owned secrets, discards work and cancels runs, keeps routines", async () => {
    const h = await setup("https://api.example.com");
    const connection = await h.connect();
    await h.service.configureWebhook(h.actor, {
      connectionId: connection.id,
      expectedRevision: (await h.source(connection.id)).revision,
      signingSecret: "whsec_synthetic_one",
    });
    const fixture = await attachActiveRoutine(h.actor, connection.id);
    const before = await h.source(connection.id);
    const optionCallsBefore = h.provider.optionCalls.length;

    const result = await h.service.revoke(h.actor, { connectionId: connection.id });

    expect(result.cancelledRunIds).toEqual([fixture.run.id]);
    const after = await h.source(connection.id);
    expect(after.connection).toMatchObject({ status: "revoked", secretId: null });
    expect(after).toMatchObject({
      webhookSecretId: null,
      generation: before.generation + 1,
      webhookRevision: before.webhookRevision + 1,
      nextPollAt: null,
      nextSyncAt: null,
      leaseToken: null,
      monitoringSince: null,
    });
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(await h.secretsOf()).toEqual([]);
    expect(
      await db.prisma.linearEvent.findUniqueOrThrow({ where: { id: fixture.event.id } }),
    ).toMatchObject({ status: "discarded" });
    expect(await db.prisma.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject(
      { status: "cancelled" },
    );
    expect(
      await db.prisma.routineLinearTrigger.findUnique({ where: { routineId: fixture.routine.id } }),
    ).not.toBeNull();
    expect(h.cancel).toHaveBeenCalledWith(runJobKey(fixture.run.id));
    expect(h.cancel).toHaveBeenCalledWith(linearSyncJobKey(connection.id));
    expect(h.provider.optionCalls.length).toBe(optionCallsBefore);
    expect(await h.service.status(h.actor, { connectionId: connection.id })).toMatchObject({
      connectionStatus: "revoked",
      monitoring: "idle",
      webhookConfigured: false,
    });

    const reconnected = await h.service.connect(
      h.actor,
      {
        apiKey: h.key,
        displayName: "Work",
        connectionId: connection.id,
        expectedRevision: after.revision,
      },
      h.signal,
    );
    expect(reconnected.status).toBe("connected");
    expect((await h.source(connection.id)).webhookSecretId).toBeNull();
  });

  it("passes options through and fences them on the source revision", async () => {
    const h = await setup();
    const connection = await h.connect();
    expect(
      await h.service.options(h.actor, { connectionId: connection.id, kind: "teams" }, h.signal),
    ).toEqual({ items: [{ id: "team-1", name: "Team One" }], nextCursor: null });
    expect(h.provider.optionCalls.at(-1)).toEqual({ kind: "teams" });
    await h.service.options(
      h.actor,
      { connectionId: connection.id, kind: "labels", teamId: "team-1", cursor: "cursor-1" },
      h.signal,
    );
    expect(h.provider.optionCalls.at(-1)).toEqual({
      kind: "labels",
      teamId: "team-1",
      cursor: "cursor-1",
    });

    h.provider.beforeOptions = async () => {
      await db.prisma.linearSource.update({
        where: { connectionId: connection.id },
        data: { revision: { increment: 1 } },
      });
    };
    await expectServiceError(
      h.service.options(h.actor, { connectionId: connection.id, kind: "teams" }, h.signal),
      "CONFLICT",
      LINEAR_MESSAGES.changed,
    );
  });

  it("maps provider failures and records rate limits and key rejection", async () => {
    const h = await setup();
    const connection = await h.connect();
    const input = { connectionId: connection.id, kind: "teams" as const };

    h.provider.failure = new IssueTrackerError({ code: "unavailable", retryAt: null });
    await expectServiceError(
      h.service.options(h.actor, input, h.signal),
      "SERVICE_UNAVAILABLE",
      LINEAR_MESSAGES.unavailable,
    );

    const retryAt = new Date(Date.now() + 120_000).toISOString();
    h.provider.failure = new IssueTrackerError({ code: "rate_limit", retryAt });
    await expectServiceError(
      h.service.options(h.actor, input, h.signal),
      "SERVICE_UNAVAILABLE",
      LINEAR_MESSAGES.unavailable,
    );
    const limited = await h.source(connection.id);
    expect(limited.rateLimitedUntil?.toISOString()).toBe(retryAt);
    h.provider.failure = null;
    const calls = h.provider.optionCalls.length;
    await expectServiceError(
      h.service.options(h.actor, input, h.signal),
      "SERVICE_UNAVAILABLE",
      LINEAR_MESSAGES.unavailable,
    );
    expect(h.provider.optionCalls.length).toBe(calls);

    await db.prisma.linearSource.update({
      where: { connectionId: connection.id },
      data: { rateLimitedUntil: null },
    });
    h.provider.identities.delete(h.key);
    await expectServiceError(
      h.service.options(h.actor, input, h.signal),
      "BAD_REQUEST",
      LINEAR_MESSAGES.checkKey,
    );
    const rejected = await h.source(connection.id);
    expect(rejected.connection.status).toBe("error");
    expect(rejected).toMatchObject({ errorCode: "auth", nextPollAt: null, nextSyncAt: null });
    expect(await h.service.status(h.actor, { connectionId: connection.id })).toMatchObject({
      connectionStatus: "error",
      monitoring: "error",
      errorCode: "auth",
    });
  });

  it("validates trigger selections remotely and reports the pre-request revision", async () => {
    const h = await setup();
    const connection = await h.connect();
    const revision = (await h.source(connection.id)).revision;
    expect(
      await h.service.validateTrigger(
        h.actor,
        trigger(connection.id, {
          projectId: "project-1",
          assigneeId: "viewer-synthetic",
          stateId: "state-1",
          labelIds: ["label-1", "label-2"],
        }),
        h.signal,
      ),
    ).toEqual({ sourceRevision: revision });
    expect(h.provider.optionCalls).toEqual(
      expect.arrayContaining([
        { kind: "teams", ids: ["team-1"] },
        { kind: "projects", ids: ["project-1"], teamId: "team-1" },
        { kind: "labels", ids: ["label-1", "label-2"], teamId: "team-1" },
      ]),
    );

    await expectServiceError(
      h.service.validateTrigger(
        h.actor,
        trigger(connection.id, { labelIds: ["label-1", "label-missing"] }),
        h.signal,
      ),
      "BAD_REQUEST",
      LINEAR_MESSAGES.chooseOption,
    );
    await expectServiceError(
      h.service.validateTrigger(h.actor, trigger(connection.id, { teamId: "team-gone" }), h.signal),
      "BAD_REQUEST",
      LINEAR_MESSAGES.chooseOption,
    );

    h.provider.failure = new IssueTrackerError({ code: "unavailable", retryAt: null });
    await expectServiceError(
      h.service.validateTrigger(h.actor, trigger(connection.id), h.signal),
      "SERVICE_UNAVAILABLE",
      LINEAR_MESSAGES.unavailable,
    );
    h.provider.failure = null;

    await h.service.revoke(h.actor, { connectionId: connection.id });
    await expectServiceError(
      h.service.validateTrigger(h.actor, trigger(connection.id), h.signal),
      "BAD_REQUEST",
      LINEAR_MESSAGES.chooseOption,
    );
  });

  it("keeps every operation owner-scoped", async () => {
    const h = await setup("https://api.example.com");
    const connection = await h.connect();
    const intruder = await createOwner();
    const revision = (await h.source(connection.id)).revision;
    await expect(
      h.service.status(intruder, { connectionId: connection.id }),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      h.service.options(intruder, { connectionId: connection.id, kind: "teams" }, h.signal),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      h.service.configureWebhook(intruder, {
        connectionId: connection.id,
        expectedRevision: revision,
        signingSecret: "whsec_synthetic_one",
      }),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      h.service.connect(
        intruder,
        { apiKey: h.key, displayName: "Stolen", connectionId: connection.id, expectedRevision: revision },
        h.signal,
      ),
    ).rejects.toBeInstanceOf(IsolationError);
    await expectServiceError(
      h.service.validateTrigger(intruder, trigger(connection.id), h.signal),
      "BAD_REQUEST",
      LINEAR_MESSAGES.chooseOption,
    );
    expect(await h.service.revoke(intruder, { connectionId: connection.id })).toEqual({
      cancelledRunIds: [],
    });
    const untouched = await h.source(connection.id);
    expect(untouched.connection.status).toBe("connected");
    expect(untouched.revision).toBe(revision);
    expect(untouched.webhookSecretId).toBeNull();
  });
});
