import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import {
  compatibleCatalogModelsForSpace,
  withCompatibleCatalogEntries,
} from "./compatible-model-catalog.js";
import { listPiCatalog } from "./pi-models.js";

const COMPAT = "openai-compatible";
const scope = { userId: "user-1", spaceId: "space-1" };

type TestCredential = {
  id: string;
  provider: string;
  secretId: string;
  enabledModelIds: string[];
  supportsImages: boolean;
  updatedAt: Date;
  createdAt: Date;
};

function credential(id: string, enabledModelIds: string[], updatedAt: number): TestCredential {
  return {
    id,
    provider: COMPAT,
    secretId: `secret-${id}`,
    enabledModelIds,
    supportsImages: false,
    updatedAt: new Date(updatedAt),
    createdAt: new Date(0),
  };
}

function secretFor(baseUrl: string, models: Array<Record<string, unknown>>) {
  return JSON.stringify({ kind: "openai_compatible", baseUrl, models });
}

const shared = (thinkingLevels: string[], defaultThinkingLevel: string | null) => ({
  modelId: "shared",
  thinkingLevels,
  defaultThinkingLevel,
  contextWindow: 32_000,
  maxTokens: 4_000,
  supportsImages: false,
});

function prismaFor(input: {
  credentials: TestCredential[];
  preferences?: Array<{
    credential: TestCredential;
    modelId: string | null;
    thinkingLevel: string | null;
    isDefault: boolean;
  }>;
  secrets: Record<string, string>;
}) {
  return {
    userModelCredential: { findMany: async () => input.credentials },
    spaceModelPreference: {
      findMany: async () =>
        (input.preferences ?? []).map((preference, index) => ({
          id: `preference-${index}`,
          updatedAt: new Date(0),
          ...preference,
        })),
    },
    secret: {
      findMany: async (args: { where: { id: { in: string[] } } }) =>
        args.where.id.in.flatMap((id) =>
          input.secrets[id] ? [{ id, ciphertext: input.secrets[id] }] : [],
        ),
    },
  } as unknown as PrismaClient;
}

const secretStore = { load: async (ciphertext: string) => ciphertext };

describe("compatible catalog models", () => {
  it("publishes only the chosen credential's metadata for an id two credentials enable", async () => {
    const older = credential("older", ["shared", "only-older"], 1);
    const newer = credential("newer", ["shared"], 2);
    const prisma = prismaFor({
      credentials: [newer, older],
      preferences: [
        { credential: older, modelId: "shared", thinkingLevel: "high", isDefault: true },
      ],
      secrets: {
        "secret-older": secretFor("http://127.0.0.1:1111/v1", [
          shared(["off", "low", "high"], "low"),
          { ...shared(["off"], null), modelId: "only-older" },
        ]),
        "secret-newer": secretFor("http://127.0.0.1:2222/v1", [shared(["xhigh"], "xhigh")]),
      },
    });

    const models = await compatibleCatalogModelsForSpace(prisma, secretStore, scope);

    expect(models).toEqual([
      expect.objectContaining({
        modelId: "shared",
        credentialId: "older",
        baseUrl: "http://127.0.0.1:1111/v1",
        config: expect.objectContaining({ thinkingLevels: ["off", "low", "high"] }),
        defaultThinkingLevel: "high",
      }),
      expect.objectContaining({
        modelId: "only-older",
        credentialId: "older",
        defaultThinkingLevel: null,
      }),
    ]);
  });

  it("omits ids the chosen credential does not enable or configure", async () => {
    const preferred = credential("preferred", ["configured", "missing-config"], 1);
    const newer = credential("newer", ["shadowed"], 2);
    const prisma = prismaFor({
      credentials: [newer, preferred],
      preferences: [
        { credential: preferred, modelId: "configured", thinkingLevel: null, isDefault: true },
      ],
      secrets: {
        "secret-preferred": secretFor("http://127.0.0.1:1111/v1", [
          { ...shared(["low", "medium"], "medium"), modelId: "configured" },
        ]),
        "secret-newer": secretFor("http://127.0.0.1:2222/v1", [
          { ...shared(["low"], null), modelId: "shadowed" },
        ]),
      },
    });

    const models = await compatibleCatalogModelsForSpace(prisma, secretStore, scope);

    expect(models.map((model) => [model.modelId, model.defaultThinkingLevel])).toEqual([
      ["configured", "medium"],
    ]);
  });
});

describe("compatible catalog entries", () => {
  const catalog = listPiCatalog();

  it("keeps one placeholder when nothing is selectable", () => {
    const entries = withCompatibleCatalogEntries(catalog, []).filter(
      (entry) => entry.provider === COMPAT,
    );
    expect(entries).toEqual([expect.objectContaining({ id: "custom", placeholder: true })]);
  });

  it("replaces placeholders with selectable rows, including an enabled custom id", () => {
    const config = {
      modelId: "custom",
      thinkingLevels: ["off", "low", "xhigh"] as const,
      defaultThinkingLevel: null,
      contextWindow: 32_000,
      maxTokens: 4_000,
      supportsImages: false,
    };
    const entries = withCompatibleCatalogEntries(catalog, [
      {
        modelId: "custom",
        credentialId: "credential-1",
        secretId: "secret-1",
        baseUrl: "http://127.0.0.1:1111/v1",
        config: { ...config, thinkingLevels: [...config.thinkingLevels] },
        defaultThinkingLevel: "xhigh",
      },
    ]);
    const compatible = entries.filter((entry) => entry.provider === COMPAT);
    expect(compatible).toHaveLength(1);
    expect(compatible[0]).toMatchObject({
      id: "custom",
      label: "custom",
      reasoning: true,
      thinkingLevels: ["off", "low", "xhigh"],
      defaultThinkingLevel: "xhigh",
    });
    expect(compatible[0]).not.toHaveProperty("placeholder");
    expect(entries.filter((entry) => entry.provider !== COMPAT)).toEqual(
      catalog.filter((entry) => entry.provider !== COMPAT),
    );
  });
});
