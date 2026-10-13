import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ComposioEmulator,
  DEFAULT_OPENROUTER_MODEL_ID,
  EncryptedSecretStore,
  spawnBot,
} from "@rakazo/adapters";
import {
  effectiveThinkingLevel,
  MODEL_CONFIGURATION_CONFLICT_MESSAGES,
  type ModelCatalogEntry,
  type ModelConfigurationConflictData,
  ModelConfigurationConflictDataSchema,
  type ModelConfigurationUsage,
  type ModelCredential,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  type OpenAiCompatibleDiscoveredModel,
  type OpenAiCompatibleModelConfig,
  type RunStatus,
} from "@rakazo/contracts";
import { isActive } from "@rakazo/core";
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
  type ModelEmulatorStep,
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
  contextWindow: 160_000,
  maxTokens: 4096,
  supportsImages: false,
} satisfies OpenAiCompatibleModelConfig;
const modelB = {
  modelId: "fixture-b",
  thinkingLevels: ["low", "medium"],
  defaultThinkingLevel: null,
  contextWindow: 160_000,
  maxTokens: 4096,
  supportsImages: false,
} satisfies OpenAiCompatibleModelConfig;
const modelPlain = {
  modelId: "fixture-plain",
  thinkingLevels: ["off"],
  defaultThinkingLevel: null,
  contextWindow: 160_000,
  maxTokens: 4096,
  supportsImages: false,
} satisfies OpenAiCompatibleModelConfig;
const undiscoveredModelId = "fixture-c";
const sharedModelId = "fixture-shared";
const sharedOnFirst = {
  modelId: sharedModelId,
  thinkingLevels: ["low", "high"],
  defaultThinkingLevel: "high",
  contextWindow: 100_000,
  maxTokens: 4096,
  supportsImages: false,
} satisfies OpenAiCompatibleModelConfig;
const sharedOnSecond = {
  modelId: sharedModelId,
  thinkingLevels: ["off"],
  defaultThinkingLevel: null,
  contextWindow: 50_000,
  maxTokens: 2048,
  supportsImages: true,
} satisfies OpenAiCompatibleModelConfig;
const neverEnabledModelId = "fixture-never-enabled";
const raceKey = "owner-lock-race-fixture-key";
const secondKey = "second-compatible-fixture-key";
const hostedKey = "sk-or-hosted-race-fixture-key";
const weeklyCron = "17 3 * * 0";
const runSettleMs = 60_000;
const pinnedToB = {
  modelProvider: compatible,
  modelId: modelB.modelId,
  thinkingLevel: "low",
} as const;
const removalKinds = ["uncheck", "disconnect"] as const;
type RemovalKind = (typeof removalKinds)[number];
const removalLabels: Record<RemovalKind, string> = {
  uncheck: "model disable",
  disconnect: "compatible disconnect",
};

