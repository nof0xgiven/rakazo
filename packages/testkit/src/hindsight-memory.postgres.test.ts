import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BackgroundJob } from "@rakazo/adapter-kit";
import {
  ComposioEmulator,
  createMemoryRetentionReconciler,
  HINDSIGHT_CLOUD_ORIGIN,
} from "@rakazo/adapters";
import type { Bot, SpaceMemoryConfig } from "@rakazo/contracts";
import { RECALLED_MEMORY_PREFIX } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { type AppHandles, createApp } from "../../../apps/api/src/app.ts";
import { compatibleConnection } from "./compatible-connection.js";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { startHindsightEmulator } from "./hindsight-emulator.js";
import { sessionCookieHeader } from "./index.js";
import { type ModelEmulatorRequest, startModelEmulator } from "./model-emulator.js";

const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const fixtureOrigin = "http://127.0.0.1:5173";
const modelKey = "offline-hindsight-model-key";

const SEEDED_FACT = "Greenhouse project codename: MARIGOLD-773.";
const LADDER_FACT = "Orchard ladder inventory: LADDER-PINE-12.";
const FIRST_PROMPT =
  "What is the greenhouse project codename? Also note my favourite seedling tray is TRAY-QUILL-58.";
const FIRST_REPLY =
  "The greenhouse project codename is MARIGOLD-773, and I noted seedling tray TRAY-QUILL-58.";
const ISOLATED_PROMPT = "Which seedling tray do I like? What is the greenhouse project codename?";
const SHARED_PROMPT = "Which seedling tray do I like?";
const REBIND_PROMPT = "Also remember the compost bin label is BIN-ORCHID-91.";

const transcript = (request: ModelEmulatorRequest) => JSON.stringify(request.messages);

