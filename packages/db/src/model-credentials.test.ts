import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import {
  chooseModelCredential,
  defaultModelCredentialCandidates,
  findDefaultModelCredential,
  findModelCredential,
  newestModelCredentialOrder,
  selectSpaceModelPreference,
} from "./model-credentials.js";
import {
  assertCompatibleReferenceBindingsUnchanged,
  loadCompatibleModelReferences,
  ModelConfigurationConflictError,
  resolveCompatibleReferenceBindings,
  snapshotCompatibleReferenceBindings,
} from "./model-references.js";

describe("findDefaultModelCredential", () => {
  it("resolves the default from the active space preference", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { spaceModelPreference: { findFirst } } as unknown as PrismaClient;

    await findDefaultModelCredential(prisma, { userId: "user", spaceId: "space" });

    expect(findFirst).toHaveBeenCalledWith({
      where: { userId: "user", spaceId: "space", isDefault: true },
      include: { credential: true },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    });
  });

  it("treats a stored stringified null model id as unset", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      credential: {
        id: "credential",
        userId: "user",
        provider: "anthropic",
        label: "Anthropic",
        secretId: "secret",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      isDefault: true,
      modelId: "null",
    });
    const prisma = { spaceModelPreference: { findFirst } } as unknown as PrismaClient;

    await expect(
      findDefaultModelCredential(prisma, { userId: "user", spaceId: "space" }),
    ).resolves.toEqual(
      expect.objectContaining({ id: "credential", provider: "anthropic", defaultModel: null }),
    );
  });
});

