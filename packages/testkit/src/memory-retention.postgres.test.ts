import { randomUUID } from "node:crypto";
import type { AdapterContext, BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import {
  createMemoryRetainHandler,
  createMemoryRetentionReconciler,
  EncryptedSecretStore,
  HINDSIGHT_CLOUD_ORIGIN,
  prepareConversationRetention,
  retentionDocumentId,
  SpaceMemoryProviderResolver,
} from "@rakazo/adapters";
import {
  claimMemoryRetention,
  claimSteering,
  clearThread,
  createDb,
  finalizeRun,
  insertExplicitMemoryRetention,
  listDueMemoryRetentions,
  loadRetentionSourceMessages,
  type Pool,
  type PrismaClient,
  pinRunMemorySelection,
  settleMemoryRetention,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type HindsightEmulator,
  type HindsightFixture,
  startHindsightEmulator,
} from "./hindsight-emulator.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

const WORKER = "worker-retention";
const LEASE_MS = 120_000;
const HOUR = 60 * 60_000;

describePostgres("memory retention (PostgreSQL + Hindsight emulator)", () => {
  let db: { prisma: PrismaClient; pool: Pool };
  let prisma: PrismaClient;
  let emulator: HindsightEmulator;
  const secrets = new EncryptedSecretStore("memory-retention-test-encryption-key");
  const users: string[] = [];
  let clock = new Date();
  const enqueued: BackgroundJob[] = [];
  const jobs: JobPublisher = {
    enqueue: async (job) => {
      enqueued.push(job);
    },
    cancel: async () => undefined,
    close: async () => undefined,
  };

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    emulator = await startHindsightEmulator();
  });

  afterAll(async () => {
    await emulator?.close();
    if (!db) return;
    await prisma.organization.deleteMany({ where: { id: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
    await db.pool.end();
  });

  const resolver = () =>
    new SpaceMemoryProviderResolver({
      prisma,
      secrets,
      memoryTransport: { fetch: emulator.fetch },
    });
  const handler = () =>
    createMemoryRetainHandler({ prisma, resolver: resolver(), jobs, now: () => clock });
  const retention = (id: string) => prisma.memoryRetention.findUnique({ where: { id } });
  const retainRequests = (fixture: HindsightFixture) =>
    fixture.requests.filter((request) => request.route === "retain");

  async function setup() {
    clock = new Date();
    const id = randomUUID();
    users.push(id);
    await prisma.user.create({
      data: { id, name: "Retention", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Retention", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Retention" } });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    await prisma.spaceMember.create({
      data: {
        id,
        spaceId: id,
        organizationId: id,
        userId: id,
        role: "owner",
        createdAt: new Date(),
      },
    });
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Retention", color: "test-color" },
    });
    const thread = await prisma.thread.create({
      data: { spaceId: id, userId: id, botId: bot.id, nextMessageSeq: 1 },
    });
    const source = await prisma.message.create({
      data: {
        threadId: thread.id,
        seq: 0,
        role: "user",
        blocks: [{ kind: "text", text: "I prefer jasmine tea." }],
      },
    });
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        prompt: "I prefer jasmine tea.",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "running",
        trigger: "user",
        leaseOwner: WORKER,
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + HOUR),
        sourceMessageId: source.id,
        startedAt: new Date(),
      },
    });
    const attempt = await prisma.attempt.create({
      data: { runId: run.id, fence: 1, status: "running" },
    });
    const fixture = emulator.createFixture({
      banks: [
        { bankId: "bank-a", name: "Alpha" },
        { bankId: "bank-b", name: "Beta" },
      ],
    });
    const context: AdapterContext = {
      operationId: "test",
      traceId: "test",
      spaceId: id,
      userId: id,
      signal: new AbortController().signal,
    };
    const secretId = randomUUID().replaceAll("-", "");
    const record = await secrets.put(JSON.stringify({ apiKey: fixture.apiKey }), context, {
      recordId: secretId,
    });
    await prisma.secret.create({
      data: {
        id: secretId,
        userId: id,
        spaceId: id,
        kind: "memory-provider",
        ciphertext: record.ciphertext,
      },
    });
    const config = await prisma.spaceMemoryConfig.create({
      data: {
        spaceId: id,
        userId: id,
        provider: "hindsight",
        settings: { baseUrl: HINDSIGHT_CLOUD_ORIGIN },
        secretId,
      },
    });
    const binding = await prisma.botMemoryBank.create({
      data: { botId: bot.id, spaceMemoryConfigId: config.id, bankId: "bank-a", name: "Alpha" },
    });
    await pinRunMemorySelection(prisma, {
      runId: run.id,
      leaseOwner: WORKER,
      leaseFence: 1,
      selection: {
        kind: "bank",
        configId: config.id,
        provider: "hindsight",
        bindingId: binding.id,
        bankId: "bank-a",
      },
    });
    let nextSeq = 1;
    const addUserMessage = async (text: string, role = "user") => {
      const seq = nextSeq++;
      await prisma.thread.update({ where: { id: thread.id }, data: { nextMessageSeq: seq + 1 } });
      return prisma.message.create({
        data: { threadId: thread.id, seq, role, blocks: [{ kind: "text", text }] },
      });
    };
    const finalizeInput = (
      memoryRetention?: {
        bindingId: string;
        content: string;
        occurredAt: string;
        sourceMessageIds: string[];
      },
      overrides: { attemptId?: string; leaseFence?: number } = {},
    ) => ({
      spaceId: id,
      threadId: thread.id,
      botId: bot.id,
      runId: run.id,
      taskId: task.id,
      attemptId: overrides.attemptId ?? attempt.id,
      leaseOwner: WORKER,
      leaseFence: overrides.leaseFence ?? 1,
      outcome: "completed" as const,
      blocks: [{ kind: "text" as const, text: "Noted: jasmine tea." }],
      ...(memoryRetention ? { memoryRetention } : {}),
    });
    const conversation = async (messageIds: string[] = [source.id]) => {
      const sources = await loadRetentionSourceMessages(prisma, {
        runId: run.id,
        threadId: thread.id,
        messageIds,
      });
      const prepared = prepareConversationRetention({
        userSources: sources,
        assistantText: "Noted: jasmine tea.",
        completedAt: new Date(),
        metadata: {
          space_id: id,
          bot_id: bot.id,
          thread_id: thread.id,
          run_id: run.id,
          source_kind: "conversation",
          source_key: "conversation",
        },
      });
      if (!prepared) throw new Error("Nothing to retain");
      return {
        bindingId: binding.id,
        content: prepared.content,
        occurredAt: new Date().toISOString(),
        sourceMessageIds: prepared.sourceMessageIds,
      };
    };
    const commit = async (messageIds?: string[]) => {
      const result = await finalizeRun(prisma, finalizeInput(await conversation(messageIds)));
      if (!result?.memoryRetentionId) throw new Error("Expected a learning intent");
      clock = new Date();
      return result.memoryRetentionId;
    };
    const drive = async (retentionId: string) => {
      await handler()({ retentionId });
      return prisma.memoryRetention.findUniqueOrThrow({ where: { id: retentionId } });
    };
    const driveUntil = async (retentionId: string, state: string) => {
      for (let step = 0; step < 50; step++) {
        const row = await drive(retentionId);
        if (row.state === state) return row;
        if (row.state === "completed" || row.state === "failed") return row;
        if (row.nextAttemptAt) clock = row.nextAttemptAt;
      }
      throw new Error(`Retention ${retentionId} never reached ${state}`);
    };
    return {
      id,
      bot,
      thread,
      source,
      task,
      run,
      attempt,
      fixture,
      config,
      binding,
      addUserMessage,
      finalizeInput,
      conversation,
      commit,
      drive,
      driveUntil,
    };
  }

  it("commits one intent with the winning reply and none for losers, stale fences or rollbacks", async () => {
    const s = await setup();
    const intent = await s.conversation();
    const results = await Promise.all([
      finalizeRun(prisma, s.finalizeInput(intent)),
      finalizeRun(prisma, s.finalizeInput(intent)),
    ]);
    const winners = results.filter((result) => result !== false);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.memoryRetentionId).toEqual(expect.any(String));
    const rows = await prisma.memoryRetention.findMany({ where: { runId: s.run.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: winners[0]?.memoryRetentionId,
      state: "pending",
      attemptCount: 0,
      sourceKind: "conversation",
      sourceKey: "conversation",
      content: intent.content,
      acceptedAt: null,
      claimToken: null,
      leaseUntil: null,
      failureCode: null,
    });
    expect(rows[0]?.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[0]?.nextAttemptAt?.getTime()).toBeLessThanOrEqual(Date.now());

    const stale = await setup();
    await expect(
      finalizeRun(prisma, stale.finalizeInput(await stale.conversation(), { leaseFence: 2 })),
    ).resolves.toBe(false);
    expect(await prisma.memoryRetention.count({ where: { runId: stale.run.id } })).toBe(0);

    const rolledBack = await setup();
    const trigger = `rakazo_test_fail_${rolledBack.bot.id}`;
    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION ${trigger}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'forced rollback'; END $$ LANGUAGE plpgsql`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${trigger} BEFORE UPDATE ON bots FOR EACH ROW WHEN (OLD.id = '${rolledBack.bot.id}') EXECUTE FUNCTION ${trigger}()`,
    );
    try {
      await expect(
        finalizeRun(prisma, rolledBack.finalizeInput(await rolledBack.conversation())),
      ).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER ${trigger} ON bots`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION ${trigger}()`);
    }
    expect(await prisma.memoryRetention.count({ where: { runId: rolledBack.run.id } })).toBe(0);
    expect(
      await prisma.message.count({ where: { threadId: rolledBack.thread.id, role: "bot" } }),
    ).toBe(0);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: rolledBack.run.id } })).status).toBe(
      "running",
    );
  });

  it("replays explicit saves without replacing the stored intent", async () => {
    const s = await setup();
    const save = (content: string, sourceKey = "effect-1") =>
      insertExplicitMemoryRetention(prisma, {
        runId: s.run.id,
        leaseOwner: WORKER,
        leaseFence: 1,
        bindingId: s.binding.id,
        sourceKey,
        content,
        occurredAt: new Date(),
      });
    const [first, concurrent] = await Promise.all([save("Likes jasmine."), save("Likes jasmine.")]);
    if (!("retentionId" in first) || !("retentionId" in concurrent))
      throw new Error("Expected rows");
    expect(concurrent.retentionId).toBe(first.retentionId);
    expect([first.created, concurrent.created].sort()).toEqual([false, true]);
    const stored = await retention(first.retentionId);
    const replay = await save("Changed wording");
    expect(replay).toEqual({ retentionId: first.retentionId, created: false });
    expect(await retention(first.retentionId)).toEqual(stored);
    expect(stored).toMatchObject({
      sourceKind: "durable",
      content: "Likes jasmine.",
      state: "pending",
    });
    await expect(
      insertExplicitMemoryRetention(prisma, {
        runId: s.run.id,
        leaseOwner: WORKER,
        leaseFence: 2,
        bindingId: s.binding.id,
        sourceKey: "effect-2",
        content: "Late",
        occurredAt: new Date(),
      }),
    ).resolves.toEqual({ error: "fence_lost" });
    expect(await prisma.memoryRetention.count({ where: { runId: s.run.id } })).toBe(1);
  });

  it("attributes only delivered sources, deduplicates them and crops oversized turns", async () => {
    const s = await setup();
    const steering = await s.addUserMessage("Green tea, not black. ".repeat(400));
    await prisma.steeringMessage.create({
      data: { messageId: steering.id, botId: s.bot.id, userId: s.id },
    });
    const claimed = await claimSteering(prisma, {
      threadId: s.thread.id,
      botId: s.bot.id,
      runId: s.run.id,
      leaseOwner: WORKER,
      leaseFence: 1,
      seenIds: [],
    });
    expect(claimed.map((item) => item.messageId)).toEqual([steering.id]);
    const assigned = await s.addUserMessage("Also oolong.");
    await prisma.steeringMessage.create({
      data: { messageId: assigned.id, botId: s.bot.id, userId: s.id, runId: s.run.id },
    });
    const botMessage = await s.addUserMessage("Earlier reply", "bot");

    const sources = await loadRetentionSourceMessages(prisma, {
      runId: s.run.id,
      threadId: s.thread.id,
      messageIds: [s.source.id, s.source.id, steering.id, assigned.id, botMessage.id],
    });
    expect(sources.map((source) => source.id)).toEqual([s.source.id, steering.id]);

    const retentionId = await s.commit([s.source.id, steering.id, assigned.id]);
    const row = await retention(retentionId);
    expect(row?.content).toContain("User ");
    expect(row?.content).toContain("I prefer jasmine tea.");
    expect(row?.content).toContain("\n[truncated]");
    expect(row?.content).not.toContain("Also oolong.");
    expect(row?.content).toMatch(/\n\nAssistant [^\n]+:\nNoted: jasmine tea\.$/);
    expect(await prisma.steeringMessage.count({ where: { messageId: steering.id } })).toBe(0);
  });

  it("skips the whole intent when a source disappears but still commits the reply", async () => {
    const s = await setup();
    const steering = await s.addUserMessage("Green tea, please.");
    await prisma.steeringMessage.create({
      data: { messageId: steering.id, botId: s.bot.id, userId: s.id },
    });
    await claimSteering(prisma, {
      threadId: s.thread.id,
      botId: s.bot.id,
      runId: s.run.id,
      leaseOwner: WORKER,
      leaseFence: 1,
      seenIds: [],
    });
    const intent = await s.conversation([s.source.id, steering.id]);
    await prisma.message.delete({ where: { id: steering.id } });
    await expect(finalizeRun(prisma, s.finalizeInput(intent))).resolves.toEqual({
      continuationRunId: null,
      memoryRetentionId: null,
    });
    expect(await prisma.memoryRetention.count({ where: { runId: s.run.id } })).toBe(0);
    expect(await prisma.message.count({ where: { threadId: s.thread.id, role: "bot" } })).toBe(1);
  });

  it("delivers captured content after the thread is cleared and clears it on acceptance", async () => {
    const s = await setup();
    const retentionId = await s.commit();
    const content = (await retention(retentionId))?.content;
    await clearThread(prisma, { spaceId: s.id, threadId: s.thread.id, botId: s.bot.id });
    expect(await prisma.message.count({ where: { threadId: s.thread.id } })).toBe(0);
    expect((await retention(retentionId))?.content).toBe(content);

    const accepted = await s.drive(retentionId);
    expect(accepted).toMatchObject({
      state: "processing",
      content: null,
      attemptCount: 0,
      claimToken: null,
      leaseUntil: null,
    });
    expect(accepted.acceptedAt).toEqual(clock);
    expect(accepted.nextAttemptAt).toEqual(new Date(clock.getTime() + 30_000));
    expect(enqueued.at(-1)).toMatchObject({
      name: "memory.retain",
      payload: { retentionId },
      availableAt: accepted.nextAttemptAt,
    });
    const [request] = retainRequests(s.fixture);
    expect(request?.body).toMatchObject({
      items: [
        {
          content,
          document_id: retentionDocumentId(s.config.id, s.bot.id, s.run.id, "conversation"),
          context: "Rakazo conversation",
          update_mode: "replace",
          metadata: {
            space_id: s.id,
            bot_id: s.bot.id,
            thread_id: s.thread.id,
            run_id: s.run.id,
            source_kind: "conversation",
            source_key: "conversation",
          },
        },
      ],
      async: true,
      operation_id: accepted.operationId,
    });

    clock = accepted.nextAttemptAt!;
    const completed = await s.drive(retentionId);
    expect(completed).toMatchObject({ state: "completed", content: null, nextAttemptAt: null });
    const bank = s.fixture.snapshot().banks.find((item) => item.bankId === "bank-a");
    expect(bank?.documents.map((document) => document.content)).toContain(content);
  });

  it("stops new calls after rebind, disconnect, bot deletion or revoked membership", async () => {
    const rebound = await setup();
    const first = await rebound.commit();
    await prisma.botMemoryBank.delete({ where: { id: rebound.binding.id } });
    const bindingB = await prisma.botMemoryBank.create({
      data: {
        botId: rebound.bot.id,
        spaceMemoryConfigId: rebound.config.id,
        bankId: "bank-b",
        name: "Beta",
      },
    });
    await prisma.botMemoryBank.delete({ where: { id: bindingB.id } });
    await prisma.botMemoryBank.create({
      data: {
        botId: rebound.bot.id,
        spaceMemoryConfigId: rebound.config.id,
        bankId: "bank-a",
        name: "Alpha",
      },
    });
    expect(await retention(first)).toBeNull();
    await handler()({ retentionId: first });
    await expect(
      insertExplicitMemoryRetention(prisma, {
        runId: rebound.run.id,
        leaseOwner: WORKER,
        leaseFence: 1,
        bindingId: rebound.binding.id,
        sourceKey: "effect-1",
        content: "Retired pin",
        occurredAt: new Date(),
      }),
    ).resolves.toEqual({ error: "binding_retired" });
    expect(rebound.fixture.requests).toHaveLength(0);

    const disconnected = await setup();
    const pending = await disconnected.commit();
    await prisma.spaceMemoryConfig.delete({ where: { id: disconnected.config.id } });
    expect(await retention(pending)).toBeNull();
    await handler()({ retentionId: pending });
    expect(disconnected.fixture.requests).toHaveLength(0);

    const deleted = await setup();
    const orphan = await deleted.commit();
    await prisma.bot.delete({ where: { id: deleted.bot.id } });
    expect(await retention(orphan)).toBeNull();
    expect(deleted.fixture.requests).toHaveLength(0);

    const revoked = await setup();
    const denied = await revoked.commit();
    await prisma.spaceMember.delete({ where: { id: revoked.id } });
    expect(await revoked.drive(denied)).toMatchObject({
      state: "failed",
      failureCode: "forbidden",
      content: null,
      nextAttemptAt: null,
    });
    expect(revoked.fixture.requests).toHaveLength(0);
    expect(
      [rebound, disconnected, deleted, revoked].flatMap((s) =>
        s.fixture.requests.filter((request) => request.method === "DELETE"),
      ),
    ).toEqual([]);
  });

  it("fails on known bank absence instead of retaining elsewhere", async () => {
    const s = await setup();
    const retentionId = await s.commit();
    s.fixture.removeBank("bank-a");
    expect(await s.drive(retentionId)).toMatchObject({ state: "failed", failureCode: "not_found" });
    expect(s.fixture.requests.map((request) => request.route)).toEqual(["profile"]);
  });

  it("claims with compare-and-set leases and recovers after a lease expires", async () => {
    const s = await setup();
    const retentionId = await s.commit();
    const claims = await Promise.all([
      claimMemoryRetention(prisma, { retentionId, now: clock, leaseMs: LEASE_MS }),
      claimMemoryRetention(prisma, { retentionId, now: clock, leaseMs: LEASE_MS }),
    ]);
    const winner = claims.find((claim) => claim !== null);
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    expect(await listDueMemoryRetentions(prisma, { now: clock, limit: 100 })).not.toContain(
      retentionId,
    );
    await handler()({ retentionId });
    expect(s.fixture.requests).toHaveLength(0);

    clock = new Date(clock.getTime() + LEASE_MS + 1_000);
    expect(await listDueMemoryRetentions(prisma, { now: clock, limit: 100 })).toContain(
      retentionId,
    );
    enqueued.length = 0;
    await createMemoryRetentionReconciler({ prisma, jobs, now: () => clock })();
    expect(enqueued.map((job) => job.payload)).toContainEqual({ retentionId });

    const recovered = await s.drive(retentionId);
    expect(recovered.state).toBe("processing");
    await expect(
      settleMemoryRetention(prisma, {
        retentionId,
        claimToken: winner!.claimToken,
        settlement: { kind: "finish", state: "failed", failureCode: "invalid_request" },
      }),
    ).resolves.toBe(false);
    expect((await retention(retentionId))?.state).toBe("processing");
  });

  it("reuses the same operation and document after a lost acknowledgement", async () => {
    const s = await setup();
    const retentionId = await s.commit();
    s.fixture.dropAcknowledgement("retain");
    const retried = await s.drive(retentionId);
    expect(retried).toMatchObject({ state: "pending", attemptCount: 1 });
    expect(retried.content).not.toBeNull();
    clock = retried.nextAttemptAt!;
    const accepted = await s.drive(retentionId);
    expect(accepted.state).toBe("processing");
    const bodies = retainRequests(s.fixture).map(
      (request) => request.body as { operation_id: string; items: Array<{ document_id: string }> },
    );
    expect(bodies).toHaveLength(2);
    expect(new Set(bodies.map((body) => body.operation_id))).toEqual(
      new Set([accepted.operationId]),
    );
    expect(new Set(bodies.map((body) => body.items[0]?.document_id))).toEqual(
      new Set([retentionDocumentId(s.config.id, s.bot.id, s.run.id, "conversation")]),
    );
    expect(s.fixture.snapshot().operations).toHaveLength(1);
  });

  it("makes no HTTP request when a settled intent is delivered again", async () => {
    const s = await setup();
    const retentionId = await s.commit();
    expect((await s.driveUntil(retentionId, "completed")).state).toBe("completed");
    const requests = s.fixture.requests.length;
    clock = new Date(clock.getTime() + HOUR);
    await handler()({ retentionId });
    await handler()({ retentionId });
    expect(s.fixture.requests).toHaveLength(requests);
  });

  it("never treats a missing or failed receipt as stored memory", async () => {
    for (const [status, failureCode] of [
      ["not_found", "operation_unknown"],
      ["failed", "operation_failed"],
      ["cancelled", "operation_cancelled"],
    ] as const) {
      const s = await setup();
      s.fixture.setOperationStatuses([status]);
      const retentionId = await s.commit();
      expect(await s.driveUntil(retentionId, "failed")).toMatchObject({
        state: "failed",
        failureCode,
      });
    }
  });

  it("recovers after more than five transient failures", async () => {
    const s = await setup();
    const retentionId = await s.commit();
    for (let index = 0; index < 7; index++) s.fixture.queueFailure("profile", { status: 503 });
    const attempts: number[] = [];
    let row = await s.drive(retentionId);
    while (row.state === "pending") {
      attempts.push(row.attemptCount);
      clock = row.nextAttemptAt!;
      row = await s.drive(retentionId);
    }
    expect(attempts).toEqual([1, 2, 3, 4, 5, 5, 5]);
    expect(row).toMatchObject({ state: "processing", attemptCount: 0 });
  });

  it("keeps polling healthy work past a day and expires accepted work after two days", async () => {
    const s = await setup();
    s.fixture.setOperationStatuses(["processing"]);
    const retentionId = await s.commit();
    const accepted = await s.drive(retentionId);
    expect(accepted.state).toBe("processing");
    const acceptedAt = accepted.acceptedAt!.getTime();

    clock = new Date(acceptedAt + 30 * HOUR);
    const polled = await s.drive(retentionId);
    expect(polled).toMatchObject({ state: "processing", failureCode: null });
    expect(polled.nextAttemptAt).toEqual(new Date(clock.getTime() + 600_000));

    const requests = s.fixture.requests.length;
    clock = new Date(acceptedAt + 48 * HOUR);
    expect(await s.drive(retentionId)).toMatchObject({
      state: "failed",
      failureCode: "operation_timeout",
    });
    expect(s.fixture.requests).toHaveLength(requests);
  });

  it("does not renew the pending deadline through retries or crashed claims", async () => {
    const s = await setup();
    const retentionId = await s.commit();
    const createdAt = (await retention(retentionId))!.createdAt.getTime();
    s.fixture.queueFailure("profile", { status: 503 });
    clock = new Date(createdAt + 23 * HOUR);
    expect(await s.drive(retentionId)).toMatchObject({ state: "pending", attemptCount: 1 });
    await claimMemoryRetention(prisma, {
      retentionId,
      now: new Date(createdAt + 23.5 * HOUR),
      leaseMs: LEASE_MS,
    });
    const requests = s.fixture.requests.length;
    clock = new Date(createdAt + 24 * HOUR);
    expect(await s.drive(retentionId)).toMatchObject({
      state: "failed",
      failureCode: "operation_timeout",
      content: null,
    });
    expect(s.fixture.requests).toHaveLength(requests);
  });

  it("does not dispatch or write after another worker takes over an expired claim", async () => {
    const s = await setup();
    const retentionId = await s.commit();
    const stale = await claimMemoryRetention(prisma, {
      retentionId,
      now: clock,
      leaseMs: LEASE_MS,
    });
    clock = new Date(clock.getTime() + LEASE_MS + 1_000);
    const current = await claimMemoryRetention(prisma, {
      retentionId,
      now: clock,
      leaseMs: LEASE_MS,
    });
    expect(current?.claimToken).not.toBe(stale?.claimToken);
    await expect(
      settleMemoryRetention(prisma, {
        retentionId,
        claimToken: stale!.claimToken,
        settlement: { kind: "accept", acceptedAt: clock, nextAttemptAt: clock },
      }),
    ).resolves.toBe(false);
    await handler()({ retentionId });
    expect(s.fixture.requests).toHaveLength(0);
    expect(await retention(retentionId)).toMatchObject({
      state: "pending",
      claimToken: current?.claimToken,
    });
  });
});
