import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator, EncryptedSecretStore } from "@rakazo/adapters";
import {
  effectiveThinkingLevel,
  MODEL_CONFIGURATION_CONFLICT_MESSAGES,
  type ModelCatalogEntry,
  type ModelConfigurationConflictData,
  ModelConfigurationConflictDataSchema,
  type ModelCredential,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  type OpenAiCompatibleDiscoveredModel,
  type OpenAiCompatibleModelConfig,
} from "@rakazo/contracts";
import {
  createDb,
  lockModelConfigurationOwner,
  type Pool,
  Prisma,
  type PrismaClient,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppHandles } from "../../../apps/api/src/app.js";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";
import {
  type ModelEmulator,
  type ModelEmulatorRequest,
  startModelEmulator,
} from "./model-emulator.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
type Handles = AppHandles;
type Emulator = ModelEmulator;
type Account = { cookie: string; userId: string; spaceId: string };
type RpcFailure = {
  ok: false;
  status: number;
  code: string | undefined;
  message: string | undefined;
  data: unknown;
};
type RpcResult<T> = { ok: true; status: number; value: T } | RpcFailure;

const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const fixtureOrigin = "http://127.0.0.1:5173";
const encryptionKey = "model-enablement-fixture-encryption-key";
const compatible = OPENAI_COMPATIBLE_PROVIDER_ID;
const migrationPath = new URL(
  "../../db/prisma/migrations/20261013120000_model_enablement/migration.sql",
  import.meta.url,
);

const modelA = {
  modelId: "fixture-a",
  thinkingLevels: ["off", "low", "high", "xhigh"],
  defaultThinkingLevel: null,
  contextWindow: 128_000,
  maxTokens: 4096,
  supportsImages: false,
} satisfies OpenAiCompatibleModelConfig;
const modelB = {
  modelId: "fixture-b",
  thinkingLevels: ["low", "medium"],
  defaultThinkingLevel: null,
  contextWindow: 64_000,
  maxTokens: 4096,
  supportsImages: false,
} satisfies OpenAiCompatibleModelConfig;
const modelPlain = {
  modelId: "fixture-plain",
  thinkingLevels: ["off"],
  defaultThinkingLevel: null,
  contextWindow: 32_768,
  maxTokens: 4096,
  supportsImages: false,
} satisfies OpenAiCompatibleModelConfig;
const undiscoveredModelId = "fixture-c";

