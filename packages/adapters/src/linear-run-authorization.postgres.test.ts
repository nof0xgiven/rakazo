import { randomUUID } from "node:crypto";
import type { BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import { createDb, type PrismaClient } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { authorizeLinearRun } from "./linear-run-authorization.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describePostgres("Linear run start authorization (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let endPool: (() => Promise<void>) | undefined;
  const owners: string[] = [];

  beforeAll(() => {
    const db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    endPool = () => db.pool.end();
  });

  afterAll(async () => {
    if (!endPool) return;
    await prisma.space.deleteMany({ where: { id: { in: owners } } });
    await prisma.organization.deleteMany({ where: { id: { in: owners } } });
    await prisma.user.deleteMany({ where: { id: { in: owners } } });
    await prisma.$disconnect();
    await endPool();
  });

  async function setup(options: { linearEvent?: boolean } = {}) {
    const id = randomUUID();
    owners.push(id);
    await prisma.user.create({
      data: { id, name: "Linear auth", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Linear auth", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id, organizationId: id, name: "Linear auth", isDefault: true },
    });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Linear auth", color: "test-color" },
    });
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    const connection = await prisma.connection.create({
      data: {
        spaceId: id,
        userId: id,
        connectorId: "linear",
        provider: "linear",
        displayName: "Synthetic Linear",
        status: "connected",
      },
    });
    const activatedAt = new Date(Date.now() - 60_000);
    await prisma.linearSource.create({
      data: {
        connectionId: connection.id,
        organizationId: "org-synthetic",
        viewerId: "viewer-synthetic",
        organizationName: "Synthetic",
        monitoringSince: activatedAt,
      },
    });
    const routine = await prisma.routine.create({
      data: {
        spaceId: id,
        botId: bot.id,
        userId: id,
        name: "Triage",
        prompt: "Triage the issue.",
        crons: [],
        active: true,
        linearTrigger: {
          create: {
            connectionId: connection.id,
            teamId: "team-synthetic",
            events: ["issue.created"],
            labelIds: [],
            activatedAt,
          },
        },
      },
    });
    const event = await prisma.linearEvent.create({
      data: {
        connectionId: connection.id,
        sourceGeneration: 1,
        eventKey: `issue.created:${id}`,
        kind: "issue.created",
        entityId: id,
        issueId: id,
        occurredAt: new Date(Date.now() - 30_000),
        receivedAt: new Date(),
        transport: "poll",
        status: "done",
        nextAttemptAt: new Date(),
      },
    });
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        prompt: "Triage the issue.",
        status: "queued",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "queued",
        trigger: "linear",
        routineId: routine.id,
        linearEventId: options.linearEvent === false ? null : event.id,
      },
    });
    const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);
    const jobs: JobPublisher = {
      enqueue,
      cancel: async () => undefined,
      close: async () => undefined,
    };
    const notify = vi.fn(async () => undefined);
    const deps = { prisma, jobs, events: { notify } };
    const start = (workerId: string, fence: number) =>
      authorizeLinearRun(deps, {
        runId: run.id,
        workerId,
        fence,
        claim: {
          where: { id: run.id, status: "queued", checkpoint: null },
          data: {
            status: "leased",
            leaseOwner: workerId,
            leaseFence: fence,
            leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
            error: null,
            checkpoint: null,
          },
        },
      });
    const recheck = (workerId: string, fence: number) =>
      authorizeLinearRun(deps, { runId: run.id, workerId, fence });
    const state = async () => ({
      run: await prisma.run.findUniqueOrThrow({ where: { id: run.id } }),
      task: await prisma.task.findUniqueOrThrow({ where: { id: task.id } }),
      cancelledEvents: await prisma.event.count({
        where: { runId: run.id, type: "run.cancelled" },
      }),
    });
    return { id, bot, thread, connection, routine, run, notify, start, recheck, state };
  }

  async function waitForLockWait() {
    for (let attempt = 0; attempt < 5_000; attempt += 1) {
      const rows = await prisma.$queryRaw<Array<{ waiting: bigint }>>`
        SELECT count(*) AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
      `;
      if (Number(rows[0]?.waiting ?? 0) > 0) return;
    }
    throw new Error("Authorization never waited on the lifecycle lock");
  }

  it("claims and starts an eligible run inside the locked transaction", async () => {
    const f = await setup();
    await expect(f.start("worker-1", 1)).resolves.toBe("authorized");
    const { run, task } = await f.state();
    expect(run).toMatchObject({ status: "running", leaseOwner: "worker-1", leaseFence: 1 });
    expect(run.startedAt).toBeInstanceOf(Date);
    expect(task.status).toBe("queued");
    await expect(f.recheck("worker-1", 1)).resolves.toBe("authorized");
  });

  it("does not claim or recheck a run another worker holds", async () => {
    const f = await setup();
    await prisma.run.update({
      where: { id: f.run.id },
      data: {
        status: "running",
        leaseOwner: "worker-0",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    await expect(f.start("worker-1", 2)).resolves.toBe("lost");
    await expect(f.recheck("worker-1", 2)).resolves.toBe("lost");
    expect((await f.state()).run).toMatchObject({ status: "running", leaseOwner: "worker-0" });
  });

  it.each([
    ["missing provenance", () => setup({ linearEvent: false })],
    [
      "a paused routine",
      async () => {
        const f = await setup();
        await prisma.routine.update({ where: { id: f.routine.id }, data: { active: false } });
        return f;
      },
    ],
    [
      "a lost source generation",
      async () => {
        const f = await setup();
        await prisma.linearSource.update({
          where: { connectionId: f.connection.id },
          data: { generation: 2 },
        });
        return f;
      },
    ],
    [
      "a revoked connection",
      async () => {
        const f = await setup();
        await prisma.connection.update({
          where: { id: f.connection.id },
          data: { status: "revoked" },
        });
        return f;
      },
    ],
    [
      "an activation after the event",
      async () => {
        const f = await setup();
        await prisma.routineLinearTrigger.update({
          where: { routineId: f.routine.id },
          data: { activatedAt: new Date() },
        });
        return f;
      },
    ],
    [
      "a trigger moved to another connection",
      async () => {
        const f = await setup();
        const other = await prisma.connection.create({
          data: {
            spaceId: f.id,
            userId: f.id,
            connectorId: "linear",
            provider: "linear",
            displayName: "Other Linear",
            status: "connected",
          },
        });
        await prisma.linearSource.create({
          data: {
            connectionId: other.id,
            organizationId: "org-synthetic",
            viewerId: "viewer-synthetic",
            organizationName: "Synthetic",
          },
        });
        await prisma.routineLinearTrigger.update({
          where: { routineId: f.routine.id },
          data: { connectionId: other.id },
        });
        return f;
      },
    ],
    [
      "an archived bot",
      async () => {
        const f = await setup();
        await prisma.bot.update({ where: { id: f.bot.id }, data: { archivedAt: new Date() } });
        return f;
      },
    ],
    [
      "lost membership",
      async () => {
        const f = await setup();
        await prisma.spaceMember.delete({
          where: { spaceId_userId: { spaceId: f.id, userId: f.id } },
        });
        return f;
      },
    ],
  ])("fails closed and cancels the run on %s", async (_label, arrange) => {
    const f = await arrange();
    await expect(f.start("worker-1", 1)).resolves.toBe("cancelled");
    const { run, task, cancelledEvents } = await f.state();
    expect(run).toMatchObject({ status: "cancelled", leaseOwner: null, startedAt: null });
    expect(task.status).toBe("cancelled");
    expect(cancelledEvents).toBe(1);
    expect(f.notify).toHaveBeenCalledWith(f.thread.id, expect.any(Number));
  });

  it("prevents start when a pause commits first while authorization waits", async () => {
    const f = await setup();
    const locked = deferred();
    const release = deferred();
    const pause = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM routines WHERE id = ${f.routine.id} FOR UPDATE`;
        await tx.routine.update({ where: { id: f.routine.id }, data: { active: false } });
        locked.resolve();
        await release.promise;
      },
      { timeout: 20_000 },
    );
    await locked.promise;
    const authorization = f.start("worker-1", 1);
    await waitForLockWait();
    expect((await f.state()).run.status).toBe("queued");
    release.resolve();
    await pause;
    await expect(authorization).resolves.toBe("cancelled");
    expect((await f.state()).run).toMatchObject({ status: "cancelled", startedAt: null });
  });

  it("serializes behind archive holding the bot lock and then fails closed", async () => {
    const f = await setup();
    const locked = deferred();
    const release = deferred();
    const archive = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM bots WHERE id = ${f.bot.id} FOR UPDATE`;
        await tx.bot.update({ where: { id: f.bot.id }, data: { archivedAt: new Date() } });
        locked.resolve();
        await release.promise;
      },
      { timeout: 20_000 },
    );
    await locked.promise;
    const authorization = f.start("worker-1", 1);
    await waitForLockWait();
    expect((await f.state()).run.status).toBe("queued");
    release.resolve();
    await archive;
    await expect(authorization).resolves.toBe("cancelled");
  });

  it("cancels a run that started first when a later pause reaches the next recheck", async () => {
    const f = await setup();
    await expect(f.start("worker-1", 1)).resolves.toBe("authorized");
    await prisma.routine.update({ where: { id: f.routine.id }, data: { active: false } });
    await expect(f.recheck("worker-1", 1)).resolves.toBe("cancelled");
    const { run, task } = await f.state();
    expect(run.status).toBe("cancelled");
    expect(run.startedAt).toBeInstanceOf(Date);
    expect(task.status).toBe("cancelled");
  });
});
