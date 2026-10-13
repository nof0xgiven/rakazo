import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  JobPublisher,
  SecretStore,
} from "@rakazo/adapter-kit";
import { linearSyncJobKey } from "@rakazo/adapter-kit";
import type { LinearTrigger } from "@rakazo/contracts";
import { ONCE_ROUTINE_CRON } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { makeWorkerUtils } from "graphile-worker";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLinearEmulator } from "./linear-emulator.js";
import { createLinearProvider } from "./linear-provider.js";
import { createLinearService, LINEAR_MESSAGES, type LinearService } from "./linear-service.js";
import { type LinearWorkerDeps, syncLinearConnection } from "./linear-sync.js";
import { ScriptedAgentRuntime } from "./scripted-runtime.js";
import { EncryptedSecretStore } from "./secrets.js";

process.env.WAKEUP_DRIVER = "graphile";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";
process.env.DB_POOL_MAX = "12";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

type WebhookApp = {
  request(input: string, init?: RequestInit): Response | Promise<Response>;
};
type AppHandles = {
  app: WebhookApp;
  prisma: PrismaClient;
  jobs: JobPublisher;
  executor: {
    continueRun(runId: string, workerId: string): Promise<void>;
    wakeRoutine(routineId: string, scheduledFor: string): Promise<void>;
  };
  stop(): Promise<void>;
};
type ApiModules = [
  { createApp(overrides: Record<string, unknown>): Promise<AppHandles> },
  {
    mountLinearWebhookHttpRoutes(
      app: WebhookApp,
      deps: { prisma: PrismaClient; secrets: SecretStore; jobs: JobPublisher },
    ): void;
  },
];
type RpcResult = {
  status: number;
  text: string;
  code: string | null;
  message: string | null;
  json: unknown;
};
type Account = {
  cookie: string;
  userId: string;
  spaceId: string;
  call: <T>(procedure: string, body?: unknown, spaceId?: string) => Promise<T>;
  attempt: (procedure: string, body?: unknown, spaceId?: string) => Promise<RpcResult>;
};
type Deferred<T = void> = { promise: Promise<T>; resolve: (value: T) => void };
type Gate = { arrived: Deferred; release: Deferred };
type RoutineRow = {
  id: string;
  active: boolean;
  nextRunAt: string | null;
  linearTrigger: LinearTrigger | null;
};
type ConnectionRow = { id: string; status: string; connectorId: string; capabilities: string[] };
type StatusRow = {
  revision: number;
  connectionStatus: string;
  webhookConfigured: boolean;
  monitoring: string;
};

const ENCRYPTION_KEY = "linear-lifecycle-postgres-test-key-0123456789";
const PUBLIC_API_URL = "https://rakazo.example.com";
const IDENTITY = {
  organizationId: "org-lifecycle",
  organizationName: "Lifecycle Org",
  viewerId: "viewer-lifecycle",
};

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class GatedRuntime implements AgentRuntime {
  private readonly inner = new ScriptedAgentRuntime();
  readonly started: string[] = [];
  gate: Gate | null = null;

  describe() {
    return this.inner.describe();
  }

  abort(runId: string): Promise<void> {
    return this.inner.abort(runId);
  }

  async *run(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
  ): AsyncIterable<AgentRuntimeEvent> {
    this.started.push(request.runId);
    const gate = this.gate;
    this.gate = null;
    if (gate) {
      gate.arrived.resolve();
      await gate.release.promise;
    }
    yield* this.inner.run(request, context);
  }
}