describe.skipIf(!databaseAvailable)("OpenAI-compatible model enablement", () => {
  let handles: Handles;
  let observer: { prisma: PrismaClient; pool: Pool };
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-model-enablement-"));
    observer = createDb(process.env.DATABASE_URL!, {
      poolMax: 3,
      applicationName: "model-enablement-observer",
    });
    // Loaded lazily so a skipped suite never imports the API or its environment.
    const { createApp } = await import("../../../apps/api/src/app.js");
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
      encryptionKey,
    });
  }, 60_000);

  afterAll(async () => {
    try {
      await handles?.stop();
    } finally {
      await observer?.prisma.$disconnect();
      await observer?.pool.end();
      if (dataDir) await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("backfills allowlists from selections and projects legacy secrets onto seeded models only", async () => {
    const legacyKey = "legacy-fixture-key";
    const model = await startModelEmulator({
      apiKey: legacyKey,
      models: [{ id: "legacy-a" }, { id: "legacy-b" }],
      steps: [legacyStep("Legacy before adoption."), legacyStep("Legacy after adoption.")],
    });
    try {
      const owner = await signup(handles.app, "legacy-owner");
      const plainOwner = await signup(handles.app, "legacy-plain");
      const bot = await createBot(handles, owner, "Legacy bot");
      const second = await rpc<{ id: string }>(handles.app, owner.cookie, "spaces/create", {
        name: "Legacy second",
      });
      const third = await rpc<{ id: string }>(handles.app, owner.cookie, "spaces/create", {
        name: "Legacy third",
      });
      const store = new EncryptedSecretStore(encryptionKey);
      const legacy = await insertCredential(handles.prisma, store, owner, {
        provider: compatible,
        plaintext: JSON.stringify({
          kind: "openai_compatible",
          baseUrl: model.baseUrl,
          apiKey: legacyKey,
          reasoning: true,
          thinkingLevel: "xhigh",
          contextWindow: 64_000,
          maxTokens: 2048,
          visionModelIds: ["legacy-b", "legacy-vision-only"],
        }),
      });
      const hosted = await insertCredential(handles.prisma, store, owner, {
        provider: "openrouter",
        plaintext: "sk-or-hosted-fixture-key",
      });
      await handles.prisma.spaceModelPreference.createMany({
        data: [
          {
            spaceId: owner.spaceId,
            userId: owner.userId,
            credentialId: legacy.id,
            modelId: "legacy-a",
            isDefault: true,
          },
          {
            spaceId: second.id,
            userId: owner.userId,
            credentialId: legacy.id,
            modelId: "  legacy-b  ",
            isDefault: true,
          },
          {
            spaceId: third.id,
            userId: owner.userId,
            credentialId: legacy.id,
            modelId: "null",
            isDefault: true,
          },
          {
            spaceId: owner.spaceId,
            userId: owner.userId,
            credentialId: hosted.id,
            modelId: "openai/gpt-4o",
            isDefault: false,
          },
        ],
      });
      const plain = await insertCredential(handles.prisma, store, plainOwner, {
        provider: compatible,
        supportsImages: true,
        plaintext: JSON.stringify({
          kind: "openai_compatible",
          baseUrl: model.baseUrl,
          reasoning: false,
        }),
      });
      const unselected = await insertCredential(handles.prisma, store, plainOwner, {
        provider: compatible,
        plaintext: JSON.stringify({
          kind: "openai_compatible",
          baseUrl: model.baseUrl,
          reasoning: true,
          thinkingLevel: "low",
        }),
      });
      await handles.prisma.spaceModelPreference.create({
        data: {
          spaceId: plainOwner.spaceId,
          userId: plainOwner.userId,
          credentialId: plain.id,
          modelId: "plain-a",
          isDefault: true,
        },
      });

      const migration = await readFile(migrationPath, "utf8");
      const backfill = migration
        .slice(migration.indexOf('UPDATE "user_model_credentials"'))
        .trim()
        .replace(/;$/, "");
      expect(backfill).toMatch(/^UPDATE "user_model_credentials"/);
      await observer.prisma.$executeRawUnsafe(
        `${backfill}\n  AND credential."userId" IN ($1, $2)`,
        owner.userId,
        plainOwner.userId,
      );

      const seeded = await handles.prisma.userModelCredential.findMany({
        where: { userId: { in: [owner.userId, plainOwner.userId] } },
        select: { id: true, enabledModelIds: true, modelConfigurationVersion: true },
      });
      const seededById = new Map(seeded.map((row) => [row.id, row]));
      expect(seededById.get(legacy.id)).toMatchObject({
        enabledModelIds: ["legacy-a", "legacy-b"],
        modelConfigurationVersion: 0,
      });
      expect(seededById.get(hosted.id)?.enabledModelIds).toEqual([]);
      expect(seededById.get(plain.id)?.enabledModelIds).toEqual(["plain-a"]);
      expect(seededById.get(unselected.id)?.enabledModelIds).toEqual([]);
      const preferences = await handles.prisma.spaceModelPreference.findMany({
        where: { userId: owner.userId },
        select: { modelId: true },
      });
      expect(preferences.map((row) => row.modelId).sort()).toEqual(
        ["  legacy-b  ", "legacy-a", "null", "openai/gpt-4o"].sort(),
      );

      const legacyLimits = { contextWindow: 64_000, maxTokens: 2048 };
      const ownerCredentials = await rpc<ModelCredential[]>(
        handles.app,
        owner.cookie,
        "models/credentials",
      );
      expect(JSON.stringify(ownerCredentials)).not.toContain(legacyKey);
      const legacyDto = ownerCredentials.find((row) => row.id === legacy.id);
      expect(legacyDto).toMatchObject({
        enabledModelIds: ["legacy-a", "legacy-b"],
        configurationVersion: 0,
        hasKey: true,
        isDefault: true,
        modelId: "legacy-a",
      });
      expect(legacyDto?.models).toEqual([
        {
          modelId: "legacy-a",
          thinkingLevels: ["off", "minimal", "low", "medium", "high"],
          defaultThinkingLevel: "high",
          ...legacyLimits,
          supportsImages: false,
        },
        {
          modelId: "legacy-b",
          thinkingLevels: ["off", "minimal", "low", "medium", "high"],
          defaultThinkingLevel: "high",
          ...legacyLimits,
          supportsImages: true,
        },
      ]);
      const plainCredentials = await rpc<ModelCredential[]>(
        handles.app,
        plainOwner.cookie,
        "models/credentials",
      );
      expect(plainCredentials.find((row) => row.id === plain.id)?.models).toEqual([
        {
          modelId: "plain-a",
          thinkingLevels: ["off"],
          defaultThinkingLevel: null,
          contextWindow: 32_768,
          maxTokens: 4096,
          supportsImages: true,
        },
      ]);
      expect(plainCredentials.find((row) => row.id === unselected.id)).toMatchObject({
        enabledModelIds: [],
        models: [],
      });

      await handles.prisma.bot.update({
        where: { id: bot.id },
        data: { modelProvider: compatible, modelId: "legacy-a", thinkingLevel: "xhigh" },
      });
      await sendAndComplete(handles, owner, model, bot.id, "Legacy before adoption.");

      const adopted = await rpc<ModelCredential>(handles.app, owner.cookie, "models/connect", {
        provider: compatible,
        baseUrl: model.baseUrl,
        credentialId: legacy.id,
        expectedConfigurationVersion: 0,
        models: legacyDto?.models,
      });
      expect(adopted.configurationVersion).toBeGreaterThan(0);
      expect(adopted.enabledModelIds).toEqual(["legacy-a", "legacy-b"]);
      const adoptedRow = await handles.prisma.userModelCredential.findUniqueOrThrow({
        where: { id: legacy.id },
        select: { secretId: true },
      });
      const adoptedSecret = await handles.prisma.secret.findUniqueOrThrow({
        where: { id: adoptedRow.secretId },
        select: { id: true, ciphertext: true },
      });
      const canonical = JSON.parse(
        await store.load(adoptedSecret.ciphertext, adoptedSecret.id),
      ) as Record<string, unknown>;
      expect(canonical).toEqual({
        kind: "openai_compatible",
        baseUrl: model.baseUrl,
        apiKey: legacyKey,
        models: legacyDto?.models,
      });
      const storedBot = await handles.prisma.bot.findUniqueOrThrow({
        where: { id: bot.id },
        select: { thinkingLevel: true },
      });
      expect(storedBot.thinkingLevel).toBe("xhigh");
      await sendAndComplete(handles, owner, model, bot.id, "Legacy after adoption.");

      model.assertComplete();
      expect(model.completions).toEqual([
        { model: "legacy-a", hasReasoningEffort: true, reasoningEffort: "high" },
        { model: "legacy-a", hasReasoningEffort: true, reasoningEffort: "high" },
      ]);
    } finally {
      await model.close();
    }
  }, 120_000);

  it("connects, executes per-bot models and efforts, and requires reassignment before disabling", async () => {
    const fixtureKey = "enablement-fixture-key";
    const routinePinnedPrompt = "Routine pinned to B.";
    const routineFollowingPrompt = "Routine following its bot.";
    const model = await startModelEmulator({
      apiKey: fixtureKey,
      models: [
        { id: modelA.modelId, owned_by: "fixture" },
        { id: modelB.modelId },
        { id: modelPlain.modelId },
        { id: undiscoveredModelId },
      ],
      steps: [
        effortStep(modelA.modelId, "A extra high.", "xhigh"),
        effortStep(modelB.modelId, "B low.", "low"),
        effortStep(modelPlain.modelId, "Plain model.", undefined),
        effortStep(
          modelA.modelId,
          "Space default.",
          effectiveThinkingLevel(modelA.thinkingLevels, null, null),
        ),
        effortStep(modelA.modelId, "A off.", "none"),
        effortStep(modelB.modelId, routinePinnedPrompt, "medium"),
        effortStep(modelA.modelId, routineFollowingPrompt, "low"),
        effortStep(modelA.modelId, "After removal.", "high"),
      ],
    });
    const otherEndpoint = await startModelEmulator({
      models: [{ id: "other-endpoint-model" }],
      steps: [],
    });
    try {
      expect(effectiveThinkingLevel(modelA.thinkingLevels, null, null)).toBe("high");
      const owner = await signup(handles.app, "enablement");
      const bot1 = await createBot(handles, owner, "Bot one");
      const bot2 = await createBot(handles, owner, "Bot two");
      const bot3 = await createBot(handles, owner, "Bot three");

      const discovered = await rpc<{ models: OpenAiCompatibleDiscoveredModel[] }>(
        handles.app,
        owner.cookie,
        "models/probeOpenAiCompatible",
        { baseUrl: model.baseUrl, apiKey: fixtureKey },
      );
      expect(discovered.models.map((entry) => entry.modelId).sort()).toEqual(
        [modelA.modelId, modelB.modelId, modelPlain.modelId, undiscoveredModelId].sort(),
      );
      expect(discovered.models.every((entry) => entry.capabilities === null)).toBe(true);

      const created = await rpc<ModelCredential>(handles.app, owner.cookie, "models/connect", {
        provider: compatible,
        baseUrl: model.baseUrl,
        apiKey: fixtureKey,
        models: [modelA, modelB, modelPlain],
        modelId: modelA.modelId,
      });
      expect(created).toMatchObject({
        provider: compatible,
        isDefault: true,
        modelId: modelA.modelId,
      });
      expect([...(created.enabledModelIds ?? [])].sort()).toEqual(
        [modelA.modelId, modelB.modelId, modelPlain.modelId].sort(),
      );
      expect(JSON.stringify(created)).not.toContain(fixtureKey);
      const credentialId = created.id;
      const version1 = created.configurationVersion ?? -1;
      expect(version1).toBeGreaterThanOrEqual(0);

      const reprobe = await rpc<{ models: OpenAiCompatibleDiscoveredModel[] }>(
        handles.app,
        owner.cookie,
        "models/probeOpenAiCompatible",
        { baseUrl: model.baseUrl, credentialId },
      );
      expect(reprobe.models).toHaveLength(4);
      expect(model.listRequests.length).toBeGreaterThanOrEqual(2);
      expect(
        model.listRequests.every((entry) => entry.authorization === `Bearer ${fixtureKey}`),
      ).toBe(true);
      const elsewhere = await rpc<{ models: OpenAiCompatibleDiscoveredModel[] }>(
        handles.app,
        owner.cookie,
        "models/probeOpenAiCompatible",
        { baseUrl: otherEndpoint.baseUrl, credentialId },
      );
      expect(elsewhere.models.map((entry) => entry.modelId)).toEqual(["other-endpoint-model"]);
      expect(otherEndpoint.listRequests).toHaveLength(1);
      expect(JSON.stringify(otherEndpoint.listRequests)).not.toContain(fixtureKey);

      const catalog = await rpc<ModelCatalogEntry[]>(handles.app, owner.cookie, "models/list");
      const compatibleChoices = catalog.filter(
        (entry) => entry.provider === compatible && !entry.placeholder,
      );
      expect(compatibleChoices.map((entry) => entry.id).sort()).toEqual(
        [modelA.modelId, modelB.modelId, modelPlain.modelId].sort(),
      );
      expect(
        compatibleChoices.find((entry) => entry.id === modelA.modelId)?.thinkingLevels,
      ).toEqual(modelA.thinkingLevels);
      expect(
        compatibleChoices.find((entry) => entry.id === modelB.modelId)?.thinkingLevels,
      ).toEqual(modelB.thinkingLevels);
      expect(catalog.some((entry) => entry.id === undiscoveredModelId)).toBe(false);

      await rpc(handles.app, owner.cookie, "bots/update", {
        botId: bot1.id,
        modelProvider: compatible,
        modelId: modelA.modelId,
        thinkingLevel: "xhigh",
      });
      await rpc(handles.app, owner.cookie, "bots/update", {
        botId: bot2.id,
        modelProvider: compatible,
        modelId: modelB.modelId,
        thinkingLevel: "low",
      });
      await rpc(handles.app, owner.cookie, "bots/update", {
        botId: bot3.id,
        modelProvider: compatible,
        modelId: modelPlain.modelId,
      });
      const unsupported = await rpcFailure(handles.app, owner.cookie, "bots/update", {
        botId: bot2.id,
        modelProvider: compatible,
        modelId: modelB.modelId,
        thinkingLevel: "xhigh",
      });
      expect(unsupported.status).toBe(400);
      const notEnabled = await rpcFailure(handles.app, owner.cookie, "bots/update", {
        botId: bot2.id,
        modelProvider: compatible,
        modelId: undiscoveredModelId,
      });
      expect(notEnabled.status).toBe(400);
      await expectBotModel(handles.prisma, bot2.id, modelB.modelId, "low");

      await sendAndComplete(handles, owner, model, bot1.id, "A extra high.");
      await sendAndComplete(handles, owner, model, bot2.id, "B low.");
      await sendAndComplete(handles, owner, model, bot3.id, "Plain model.");
      await rpc(handles.app, owner.cookie, "bots/update", {
        botId: bot3.id,
        modelProvider: null,
        modelId: null,
      });
      await sendAndComplete(handles, owner, model, bot3.id, "Space default.");
      await rpc(handles.app, owner.cookie, "bots/update", {
        botId: bot1.id,
        modelProvider: compatible,
        modelId: modelA.modelId,
        thinkingLevel: "off",
      });
      await expectBotModel(handles.prisma, bot1.id, modelA.modelId, "off");
      await sendAndComplete(handles, owner, model, bot1.id, "A off.");

      const pinnedRoutine = await rpc<{ id: string }>(
        handles.app,
        owner.cookie,
        "routines/create",
        {
          botId: bot2.id,
          name: "Pinned to B",
          prompt: routinePinnedPrompt,
          crons: ["0 9 * * 1"],
          notify: false,
          modelProvider: compatible,
          modelId: modelB.modelId,
          thinkingLevel: "medium",
        },
      );
      const followingRoutine = await rpc<{ id: string }>(
        handles.app,
        owner.cookie,
        "routines/create",
        {
          botId: bot2.id,
          name: "Follows bot",
          prompt: routineFollowingPrompt,
          crons: ["0 10 * * 1"],
          notify: false,
        },
      );
      await rpc(handles.app, owner.cookie, "bots/update", {
        botId: bot2.id,
        modelProvider: compatible,
        modelId: modelA.modelId,
        thinkingLevel: "low",
      });
      const pinnedRun = await rpc<{ runId: string }>(
        handles.app,
        owner.cookie,
        "routines/testRun",
        {
          routineId: pinnedRoutine.id,
        },
      );
      await awaitCompletedRun(handles.prisma, model, pinnedRun.runId);
      expect(
        await handles.prisma.run.findUniqueOrThrow({
          where: { id: pinnedRun.runId },
          select: { modelPinned: true, modelProvider: true, modelId: true, thinkingLevel: true },
        }),
      ).toEqual({
        modelPinned: true,
        modelProvider: compatible,
        modelId: modelB.modelId,
        thinkingLevel: "medium",
      });
      const followingRun = await rpc<{ runId: string }>(
        handles.app,
        owner.cookie,
        "routines/testRun",
        { routineId: followingRoutine.id },
      );
      await awaitCompletedRun(handles.prisma, model, followingRun.runId);

      await rpc(handles.app, owner.cookie, "bots/update", {
        botId: bot1.id,
        modelProvider: compatible,
        modelId: modelB.modelId,
        thinkingLevel: "medium",
      });
      const before = await credentialState(handles.prisma, credentialId);
      const inUse = conflictData(
        await rpcFailure(handles.app, owner.cookie, "models/connect", {
          provider: compatible,
          baseUrl: model.baseUrl,
          credentialId,
          expectedConfigurationVersion: version1,
          models: [modelA, modelPlain],
        }),
        MODEL_CONFIGURATION_CONFLICT_MESSAGES.models_in_use,
      );
      expect(inUse.reason).toBe("models_in_use");
      const usages = "usages" in inUse ? inUse.usages : [];
      expect(usages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "bot",
            spaceId: owner.spaceId,
            id: bot1.id,
            name: "Bot one",
            modelId: modelB.modelId,
            thinkingLevel: "medium",
          }),
          expect.objectContaining({
            kind: "routine",
            spaceId: owner.spaceId,
            id: pinnedRoutine.id,
            name: "Pinned to B",
            modelId: modelB.modelId,
            thinkingLevel: "medium",
          }),
        ]),
      );
      expect(usages.every((usage) => usage.modelId === modelB.modelId)).toBe(true);
      expect(usages.some((usage) => usage.id === followingRoutine.id)).toBe(false);
      expect(await credentialState(handles.prisma, credentialId)).toEqual(before);
      const afterConflict = await compatibleCredential(handles.app, owner.cookie, credentialId);
      expect(afterConflict.models?.map((entry) => entry.modelId)).toContain(modelB.modelId);

      const plainShorterOutput = { ...modelPlain, maxTokens: 2048 };
      const edited = await rpc<ModelCredential>(handles.app, owner.cookie, "models/connect", {
        provider: compatible,
        baseUrl: model.baseUrl,
        credentialId,
        expectedConfigurationVersion: version1,
        models: [modelA, modelB, plainShorterOutput],
      });
      const version2 = edited.configurationVersion ?? -1;
      expect(version2).toBeGreaterThan(version1);
      expect(edited).toMatchObject({ isDefault: true, modelId: modelA.modelId });
      const editedState = await credentialState(handles.prisma, credentialId);
      const stale = conflictData(
        await rpcFailure(handles.app, owner.cookie, "models/connect", {
          provider: compatible,
          baseUrl: model.baseUrl,
          credentialId,
          expectedConfigurationVersion: version1,
          models: [modelA, modelB, modelPlain],
        }),
        MODEL_CONFIGURATION_CONFLICT_MESSAGES.model_configuration_changed,
      );
      expect(stale).toEqual({ reason: "model_configuration_changed" });
      expect(await credentialState(handles.prisma, credentialId)).toEqual(editedState);
      expect(
        (await compatibleCredential(handles.app, owner.cookie, credentialId)).models?.find(
          (entry) => entry.modelId === modelPlain.modelId,
        )?.maxTokens,
      ).toBe(2048);

      await rpc(handles.app, owner.cookie, "bots/update", {
        botId: bot1.id,
        modelProvider: compatible,
        modelId: modelA.modelId,
        thinkingLevel: "high",
      });
      await rpc(handles.app, owner.cookie, "routines/update", {
        routineId: pinnedRoutine.id,
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
      });
      const removed = await rpc<ModelCredential>(handles.app, owner.cookie, "models/connect", {
        provider: compatible,
        baseUrl: model.baseUrl,
        credentialId,
        expectedConfigurationVersion: version2,
        models: [modelA, plainShorterOutput],
      });
      expect(removed.configurationVersion ?? -1).toBeGreaterThan(version2);
      expect([...(removed.enabledModelIds ?? [])].sort()).toEqual(
        [modelA.modelId, modelPlain.modelId].sort(),
      );
      const catalogAfter = await rpc<ModelCatalogEntry[]>(handles.app, owner.cookie, "models/list");
      expect(catalogAfter.some((entry) => entry.id === modelB.modelId)).toBe(false);
      const tampered = await rpcFailure(handles.app, owner.cookie, "bots/update", {
        botId: bot2.id,
        modelProvider: compatible,
        modelId: modelB.modelId,
        thinkingLevel: "low",
      });
      expect(tampered.status).toBe(400);
      await expectBotModel(handles.prisma, bot2.id, modelA.modelId, "low");
      const tamperedRoutine = await rpcFailure(handles.app, owner.cookie, "routines/create", {
        botId: bot2.id,
        name: "Removed model",
        prompt: "Never runs.",
        crons: ["0 11 * * 1"],
        notify: false,
        modelProvider: compatible,
        modelId: modelB.modelId,
      });
      expect(tamperedRoutine.status).toBe(400);

      await sendAndComplete(handles, owner, model, bot1.id, "After removal.");
      const finalCredential = await compatibleCredential(handles.app, owner.cookie, credentialId);
      expect(finalCredential).toMatchObject({ isDefault: true, modelId: modelA.modelId });
      expect(JSON.stringify(finalCredential)).not.toContain(fixtureKey);

      model.assertComplete();
      otherEndpoint.assertComplete();
      expect(model.completions).toEqual([
        { model: modelA.modelId, hasReasoningEffort: true, reasoningEffort: "xhigh" },
        { model: modelB.modelId, hasReasoningEffort: true, reasoningEffort: "low" },
        { model: modelPlain.modelId, hasReasoningEffort: false, reasoningEffort: undefined },
        { model: modelA.modelId, hasReasoningEffort: true, reasoningEffort: "high" },
        { model: modelA.modelId, hasReasoningEffort: true, reasoningEffort: "none" },
        { model: modelB.modelId, hasReasoningEffort: true, reasoningEffort: "medium" },
        { model: modelA.modelId, hasReasoningEffort: true, reasoningEffort: "low" },
        { model: modelA.modelId, hasReasoningEffort: true, reasoningEffort: "high" },
      ]);
    } finally {
      await model.close();
      await otherEndpoint.close();
    }
  }, 180_000);

  it("serializes two first-connection creates so exactly one connection is created", async () => {
    const fixtureKey = "first-connection-fixture-key";
    const model = await startModelEmulator({
      apiKey: fixtureKey,
      models: [{ id: modelA.modelId }, { id: modelB.modelId }],
      steps: [],
    });
    try {
      const owner = await signup(handles.app, "first-connection");
      const createInput = {
        provider: compatible,
        baseUrl: model.baseUrl,
        apiKey: fixtureKey,
        models: [modelA, modelB],
        modelId: modelA.modelId,
      };
      const raced = await raceOnOwnerLock(
        observer.prisma,
        owner.userId,
        () => call<ModelCredential>(handles.app, owner.cookie, "models/connect", createInput),
        () => call<ModelCredential>(handles.app, owner.cookie, "models/connect", createInput),
      );
      expect(raced.first.ok).toBe(true);
      expect(raced.second.ok).toBe(false);
      expect(
        conflictData(
          raced.second as RpcFailure,
          MODEL_CONFIGURATION_CONFLICT_MESSAGES.model_configuration_changed,
        ),
      ).toEqual({ reason: "model_configuration_changed" });
      const credentials = await handles.prisma.userModelCredential.findMany({
        where: { userId: owner.userId, provider: compatible },
        select: { id: true, secretId: true },
      });
      expect(credentials).toHaveLength(1);
      expect(
        await handles.prisma.secret.findMany({
          where: { userId: owner.userId, kind: "model" },
          select: { id: true },
        }),
      ).toEqual([{ id: credentials[0]!.secretId }]);
      const defaults = await handles.prisma.spaceModelPreference.findMany({
        where: { userId: owner.userId, isDefault: true },
        select: { credentialId: true, modelId: true },
      });
      expect(defaults).toEqual([{ credentialId: credentials[0]!.id, modelId: modelA.modelId }]);
      model.assertComplete();
    } finally {
      await model.close();
    }
  }, 60_000);

  it("orders model removal and bot saves on the owner lock in both directions", async () => {
    const fixtureKey = "lock-order-fixture-key";
    const model = await startModelEmulator({
      apiKey: fixtureKey,
      models: [{ id: modelA.modelId }, { id: modelB.modelId }],
      steps: [],
    });
    try {
      const owner = await signup(handles.app, "lock-order");
      const referencing = await createBot(handles, owner, "Referencing bot");
      const stale = await createBot(handles, owner, "Stale bot");
      const created = await rpc<ModelCredential>(handles.app, owner.cookie, "models/connect", {
        provider: compatible,
        baseUrl: model.baseUrl,
        apiKey: fixtureKey,
        models: [modelA, modelB],
        modelId: modelA.modelId,
      });
      const credentialId = created.id;
      const version = created.configurationVersion ?? -1;
      const removeB = {
        provider: compatible,
        baseUrl: model.baseUrl,
        credentialId,
        expectedConfigurationVersion: version,
        models: [modelA],
      };

      const referenceFirst = await raceOnOwnerLock(
        observer.prisma,
        owner.userId,
        () =>
          call(handles.app, owner.cookie, "bots/update", {
            botId: referencing.id,
            modelProvider: compatible,
            modelId: modelB.modelId,
            thinkingLevel: "low",
          }),
        () => call<ModelCredential>(handles.app, owner.cookie, "models/connect", removeB),
      );
      expect(referenceFirst.first.ok).toBe(true);
      expect(referenceFirst.second.ok).toBe(false);
      const blocked = conflictData(
        referenceFirst.second as RpcFailure,
        MODEL_CONFIGURATION_CONFLICT_MESSAGES.models_in_use,
      );
      expect(blocked).toEqual({
        reason: "models_in_use",
        usages: [
          expect.objectContaining({
            kind: "bot",
            id: referencing.id,
            modelId: modelB.modelId,
            thinkingLevel: "low",
          }),
        ],
      });
      await expectBotModel(handles.prisma, referencing.id, modelB.modelId, "low");
      expect(await credentialState(handles.prisma, credentialId)).toMatchObject({
        modelConfigurationVersion: version,
        enabledModelIds: [modelA.modelId, modelB.modelId],
      });

      await rpc(handles.app, owner.cookie, "bots/update", {
        botId: referencing.id,
        modelProvider: compatible,
        modelId: modelA.modelId,
        thinkingLevel: "low",
      });
      const removalFirst = await raceOnOwnerLock(
        observer.prisma,
        owner.userId,
        () => call<ModelCredential>(handles.app, owner.cookie, "models/connect", removeB),
        () =>
          call(handles.app, owner.cookie, "bots/update", {
            botId: stale.id,
            modelProvider: compatible,
            modelId: modelB.modelId,
            thinkingLevel: "low",
          }),
      );
      expect(removalFirst.first.ok).toBe(true);
      expect(removalFirst.second).toMatchObject({ ok: false, status: 400 });
      await expectBotModel(handles.prisma, stale.id, null, null);
      const afterRemoval = await credentialState(handles.prisma, credentialId);
      expect(afterRemoval.enabledModelIds).toEqual([modelA.modelId]);
      expect(afterRemoval.modelConfigurationVersion).toBeGreaterThan(version);
      model.assertComplete();
    } finally {
      await model.close();
    }
  }, 90_000);
});