describe("findModelCredential", () => {
  it("falls back to the newest user credential when the space has no preference", async () => {
    const preferenceFindFirst = vi.fn().mockResolvedValue(null);
    const credentialFindFirst = vi.fn().mockResolvedValue(null);
    const prisma = {
      spaceModelPreference: { findFirst: preferenceFindFirst },
      userModelCredential: { findFirst: credentialFindFirst },
    } as unknown as PrismaClient;

    await findModelCredential(prisma, { userId: "user", spaceId: "space" }, "xai");

    expect(preferenceFindFirst).toHaveBeenCalledWith({
      where: { userId: "user", spaceId: "space", credential: { provider: "xai" } },
      include: { credential: true },
      orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
    });
    expect(credentialFindFirst).toHaveBeenCalledWith({
      where: { userId: "user", provider: "xai" },
      orderBy: newestModelCredentialOrder,
    });
  });

  it("prefers the preference that owns a free-form modelId over the provider default", async () => {
    const matching = {
      credential: {
        id: "credential-other",
        userId: "user",
        provider: "openai-compatible",
        label: "Other",
        secretId: "secret-other",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      isDefault: false,
      modelId: "other-model",
    };
    const preferenceFindFirst = vi.fn().mockResolvedValue(matching);
    const prisma = {
      spaceModelPreference: { findFirst: preferenceFindFirst },
      userModelCredential: { findFirst: vi.fn() },
    } as unknown as PrismaClient;

    await expect(
      findModelCredential(
        prisma,
        { userId: "user", spaceId: "space" },
        "openai-compatible",
        "other-model",
      ),
    ).resolves.toEqual({
      ...matching.credential,
      isDefault: false,
      defaultModel: "other-model",
    });
    expect(preferenceFindFirst).toHaveBeenCalledWith({
      where: {
        userId: "user",
        spaceId: "space",
        modelId: "other-model",
        credential: { provider: "openai-compatible" },
      },
      include: { credential: true },
      orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
    });
    expect(preferenceFindFirst).toHaveBeenCalledTimes(1);
  });

  it("uses chooseModelCredential when the client can list every candidate", async () => {
    const older = {
      id: "credential-older",
      userId: "user",
      provider: "openai-codex",
      label: "Older",
      secretId: "secret-older",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    };
    const newer = {
      id: "credential-newer",
      userId: "user",
      provider: "openai-codex",
      label: "Newer",
      secretId: "secret-newer",
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
      updatedAt: new Date("2026-02-02T00:00:00.000Z"),
    };
    const sparkPreference = {
      id: "pref-spark",
      modelId: "gpt-5.3-codex-spark",
      thinkingLevel: null,
      isDefault: false,
      updatedAt: new Date("2026-02-03T00:00:00.000Z"),
      credential: older,
    };
    const defaultPreference = {
      id: "pref-default",
      modelId: "gpt-6-luna",
      thinkingLevel: null,
      isDefault: true,
      updatedAt: new Date("2026-03-01T00:00:00.000Z"),
      credential: newer,
    };
    const preferenceFindMany = vi.fn().mockResolvedValue([defaultPreference, sparkPreference]);
    const credentialFindMany = vi.fn().mockResolvedValue([older, newer]);
    const prisma = {
      spaceModelPreference: { findMany: preferenceFindMany },
      userModelCredential: { findMany: credentialFindMany },
    } as unknown as PrismaClient;

    await expect(
      findModelCredential(
        prisma,
        { userId: "user", spaceId: "space" },
        "openai-codex",
        "gpt-5.3-codex-spark",
      ),
    ).resolves.toEqual({
      ...older,
      isDefault: false,
      defaultModel: "gpt-5.3-codex-spark",
      thinkingLevel: null,
    });
    await expect(
      findModelCredential(
        prisma,
        { userId: "user", spaceId: "space" },
        "openai-codex",
        "gpt-6-luna",
      ),
    ).resolves.toEqual({
      ...newer,
      isDefault: true,
      defaultModel: "gpt-6-luna",
      thinkingLevel: null,
    });
  });
});

describe("chooseModelCredential", () => {
  function credential(id: string, iso: string) {
    const at = new Date(iso);
    return {
      id,
      provider: "openai-codex",
      secretId: `secret-${id}`,
      updatedAt: at,
      createdAt: at,
    };
  }

  it("prefers the preference that owns the model id over the default", () => {
    const apiKey = credential("api", "2026-01-01T00:00:00.000Z");
    const oauth = credential("oauth", "2026-03-01T00:00:00.000Z");
    const choice = chooseModelCredential({
      provider: "openai-codex",
      modelId: "gpt-5.3-codex-spark",
      preferences: [
        {
          id: "pref-default",
          modelId: "gpt-6-luna",
          thinkingLevel: null,
          isDefault: true,
          updatedAt: new Date("2026-03-02T00:00:00.000Z"),
          credential: oauth,
        },
        {
          id: "pref-spark",
          modelId: "gpt-5.3-codex-spark",
          thinkingLevel: null,
          isDefault: false,
          updatedAt: new Date("2026-02-01T00:00:00.000Z"),
          credential: apiKey,
        },
      ],
      credentials: [oauth, apiKey],
    });
    expect(choice).toEqual({
      source: "preference",
      preference: expect.objectContaining({ credential: apiKey }),
    });
  });

  it("prefers the space preference over a newer unused credential", () => {
    const older = credential("older", "2026-01-01T00:00:00.000Z");
    const newer = credential("newer", "2026-02-01T00:00:00.000Z");
    const candidates = defaultModelCredentialCandidates({
      provider: "openai-codex",
      modelId: "gpt-6-luna",
      preferences: [
        {
          id: "pref-older",
          modelId: "gpt-5.4",
          thinkingLevel: null,
          isDefault: true,
          updatedAt: new Date("2026-01-02T00:00:00.000Z"),
          credential: older,
        },
      ],
      credentials: [newer, older],
    });
    expect(candidates.map((item) => item.id)).toEqual(["older", "newer"]);
  });

  it("keeps the model owner as the only default candidate", () => {
    const apiKey = credential("api", "2026-01-01T00:00:00.000Z");
    const oauth = credential("oauth", "2026-03-01T00:00:00.000Z");
    const candidates = defaultModelCredentialCandidates({
      provider: "openai-codex",
      modelId: "gpt-5.3-codex-spark",
      preferences: [
        {
          id: "pref-spark",
          modelId: "gpt-5.3-codex-spark",
          thinkingLevel: null,
          isDefault: false,
          updatedAt: new Date("2026-02-01T00:00:00.000Z"),
          credential: apiKey,
        },
        {
          id: "pref-luna",
          modelId: "gpt-6-luna",
          thinkingLevel: null,
          isDefault: true,
          updatedAt: new Date("2026-03-02T00:00:00.000Z"),
          credential: oauth,
        },
      ],
      credentials: [oauth, apiKey],
    });
    expect(candidates.map((item) => item.id)).toEqual(["api"]);
  });

  it("lists the space preference before a credential that owns another model", () => {
    const apiKey = credential("api", "2026-01-01T00:00:00.000Z");
    const oauth = credential("oauth", "2026-03-01T00:00:00.000Z");
    const candidates = defaultModelCredentialCandidates({
      provider: "openai-codex",
      modelId: "gpt-6-luna",
      preferences: [
        {
          id: "pref-spark",
          modelId: "gpt-5.3-codex-spark",
          thinkingLevel: null,
          isDefault: true,
          updatedAt: new Date("2026-02-01T00:00:00.000Z"),
          credential: apiKey,
        },
        {
          id: "pref-other",
          modelId: "gpt-5.4",
          thinkingLevel: null,
          isDefault: false,
          updatedAt: new Date("2026-03-02T00:00:00.000Z"),
          credential: oauth,
        },
      ],
      credentials: [apiKey, oauth],
    });
    expect(candidates.map((item) => item.id)).toEqual(["api", "oauth"]);
  });

  it("still offers the only credential when its preference owns a different model", () => {
    const apiKey = credential("api", "2026-01-01T00:00:00.000Z");
    const candidates = defaultModelCredentialCandidates({
      provider: "openai-codex",
      modelId: "gpt-6-luna",
      preferences: [
        {
          id: "pref-spark",
          modelId: "gpt-5.3-codex-spark",
          thinkingLevel: null,
          isDefault: true,
          updatedAt: apiKey.updatedAt,
          credential: apiKey,
        },
      ],
      credentials: [apiKey],
    });
    expect(candidates.map((item) => item.id)).toEqual(["api"]);
  });

  it("keeps the newest account credential when the space has no preference", () => {
    const older = credential("older", "2026-01-01T00:00:00.000Z");
    const newest = credential("newest", "2026-04-01T00:00:00.000Z");
    expect(
      chooseModelCredential({
        provider: "openai-codex",
        modelId: "gpt-5.3-codex-spark",
        preferences: [],
        credentials: [older, newest],
      }),
    ).toEqual({ source: "credential", credential: newest });
  });

  it("offers only the chooser's credential for an OpenAI-compatible default", () => {
    const compatible = (id: string, iso: string) => ({
      ...credential(id, iso),
      provider: "openai-compatible",
    });
    const older = compatible("older", "2026-01-01T00:00:00.000Z");
    const newer = compatible("newer", "2026-02-01T00:00:00.000Z");
    expect(
      defaultModelCredentialCandidates({
        provider: "openai-compatible",
        modelId: "unsaved-model",
        preferences: [],
        credentials: [older, newer],
      }).map((item) => item.id),
    ).toEqual(["newer"]);
    expect(
      defaultModelCredentialCandidates({
        provider: "openai-compatible",
        modelId: "unsaved-model",
        preferences: [
          {
            id: "pref-older",
            modelId: "other-model",
            thinkingLevel: null,
            isDefault: true,
            updatedAt: older.updatedAt,
            credential: older,
          },
        ],
        credentials: [older, newer],
      }).map((item) => item.id),
    ).toEqual(["older"]);
  });
});

describe("selectSpaceModelPreference", () => {
  it("clears only a different active default before selecting the credential", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const upsert = vi.fn().mockResolvedValue({ id: "preference" });
    const prisma = { spaceModelPreference: { updateMany, upsert } } as unknown as PrismaClient;

    await selectSpaceModelPreference(
      prisma,
      { userId: "user", spaceId: "space" },
      "credential",
      "model",
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        userId: "user",
        spaceId: "space",
        isDefault: true,
        credentialId: { not: "credential" },
      },
      data: { isDefault: false },
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ isDefault: true, modelId: "model" }),
        update: { isDefault: true, modelId: "model", thinkingLevel: null },
      }),
    );
  });

  it.each([null, undefined, "null", "undefined", "  null  ", ""])(
    "does not persist %j as a model id",
    async (modelId) => {
      const updateMany = vi.fn().mockResolvedValue({ count: 0 });
      const upsert = vi.fn().mockResolvedValue({ id: "preference" });
      const prisma = { spaceModelPreference: { updateMany, upsert } } as unknown as PrismaClient;

      await selectSpaceModelPreference(
        prisma,
        { userId: "user", spaceId: "space" },
        "credential",
        modelId,
      );

      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ modelId: null }),
          update: { isDefault: true, modelId: null, thinkingLevel: null },
        }),
      );
    },
  );
});