describe.skipIf(!databaseAvailable)("OpenAI-compatible model enablement", () => {
  let handles: Handles;
  let observer: { prisma: PrismaClient; pool: Pool };
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-model-enablement-"));
    observer = createDb(process.env.DATABASE_URL!, {
      poolMax: 4,
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
      const [first, second] = await queueOnOwnerLock(observer.prisma, owner.userId, [
        () => call<ModelCredential>(handles.app, owner.cookie, "models/connect", createInput),
        () => call<ModelCredential>(handles.app, owner.cookie, "models/connect", createInput),
      ]);
      expect(first!.ok).toBe(true);
      expect(second!.ok).toBe(false);
      expect(
        conflictData(
          second as RpcFailure,
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

      const [referenced, referenceBlocked] = await queueOnOwnerLock(observer.prisma, owner.userId, [
        () =>
          call(handles.app, owner.cookie, "bots/update", {
            botId: referencing.id,
            modelProvider: compatible,
            modelId: modelB.modelId,
            thinkingLevel: "low",
          }),
        () => call<ModelCredential>(handles.app, owner.cookie, "models/connect", removeB),
      ]);
      expect(referenced!.ok).toBe(true);
      expect(referenceBlocked!.ok).toBe(false);
      const blocked = conflictData(
        referenceBlocked as RpcFailure,
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
      const [removedFirst, staleChoice] = await queueOnOwnerLock(observer.prisma, owner.userId, [
        () => call<ModelCredential>(handles.app, owner.cookie, "models/connect", removeB),
        () =>
          call(handles.app, owner.cookie, "bots/update", {
            botId: stale.id,
            modelProvider: compatible,
            modelId: modelB.modelId,
            thinkingLevel: "low",
          }),
      ]);
      expect(removedFirst!.ok).toBe(true);
      expect(staleChoice).toMatchObject({ ok: false, status: 400 });
      await expectBotModel(handles.prisma, stale.id, null, null);
      const afterRemoval = await credentialState(handles.prisma, credentialId);
      expect(afterRemoval.enabledModelIds).toEqual([modelA.modelId]);
      expect(afterRemoval.modelConfigurationVersion).toBeGreaterThan(version);
      model.assertComplete();
    } finally {
      await model.close();
    }
  }, 90_000);

  describe("owner-lock ordering", () => {
    type RaceFixture = {
      owner: Account;
      model: Emulator;
      bots: Array<{ id: string; name: string }>;
      credentialId: string;
      version: number;
    };
    type Starter = () => Promise<RpcResult<unknown>>;
    type CaptureKind = "testRun" | "wake" | "webhook";
    type WebhookHook = { secret: string; path: string };

    const raceCases: Array<[string, (kind: RemovalKind) => Promise<void>]> = [
      ["routine saves", routineSaveRaces],
      ["space default selection", setDefaultRaces],
      ["backup lists", setBackupsRaces],
      ["duplicated bots", duplicateRaces],
      ["spawned child bots", spawnRaces],
      ["manual routine runs", (kind) => capturedPinRaces("testRun", kind)],
      ["scheduled routine wakes", (kind) => capturedPinRaces("wake", kind)],
      ["inbound webhook deliveries", (kind) => capturedPinRaces("webhook", kind)],
      ["pending steering continuations", continuationRaces],
    ];
    for (const [name, race] of raceCases) {
      for (const kind of removalKinds) {
        it(
          `orders ${name} and ${removalLabels[kind]} on the owner lock in both directions`,
          () => race(kind),
          180_000,
        );
      }
    }

    it("acts on allowlists and cross-provider default flags committed while it waited", async () => {
      await withRaceFixture("fresh-hosted-first", {}, async (fx) => {
        await insertHostedCredential(fx.owner);
        const [hostedDefault, removed] = await queue(fx, [
          selectHostedDefault(fx),
          editModels(fx, [modelB]),
        ]);
        okValue(hostedDefault);
        okValue(removed);
        expect((await credentialState(handles.prisma, fx.credentialId)).enabledModelIds).toEqual([
          modelB.modelId,
        ]);
        expect(await spaceDefaults(fx.owner.userId)).toEqual([
          {
            provider: "openrouter",
            modelId: DEFAULT_OPENROUTER_MODEL_ID,
            thinkingLevel: null,
          },
        ]);
        return [hostedDefault, removed];
      });

      await withRaceFixture("fresh-compatible-first", {}, async (fx) => {
        await insertHostedCredential(fx.owner);
        const before = await credentialRows(fx.owner.userId);
        const [removed, hostedDefault] = await queue(fx, [
          editModels(fx, [modelB]),
          selectHostedDefault(fx),
        ]);
        expectConflictUsages(removed, "models_in_use", [
          { kind: "default", spaceId: fx.owner.spaceId, modelId: modelA.modelId },
        ]);
        expect(await credentialRows(fx.owner.userId)).toEqual(before);
        okValue(hostedDefault);
        expect(await spaceDefaults(fx.owner.userId)).toEqual([
          {
            provider: "openrouter",
            modelId: DEFAULT_OPENROUTER_MODEL_ID,
            thinkingLevel: null,
          },
        ]);
        return [removed, hostedDefault];
      });

      await withRaceFixture("fresh-capability", { bots: ["Effort bot"] }, async (fx) => {
        const bot = fx.bots[0]!;
        const reducedA = {
          ...modelA,
          thinkingLevels: ["off", "low", "high"],
        } satisfies typeof modelA;
        const [edited, saved] = await queue(fx, [
          editModels(fx, [reducedA, modelB]),
          () =>
            call(handles.app, fx.owner.cookie, "bots/update", {
              botId: bot.id,
              modelProvider: compatible,
              modelId: modelA.modelId,
              thinkingLevel: "xhigh",
            }),
        ]);
        okValue(edited);
        expect(saved).toMatchObject({ ok: false, status: 400 });
        await expectBotModel(handles.prisma, bot.id, null, null);
        return [edited, saved];
      });
    }, 120_000);

    it("blocks compatible disconnect on explicit references and disconnects a default-only connection", async () => {
      await withRaceFixture("disconnect-blocked", { bots: ["Disconnect bot"] }, async (fx) => {
        const bot = fx.bots[0]!;
        await rpc(handles.app, fx.owner.cookie, "bots/update", { botId: bot.id, ...pinnedToB });
        await rpc(handles.app, fx.owner.cookie, "models/setBackups", [
          { provider: compatible, modelId: modelA.modelId },
        ]);
        const before = await configurationRows(fx.owner.userId);
        const blocked = await call(handles.app, fx.owner.cookie, "models/disconnect", {
          provider: compatible,
        });
        const usages = expectConflictUsages(blocked, "models_in_use", [
          { kind: "bot", id: bot.id, modelId: modelB.modelId, thinkingLevel: "low" },
          { kind: "backup", spaceId: fx.owner.spaceId, modelId: modelA.modelId },
        ]);
        expect(usages.some((usage) => usage.kind === "default")).toBe(false);
        expect(await configurationRows(fx.owner.userId)).toEqual(before);
        expect(before.backups).toHaveLength(1);
        expect(before.preferences).toHaveLength(1);

        await rpc(handles.app, fx.owner.cookie, "bots/update", {
          botId: bot.id,
          modelProvider: null,
          modelId: null,
        });
        await rpc(handles.app, fx.owner.cookie, "models/setBackups", []);
        await rpc(handles.app, fx.owner.cookie, "models/disconnect", { provider: compatible });
        expect(await configurationRows(fx.owner.userId)).toMatchObject({
          credentials: [],
          preferences: [],
          backups: [],
          secrets: [],
        });
        return [blocked];
      });

      await withRaceFixture("disconnect-default-only", {}, async (fx) => {
        expect(await spaceDefaults(fx.owner.userId)).toEqual([
          { provider: compatible, modelId: modelA.modelId, thinkingLevel: null },
        ]);
        await rpc(handles.app, fx.owner.cookie, "models/disconnect", { provider: compatible });
        expect(await configurationRows(fx.owner.userId)).toMatchObject({
          credentials: [],
          preferences: [],
          backups: [],
          secrets: [],
        });
        const catalog = await rpc<ModelCatalogEntry[]>(handles.app, fx.owner.cookie, "models/list");
        expect(
          catalog.filter((entry) => entry.provider === compatible && !entry.placeholder),
        ).toEqual([]);
        return [catalog];
      });
    }, 120_000);

    it("rolls back writes that would reroute an explicit reference to another compatible credential", async () => {
      await withRaceFixture(
        "rebind-default",
        { bots: ["Shared bot"], models: [modelA, sharedOnFirst], defaultModelId: sharedModelId },
        async (fx) => {
          const bot = fx.bots[0]!;
          const second = await insertSecondCompatible(fx);
          await handles.prisma.spaceModelPreference.create({
            data: {
              spaceId: fx.owner.spaceId,
              userId: fx.owner.userId,
              credentialId: second.id,
              modelId: sharedModelId,
              isDefault: false,
            },
          });
          await rpc(handles.app, fx.owner.cookie, "bots/update", {
            botId: bot.id,
            modelProvider: compatible,
            modelId: sharedModelId,
            thinkingLevel: "low",
          });
          const catalog = await expectSharedCatalog(fx.owner, sharedOnFirst);
          const before = await configurationRows(fx.owner.userId);
          const rerouted = await call(handles.app, fx.owner.cookie, "models/setDefault", {
            provider: compatible,
            modelId: modelA.modelId,
          });
          expectConflictUsages(rerouted, "model_connection_in_use", [
            { kind: "bot", id: bot.id, modelId: sharedModelId, thinkingLevel: "low" },
          ]);
          expect(await configurationRows(fx.owner.userId)).toEqual(before);
          return [catalog, rerouted, await expectSharedCatalog(fx.owner, sharedOnFirst)];
        },
      );

      await withRaceFixture(
        "rebind-hosted",
        { bots: ["Shared bot"], models: [modelA, sharedOnFirst] },
        async (fx) => {
          const bot = fx.bots[0]!;
          const second = await insertSecondCompatible(fx);
          const newer = await handles.prisma.spaceModelPreference.create({
            data: {
              spaceId: fx.owner.spaceId,
              userId: fx.owner.userId,
              credentialId: second.id,
              modelId: null,
              isDefault: false,
            },
          });
          await observer.prisma.$executeRaw`
            UPDATE "space_model_preferences"
            SET "updatedAt" = now() + interval '1 hour'
            WHERE "id" = ${newer.id}
          `;
          await insertHostedCredential(fx.owner);
          await rpc(handles.app, fx.owner.cookie, "bots/update", {
            botId: bot.id,
            modelProvider: compatible,
            modelId: sharedModelId,
            thinkingLevel: "low",
          });
          const catalog = await expectSharedCatalog(fx.owner, sharedOnFirst);
          const before = await configurationRows(fx.owner.userId);
          const rerouted = await selectHostedDefault(fx)();
          expectConflictUsages(rerouted, "model_connection_in_use", [
            { kind: "bot", id: bot.id, modelId: sharedModelId, thinkingLevel: "low" },
          ]);
          expect(await configurationRows(fx.owner.userId)).toEqual(before);
          return [catalog, rerouted, await expectSharedCatalog(fx.owner, sharedOnFirst)];
        },
      );

      await withRaceFixture(
        "rebind-config",
        { bots: ["Shared bot"], models: [modelA, sharedOnFirst] },
        async (fx) => {
          const bot = fx.bots[0]!;
          await handles.prisma.spaceModelPreference.deleteMany({
            where: { userId: fx.owner.userId },
          });
          await insertSecondCompatible(fx);
          await rpc(handles.app, fx.owner.cookie, "bots/update", {
            botId: bot.id,
            modelProvider: compatible,
            modelId: sharedModelId,
          });
          await expectBotModel(handles.prisma, bot.id, sharedModelId, null);
          const catalog = await expectSharedCatalog(fx.owner, sharedOnSecond);
          const before = await configurationRows(fx.owner.userId);
          const rerouted = await editModels(fx, [modelA, { ...sharedOnFirst, maxTokens: 2048 }])();
          expectConflictUsages(rerouted, "model_connection_in_use", [
            { kind: "bot", id: bot.id, modelId: sharedModelId },
          ]);
          expect(await configurationRows(fx.owner.userId)).toEqual(before);
          return [catalog, rerouted, await expectSharedCatalog(fx.owner, sharedOnSecond)];
        },
      );
    }, 120_000);

    it("keeps the execution-time setup failure of a never-enabled legacy routine pin", async () => {
      await withRaceFixture("legacy-pin", { bots: ["Legacy pin bot"] }, async (fx) => {
        const bot = fx.bots[0]!;
        const routine = await rpc<{ id: string }>(
          handles.app,
          fx.owner.cookie,
          "routines/create",
          routineInput(bot.id, "Legacy pin"),
        );
        await handles.prisma.routine.update({
          where: { id: routine.id },
          data: {
            modelProvider: compatible,
            modelId: neverEnabledModelId,
            thinkingLevel: "high",
          },
        });
        const started = await rpc<{ runId: string }>(
          handles.app,
          fx.owner.cookie,
          "routines/testRun",
          { routineId: routine.id },
        );
        expect(await runPin(started.runId)).toEqual({
          modelPinned: true,
          modelProvider: compatible,
          modelId: neverEnabledModelId,
          thinkingLevel: "high",
        });
        expect(await awaitRunStatus(observer.prisma, started.runId)).toEqual({
          status: "failed",
          error: "This model is not enabled for the connection.",
        });
        expect(fx.model.completions).toEqual([]);
        expect(fx.model.listRequests).toEqual([]);
        return [started];
      });
    }, 60_000);

    async function routineSaveRaces(kind: RemovalKind) {
      const createPinned = (fx: RaceFixture) => () =>
        call(
          handles.app,
          fx.owner.cookie,
          "routines/create",
          routineInput(fx.bots[0]!.id, "Pinned save", pinnedToB),
        );
      await withRaceFixture(`routine-reference-${kind}`, { bots: ["Routine bot"] }, async (fx) => {
        const before = await credentialRows(fx.owner.userId);
        const [created, removed] = await queue(fx, [createPinned(fx), removal(fx, kind)]);
        const routine = okValue<{ id: string }>(created);
        expectConflictUsages(removed, "models_in_use", [
          { kind: "routine", id: routine.id, modelId: modelB.modelId, thinkingLevel: "low" },
        ]);
        expect(await credentialRows(fx.owner.userId)).toEqual(before);
        return [created, removed];
      });
      await withRaceFixture(`routine-removal-${kind}`, { bots: ["Routine bot"] }, async (fx) => {
        const [removed, created] = await queue(fx, [removal(fx, kind), createPinned(fx)]);
        await expectRemoved(fx, kind, removed);
        expect(created).toMatchObject({ ok: false, status: 400 });
        expect(await handles.prisma.routine.count({ where: { userId: fx.owner.userId } })).toBe(0);
        return [removed, created];
      });
    }

    async function setDefaultRaces(kind: RemovalKind) {
      const selectB = (fx: RaceFixture) => () =>
        call(handles.app, fx.owner.cookie, "models/setDefault", {
          provider: compatible,
          modelId: modelB.modelId,
          thinkingLevel: "low",
        });
      await withRaceFixture(`default-reference-${kind}`, {}, async (fx) => {
        const before = await credentialRows(fx.owner.userId);
        const [selected, removed] = await queue(fx, [selectB(fx), removal(fx, kind)]);
        okValue(selected);
        if (kind === "disconnect") {
          await expectRemoved(fx, kind, removed);
          return [selected, removed];
        }
        expectConflictUsages(removed, "models_in_use", [
          {
            kind: "default",
            spaceId: fx.owner.spaceId,
            modelId: modelB.modelId,
            thinkingLevel: "low",
          },
        ]);
        expect(await credentialRows(fx.owner.userId)).toEqual(before);
        expect(await spaceDefaults(fx.owner.userId)).toEqual([
          { provider: compatible, modelId: modelB.modelId, thinkingLevel: "low" },
        ]);
        return [selected, removed];
      });
      await withRaceFixture(`default-removal-${kind}`, {}, async (fx) => {
        const [removed, selected] = await queue(fx, [removal(fx, kind), selectB(fx)]);
        await expectRemoved(fx, kind, removed);
        expect(selected).toMatchObject({ ok: false, status: 409 });
        expect(
          conflictData(
            selected as RpcFailure,
            MODEL_CONFIGURATION_CONFLICT_MESSAGES.model_configuration_changed,
          ),
        ).toEqual({ reason: "model_configuration_changed" });
        expect(await spaceDefaults(fx.owner.userId)).toEqual(
          kind === "uncheck"
            ? [{ provider: compatible, modelId: modelA.modelId, thinkingLevel: null }]
            : [],
        );
        return [removed, selected];
      });
    }

    async function setBackupsRaces(kind: RemovalKind) {
      const backupB = (fx: RaceFixture) => () =>
        call(handles.app, fx.owner.cookie, "models/setBackups", [
          { provider: compatible, modelId: modelB.modelId },
        ]);
      await withRaceFixture(`backups-reference-${kind}`, {}, async (fx) => {
        const before = await credentialRows(fx.owner.userId);
        const [saved, removed] = await queue(fx, [backupB(fx), removal(fx, kind)]);
        okValue(saved);
        expectConflictUsages(removed, "models_in_use", [
          { kind: "backup", spaceId: fx.owner.spaceId, modelId: modelB.modelId },
        ]);
        expect(await credentialRows(fx.owner.userId)).toEqual(before);
        expect(await backupRows(fx.owner.userId)).toEqual([
          { provider: compatible, modelId: modelB.modelId },
        ]);
        return [saved, removed];
      });
      await withRaceFixture(`backups-removal-${kind}`, {}, async (fx) => {
        const [removed, saved] = await queue(fx, [removal(fx, kind), backupB(fx)]);
        await expectRemoved(fx, kind, removed);
        expect(saved).toMatchObject({ ok: false, status: 400 });
        expect(await backupRows(fx.owner.userId)).toEqual([]);
        return [removed, saved];
      });
    }

    async function duplicateRaces(kind: RemovalKind) {
      const duplicate = (fx: RaceFixture) => () =>
        call(handles.app, fx.owner.cookie, "bots/duplicate", { botId: fx.bots[0]!.id });
      await withRaceFixture(`duplicate-reference-${kind}`, { bots: ["Source bot"] }, async (fx) => {
        const source = fx.bots[0]!;
        await rpc(handles.app, fx.owner.cookie, "bots/update", { botId: source.id, ...pinnedToB });
        const before = await credentialRows(fx.owner.userId);
        const [duplicated, removed] = await queue(fx, [duplicate(fx), removal(fx, kind)]);
        const copy = okValue<{ id: string }>(duplicated);
        await expectBotModel(handles.prisma, copy.id, modelB.modelId, "low");
        expectConflictUsages(removed, "models_in_use", [
          { kind: "bot", id: source.id, modelId: modelB.modelId, thinkingLevel: "low" },
          { kind: "bot", id: copy.id, modelId: modelB.modelId, thinkingLevel: "low" },
        ]);
        expect(await credentialRows(fx.owner.userId)).toEqual(before);
        return [duplicated, removed];
      });
      await withRaceFixture(`duplicate-removal-${kind}`, { bots: ["Source bot"] }, async (fx) => {
        const source = fx.bots[0]!;
        await rpc(handles.app, fx.owner.cookie, "bots/update", { botId: source.id, ...pinnedToB });
        const [moved, removed, duplicated] = await queue(fx, [
          () =>
            call(handles.app, fx.owner.cookie, "bots/update", {
              botId: source.id,
              ...botReplacement(kind),
            }),
          removal(fx, kind),
          duplicate(fx),
        ]);
        okValue(moved);
        await expectRemoved(fx, kind, removed);
        expect(duplicated).toMatchObject({ ok: false, status: 400 });
        expect(await handles.prisma.bot.count({ where: { userId: fx.owner.userId } })).toBe(1);
        return [moved, removed, duplicated];
      });
    }

    async function spawnRaces(kind: RemovalKind) {
      const parentPrompt = "Parent turn before spawning.";
      const parentSteps = [
        effortStep(
          modelA.modelId,
          parentPrompt,
          effectiveThinkingLevel(modelA.thinkingLevels, null, null),
        ),
      ];
      const prepareParent = async (fx: RaceFixture) => {
        const parent = fx.bots[0]!;
        const sent = await rpc<{ runId: string }>(handles.app, fx.owner.cookie, "threads/send", {
          botId: parent.id,
          text: parentPrompt,
        });
        await awaitCompletedRun(handles.prisma, fx.model, sent.runId);
        await rpc(handles.app, fx.owner.cookie, "bots/update", { botId: parent.id, ...pinnedToB });
        const spawn: Starter = () =>
          settled(
            spawnBot(
              { prisma: handles.prisma, jobs: handles.jobs },
              {
                spawnedBy: {
                  id: parent.id,
                  name: parent.name,
                  spaceId: fx.owner.spaceId,
                  userId: fx.owner.userId,
                },
                runId: sent.runId,
                spawnKey: randomUUID(),
                name: "Spawned child",
              },
            ),
          );
        return { parent, spawn };
      };
      const childId = (result: RpcResult<unknown> | undefined) => {
        const spawned = okValue<{ ok?: true; botId?: string }>(result);
        expect(spawned.ok).toBe(true);
        return spawned.botId!;
      };
      await withRaceFixture(
        `spawn-reference-${kind}`,
        { bots: ["Parent bot"], steps: parentSteps },
        async (fx) => {
          const { parent, spawn } = await prepareParent(fx);
          const before = await credentialRows(fx.owner.userId);
          const [spawned, removed] = await queue(fx, [spawn, removal(fx, kind)]);
          const child = childId(spawned);
          await expectBotModel(handles.prisma, child, modelB.modelId, "low");
          expectConflictUsages(removed, "models_in_use", [
            { kind: "bot", id: parent.id, modelId: modelB.modelId, thinkingLevel: "low" },
            { kind: "bot", id: child, modelId: modelB.modelId, thinkingLevel: "low" },
          ]);
          expect(await credentialRows(fx.owner.userId)).toEqual(before);
          return [spawned, removed];
        },
      );
      await withRaceFixture(
        `spawn-removal-${kind}`,
        { bots: ["Parent bot"], steps: parentSteps },
        async (fx) => {
          const { parent, spawn } = await prepareParent(fx);
          const [moved, removed, spawned] = await queue(fx, [
            () =>
              call(handles.app, fx.owner.cookie, "bots/update", {
                botId: parent.id,
                ...botReplacement(kind),
              }),
            removal(fx, kind),
            spawn,
          ]);
          okValue(moved);
          await expectRemoved(fx, kind, removed);
          const replacement = routineReplacement(kind);
          await expectBotModel(
            handles.prisma,
            childId(spawned),
            replacement.modelId,
            replacement.thinkingLevel,
          );
          return [moved, removed, spawned];
        },
      );
    }

    async function capturedPinRaces(capture: CaptureKind, kind: RemovalKind) {
      const prompt = `Captured ${capture} routine.`;
      const createRoutine = (fx: RaceFixture) =>
        rpc<{ id: string }>(
          handles.app,
          fx.owner.cookie,
          "routines/create",
          routineInput(fx.bots[0]!.id, "Captured", {
            prompt,
            webhookEnabled: capture === "webhook",
            ...pinnedToB,
          }),
        );
      await withRaceFixture(
        `${capture}-reference-${kind}`,
        { bots: ["Capture bot"], steps: [effortStep(modelB.modelId, prompt, "low")] },
        async (fx) => {
          const bot = fx.bots[0]!;
          const routine = await createRoutine(fx);
          const trigger = await prepareCapture(fx, capture, routine.id);
          const before = await credentialRows(fx.owner.userId);
          await trigger.arm();
          const [captured, removed] = await queue(fx, [trigger.fire, removal(fx, kind)]);
          okValue(captured);
          const runId = await trigger.runId(captured!);
          expect(await runPin(runId)).toEqual({
            modelPinned: true,
            modelProvider: compatible,
            modelId: modelB.modelId,
            thinkingLevel: "low",
          });
          expectConflictUsages(removed, "models_in_use", [
            {
              kind: "run",
              id: runId,
              name: bot.name,
              modelId: modelB.modelId,
              thinkingLevel: "low",
            },
            { kind: "routine", id: routine.id, modelId: modelB.modelId, thinkingLevel: "low" },
          ]);
          expect(await credentialRows(fx.owner.userId)).toEqual(before);
          await awaitCompletedRun(handles.prisma, fx.model, runId);
          return [captured, removed];
        },
      );
      await withRaceFixture(
        `${capture}-removal-${kind}`,
        {
          bots: ["Capture bot"],
          steps: kind === "uncheck" ? [effortStep(modelA.modelId, prompt, "low")] : [],
        },
        async (fx) => {
          const routine = await createRoutine(fx);
          const trigger = await prepareCapture(fx, capture, routine.id);
          await trigger.arm();
          const [moved, removed, captured] = await queue(fx, [
            () =>
              call(handles.app, fx.owner.cookie, "routines/update", {
                routineId: routine.id,
                ...routineReplacement(kind),
              }),
            removal(fx, kind),
            trigger.fire,
          ]);
          okValue(moved);
          await expectRemoved(fx, kind, removed);
          okValue(captured);
          const runId = await trigger.runId(captured!);
          expect(await handles.prisma.run.count({ where: { userId: fx.owner.userId } })).toBe(1);
          if (kind === "uncheck") {
            expect(await runPin(runId)).toEqual({
              modelPinned: true,
              modelProvider: compatible,
              modelId: modelA.modelId,
              thinkingLevel: "low",
            });
            await awaitCompletedRun(handles.prisma, fx.model, runId);
          } else {
            const pin = await runPin(runId);
            expect(pin.modelPinned).toBe(false);
            expect(pin.modelProvider).not.toBe(compatible);
            expect((await awaitRunStatus(observer.prisma, runId)).status).toBe("failed");
          }
          return [moved, removed, captured];
        },
      );
    }

    async function continuationRaces(kind: RemovalKind) {
      const holdPrompt = "Hold the queue for steering.";
      const pinnedPrompt = "Pinned steering delivery.";
      for (const order of ["finalize-first", "removal-first"] as const) {
        const hold = gate();
        try {
          await withRaceFixture(
            `steering-${order}-${kind}`,
            {
              bots: ["Steering bot"],
              steps: [
                {
                  model: modelA.modelId,
                  async expect(request: ModelEmulatorRequest) {
                    expect(JSON.stringify(request.messages)).toContain(holdPrompt);
                    hold.arrive();
                    await hold.opened;
                  },
                  response: { type: "text", text: "Held run finished." },
                },
                effortStep(modelB.modelId, pinnedPrompt, "low"),
              ],
            },
            async (fx) => {
              const bot = fx.bots[0]!;
              const holding = await rpc<{ id: string }>(
                handles.app,
                fx.owner.cookie,
                "routines/create",
                routineInput(bot.id, "Holding", { prompt: holdPrompt }),
              );
              const pinned = await rpc<{ id: string }>(
                handles.app,
                fx.owner.cookie,
                "routines/create",
                routineInput(bot.id, "Pinned delivery", {
                  prompt: pinnedPrompt,
                  webhookEnabled: true,
                  ...pinnedToB,
                }),
              );
              const hook = await rpc<WebhookHook>(
                handles.app,
                fx.owner.cookie,
                "bots/rotateWebhookSecret",
                { botId: bot.id },
              );
              const held = await rpc<{ runId: string }>(
                handles.app,
                fx.owner.cookie,
                "routines/testRun",
                { routineId: holding.id },
              );
              await hold.reached;
              const delivered = await postWebhook(hook);
              okValue(delivered);
              const steering = await handles.prisma.steeringMessage.findFirstOrThrow({
                where: { botId: bot.id, runId: null },
                select: { id: true, modelProvider: true, modelId: true, thinkingLevel: true },
              });
              expect(steering).toMatchObject({
                modelProvider: compatible,
                modelId: modelB.modelId,
                thinkingLevel: "low",
              });
              await rpc(handles.app, fx.owner.cookie, "routines/update", {
                routineId: pinned.id,
                modelProvider: null,
                modelId: null,
                thinkingLevel: null,
              });
              const before = await credentialRows(fx.owner.userId);
              const finalize: Starter = () => {
                hold.open();
                return settled(awaitRunStatus(observer.prisma, held.runId));
              };
              const results = await queue(
                fx,
                order === "finalize-first"
                  ? [finalize, removal(fx, kind)]
                  : [removal(fx, kind), finalize],
              );
              const removed = order === "finalize-first" ? results[1] : results[0];
              expect(await awaitRunStatus(observer.prisma, held.runId)).toEqual({
                status: "completed",
                error: null,
              });
              const continuation = await handles.prisma.run.findFirstOrThrow({
                where: { botId: bot.id, trigger: "follow_up" },
                select: { id: true },
              });
              expect(await runPin(continuation.id)).toEqual({
                modelPinned: true,
                modelProvider: compatible,
                modelId: modelB.modelId,
                thinkingLevel: "low",
              });
              expectConflictUsages(removed, "models_in_use", [
                {
                  kind: order === "finalize-first" ? "run" : "steering",
                  id: order === "finalize-first" ? continuation.id : steering.id,
                  name: bot.name,
                  modelId: modelB.modelId,
                  thinkingLevel: "low",
                },
              ]);
              expect(await credentialRows(fx.owner.userId)).toEqual(before);
              await awaitCompletedRun(handles.prisma, fx.model, continuation.id);
              return [delivered, removed];
            },
          );
        } finally {
          hold.open();
        }
      }
    }

    async function withRaceFixture(
      label: string,
      options: {
        bots?: string[];
        steps?: ModelEmulatorStep[];
        models?: OpenAiCompatibleModelConfig[];
        defaultModelId?: string;
      },
      body: (fx: RaceFixture) => Promise<unknown[]>,
    ) {
      const model = await startModelEmulator({
        apiKey: raceKey,
        models: [{ id: modelA.modelId }, { id: modelB.modelId }, { id: sharedModelId }],
        steps: options.steps ?? [],
      });
      let owner: Account | undefined;
      try {
        owner = await signup(handles.app, label);
        const bots: RaceFixture["bots"] = [];
        for (const name of options.bots ?? []) {
          bots.push({ id: (await createBot(handles, owner, name)).id, name });
        }
        const models = options.models ?? [modelA, modelB];
        const created = await rpc<ModelCredential>(handles.app, owner.cookie, "models/connect", {
          provider: compatible,
          baseUrl: model.baseUrl,
          apiKey: raceKey,
          models,
          modelId: options.defaultModelId ?? models[0]!.modelId,
        });
        const exposed = await body({
          owner,
          model,
          bots,
          credentialId: created.id,
          version: created.configurationVersion ?? -1,
        });
        await awaitRunsSettled(owner.userId);
        model.assertComplete();
        const credentials = await rpc<ModelCredential[]>(
          handles.app,
          owner.cookie,
          "models/credentials",
        );
        await expectKeysHidden(owner.userId, [created, credentials, ...exposed]);
      } finally {
        if (owner) await awaitRunsSettled(owner.userId).catch(() => undefined);
        await model.close();
      }
    }

    function queue(fx: RaceFixture, starters: Starter[]) {
      return queueOnOwnerLock(observer.prisma, fx.owner.userId, starters);
    }

    function editModels(fx: RaceFixture, models: OpenAiCompatibleModelConfig[]): Starter {
      return () =>
        call<ModelCredential>(handles.app, fx.owner.cookie, "models/connect", {
          provider: compatible,
          baseUrl: fx.model.baseUrl,
          credentialId: fx.credentialId,
          expectedConfigurationVersion: fx.version,
          models,
        });
    }

    function removal(fx: RaceFixture, kind: RemovalKind): Starter {
      if (kind === "uncheck") return editModels(fx, [modelA]);
      return () =>
        call(handles.app, fx.owner.cookie, "models/disconnect", { provider: compatible });
    }

    function selectHostedDefault(fx: RaceFixture): Starter {
      return () =>
        call(handles.app, fx.owner.cookie, "models/setDefault", {
          provider: "openrouter",
          modelId: DEFAULT_OPENROUTER_MODEL_ID,
        });
    }

    async function expectRemoved(
      fx: RaceFixture,
      kind: RemovalKind,
      result: RpcResult<unknown> | undefined,
    ) {
      okValue(result);
      const credentials = await handles.prisma.userModelCredential.findMany({
        where: { userId: fx.owner.userId, provider: compatible },
        select: { enabledModelIds: true, modelConfigurationVersion: true },
      });
      if (kind === "uncheck") {
        expect(credentials).toHaveLength(1);
        expect(credentials[0]!.enabledModelIds).toEqual([modelA.modelId]);
        expect(credentials[0]!.modelConfigurationVersion).toBeGreaterThan(fx.version);
        return;
      }
      expect(credentials).toEqual([]);
      expect(await configurationRows(fx.owner.userId)).toMatchObject({
        credentials: [],
        preferences: [],
        secrets: [],
      });
    }

    async function prepareCapture(fx: RaceFixture, capture: CaptureKind, routineId: string) {
      const runFromResult = async (result: RpcResult<unknown>) =>
        okValue<{ runId: string }>(result).runId;
      if (capture === "testRun") {
        return {
          arm: async () => undefined,
          fire: (() =>
            call(handles.app, fx.owner.cookie, "routines/testRun", { routineId })) as Starter,
          runId: runFromResult,
        };
      }
      if (capture === "webhook") {
        const hook = await rpc<WebhookHook>(
          handles.app,
          fx.owner.cookie,
          "bots/rotateWebhookSecret",
          { botId: fx.bots[0]!.id },
        );
        return {
          arm: async () => undefined,
          fire: (() => postWebhook(hook)) as Starter,
          runId: runFromResult,
        };
      }
      let scheduledFor = new Date(0);
      return {
        arm: async () => {
          scheduledFor = new Date(Date.now() - 1_000);
          await handles.prisma.routine.update({
            where: { id: routineId },
            data: { nextRunAt: scheduledFor },
          });
        },
        fire: (() =>
          settled(handles.executor.wakeRoutine(routineId, scheduledFor.toISOString()))) as Starter,
        runId: async () =>
          (
            await handles.prisma.run.findFirstOrThrow({
              where: { routineId },
              select: { id: true },
            })
          ).id,
      };
    }

    async function postWebhook(hook: WebhookHook): Promise<RpcResult<unknown>> {
      const response = await handles.app.request(hook.path, {
        method: "POST",
        headers: { authorization: `Bearer ${hook.secret}`, "content-type": "application/json" },
        body: JSON.stringify({ event_id: randomUUID(), summary: "Fixture delivery" }),
      });
      const text = await response.text();
      if (!response.ok) {
        return { ok: false, status: response.status, code: undefined, message: text, data: text };
      }
      return { ok: true, status: response.status, value: JSON.parse(text) as unknown };
    }

    async function insertHostedCredential(account: Account) {
      return insertCredential(handles.prisma, new EncryptedSecretStore(encryptionKey), account, {
        provider: "openrouter",
        plaintext: hostedKey,
      });
    }

    async function insertSecondCompatible(fx: RaceFixture) {
      const second = await insertCredential(
        handles.prisma,
        new EncryptedSecretStore(encryptionKey),
        fx.owner,
        {
          provider: compatible,
          plaintext: JSON.stringify({
            kind: "openai_compatible",
            baseUrl: fx.model.baseUrl,
            apiKey: secondKey,
            models: [sharedOnSecond],
          }),
        },
      );
      await handles.prisma.userModelCredential.update({
        where: { id: second.id },
        data: { enabledModelIds: [sharedModelId] },
      });
      return second;
    }

    async function expectSharedCatalog(account: Account, expected: OpenAiCompatibleModelConfig) {
      const catalog = await rpc<ModelCatalogEntry[]>(handles.app, account.cookie, "models/list");
      const shared = catalog.filter(
        (entry) =>
          entry.provider === compatible && entry.id === expected.modelId && !entry.placeholder,
      );
      expect(shared).toHaveLength(1);
      expect(shared[0]).toMatchObject({
        thinkingLevels: expected.thinkingLevels,
        defaultThinkingLevel: expected.defaultThinkingLevel,
      });
      return catalog;
    }

    async function credentialRows(userId: string) {
      const { credentials, secrets } = await configurationRows(userId);
      return { credentials, secrets };
    }

    async function configurationRows(userId: string) {
      const [credentials, preferences, backups, secrets] = await Promise.all([
        handles.prisma.userModelCredential.findMany({
          where: { userId },
          orderBy: { id: "asc" },
          select: {
            id: true,
            provider: true,
            enabledModelIds: true,
            modelConfigurationVersion: true,
            secretId: true,
            updatedAt: true,
          },
        }),
        handles.prisma.spaceModelPreference.findMany({
          where: { userId },
          orderBy: { id: "asc" },
          select: {
            id: true,
            credentialId: true,
            modelId: true,
            thinkingLevel: true,
            isDefault: true,
            updatedAt: true,
          },
        }),
        backupRows(userId),
        handles.prisma.secret.findMany({
          where: { userId, kind: "model" },
          orderBy: { id: "asc" },
          select: { id: true, ciphertext: true },
        }),
      ]);
      return { credentials, preferences, backups, secrets };
    }

    function backupRows(userId: string) {
      return handles.prisma.spaceBackupModel.findMany({
        where: { userId },
        orderBy: [{ spaceId: "asc" }, { position: "asc" }],
        select: { provider: true, modelId: true },
      });
    }

    async function spaceDefaults(userId: string) {
      const rows = await handles.prisma.spaceModelPreference.findMany({
        where: { userId, isDefault: true },
        select: { modelId: true, thinkingLevel: true, credential: { select: { provider: true } } },
      });
      return rows.map((row) => ({
        provider: row.credential.provider,
        modelId: row.modelId,
        thinkingLevel: row.thinkingLevel,
      }));
    }

    function runPin(runId: string) {
      return handles.prisma.run.findUniqueOrThrow({
        where: { id: runId },
        select: { modelPinned: true, modelProvider: true, modelId: true, thinkingLevel: true },
      });
    }

    async function awaitRunsSettled(userId: string) {
      const deadline = Date.now() + runSettleMs;
      for (;;) {
        const runs = await observer.prisma.run.findMany({
          where: { userId },
          select: { status: true },
        });
        if (runs.every((run) => !isActive(run.status as RunStatus))) return;
        if (Date.now() > deadline) throw new Error("Runs did not settle");
        await pollPause(observer.prisma);
      }
    }

    async function expectKeysHidden(userId: string, exposed: unknown[]) {
      const [messages, events, runs] = await Promise.all([
        handles.prisma.message.findMany({
          where: { thread: { userId } },
          select: { blocks: true },
        }),
        handles.prisma.event.findMany({ where: { thread: { userId } }, select: { payload: true } }),
        handles.prisma.run.findMany({ where: { userId }, select: { error: true } }),
      ]);
      const visible = JSON.stringify([exposed, messages, events, runs]);
      for (const key of [raceKey, secondKey, hostedKey]) expect(visible).not.toContain(key);
    }
  });
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
  const deadline = Date.now() + runSettleMs;
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

async function queueOnOwnerLock<T>(
  prisma: PrismaClient,
  userId: string,
  starters: Array<() => Promise<T>>,
): Promise<T[]> {
  const blocker = await holdOwnerLock(prisma, userId);
  const started: Array<InFlight<T>> = [];
  const waiters: number[] = [];
  try {
    for (const start of starters) {
      const pending = inFlight(Promise.resolve().then(start));
      started.push(pending);
      waiters.push(
        await waitForOwnerLockWaiter(prisma, [blocker.pid, ...waiters], waiters, pending),
      );
    }
    blocker.release();
    await blocker.transaction;
    return await Promise.all(started.map((entry) => entry.promise));
  } finally {
    blocker.release();
    await Promise.allSettled([blocker.transaction, ...started.map((entry) => entry.promise)]);
  }
}

async function settled<T>(promise: Promise<T>): Promise<RpcResult<T>> {
  try {
    return { ok: true, status: 200, value: await promise };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 500, code: undefined, message, data: undefined };
  }
}

function gate() {
  let open!: () => void;
  let arrive!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  return { open, opened, arrive, reached };
}

async function awaitRunStatus(prisma: PrismaClient, runId: string) {
  const deadline = Date.now() + runSettleMs;
  for (;;) {
    const run = await prisma.run.findUnique({
      where: { id: runId },
      select: { status: true, error: true },
    });
    if (!run) throw new Error(`Run ${runId} is missing`);
    if (!isActive(run.status as RunStatus)) return run;
    if (Date.now() > deadline) throw new Error(`Run ${runId} is still ${run.status}`);
    await pollPause(prisma);
  }
}

function okValue<T>(result: RpcResult<unknown> | undefined): T {
  if (!result?.ok) throw new Error(`Expected success: ${JSON.stringify(result)}`);
  return result.value as T;
}

function expectConflictUsages(
  result: RpcResult<unknown> | undefined,
  reason: "models_in_use" | "model_connection_in_use",
  expected: Array<Partial<ModelConfigurationUsage>>,
): ModelConfigurationUsage[] {
  const data = conflictData(result as RpcFailure, MODEL_CONFIGURATION_CONFLICT_MESSAGES[reason]);
  expect(data.reason).toBe(reason);
  const usages = "usages" in data ? data.usages : [];
  expect(usages).toEqual(
    expect.arrayContaining(expected.map((usage) => expect.objectContaining(usage))),
  );
  return usages;
}

function routineInput(botId: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    botId,
    name,
    prompt: `${name} prompt.`,
    crons: [weeklyCron],
    notify: false,
    active: true,
    ...overrides,
  };
}

function routineReplacement(kind: RemovalKind) {
  return kind === "uncheck"
    ? { modelProvider: compatible, modelId: modelA.modelId, thinkingLevel: "low" }
    : { modelProvider: null, modelId: null, thinkingLevel: null };
}

function botReplacement(kind: RemovalKind) {
  return kind === "uncheck" ? routineReplacement(kind) : { modelProvider: null, modelId: null };
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