function legacyStep(text: string) {
  return {
    model: "legacy-a",
    expect(request: ModelEmulatorRequest) {
      expect(JSON.stringify(request.messages)).toContain(text);
      expect(request.reasoning_effort).toBe("high");
    },
    response: { type: "text" as const, text: `Done: ${text}` },
  };
}

function effortStep(modelId: string, text: string, effort: string | undefined) {
  return {
    model: modelId,
    expect(request: ModelEmulatorRequest) {
      expect(JSON.stringify(request.messages)).toContain(text);
      if (effort === undefined) expect(Object.hasOwn(request, "reasoning_effort")).toBe(false);
      else expect(request.reasoning_effort).toBe(effort);
    },
    response: { type: "text" as const, text: `Done: ${text}` },
  };
}

async function signup(app: App, label: string): Promise<Account> {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: fixtureOrigin },
    body: JSON.stringify({
      email: `model-enablement-${label}-${randomUUID()}@rakazo.test`,
      password: "password12",
      name: "Model enablement fixture",
    }),
  });
  expect(response.status).toBeLessThan(400);
  const cookie = sessionCookieHeader(response);
  const me = await rpc<{ userId: string; spaceId: string }>(app, cookie, "me");
  return { cookie, userId: me.userId, spaceId: me.spaceId };
}