describe.skipIf(!databaseAvailable)("Hindsight Cloud memory through the app (PostgreSQL)", () => {
  it("recalls before replies, learns durably, isolates and shares banks, and never reroutes", async () => {
    const hindsight = await startHindsightEmulator();
    const fixture = hindsight.createFixture({
      banks: [
        { bankId: "bank-a", name: "Greenhouse", documents: [{ content: SEEDED_FACT }] },
        { bankId: "bank-b", name: "Orchard", documents: [{ content: LADDER_FACT }] },
      ],
    });
    const recallRequests = () => fixture.requests.filter((request) => request.route === "recall");
    const retainRequests = () => fixture.requests.filter((request) => request.route === "retain");
    const bankDocuments = (bankId: string) =>
      fixture
        .snapshot()
        .banks.find((bank) => bank.bankId === bankId)
        ?.documents.map((document) => document.content) ?? [];

    const model = await startModelEmulator({
      apiKey: modelKey,
      steps: [
        {
          expect(request) {
            expect(recallRequests().map((entry) => entry.bankId)).toEqual(["bank-a"]);
            expect(retainRequests()).toHaveLength(0);
            expect(transcript(request)).toContain(RECALLED_MEMORY_PREFIX);
            expect(transcript(request)).toContain("MARIGOLD-773");
          },
          response: { type: "text", text: FIRST_REPLY },
        },
        {
          expect(request) {
            expect(recallRequests().at(-1)?.bankId).toBe("bank-b");
            expect(transcript(request)).not.toContain(RECALLED_MEMORY_PREFIX);
            expect(transcript(request)).not.toContain("TRAY-QUILL-58");
            expect(transcript(request)).not.toContain("MARIGOLD-773");
          },
          response: { type: "text", text: "I have nothing saved about that yet." },
        },
        {
          expect() {
            expect(recallRequests().at(-1)?.bankId).toBe("bank-a");
          },
          response: { type: "text", text: "Noted the compost bin label." },
        },
        {
          expect(request) {
            expect(recallRequests().at(-1)?.bankId).toBe("bank-a");
            expect(transcript(request)).toContain(RECALLED_MEMORY_PREFIX);
            expect(transcript(request)).toContain("TRAY-QUILL-58");
          },
          response: { type: "text", text: "You like seedling tray TRAY-QUILL-58." },
        },
        {
          expect(request) {
            expect(transcript(request)).not.toContain(RECALLED_MEMORY_PREFIX);
          },
          response: { type: "text", text: "I do not have memory for that here." },
        },
      ],
    });
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-hindsight-memory-"));
    let handles: AppHandles | undefined;
    try {
      handles = await createApp({
        databaseUrl: process.env.DATABASE_URL!,
        realtimeDatabaseUrl: process.env.DATABASE_URL!,
        authUrl: fixtureOrigin,
        webOrigin: fixtureOrigin,
        dataDir,
        sandboxProvider: "fake",
        agentRuntime: "pi",
        wakeupDriver: "memory",
        signupsEnabled: "true",
        composio: new ComposioEmulator(),
        encryptionKey: "offline-hindsight-fixture-encryption-key",
        memoryTransport: { fetch: hindsight.fetch },
      });
      const app = handles;
      const { prisma, jobs } = app;

      let dropRetainEnqueues = 0;
      const droppedRetentions: string[] = [];
      const enqueue = jobs.enqueue.bind(jobs);
      vi.spyOn(jobs, "enqueue").mockImplementation(async (job: BackgroundJob) => {
        if (job.name === "memory.retain" && dropRetainEnqueues > 0) {
          dropRetainEnqueues--;
          droppedRetentions.push(job.payload.retentionId);
          return;
        }
        await enqueue(job);
      });
      const reconcile = createMemoryRetentionReconciler({ prisma, jobs });
      const retention = (id: string) => prisma.memoryRetention.findUnique({ where: { id } });

      const signup = await app.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: fixtureOrigin },
        body: JSON.stringify({
          email: `hindsight-memory-${randomUUID()}@rakazo.test`,
          password: "password12",
          name: "Hindsight fixture",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = sessionCookieHeader(signup);
      const call = <T>(procedure: string, input: unknown = {}) =>
        rpc<T>(app.app, cookie, procedure, input);

      const createBot = async (name: string) => {
        const bot = await call<Bot>("bots/create", {
          name,
          title: "",
          description: "",
          instructions: "Answer briefly.",
          notifyOnFinish: false,
        });
        await discardBotIntroRun(app, cookie, bot.id);
        return bot;
      };
      const send = async (botId: string, text: string) => {
        const sent = await call<{ runId: string }>("threads/send", { botId, text });
        await expect
          .poll(
            async () => {
              const run = await prisma.run.findUniqueOrThrow({ where: { id: sent.runId } });
              if (run.status === "failed") model.assertComplete();
              return run.status;
            },
            { timeout: 20_000, interval: 100 },
          )
          .toBe("completed");
        return sent.runId;
      };
      const conversationIntent = async (runId: string) => {
        await expect
          .poll(() => prisma.memoryRetention.count({ where: { runId } }), { timeout: 10_000 })
          .toBe(1);
        return prisma.memoryRetention.findFirstOrThrow({ where: { runId } });
      };
      const pollUntilCompleted = async (retentionId: string) => {
        await expect
          .poll(async () => (await retention(retentionId))?.state, {
            timeout: 15_000,
            interval: 100,
          })
          .toBe("processing");
        const accepted = await retention(retentionId);
        expect(accepted).toMatchObject({ content: null, attemptCount: 0 });
        vi.useFakeTimers({
          toFake: ["Date"],
          now: accepted!.nextAttemptAt!.getTime() + 1_000,
          shouldAdvanceTime: true,
        });
        try {
          await reconcile();
          await expect
            .poll(async () => (await retention(retentionId))?.state, {
              timeout: 15_000,
              interval: 100,
            })
            .toBe("completed");
        } finally {
          vi.useRealTimers();
        }
        return retention(retentionId);
      };

      const alpha = await createBot("Greenhouse");
      const beta = await createBot("Orchard");
      const gamma = await createBot("Greenhouse partner");
      await call(
        "models/connect",
        compatibleConnection({ baseUrl: model.baseUrl, modelId: model.model.id, apiKey: modelKey }),
      );
      for (const bot of [alpha, beta, gamma]) {
        await call("bots/update", {
          botId: bot.id,
          modelProvider: model.model.provider,
          modelId: model.model.id,
        });
      }

      const config = await call<SpaceMemoryConfig>("memory/connectProvider", {
        provider: "hindsight",
        settings: { baseUrl: HINDSIGHT_CLOUD_ORIGIN },
        credentials: { apiKey: fixture.apiKey },
        expectedConfigId: null,
      });
      expect(config).toMatchObject({
        provider: "hindsight",
        capabilities: { banks: true, sharedScope: false },
      });
      const listed = await call<{ banks: Array<{ bankId: string }>; nextOffset: number | null }>(
        "memory/banks",
        { botId: alpha.id, configId: config.id },
      );
      expect(listed.banks.map((bank) => bank.bankId)).toEqual(["bank-a", "bank-b"]);
      const bind = (botId: string, bankId: string, expectedBindingId: string | null = null) =>
        call<Bot>("bots/update", {
          botId,
          memoryBank: { configId: config.id, expectedBindingId, bankId },
        });
      const boundAlpha = await bind(alpha.id, "bank-a");
      const boundBeta = await bind(beta.id, "bank-b");
      const boundGamma = await bind(gamma.id, "bank-a");
      expect(boundAlpha.memoryBank).toMatchObject({ bankId: "bank-a", configId: config.id });
      expect(boundBeta.memoryBank).toMatchObject({ bankId: "bank-b", configId: config.id });
      expect(boundGamma.memoryBank).toMatchObject({ bankId: "bank-a", configId: config.id });
      expect(boundGamma.memoryBank?.id).not.toBe(boundAlpha.memoryBank?.id);
      expect(retainRequests()).toHaveLength(0);

      dropRetainEnqueues = 1;
      fixture.dropAcknowledgement("retain");
      const firstRun = await send(alpha.id, FIRST_PROMPT);
      const reply = await prisma.message.findFirstOrThrow({
        where: { runId: firstRun, role: "bot" },
        orderBy: { seq: "desc" },
      });
      expect(JSON.stringify(reply.blocks)).toContain(FIRST_REPLY);
      const learned = await conversationIntent(firstRun);
      expect(learned).toMatchObject({
        bindingId: boundAlpha.memoryBank?.id,
        sourceKind: "conversation",
        sourceKey: "conversation",
        state: "pending",
        attemptCount: 0,
      });
      expect(learned.content).toContain("TRAY-QUILL-58");
      expect(learned.content).toContain(FIRST_REPLY);
      await expect.poll(() => droppedRetentions).toEqual([learned.id]);
      expect(
        (await prisma.run.findUniqueOrThrow({ where: { id: firstRun } })).memorySelection,
      ).toEqual({
        kind: "bank",
        configId: config.id,
        provider: "hindsight",
        bindingId: boundAlpha.memoryBank?.id,
        bankId: "bank-a",
      });

      await reconcile();
      await expect
        .poll(async () => (await retention(learned.id))?.attemptCount, { timeout: 15_000 })
        .toBe(1);
      const unacknowledged = await retention(learned.id);
      expect(unacknowledged).toMatchObject({ state: "pending", acceptedAt: null });
      expect(unacknowledged?.content).toBe(learned.content);
      expect(retainRequests()).toHaveLength(1);
      expect(retainRequests()[0]).toMatchObject({ bankId: "bank-a", acknowledged: false });
      expect(bankDocuments("bank-a")).not.toContain(learned.content);

      const settled = await pollUntilCompleted(learned.id);
      expect(settled).toMatchObject({ state: "completed", content: null, failureCode: null });
      const delivered = retainRequests();
      expect(delivered.map((request) => request.acknowledged)).toEqual([false, true]);
      const [lost, retried] = delivered.map(
        (request) =>
          request.body as {
            operation_id: string;
            items: Array<{ document_id: string; content: string }>;
          },
      );
      expect(retried!.operation_id).toBe(lost!.operation_id);
      expect(retried!.operation_id).toBe(learned.operationId);
      expect(retried!.items[0]!.document_id).toBe(lost!.items[0]!.document_id);
      expect(retried!.items[0]!.content).toBe(learned.content);
      expect(
        fixture
          .snapshot()
          .operations.filter((operation) => operation.operationId === learned.operationId),
      ).toHaveLength(1);
      expect(bankDocuments("bank-a")).toEqual([SEEDED_FACT, learned.content]);

      const isolatedRun = await send(beta.id, ISOLATED_PROMPT);
      const isolated = await conversationIntent(isolatedRun);
      expect(isolated.bindingId).toBe(boundBeta.memoryBank?.id);
      await pollUntilCompleted(isolated.id);
      expect(retainRequests().at(-1)?.bankId).toBe("bank-b");
      expect(bankDocuments("bank-b")).toHaveLength(2);
      expect(bankDocuments("bank-b").join("\n")).not.toContain("TRAY-QUILL-58");
      expect(bankDocuments("bank-a").join("\n")).not.toContain(ISOLATED_PROMPT);

      dropRetainEnqueues = 1;
      const staleRun = await send(alpha.id, REBIND_PROMPT);
      const stale = await conversationIntent(staleRun);
      await expect.poll(() => droppedRetentions.at(-1)).toBe(stale.id);
      const beforeRebind = fixture.requests.length;
      const rebound = await bind(alpha.id, "bank-b", boundAlpha.memoryBank!.id);
      expect(rebound.memoryBank).toMatchObject({ bankId: "bank-b" });
      expect(rebound.memoryBank?.id).not.toBe(boundAlpha.memoryBank?.id);
      expect(await retention(stale.id)).toBeNull();
      await reconcile();
      await jobs.enqueue({ name: "memory.retain", payload: { retentionId: stale.id } });
      await app.awaitIdle?.();
      expect(
        fixture.requests
          .slice(beforeRebind)
          .filter((request) => request.route !== "profile")
          .map((request) => request.route),
      ).toEqual([]);
      expect(
        retainRequests().filter((request) =>
          JSON.stringify(request.body).includes("BIN-ORCHID-91"),
        ),
      ).toEqual([]);
      expect(bankDocuments("bank-b").join("\n")).not.toContain("BIN-ORCHID-91");

      dropRetainEnqueues = 1;
      const sharedRun = await send(gamma.id, SHARED_PROMPT);
      const pendingShared = await conversationIntent(sharedRun);
      expect(pendingShared.bindingId).toBe(boundGamma.memoryBank?.id);
      await expect.poll(() => droppedRetentions.at(-1)).toBe(pendingShared.id);
      const beforeDisconnect = fixture.requests.length;
      await call("memory/disconnectProvider", { configId: config.id });
      expect(await retention(pendingShared.id)).toBeNull();
      expect(await prisma.botMemoryBank.count({ where: { spaceMemoryConfigId: config.id } })).toBe(
        0,
      );
      await reconcile();
      await jobs.enqueue({ name: "memory.retain", payload: { retentionId: pendingShared.id } });
      await app.awaitIdle?.();
      expect(fixture.requests.slice(beforeDisconnect)).toEqual([]);

      const nativeRun = await send(gamma.id, SHARED_PROMPT);
      expect(
        (await prisma.run.findUniqueOrThrow({ where: { id: nativeRun } })).memorySelection,
      ).toEqual({ kind: "native" });
      expect(await prisma.memoryRetention.count({ where: { runId: nativeRun } })).toBe(0);
      expect(fixture.requests.slice(beforeDisconnect)).toEqual([]);
      expect(fixture.requests.filter((request) => request.method === "DELETE")).toEqual([]);
      model.assertComplete();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
      try {
        await handles?.stop();
      } finally {
        await model.close();
        await hindsight.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  }, 180_000);
});

async function rpc<T>(
  app: AppHandles["app"],
  cookie: string,
  procedure: string,
  input: unknown,
): Promise<T> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: fixtureOrigin },
    body: JSON.stringify({ json: input }),
  });
  const body = (await response.json()) as { json?: T; error?: { message?: string } };
  if (response.status >= 400 || body.error)
    throw new Error(`${procedure}: ${body.error?.message ?? response.status}`);
  return body.json as T;
}