describePostgres("Linear connection, configuration and run lifecycle (PostgreSQL)", () => {
  let handles: AppHandles;
  let prisma: AppHandles["prisma"];
  let workerDeps: LinearWorkerDeps;
  let publicService: LinearService;
  let mountLinearWebhookHttpRoutes: ApiModules[1]["mountLinearWebhookHttpRoutes"];
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-linear-lifecycle-"));
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const store = new EncryptedSecretStore(ENCRYPTION_KEY);
  let emulatorClock: Date | null = null;
  const emulator = createLinearEmulator({ now: () => emulatorClock ?? new Date() });
  const runtime = new GatedRuntime();
  const responseGates = new Map<string, Gate[]>();
  const shutdown = new AbortController();
  let sequence = 0;

  const linearFetch: typeof fetch = async (input, init) => {
    let operation = "";
    try {
      operation = String(JSON.parse(String(init?.body ?? "{}")).operationName ?? "");
    } catch {
      operation = "";
    }
    const response = await emulator.fetch(input, init);
    const gate = responseGates.get(operation)?.shift();
    if (gate) {
      gate.arrived.resolve();
      await gate.release.promise;
    }
    return response;
  };
  const provider = createLinearProvider({ fetch: linearFetch });

  function holdResponse(operation: string): Gate {
    const gate = { arrived: deferred(), release: deferred() };
    responseGates.set(operation, [...(responseGates.get(operation) ?? []), gate]);
    return gate;
  }

  beforeAll(async () => {
    const utils = await makeWorkerUtils({ connectionString: process.env.DATABASE_URL! });
    await utils.migrate();
    await utils.release();
  });

  beforeEach(() => {
    emulator.reset();
    emulator.addTeam({ id: "team-a", name: "Alpha" });
    emulator.addTeam({ id: "team-b", name: "Beta" });
    emulator.addProject({ id: "project-a", name: "Apollo", teamIds: ["team-a"] });
    emulator.addProject({ id: "project-b", name: "Borealis", teamIds: ["team-b"] });
    emulator.addMember({ id: "member-a", name: "Avery", teamIds: ["team-a"] });
    emulator.addMember({ id: "member-b", name: "Blair", teamIds: ["team-b"] });
    emulator.addState({ id: "state-a", name: "Todo", teamId: "team-a" });
    emulator.addState({ id: "state-b", name: "Todo", teamId: "team-b" });
    emulator.addLabel({ id: "label-a", name: "Bug", teamId: "team-a" });
    emulator.addLabel({ id: "label-b", name: "Ops", teamId: "team-b" });
    emulator.addLabel({ id: "label-global", name: "Customer", teamId: null });
    emulator.addLabel({ id: "label-group", name: "Area", teamId: "team-a", isGroup: true });
    emulator.addLabel({ id: "label-archived", name: "Old", teamId: "team-a", archived: true });
  });

  beforeAll(async () => {
    // The API sits outside this package's rootDir and reads its driver environment on load.
    const apiSource = "../../../apps/api/src";
    const [{ createApp }, webhook] = (await Promise.all([
      import(`${apiSource}/app.ts`),
      import(`${apiSource}/linear-webhook.ts`),
    ])) as ApiModules;
    mountLinearWebhookHttpRoutes = webhook.mountLinearWebhookHttpRoutes;
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "graphile",
      defaultProvider: "scripted",
      defaultModel: "scripted",
      encryptionKey: ENCRYPTION_KEY,
      signupsEnabled: "true",
      apiUrl: "http://127.0.0.1:3100",
      linearProvider: provider,
      runtime,
    });
    prisma = handles.prisma;
    workerDeps = { prisma, secrets: store, provider, jobs: handles.jobs, signal: shutdown.signal };
    publicService = createLinearService({
      prisma,
      secrets: store,
      provider,
      jobs: handles.jobs,
      apiUrl: PUBLIC_API_URL,
      signal: shutdown.signal,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    emulatorClock = null;
    runtime.gate?.release.resolve();
    runtime.gate = null;
    for (const gates of responseGates.values()) for (const gate of gates) gate.release.resolve();
    responseGates.clear();
  });

  afterAll(async () => {
    shutdown.abort();
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function request(
    cookie: string,
    procedure: string,
    body: unknown,
    spaceId?: string,
  ): Promise<RpcResult> {
    const response = await handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: "http://127.0.0.1:5173",
        ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
      },
      body: JSON.stringify({ json: body }),
    });
    const text = await response.text();
    let parsed: { json?: Record<string, unknown> } = {};
    try {
      parsed = JSON.parse(text) as { json?: Record<string, unknown> };
    } catch {
      parsed = {};
    }
    const payload = parsed.json ?? {};
    return {
      status: response.status,
      text,
      code: response.ok ? null : typeof payload.code === "string" ? payload.code : null,
      message: response.ok ? null : typeof payload.message === "string" ? payload.message : null,
      json: payload,
    };
  }

  async function account(label: string): Promise<Account> {
    sequence += 1;
    const email = `linear-${label}-${sequence}-${stamp}@rakazo.test`;
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({ email, password: "password12", name: `Linear ${label}` }),
    });
    if (!response.ok) throw new Error(`signup failed ${response.status}`);
    const cookies = response.headers.getSetCookie?.() ?? [];
    const cookie = cookies.map((value) => value.split(";")[0]).join("; ");
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const member = await prisma.spaceMember.findFirstOrThrow({ where: { userId: user.id } });
    const call = async <T>(procedure: string, body: unknown = {}, spaceId?: string): Promise<T> => {
      const result = await request(cookie, procedure, body, spaceId);
      if (result.status >= 400) {
        throw new Error(`${procedure} ${result.status}: ${result.message ?? result.text}`);
      }
      return result.json as T;
    };
    const attempt = (procedure: string, body: unknown = {}, spaceId?: string) =>
      request(cookie, procedure, body, spaceId);
    return { cookie, userId: user.id, spaceId: member.spaceId, call, attempt };
  }

  function newKey(identity: Partial<typeof IDENTITY> = {}): string {
    sequence += 1;
    const apiKey = `lin_api_lifecycle_${sequence}_${stamp}`;
    emulator.addWorkspace({ ...IDENTITY, ...identity, apiKey });
    return apiKey;
  }

  async function connect(owner: Account, apiKey = newKey()) {
    const connection = await owner.call<ConnectionRow>("linear/connect", {
      apiKey,
      displayName: "Work",
    });
    return { connection, apiKey };
  }

  async function createBot(owner: Account, name = "Triage") {
    return owner.call<{ id: string }>("bots/create", {
      name,
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
  }

  function trigger(connectionId: string, overrides: Partial<LinearTrigger> = {}): LinearTrigger {
    return {
      connectionId,
      teamId: "team-a",
      events: ["issue.created"],
      projectId: null,
      assigneeId: null,
      stateId: null,
      labelIds: [],
      ...overrides,
    };
  }

  function routineInput(botId: string, linearTrigger: LinearTrigger | null, active = true) {
    return {
      botId,
      name: "Linear triage",
      prompt: "Triage the Linear issue",
      crons: [],
      timezone: "UTC",
      notify: false,
      active,
      linearTrigger,
    };
  }

  async function createRoutine(owner: Account, botId: string, linearTrigger: LinearTrigger) {
    return owner.call<RoutineRow>("routines/create", routineInput(botId, linearTrigger));
  }

  const source = (connectionId: string) =>
    prisma.linearSource.findUniqueOrThrow({ where: { connectionId }, include: { connection: true } });

  const triggerRow = (routineId: string) =>
    prisma.routineLinearTrigger.findUniqueOrThrow({ where: { routineId } });

  const linearRuns = (routineId: string) =>
    prisma.run.findMany({
      where: { routineId, trigger: "linear" },
      include: { task: true },
      orderBy: { createdAt: "asc" },
    });

  async function databaseNow(): Promise<Date> {
    const rows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
    return new Date(rows[0]!.now);
  }

  function runClockAt(at: Date) {
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    vi.setSystemTime(at);
  }

  function issueAfter(activatedAt: Date, offsetMs: number, overrides: { teamId?: string } = {}) {
    sequence += 1;
    const createdAt = new Date(activatedAt.getTime() + offsetMs).toISOString();
    return emulator.createIssue({
      teamId: overrides.teamId ?? "team-a",
      title: `Lifecycle issue ${sequence}`,
      createdAt,
      updatedAt: createdAt,
    });
  }

  async function sync(connectionId: string) {
    await syncLinearConnection(workerDeps, { connectionId });
  }

  async function waitUntil(label: string, condition: () => Promise<boolean>) {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (await condition()) return;
      await prisma.$executeRaw`SELECT pg_sleep(0.025)`;
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  async function waitForLockWaiter(blockerPid: number, pattern: string): Promise<number> {
    let waiter: number | null = null;
    await waitUntil(`a ${pattern} waiter blocked by ${blockerPid}`, async () => {
      const rows = await prisma.$queryRaw<Array<{ pid: number }>>`
        SELECT pid FROM pg_stat_activity
        WHERE ${blockerPid}::int = ANY(pg_blocking_pids(pid))
          AND wait_event_type = 'Lock'
          AND query ILIKE ${pattern}`;
      waiter = rows[0]?.pid ?? null;
      return waiter !== null;
    });
    return waiter!;
  }

  async function lockingClient(statement: string, values: unknown[]) {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL! });
    await client.connect();
    await client.query("BEGIN");
    await client.query(statement, values);
    const pid = Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    let open = true;
    return {
      pid,
      async commit() {
        if (!open) return;
        open = false;
        await client.query("COMMIT");
        await client.end();
      },
      async close() {
        if (!open) return;
        open = false;
        await client.query("ROLLBACK").catch(() => undefined);
        await client.end();
      },
    };
  }

  async function plaintextRows(secret: string): Promise<number> {
    const pattern = `%${secret}%`;
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT (
        (SELECT count(*) FROM secrets t WHERE row_to_json(t)::text LIKE ${pattern}) +
        (SELECT count(*) FROM connections t WHERE row_to_json(t)::text LIKE ${pattern}) +
        (SELECT count(*) FROM linear_sources t WHERE row_to_json(t)::text LIKE ${pattern}) +
        (SELECT count(*) FROM linear_events t WHERE row_to_json(t)::text LIKE ${pattern}) +
        (SELECT count(*) FROM events t WHERE row_to_json(t)::text LIKE ${pattern})
      ) AS count`;
    return Number(rows[0]?.count ?? 0);
  }

  async function queuedJobKeys(key: string): Promise<number> {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM graphile_worker.jobs WHERE key = ${key}`;
    return Number(rows[0]?.count ?? 0);
  }

  function webhookApp(secrets: SecretStore): WebhookApp {
    const HonoApp = handles.app.constructor as new () => WebhookApp;
    const app = new HonoApp();
    mountLinearWebhookHttpRoutes(app, { prisma, secrets, jobs: handles.jobs });
    return app;
  }

  async function deliver(
    app: WebhookApp,
    connectionId: string,
    signingSecret: string,
    issueId: string,
  ): Promise<number> {
    const delivery = emulator.webhook({
      signingSecret,
      type: "Issue",
      action: "create",
      entityId: issueId,
      timestampMs: Date.now(),
    });
    const response = await app.request(`/api/integrations/linear/${connectionId}/webhook`, {
      method: "POST",
      headers: delivery.headers,
      body: delivery.body,
    });
    return response.status;
  }

  function gatedSecretStore() {
    const gate: Gate = { arrived: deferred(), release: deferred() };
    const gated: SecretStore = Object.create(store);
    gated.load = async (ref, context) => {
      gate.arrived.resolve();
      await gate.release.promise;
      return store.load(ref, context);
    };
    return { store: gated, gate };
  }

  function commentAt(issueId: string, at: Date) {
    emulatorClock = at;
    try {
      return emulator.createComment({ issueId, body: `Comment at ${at.toISOString()}` });
    } finally {
      emulatorClock = null;
    }
  }

  async function activeRoutine(events: LinearTrigger["events"] = ["issue.created"]) {
    const owner = await account("owner");
    const { connection, apiKey } = await connect(owner);
    const bot = await createBot(owner);
    const routine = await createRoutine(owner, bot.id, trigger(connection.id, { events }));
    const activatedAt = (await triggerRow(routine.id)).activatedAt!;
    return { owner, connection, apiKey, bot, routine, activatedAt };
  }

  async function dispatchedRun() {
    const fixture = await activeRoutine();
    const issue = issueAfter(fixture.activatedAt, 1_000);
    runClockAt(new Date(fixture.activatedAt.getTime() + 10_000));
    await sync(fixture.connection.id);
    const [run] = await linearRuns(fixture.routine.id);
    expect(run).toMatchObject({ status: "queued", trigger: "linear" });
    expect(run!.linearEventId).not.toBeNull();
    return { ...fixture, issue, run: run! };
  }

  it("lists native Linear without a broker and stores only the encrypted key", async () => {
    const owner = await account("catalog");
    const catalog = await owner.call<Array<{ connectorId: string; slug: string; name: string }>>(
      "connections/catalog",
      {},
    );
    expect(catalog).toContainEqual(
      expect.objectContaining({ connectorId: "linear", slug: "linear", name: "Linear automations" }),
    );

    const { connection, apiKey } = await connect(owner);
    expect(connection).toMatchObject({
      status: "connected",
      connectorId: "linear",
      capabilities: ["automation_triggers"],
    });
    const row = await source(connection.id);
    const secrets = await prisma.secret.findMany({ where: { userId: owner.userId } });
    expect(secrets).toEqual([
      expect.objectContaining({ id: row.connection.secretId, kind: "connector" }),
    ]);
    expect(await plaintextRows(apiKey)).toBe(0);
    expect(row).toMatchObject({ monitoringSince: null, nextSyncAt: null, revision: 1 });
    const status = await owner.attempt("linear/status", { connectionId: connection.id });
    expect(status.status).toBe(200);
    expect(status.text).not.toContain(apiKey);
  });

  it("keeps the working key when a replacement is invalid or belongs to another account", async () => {
    const owner = await account("replace");
    const { connection, apiKey } = await connect(owner);
    const before = await source(connection.id);
    const reconnect = (key: string) =>
      owner.attempt("linear/connect", {
        apiKey: key,
        displayName: "Work",
        connectionId: connection.id,
        expectedRevision: before.revision,
      });

    const invalid = await reconnect("lin_api_lifecycle_unknown");
    expect(invalid).toMatchObject({ status: 400, message: LINEAR_MESSAGES.checkKey });
    const otherOrganization = await reconnect(newKey({ organizationId: "org-elsewhere" }));
    expect(otherOrganization).toMatchObject({ status: 400, message: LINEAR_MESSAGES.differentAccount });
    const otherViewer = await reconnect(newKey({ viewerId: "viewer-elsewhere" }));
    expect(otherViewer).toMatchObject({ status: 400, message: LINEAR_MESSAGES.differentAccount });

    const after = await source(connection.id);
    expect(after).toMatchObject({
      revision: before.revision,
      generation: before.generation,
      organizationId: IDENTITY.organizationId,
      viewerId: IDENTITY.viewerId,
    });
    expect(after.connection).toMatchObject({ status: "connected", secretId: before.connection.secretId });
    expect(await prisma.secret.count({ where: { userId: owner.userId } })).toBe(1);
    const teams = await owner.call<{ items: Array<{ id: string }> }>("linear/options", {
      connectionId: connection.id,
      kind: "teams",
    });
    expect(teams.items.map((item) => item.id)).toContain("team-a");
    expect(emulator.requests().at(-1)?.authorization).toBe(apiKey);

    const replacement = newKey();
    await owner.call("linear/connect", {
      apiKey: replacement,
      displayName: "Work",
      connectionId: connection.id,
      expectedRevision: before.revision,
    });
    const replaced = await source(connection.id);
    expect(replaced.connection.secretId).not.toBe(before.connection.secretId);
    expect(await prisma.secret.findMany({ where: { userId: owner.userId } })).toEqual([
      expect.objectContaining({ id: replaced.connection.secretId, kind: "connector" }),
    ]);
    await owner.call("linear/options", { connectionId: connection.id, kind: "teams" });
    expect(emulator.requests().at(-1)?.authorization).toBe(replacement);
    expect(await plaintextRows(apiKey)).toBe(0);
    expect(await plaintextRows(replacement)).toBe(0);
  });

  it("denies another user or space every connection RPC and routine attachment", async () => {
    const owner = await account("isolated-owner");
    const { connection, apiKey } = await connect(owner);
    const revision = (await source(connection.id)).revision;
    const intruder = await account("isolated-intruder");
    const otherSpace = await owner.call<{ id: string }>("spaces/create", { name: "Elsewhere" });

    const attempts = [
      ["linear/status", { connectionId: connection.id }],
      ["linear/options", { connectionId: connection.id, kind: "teams" }],
      [
        "linear/configureWebhook",
        { connectionId: connection.id, expectedRevision: revision, signingSecret: null },
      ],
      [
        "linear/connect",
        {
          apiKey: newKey(),
          displayName: "Stolen",
          connectionId: connection.id,
          expectedRevision: revision,
        },
      ],
    ] as const;
    for (const [procedure, body] of attempts) {
      for (const result of [
        await intruder.attempt(procedure, body),
        await owner.attempt(procedure, body, otherSpace.id),
      ]) {
        expect(result.status, procedure).toBeGreaterThanOrEqual(400);
        expect(result.text).not.toContain(apiKey);
        expect(result.text).not.toContain(IDENTITY.organizationName);
        expect(result.text).not.toContain(IDENTITY.viewerId);
      }
    }

    const intruderBot = await createBot(intruder, "Intruder");
    const attach = await intruder.attempt(
      "routines/create",
      routineInput(intruderBot.id, trigger(connection.id)),
    );
    expect(attach).toMatchObject({ status: 400, message: LINEAR_MESSAGES.chooseOption });
    const spaceBot = await owner.call<{ id: string }>(
      "bots/create",
      { name: "Elsewhere", title: "", description: "", instructions: "", notifyOnFinish: false },
      otherSpace.id,
    );
    const crossSpace = await owner.attempt(
      "routines/create",
      routineInput(spaceBot.id, trigger(connection.id)),
      otherSpace.id,
    );
    expect(crossSpace).toMatchObject({ status: 400, message: LINEAR_MESSAGES.chooseOption });
    const paused = await intruder.call<RoutineRow>("routines/create", {
      ...routineInput(intruderBot.id, null, false),
      webhookEnabled: true,
    });
    const update = await intruder.attempt("routines/update", {
      routineId: paused.id,
      linearTrigger: trigger(connection.id),
    });
    expect(update).toMatchObject({ status: 400, message: LINEAR_MESSAGES.chooseOption });
    expect(
      await prisma.routineLinearTrigger.count({ where: { connectionId: connection.id } }),
    ).toBe(0);
    expect(await source(connection.id)).toMatchObject({ revision, monitoringSince: null });
  });

  it("revoke clears both secrets, due work and pending events and cancels active Linear runs", async () => {
    const fixture = await dispatchedRun();
    const { owner, connection, routine, activatedAt } = fixture;
    await handles.executor.continueRun(fixture.run.id, "worker-complete");
    expect(await prisma.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "completed",
    });

    issueAfter(activatedAt, 20_000);
    vi.setSystemTime(new Date(activatedAt.getTime() + 75_000));
    await sync(connection.id);
    const active = (await linearRuns(routine.id)).find((run) => run.status === "queued");
    expect(active).toBeDefined();

    const signingSecret = `whsec_lifecycle_${stamp}`;
    await publicService.configureWebhook(
      { userId: owner.userId, spaceId: owner.spaceId },
      {
        connectionId: connection.id,
        expectedRevision: (await source(connection.id)).revision,
        signingSecret,
      },
    );
    const pendingIssue = issueAfter(activatedAt, 3_000);
    expect(await deliver(webhookApp(store), connection.id, signingSecret, pendingIssue.id)).toBe(
      200,
    );
    expect(
      await prisma.linearEvent.findFirstOrThrow({
        where: { connectionId: connection.id, entityId: pendingIssue.id },
      }),
    ).toMatchObject({ status: "pending", transport: "webhook" });
    expect(await prisma.secret.count({ where: { userId: owner.userId } })).toBe(2);
    expect(await plaintextRows(signingSecret)).toBe(0);

    expect(await owner.call("connections/revoke", { connectionId: connection.id })).toEqual({
      ok: true,
    });

    const revoked = await source(connection.id);
    expect(revoked.connection).toMatchObject({ status: "revoked", secretId: null });
    expect(revoked).toMatchObject({
      webhookSecretId: null,
      monitoringSince: null,
      nextPollAt: null,
      nextSyncAt: null,
      leaseToken: null,
    });
    expect(await prisma.secret.count({ where: { userId: owner.userId } })).toBe(0);
    expect(
      await prisma.linearEvent.findFirstOrThrow({
        where: { connectionId: connection.id, entityId: pendingIssue.id },
      }),
    ).toMatchObject({ status: "discarded", seed: null, snapshot: null });
    const runs = await linearRuns(routine.id);
    expect(runs.find((run) => run.id === fixture.run.id)?.status).toBe("completed");
    const cancelled = runs.find((run) => run.id === active!.id)!;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.task.status).toBe("cancelled");
    expect(await queuedJobKeys(linearSyncJobKey(connection.id))).toBe(0);
    expect(await owner.call<StatusRow>("linear/status", { connectionId: connection.id })).toMatchObject(
      { connectionStatus: "revoked", webhookConfigured: false, monitoring: "idle" },
    );
    expect((await triggerRow(routine.id)).connectionId).toBe(connection.id);
  });

  it("saves and reloads active Linear-only routines for each event selection", async () => {
    const owner = await account("events");
    const { connection } = await connect(owner);
    const bot = await createBot(owner);
    const selections: Array<LinearTrigger["events"]> = [
      ["issue.created"],
      ["issue.updated"],
      ["comment.created"],
      ["issue.created", "issue.updated", "comment.created"],
    ];
    const saved: RoutineRow[] = [];
    for (const events of selections) {
      const input = trigger(connection.id, {
        events,
        ...(events.length === 3
          ? {
              projectId: "project-a",
              assigneeId: "member-a",
              stateId: "state-a",
              labelIds: ["label-global", "label-a"],
            }
          : {}),
      });
      const routine = await createRoutine(owner, bot.id, input);
      expect(routine).toMatchObject({ active: true, nextRunAt: null });
      expect(routine.linearTrigger).toEqual({ ...input, labelIds: [...input.labelIds].sort() });
      saved.push(routine);
    }
    const reloaded = await owner.call<RoutineRow[]>("routines/list", { botId: bot.id });
    for (const routine of saved) {
      expect(reloaded.find((row) => row.id === routine.id)).toMatchObject({
        active: true,
        nextRunAt: null,
        linearTrigger: routine.linearTrigger,
      });
      expect((await triggerRow(routine.id)).activatedAt).toBeInstanceOf(Date);
    }
    const monitored = await source(connection.id);
    expect(monitored.monitoringSince).toBeInstanceOf(Date);
    expect(monitored.nextSyncAt).toBeInstanceOf(Date);
    expect(await queuedJobKeys(linearSyncJobKey(connection.id))).toBe(1);
  });

  it("rejects unavailable selections, empty events and unavailable metadata without saving", async () => {
    const owner = await account("validation");
    const { connection } = await connect(owner);
    const bot = await createBot(owner);
    const rejected: Array<Partial<LinearTrigger>> = [
      { teamId: "team-missing" },
      { projectId: "project-b" },
      { stateId: "state-b" },
      { assigneeId: "member-b" },
      { labelIds: ["label-b"] },
      { labelIds: ["label-group"] },
      { labelIds: ["label-archived"] },
      { labelIds: ["label-a", "label-missing"] },
    ];
    for (const overrides of rejected) {
      const result = await owner.attempt(
        "routines/create",
        routineInput(bot.id, trigger(connection.id, overrides)),
      );
      expect(result, JSON.stringify(overrides)).toMatchObject({
        status: 400,
        code: "BAD_REQUEST",
        message: LINEAR_MESSAGES.chooseOption,
      });
    }
    const empty = await owner.attempt(
      "routines/create",
      routineInput(bot.id, trigger(connection.id, { events: [] })),
    );
    expect(empty).toMatchObject({ status: 400, code: "BAD_REQUEST" });

    emulator.failNext({ kind: "http", status: 503 }, { operation: "LinearTeams" });
    const unavailable = await owner.attempt(
      "routines/create",
      routineInput(bot.id, trigger(connection.id)),
    );
    expect(unavailable).toMatchObject({
      status: 503,
      code: "SERVICE_UNAVAILABLE",
      message: LINEAR_MESSAGES.unavailable,
    });
    expect(await prisma.routine.count({ where: { botId: bot.id } })).toBe(0);
    expect(await source(connection.id)).toMatchObject({ monitoringSince: null, nextSyncAt: null });

    const global = await createRoutine(
      owner,
      bot.id,
      trigger(connection.id, { labelIds: ["label-global"] }),
    );
    expect(global.linearTrigger?.labelIds).toEqual(["label-global"]);
    await owner.call("routines/update", { routineId: global.id, active: false });
    emulator.failNext({ kind: "malformed" }, { operation: "LinearTeams" });
    const resume = await owner.attempt("routines/update", { routineId: global.id, active: true });
    expect(resume).toMatchObject({ status: 503, message: LINEAR_MESSAGES.unavailable });
    expect(await prisma.routine.findUniqueOrThrow({ where: { id: global.id } })).toMatchObject({
      active: false,
    });
    expect((await triggerRow(global.id)).activatedAt).toBeNull();
  });

  it("does not run issues or comments created before activation on the first poll", async () => {
    const owner = await account("first-poll");
    const { connection } = await connect(owner);
    const bot = await createBot(owner);
    const before = await databaseNow();
    const old = emulator.createIssue({
      teamId: "team-a",
      title: "Created before activation",
      createdAt: new Date(before.getTime() - 60_000).toISOString(),
      updatedAt: new Date(before.getTime() - 60_000).toISOString(),
    });
    commentAt(old.id, new Date(before.getTime() - 30_000));
    const routine = await createRoutine(
      owner,
      bot.id,
      trigger(connection.id, { events: ["issue.created", "issue.updated", "comment.created"] }),
    );
    const activatedAt = (await triggerRow(routine.id)).activatedAt!;
    expect(activatedAt.getTime()).toBeGreaterThan(before.getTime());

    const fresh = issueAfter(activatedAt, 1_000);
    commentAt(fresh.id, new Date(activatedAt.getTime() + 2_000));
    emulator.updateIssue(old.id, {
      title: "Edited after activation",
      updatedAt: new Date(activatedAt.getTime() + 3_000).toISOString(),
    });
    runClockAt(new Date(activatedAt.getTime() + 10_000));
    await sync(connection.id);

    expect((await source(connection.id)).lastPolledAt).toBeInstanceOf(Date);
    const events = await prisma.linearEvent.findMany({ where: { connectionId: connection.id } });
    expect(events.map((event) => `${event.kind}:${event.issueId}`).sort()).toEqual(
      [
        `comment.created:${fresh.id}`,
        `issue.created:${fresh.id}`,
        `issue.updated:${old.id}`,
      ].sort(),
    );
    const runs = await linearRuns(routine.id);
    expect(runs).toHaveLength(3);
    const prompts = runs.map((run) => run.task.prompt);
    expect(prompts.filter((prompt) => prompt.includes(fresh.identifier))).toHaveLength(2);
    const oldPrompts = prompts.filter((prompt) => prompt.includes(old.identifier));
    expect(oldPrompts).toHaveLength(1);
    expect(oldPrompts[0]).toContain("issue.updated");
  });

  it("starts fresh baselines on pause/resume, filter and account changes and reconnect only", async () => {
    const { owner, connection, routine } = await activeRoutine();
    const first = await triggerRow(routine.id);
    const sourceBefore = await source(connection.id);
    const requestsBefore = emulator.requests().length;
    await owner.call("routines/update", {
      routineId: routine.id,
      name: "Renamed triage",
      prompt: "A different instruction",
      notify: true,
    });
    await prisma.routine.update({
      where: { id: routine.id },
      data: { modelProvider: "scripted", modelId: "scripted" },
    });
    await owner.call("routines/update", { routineId: routine.id, modelProvider: null, modelId: null });
    expect(await triggerRow(routine.id)).toMatchObject({
      activatedAt: first.activatedAt,
      revision: first.revision,
    });
    expect((await source(connection.id)).revision).toBe(sourceBefore.revision);
    expect(emulator.requests()).toHaveLength(requestsBefore);

    await owner.call("routines/update", { routineId: routine.id, active: false });
    expect(await triggerRow(routine.id)).toMatchObject({
      activatedAt: null,
      revision: first.revision + 1,
    });
    expect(await source(connection.id)).toMatchObject({
      monitoringSince: null,
      nextPollAt: null,
      nextSyncAt: null,
    });
    const whilePaused = await databaseNow();
    const missed = emulator.createIssue({
      teamId: "team-a",
      title: "Created while paused",
      createdAt: whilePaused.toISOString(),
      updatedAt: whilePaused.toISOString(),
    });
    await owner.call("routines/update", { routineId: routine.id, active: true });
    const resumed = await triggerRow(routine.id);
    expect(resumed.revision).toBe(first.revision + 2);
    expect(resumed.activatedAt!.getTime()).toBeGreaterThan(whilePaused.getTime());
    expect((await source(connection.id)).monitoringSince!.getTime()).toBeGreaterThan(
      whilePaused.getTime(),
    );
    const afterResume = issueAfter(resumed.activatedAt!, 1_000);
    runClockAt(new Date(resumed.activatedAt!.getTime() + 10_000));
    await sync(connection.id);
    const resumedRuns = await linearRuns(routine.id);
    expect(resumedRuns).toHaveLength(1);
    expect(resumedRuns[0]!.task.prompt).toContain(afterResume.identifier);
    expect(resumedRuns[0]!.task.prompt).not.toContain(missed.identifier);

    await owner.call("routines/update", {
      routineId: routine.id,
      linearTrigger: trigger(connection.id, { stateId: "state-a" }),
    });
    const filtered = await triggerRow(routine.id);
    expect(filtered.revision).toBe(resumed.revision + 1);
    expect(filtered.activatedAt!.getTime()).toBeGreaterThan(resumed.activatedAt!.getTime());
    expect((await linearRuns(routine.id))[0]).toMatchObject({ status: "cancelled" });

    const second = await connect(owner);
    await owner.call("routines/update", {
      routineId: routine.id,
      linearTrigger: trigger(second.connection.id, { stateId: "state-a" }),
    });
    const moved = await triggerRow(routine.id);
    expect(moved.connectionId).toBe(second.connection.id);
    expect(moved.activatedAt!.getTime()).toBeGreaterThan(filtered.activatedAt!.getTime());
    expect(await source(connection.id)).toMatchObject({ monitoringSince: null, nextSyncAt: null });
    const secondSource = await source(second.connection.id);
    expect(secondSource.monitoringSince).toBeInstanceOf(Date);

    await owner.call("linear/connect", {
      apiKey: newKey(),
      displayName: "Work",
      connectionId: second.connection.id,
      expectedRevision: secondSource.revision,
    });
    const reconnected = await triggerRow(routine.id);
    expect(reconnected.activatedAt!.getTime()).toBeGreaterThan(moved.activatedAt!.getTime());
    const reconnectedSource = await source(second.connection.id);
    expect(reconnectedSource.generation).toBe(secondSource.generation + 1);
    expect(reconnectedSource.monitoringSince!.getTime()).toBeGreaterThan(
      secondSource.monitoringSince!.getTime(),
    );
  });

  it("returns CONFLICT when a revoke or reconnect commits during metadata validation", async () => {
    for (const change of ["revoke", "reconnect"] as const) {
      const owner = await account(`metadata-${change}`);
      const { connection } = await connect(owner);
      const bot = await createBot(owner);
      const revision = (await source(connection.id)).revision;
      const gate = holdResponse("LinearTeams");
      const saving = owner.attempt("routines/create", routineInput(bot.id, trigger(connection.id)));
      await gate.arrived.promise;
      if (change === "revoke") {
        await owner.call("connections/revoke", { connectionId: connection.id });
      } else {
        await owner.call("linear/connect", {
          apiKey: newKey(),
          displayName: "Work",
          connectionId: connection.id,
          expectedRevision: revision,
        });
      }
      gate.release.resolve();
      expect(await saving, change).toMatchObject({
        status: 409,
        code: "CONFLICT",
        message: LINEAR_MESSAGES.changed,
      });
      expect(await prisma.routine.count({ where: { botId: bot.id } })).toBe(0);
    }

    const owner = await account("options-revoke");
    const { connection } = await connect(owner);
    const gate = holdResponse("LinearTeams");
    const listing = owner.attempt("linear/options", { connectionId: connection.id, kind: "teams" });
    await gate.arrived.promise;
    await owner.call("connections/revoke", { connectionId: connection.id });
    gate.release.resolve();
    expect(await listing).toMatchObject({ status: 409, message: LINEAR_MESSAGES.changed });
  });

  it("never lets an expired lease commit the old worker's page", async () => {
    const { connection, routine, activatedAt } = await activeRoutine();
    const vanished = issueAfter(activatedAt, 1_000);
    runClockAt(new Date(activatedAt.getTime() + 10_000));
    const gate = holdResponse("LinearIssues");
    const stale = sync(connection.id);
    try {
      await gate.arrived.promise;
      expect((await source(connection.id)).leaseToken).not.toBeNull();
      emulator.deleteIssue(vanished.id);
      vi.setSystemTime(Date.now() + 91_000);
      await sync(connection.id);
    } finally {
      gate.release.resolve();
      await stale;
    }
    const replaced = await source(connection.id);
    expect(replaced.lastPolledAt).toBeInstanceOf(Date);
    expect(await prisma.linearEvent.count({ where: { connectionId: connection.id } })).toBe(0);
    expect(await linearRuns(routine.id)).toHaveLength(0);
    expect(await source(connection.id)).toMatchObject({
      issuesThrough: replaced.issuesThrough,
      issueCursor: null,
      issueWindowEnd: null,
      lastPolledAt: replaced.lastPolledAt,
      nextSyncAt: replaced.nextSyncAt,
      leaseToken: null,
    });
  });

  it("creates no run when a pause commits before fan-out", async () => {
    const owner = await account("pause-race");
    const { connection } = await connect(owner);
    const bot = await createBot(owner);
    const paused = await createRoutine(
      owner,
      bot.id,
      trigger(connection.id, { events: ["issue.created", "comment.created"] }),
    );
    const other = await createRoutine(owner, bot.id, trigger(connection.id, { teamId: "team-b" }));
    const activatedAt = (await triggerRow(other.id)).activatedAt!;
    const issue = issueAfter(activatedAt, 1_000);
    runClockAt(new Date(activatedAt.getTime() + 10_000));
    const gate = holdResponse("LinearComments");
    const worker = sync(connection.id);
    try {
      await gate.arrived.promise;
      await waitUntil("the issue page commit", async () =>
        Boolean(
          await prisma.linearEvent.findFirst({
            where: { connectionId: connection.id, entityId: issue.id },
          }),
        ),
      );
      await owner.call("routines/update", { routineId: paused.id, active: false });
    } finally {
      gate.release.resolve();
      await worker;
    }
    const event = () =>
      prisma.linearEvent.findFirstOrThrow({
        where: { connectionId: connection.id, entityId: issue.id },
      });
    expect(await event()).toMatchObject({ status: "pending" });
    await sync(connection.id);
    expect(await event()).toMatchObject({ status: "done", snapshot: null });
    expect(await linearRuns(paused.id)).toHaveLength(0);
    expect(await linearRuns(other.id)).toHaveLength(0);
  });

  it("archive cancels a run that dispatch committed first and clears due work", async () => {
    const { owner, connection, bot, routine, activatedAt } = await activeRoutine();
    issueAfter(activatedAt, 1_000);
    runClockAt(new Date(activatedAt.getTime() + 10_000));
    const blocker = await lockingClient("SELECT id FROM routines WHERE id = $1 FOR UPDATE", [
      routine.id,
    ]);
    let worker: Promise<void> | null = null;
    let archiving: Promise<unknown> | null = null;
    try {
      worker = sync(connection.id);
      const dispatchPid = await waitForLockWaiter(blocker.pid, "%FROM routines%");
      archiving = owner.call("bots/archive", { botId: bot.id });
      await waitForLockWaiter(dispatchPid, "%FROM bots%");
      await blocker.commit();
      await Promise.all([worker, archiving]);
    } finally {
      await blocker.close();
      await Promise.allSettled([worker, archiving]);
    }
    const runs = await linearRuns(routine.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "cancelled" });
    expect(runs[0]!.task.status).toBe("cancelled");
    expect(await prisma.routine.findUniqueOrThrow({ where: { id: routine.id } })).toMatchObject({
      active: false,
    });
    expect((await triggerRow(routine.id)).activatedAt).toBeNull();
    expect(await source(connection.id)).toMatchObject({
      monitoringSince: null,
      nextPollAt: null,
      nextSyncAt: null,
    });
  });

  it("destroy and membership loss clear due intent", async () => {
    const destroyed = await activeRoutine();
    expect((await source(destroyed.connection.id)).nextSyncAt).toBeInstanceOf(Date);
    await destroyed.owner.call("bots/remove", { botId: destroyed.bot.id, deleteMemories: true });
    expect(await source(destroyed.connection.id)).toMatchObject({
      monitoringSince: null,
      nextPollAt: null,
      nextSyncAt: null,
    });
    expect(
      await prisma.routineLinearTrigger.count({ where: { connectionId: destroyed.connection.id } }),
    ).toBe(0);

    const { owner, connection, routine, activatedAt } = await activeRoutine();
    const issue = issueAfter(activatedAt, 1_000);
    runClockAt(new Date(activatedAt.getTime() + 10_000));
    const gate = holdResponse("LinearIssues");
    const worker = sync(connection.id);
    try {
      await gate.arrived.promise;
      await prisma.spaceMember.delete({
        where: { spaceId_userId: { spaceId: owner.spaceId, userId: owner.userId } },
      });
    } finally {
      gate.release.resolve();
      await worker;
    }
    expect(
      await prisma.linearEvent.count({ where: { connectionId: connection.id, entityId: issue.id } }),
    ).toBe(0);
    expect(await linearRuns(routine.id)).toHaveLength(0);
    expect(await source(connection.id)).toMatchObject({
      monitoringSince: null,
      nextPollAt: null,
      nextSyncAt: null,
      leaseToken: null,
    });
    const requests = emulator.requests().length;
    await sync(connection.id);
    expect(emulator.requests()).toHaveLength(requests);
  });

  it("rejects a receipt verified with a rotated secret while a durable receipt survives", async () => {
    const { owner, connection, routine, activatedAt } = await activeRoutine();
    const actor = { userId: owner.userId, spaceId: owner.spaceId };
    const firstSecret = `whsec_first_${stamp}`;
    const secondSecret = `whsec_second_${stamp}`;
    const configure = async (signingSecret: string) =>
      publicService.configureWebhook(actor, {
        connectionId: connection.id,
        expectedRevision: (await source(connection.id)).revision,
        signingSecret,
      });
    await configure(firstSecret);
    const durable = issueAfter(activatedAt, 1_000);
    const control = issueAfter(activatedAt, 2_000);
    const stale = issueAfter(activatedAt, 3_000);
    expect(await deliver(webhookApp(store), connection.id, firstSecret, durable.id)).toBe(200);

    const unrotated = gatedSecretStore();
    const controlDelivery = deliver(webhookApp(unrotated.store), connection.id, firstSecret, control.id);
    await unrotated.gate.arrived.promise;
    unrotated.gate.release.resolve();
    expect(await controlDelivery).toBe(200);

    const verifying = gatedSecretStore();
    const staleDelivery = deliver(webhookApp(verifying.store), connection.id, firstSecret, stale.id);
    try {
      await verifying.gate.arrived.promise;
      await configure(secondSecret);
    } finally {
      verifying.gate.release.resolve();
    }
    expect(await staleDelivery).toBe(503);
    const staleEvents = () =>
      prisma.linearEvent.count({ where: { connectionId: connection.id, entityId: stale.id } });
    expect(await staleEvents()).toBe(0);
    const durableEvent = await prisma.linearEvent.findFirstOrThrow({
      where: { connectionId: connection.id, entityId: durable.id },
    });
    expect(durableEvent).toMatchObject({ status: "pending", transport: "webhook" });
    expect(durableEvent.seed).not.toBeNull();
    expect(await deliver(webhookApp(store), connection.id, firstSecret, stale.id)).toBe(401);
    expect(await staleEvents()).toBe(0);
    expect(await deliver(webhookApp(store), connection.id, secondSecret, stale.id)).toBe(200);
    expect(await staleEvents()).toBe(1);

    await sync(connection.id);
    expect(
      await prisma.linearEvent.findUniqueOrThrow({ where: { id: durableEvent.id } }),
    ).toMatchObject({ status: "done", seed: null });
    const runs = await linearRuns(routine.id);
    expect(runs.some((run) => run.task.prompt.includes(durable.identifier))).toBe(true);
  });

  it("keeps a one-shot routine with a Linear trigger active after the one-shot fires", async () => {
    const { owner, bot, routine } = await activeRoutine();
    const scheduled = new Date(Date.now() - 1_000);
    await prisma.routine.update({
      where: { id: routine.id },
      data: { crons: [ONCE_ROUTINE_CRON], nextRunAt: scheduled },
    });
    const before = await triggerRow(routine.id);
    await handles.executor.wakeRoutine(routine.id, scheduled.toISOString());
    expect(await prisma.run.count({ where: { routineId: routine.id, trigger: "routine" } })).toBe(1);
    const fired = await prisma.routine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(fired).toMatchObject({ active: true, nextRunAt: null });
    expect(fired.lastRunAt).toBeInstanceOf(Date);
    expect(await triggerRow(routine.id)).toMatchObject({
      activatedAt: before.activatedAt,
      revision: before.revision,
    });
    const reloaded = await owner.call<RoutineRow[]>("routines/list", { botId: bot.id });
    expect(reloaded.find((row) => row.id === routine.id)).toMatchObject({
      active: true,
      nextRunAt: null,
    });
  });

  it("fails closed when a Linear run has no provenance", async () => {
    const { run } = await dispatchedRun();
    await prisma.run.update({ where: { id: run.id }, data: { linearEventId: null } });
    await handles.executor.continueRun(run.id, "worker-without-provenance");
    const after = await prisma.run.findUniqueOrThrow({ where: { id: run.id }, include: { task: true } });
    expect(after.status).toBe("cancelled");
    expect(after.task.status).toBe("cancelled");
    expect(runtime.started).not.toContain(run.id);
    expect(await prisma.attempt.count({ where: { runId: run.id } })).toBe(0);
  });

  it.each(["revoke", "pause"] as const)(
    "a %s committed before the locked start prevents the model start",
    async (change) => {
      const { owner, connection, routine, run } = await dispatchedRun();
      const blocker = await lockingClient("SELECT id FROM connections WHERE id = $1 FOR UPDATE", [
        connection.id,
      ]);
      let lifecycle: Promise<unknown> | null = null;
      let starting: Promise<void> | null = null;
      try {
        lifecycle =
          change === "revoke"
            ? owner.call("connections/revoke", { connectionId: connection.id })
            : owner.call("routines/update", { routineId: routine.id, active: false });
        const lifecyclePid = await waitForLockWaiter(blocker.pid, "%FROM connections%");
        starting = handles.executor.continueRun(run.id, `worker-after-${change}`);
        await waitForLockWaiter(lifecyclePid, "%pg_advisory_xact_lock%");
        await blocker.commit();
        await Promise.all([lifecycle, starting]);
      } finally {
        await blocker.close();
        await Promise.allSettled([lifecycle, starting]);
      }
      const after = await prisma.run.findUniqueOrThrow({
        where: { id: run.id },
        include: { task: true },
      });
      expect(after.status).toBe("cancelled");
      expect(after.task.status).toBe("cancelled");
      expect(runtime.started).not.toContain(run.id);
      expect(await prisma.attempt.count({ where: { runId: run.id } })).toBe(0);
    },
  );

  it("cancels a run whose start won before revoke without claiming to undo it", async () => {
    const { owner, connection, run } = await dispatchedRun();
    const gate: Gate = { arrived: deferred(), release: deferred() };
    runtime.gate = gate;
    const starting = handles.executor.continueRun(run.id, "worker-started");
    try {
      await gate.arrived.promise;
      expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: "running",
      });
      await owner.call("connections/revoke", { connectionId: connection.id });
      expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: "cancelled",
      });
    } finally {
      gate.release.resolve();
      await starting;
    }
    expect(runtime.started).toContain(run.id);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "cancelled",
    });
    expect(
      await prisma.event.count({ where: { runId: run.id, type: "run.cancelled" } }),
    ).toBe(1);
  });
});