async function createBot(handles: Handles, account: Account, name: string) {
  const bot = await rpc<{ id: string }>(handles.app, account.cookie, "bots/create", {
    name,
    title: "",
    description: "",
    instructions: "Reply briefly.",
    notifyOnFinish: false,
  });
  await discardBotIntroRun(handles, account.cookie, bot.id);
  return bot;
}

async function insertCredential(
  prisma: PrismaClient,
  store: EncryptedSecretStore,
  account: Account,
  input: { provider: string; plaintext: string; supportsImages?: boolean },
) {
  const stored = await store.put(input.plaintext, {
    operationId: "model-enablement-fixture",
    traceId: "model-enablement-fixture",
    spaceId: account.spaceId,
    userId: account.userId,
    signal: new AbortController().signal,
  });
  const secret = await prisma.secret.create({
    data: {
      id: stored.id,
      userId: account.userId,
      spaceId: null,
      kind: "model",
      ciphertext: stored.ciphertext,
    },
  });
  return prisma.userModelCredential.create({
    data: {
      userId: account.userId,
      provider: input.provider,
      label: input.provider,
      secretId: secret.id,
      supportsImages: input.supportsImages ?? false,
    },
  });
}

async function sendAndComplete(
  handles: Handles,
  account: Account,
  model: Emulator,
  botId: string,
  text: string,
) {
  const sent = await rpc<{ runId: string }>(handles.app, account.cookie, "threads/send", {
    botId,
    text,
  });
  await awaitCompletedRun(handles.prisma, model, sent.runId);
}