describe("compatible model references", () => {
  const at = (iso: string) => new Date(iso);
  const credentialA = {
    id: "cred-a",
    userId: "user",
    provider: "openai-compatible",
    updatedAt: at("2026-01-01T00:00:00.000Z"),
    createdAt: at("2026-01-01T00:00:00.000Z"),
  };
  const credentialB = { ...credentialA, id: "cred-b", updatedAt: at("2026-02-01T00:00:00.000Z") };

  function referenceClient() {
    const preferences = [
      {
        id: "pref-a",
        spaceId: "space-1",
        modelId: "shared-model",
        thinkingLevel: "high",
        isDefault: true,
        updatedAt: at("2026-01-02T00:00:00.000Z"),
        credential: credentialA,
      },
      {
        id: "pref-b",
        spaceId: "space-1",
        modelId: "shared-model",
        thinkingLevel: null,
        isDefault: false,
        updatedAt: at("2026-02-02T00:00:00.000Z"),
        credential: credentialB,
      },
    ];
    const tx = {
      spaceMember: {
        findMany: vi.fn().mockResolvedValue([{ spaceId: "space-1", space: { name: "Home" } }]),
      },
      spaceModelPreference: {
        findMany: vi.fn(async (args: { where: { isDefault?: boolean } }) =>
          args.where.isDefault
            ? preferences.filter((preference) => preference.isDefault)
            : preferences,
        ),
      },
      userModelCredential: { findMany: vi.fn().mockResolvedValue([credentialA, credentialB]) },
      bot: {
        findMany: vi.fn(async (args: { where: { modelProvider?: string } }) =>
          args.where.modelProvider
            ? [
                {
                  id: "bot-explicit",
                  spaceId: "space-1",
                  name: "Researcher",
                  modelId: "shared-model",
                  thinkingLevel: "xhigh",
                },
              ]
            : [{ id: "bot-follower", spaceId: "space-1", name: "Helper", thinkingLevel: "low" }],
        ),
      },
      routine: { findMany: vi.fn().mockResolvedValue([]) },
      spaceBackupModel: {
        findMany: vi.fn().mockResolvedValue([{ spaceId: "space-1", modelId: "shared-model" }]),
      },
      run: { findMany: vi.fn().mockResolvedValue([]) },
      steeringMessage: { findMany: vi.fn().mockResolvedValue([]) },
    };
    return { tx: tx as unknown as Prisma.TransactionClient, preferences };
  }

  it("collects owner references with their effective credential and exact-model effort", async () => {
    const { tx } = referenceClient();
    const { references, followers, primaryEfforts } = await loadCompatibleModelReferences(
      tx,
      "user",
    );
    expect(primaryEfforts).toEqual([
      { spaceId: "space-1", thinkingLevel: "low" },
      { spaceId: "space-1", thinkingLevel: "high" },
    ]);
    expect(references.map((reference) => [reference.kind, reference.id])).toEqual([
      ["default", "pref-a"],
      ["bot", "bot-explicit"],
      ["backup", "shared-model"],
    ]);
    expect(references[0]).toMatchObject({ name: "Home", spaceName: "Home", thinkingLevel: "high" });
    expect(followers).toEqual([
      {
        spaceId: "space-1",
        spaceName: "Home",
        id: "bot-follower",
        name: "Helper",
        thinkingLevel: "low",
      },
    ]);
    await expect(resolveCompatibleReferenceBindings(tx, "user", references)).resolves.toEqual([
      { credentialId: "cred-a", preferenceThinkingLevel: "high" },
      { credentialId: "cred-a", preferenceThinkingLevel: "high" },
      { credentialId: "cred-a", preferenceThinkingLevel: "high" },
    ]);
  });

  it("rejects a write that silently moves an explicit reference to another credential", async () => {
    const { tx, preferences } = referenceClient();
    const snapshot = await snapshotCompatibleReferenceBindings(tx, "user");
    const [defaultPreference] = preferences;
    if (defaultPreference) defaultPreference.isDefault = false;
    const rebinding = assertCompatibleReferenceBindingsUnchanged(
      tx,
      "user",
      snapshot,
      (reference) => reference.kind === "default",
    );
    await expect(rebinding).rejects.toBeInstanceOf(ModelConfigurationConflictError);
    await expect(rebinding).rejects.toMatchObject({
      reason: "model_connection_in_use",
      usages: [
        expect.objectContaining({ kind: "bot", id: "bot-explicit" }),
        expect.objectContaining({ kind: "backup", id: "shared-model" }),
      ],
    });
  });

  it("accepts a write that keeps every explicit reference on its credential", async () => {
    const { tx } = referenceClient();
    const snapshot = await snapshotCompatibleReferenceBindings(tx, "user");
    await expect(
      assertCompatibleReferenceBindingsUnchanged(tx, "user", snapshot),
    ).resolves.toBeUndefined();
  });
});