async function awaitCompletedRun(prisma: PrismaClient, model: Emulator, runId: string) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const run = await prisma.run.findUnique({
      where: { id: runId },
      select: { status: true, error: true },
    });
    if (run?.status === "completed") return;
    if (run?.status === "failed" || run?.status === "cancelled" || Date.now() > deadline) {
      surfaceFixtureFailures(model);
      throw new Error(`Run ${runId} ended ${run?.status ?? "missing"}: ${run?.error ?? ""}`);
    }
    await pollPause(prisma);
  }
}

function surfaceFixtureFailures(model: Emulator) {
  try {
    model.assertComplete();
  } catch (error) {
    if (error instanceof AggregateError) throw error;
  }
}

async function pollPause(prisma: PrismaClient) {
  await prisma.$executeRaw`SELECT pg_sleep(0.025)`;
}

async function expectBotModel(
  prisma: PrismaClient,
  botId: string,
  modelId: string | null,
  thinkingLevel: string | null,
) {
  expect(
    await prisma.bot.findUniqueOrThrow({
      where: { id: botId },
      select: { modelProvider: true, modelId: true, thinkingLevel: true },
    }),
  ).toEqual({
    modelProvider: modelId === null ? null : OPENAI_COMPATIBLE_PROVIDER_ID,
    modelId,
    thinkingLevel,
  });
}

async function credentialState(prisma: PrismaClient, credentialId: string) {
  return prisma.userModelCredential.findUniqueOrThrow({
    where: { id: credentialId },
    select: {
      enabledModelIds: true,
      modelConfigurationVersion: true,
      secretId: true,
      updatedAt: true,
    },
  });
}

async function compatibleCredential(app: App, cookie: string, credentialId: string) {
  const credentials = await rpc<ModelCredential[]>(app, cookie, "models/credentials");
  const credential = credentials.find((row) => row.id === credentialId);
  if (!credential) throw new Error("Compatible credential missing from models/credentials");
  return credential;
}

function conflictData(failure: RpcFailure, message: string): ModelConfigurationConflictData {
  expect(failure).toMatchObject({ ok: false, status: 409, code: "CONFLICT", message });
  return ModelConfigurationConflictDataSchema.parse(failure.data);
}

type InFlight<T> = { promise: Promise<T>; settled: boolean };

function inFlight<T>(promise: Promise<T>): InFlight<T> {
  const state: InFlight<T> = { promise, settled: false };
  promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

async function holdOwnerLock(prisma: PrismaClient, userId: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked!: (pid: number) => void;
  const ready = new Promise<number>((resolve) => {
    locked = resolve;
  });
  const transaction = prisma.$transaction(
    async (tx) => {
      await lockModelConfigurationOwner(tx, userId);
      const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      locked(row!.pid);
      await released;
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 10_000,
      timeout: 60_000,
    },
  );
  const endedEarly = transaction.then(() => {
    throw new Error("Owner lock transaction ended before it was held");
  });
  endedEarly.catch(() => undefined);
  const pid = await Promise.race([ready, endedEarly]);
  return { pid, release, transaction };
}

async function waitForOwnerLockWaiter(
  prisma: PrismaClient,
  blockers: number[],
  known: number[],
  pending: InFlight<unknown>,
): Promise<number> {
  const deadline = Date.now() + 15_000;
  const excluded = [0, ...known];
  while (Date.now() < deadline) {
    if (pending.settled) {
      throw new Error(
        `Request finished before waiting on the owner lock: ${JSON.stringify(await pending.promise)}`,
      );
    }
    const rows = await prisma.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity
      WHERE wait_event_type = 'Lock'
        AND application_name = 'rakazo-api'
        AND pg_blocking_pids(pid) && ${blockers}::int[]
        AND NOT (pid = ANY(${excluded}::int[]))
        AND query ILIKE '%from "user"%for update%'
    `;
    if (rows[0]) return rows[0].pid;
    await pollPause(prisma);
  }
  throw new Error("No request waited on the model configuration owner lock");
}

async function raceOnOwnerLock(
  prisma: PrismaClient,
  userId: string,
  startFirst: () => Promise<RpcResult<unknown>>,
  startSecond: () => Promise<RpcResult<unknown>>,
) {
  const blocker = await holdOwnerLock(prisma, userId);
  let first: InFlight<RpcResult<unknown>> | undefined;
  let second: InFlight<RpcResult<unknown>> | undefined;
  try {
    first = inFlight(startFirst());
    const firstWaiter = await waitForOwnerLockWaiter(prisma, [blocker.pid], [], first);
    second = inFlight(startSecond());
    await waitForOwnerLockWaiter(prisma, [blocker.pid, firstWaiter], [firstWaiter], second);
    blocker.release();
    await blocker.transaction;
    return { first: await first.promise, second: await second.promise };
  } finally {
    blocker.release();
    await Promise.allSettled([
      blocker.transaction,
      ...(first ? [first.promise] : []),
      ...(second ? [second.promise] : []),
    ]);
  }
}

async function call<T>(
  app: App,
  cookie: string,
  procedure: string,
  input: unknown = {},
): Promise<RpcResult<T>> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: fixtureOrigin },
    body: JSON.stringify({ json: input }),
  });
  const text = await response.text();
  let body: { json?: unknown } | undefined;
  try {
    body = JSON.parse(text) as { json?: unknown };
  } catch {
    body = undefined;
  }
  if (response.ok) return { ok: true, status: response.status, value: body?.json as T };
  const error = (body?.json ?? {}) as { code?: unknown; message?: unknown; data?: unknown };
  return {
    ok: false,
    status: response.status,
    code: typeof error.code === "string" ? error.code : undefined,
    message: typeof error.message === "string" ? error.message : undefined,
    data: error.data,
  };
}

async function rpc<T>(app: App, cookie: string, procedure: string, input: unknown = {}) {
  const result = await call<T>(app, cookie, procedure, input);
  if (!result.ok) {
    throw new Error(
      `${procedure}: ${result.status} ${result.code ?? ""} ${result.message ?? ""} ${JSON.stringify(result.data ?? null)}`,
    );
  }
  return result.value;
}

async function rpcFailure(app: App, cookie: string, procedure: string, input: unknown = {}) {
  const result = await call(app, cookie, procedure, input);
  if (result.ok) throw new Error(`${procedure} unexpectedly succeeded`);
  return result;
}
