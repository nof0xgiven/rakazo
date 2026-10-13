import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import {
  assertCompatibleModelSnapshot,
  assertSupportedCompatibleEffort,
  type CodexLiveCatalog,
  CompatibleModelChoiceError,
  type CompatibleModelSnapshot,
  isCatalogModelChoice,
  listPiCatalog,
  loadCompatibleModelSnapshot,
  StaleCompatibleModelSnapshotError,
  validateConnectedModelChoice,
  validateStoredModelAuth,
} from "@rakazo/adapters";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  type ThinkingLevel,
  thinkingLevelsReason,
} from "@rakazo/contracts";
import {
  findDefaultModelCredential,
  findModelCredential,
  IsolationError,
  type Prisma,
  type PrismaClient,
} from "@rakazo/db";

type Scope = { userId: string; spaceId: string };

export type ModelChoiceDeps = {
  prisma: PrismaClient;
  secrets: Pick<SecretStore, "load">;
};

export type HostedModelAuthCheck = {
  codexCatalog: CodexLiveCatalog;
  refreshExpiredCredential: (secretId: string, provider: string) => unknown;
};

export type DeploymentDefaultModel = () => Promise<{
  provider: string | null;
  modelId: string | null;
}>;

/** Validated outside the owner lock; `assertCurrent` proves it still holds inside the lock. */
export type PreparedModelChoice = {
  thinkingLevel: ThinkingLevel | null;
  assertCurrent: (tx: Prisma.TransactionClient) => Promise<void>;
};

const alreadyCurrent = async () => {};

/** Use as `.catch(rejectModelChoice)` around a prepare/commit pair. */
export function rejectModelChoice(error: unknown): never {
  if (error instanceof CompatibleModelChoiceError) {
    throw new ORPCError("BAD_REQUEST", { message: error.message });
  }
  throw error;
}

function assertHostedEffort(
  provider: string,
  modelId: string,
  thinkingLevel: ThinkingLevel | null,
) {
  if (!thinkingLevel) return;
  const allowed = listPiCatalog().find(
    (entry) => entry.provider === provider && entry.id === modelId,
  )?.thinkingLevels;
  if (allowed && !allowed.includes(thinkingLevel)) {
    throw new ORPCError("BAD_REQUEST", {
      message: `Thinking level must be one of: ${allowed.join(", ")}`,
    });
  }
}

function compatibleChoice(
  scope: Scope,
  snapshot: CompatibleModelSnapshot,
  thinkingLevel: ThinkingLevel | null,
): PreparedModelChoice {
  assertSupportedCompatibleEffort(snapshot.config, thinkingLevel);
  return {
    thinkingLevel: thinkingLevelsReason(snapshot.config.thinkingLevels) ? thinkingLevel : null,
    assertCurrent: (tx) => assertCompatibleModelSnapshot(tx, scope, snapshot),
  };
}

/**
 * An explicit provider/model with its explicitly submitted effort. OpenAI-compatible
 * choices are authorized by enabled membership and the model's own supported levels;
 * hosted choices keep catalog validation, and an unchanged hosted model only checks effort.
 */
export async function prepareExplicitModelChoice(
  deps: ModelChoiceDeps,
  scope: Scope,
  choice: { provider: string; modelId: string; thinkingLevel: ThinkingLevel | null },
  options: { modelChanged?: boolean; hostedAuth?: HostedModelAuthCheck } = {},
): Promise<PreparedModelChoice> {
  if (choice.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
    const snapshot = await loadCompatibleModelSnapshot(
      deps.prisma,
      deps.secrets,
      scope,
      choice.modelId,
    );
    return compatibleChoice(scope, snapshot, choice.thinkingLevel);
  }
  if (options.modelChanged !== false) {
    const message = await validateConnectedModelChoice(
      deps.prisma,
      scope,
      choice.provider,
      choice.modelId,
    );
    if (message) throw new ORPCError("BAD_REQUEST", { message });
    const hostedAuth = options.hostedAuth;
    if (hostedAuth && isCatalogModelChoice(choice.provider, choice.modelId)) {
      const credential = await findModelCredential(
        deps.prisma,
        scope,
        choice.provider,
        choice.modelId,
      );
      if (!credential) {
        throw new ORPCError("BAD_REQUEST", { message: "Connect that model provider first" });
      }
      const authError = await validateStoredModelAuth(
        deps.prisma,
        deps.secrets,
        scope.userId,
        credential.secretId,
        choice.provider,
        choice.modelId,
        hostedAuth.codexCatalog,
        {
          onExpiredToken: () => {
            hostedAuth.refreshExpiredCredential(credential.secretId, choice.provider);
          },
        },
      );
      if (authError) throw new ORPCError("BAD_REQUEST", { message: authError });
    }
  }
  assertHostedEffort(choice.provider, choice.modelId, choice.thinkingLevel);
  return { thinkingLevel: choice.thinkingLevel, assertCurrent: alreadyCurrent };
}

/** Explicit effort on a bot that follows the space default is checked against that default. */
export async function prepareSpaceDefaultEffort(
  deps: ModelChoiceDeps,
  scope: Scope,
  thinkingLevel: ThinkingLevel | null,
  deploymentDefault: DeploymentDefaultModel,
): Promise<PreparedModelChoice> {
  if (!thinkingLevel) return { thinkingLevel: null, assertCurrent: alreadyCurrent };
  const observed = await findDefaultModelCredential(deps.prisma, scope);
  const observedId = observed?.id ?? null;
  const observedModelId = observed?.defaultModel ?? null;
  const assertDefaultUnchanged = async (tx: Prisma.TransactionClient) => {
    const current = await findDefaultModelCredential(tx, scope);
    if (
      (current?.id ?? null) !== observedId ||
      (current?.defaultModel ?? null) !== observedModelId
    ) {
      throw new StaleCompatibleModelSnapshotError();
    }
  };
  if (observed && observedModelId) {
    if (observed.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
      const snapshot = await loadCompatibleModelSnapshot(
        deps.prisma,
        deps.secrets,
        scope,
        observedModelId,
      );
      const prepared = compatibleChoice(scope, snapshot, thinkingLevel);
      return {
        thinkingLevel: prepared.thinkingLevel,
        assertCurrent: async (tx) => {
          await assertDefaultUnchanged(tx);
          await prepared.assertCurrent(tx);
        },
      };
    }
    assertHostedEffort(observed.provider, observedModelId, thinkingLevel);
    return { thinkingLevel, assertCurrent: assertDefaultUnchanged };
  }
  const fallback = await deploymentDefault();
  if (fallback.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
    // A deployment-only endpoint has no saved per-model levels to choose from.
    if (thinkingLevel !== "off") {
      throw new ORPCError("BAD_REQUEST", { message: "Thinking level must be one of: off" });
    }
  } else if (fallback.provider && fallback.modelId) {
    assertHostedEffort(fallback.provider, fallback.modelId, thinkingLevel);
  }
  return { thinkingLevel, assertCurrent: assertDefaultUnchanged };
}

export async function prepareRoutineModelChoice(
  deps: ModelChoiceDeps,
  scope: Scope,
  choice: {
    modelProvider: string | null;
    modelId: string | null;
    thinkingLevel: ThinkingLevel | null;
  },
  options: { modelChanged?: boolean } = {},
): Promise<PreparedModelChoice> {
  if (!choice.modelProvider || !choice.modelId) {
    return { thinkingLevel: null, assertCurrent: alreadyCurrent };
  }
  return prepareExplicitModelChoice(
    deps,
    scope,
    {
      provider: choice.modelProvider,
      modelId: choice.modelId,
      thinkingLevel: choice.thinkingLevel,
    },
    options,
  );
}

type BotModelColumns = {
  modelProvider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
};

export type BotModelUpdate = {
  data: Partial<BotModelColumns>;
  /** Present when the save changes the bot's model or effort. */
  validate?: (tx: Prisma.TransactionClient) => Promise<void>;
};

/**
 * Model columns for a bot save. Clients resend the saved model and effort on unrelated
 * saves; those are omitted so a legacy effort is neither revalidated nor rewritten.
 */
export async function prepareBotModelUpdate(
  deps: ModelChoiceDeps,
  scope: Scope,
  botId: string,
  input: {
    modelProvider?: string | null;
    modelId?: string | null;
    thinkingLevel?: ThinkingLevel | null;
  },
  options: { hostedAuth?: HostedModelAuthCheck; deploymentDefault: DeploymentDefaultModel },
): Promise<BotModelUpdate> {
  const where = { id: botId, spaceId: scope.spaceId, userId: scope.userId };
  const select = { modelProvider: true, modelId: true, thinkingLevel: true } as const;
  const existing = await deps.prisma.bot.findFirst({ where, select });
  if (!existing) throw new IsolationError();
  const settingModel = input.modelProvider !== undefined;
  const modelProvider = settingModel ? (input.modelProvider ?? null) : existing.modelProvider;
  const modelId = settingModel ? (input.modelId ?? null) : existing.modelId;
  const modelChanged = modelProvider !== existing.modelProvider || modelId !== existing.modelId;
  const effortChanged =
    input.thinkingLevel !== undefined && (input.thinkingLevel ?? null) !== existing.thinkingLevel;
  if (!modelChanged && !effortChanged) return { data: {} };
  // A thinking level belongs to a model, so changing the model resets an omitted one.
  const thinkingLevel = input.thinkingLevel ?? null;
  const prepared =
    !modelChanged && thinkingLevel === null
      ? { thinkingLevel: null, assertCurrent: alreadyCurrent }
      : modelProvider && modelId
        ? await prepareExplicitModelChoice(
            deps,
            scope,
            { provider: modelProvider, modelId, thinkingLevel },
            { modelChanged, hostedAuth: options.hostedAuth },
          )
        : await prepareSpaceDefaultEffort(deps, scope, thinkingLevel, options.deploymentDefault);
  return {
    data: {
      ...(modelChanged ? { modelProvider, modelId } : {}),
      thinkingLevel: prepared.thinkingLevel,
    },
    validate: async (tx) => {
      const current = await tx.bot.findFirst({ where, select });
      if (!current) throw new IsolationError();
      if (
        current.modelProvider !== existing.modelProvider ||
        current.modelId !== existing.modelId ||
        current.thinkingLevel !== existing.thinkingLevel
      ) {
        throw new StaleCompatibleModelSnapshotError();
      }
      await prepared.assertCurrent(tx);
    },
  };
}

/**
 * Validator for a bot created with an explicit model (duplication). OpenAI-compatible
 * models must still be enabled on the credential they resolve to; the copied effort is
 * the source bot's existing reference and is not revalidated.
 */
export async function prepareCreatedBotModel(
  deps: ModelChoiceDeps,
  scope: Scope,
  choice: { modelProvider: string | null; modelId: string | null },
) {
  const snapshot =
    choice.modelProvider === OPENAI_COMPATIBLE_PROVIDER_ID && choice.modelId
      ? await loadCompatibleModelSnapshot(deps.prisma, deps.secrets, scope, choice.modelId)
      : null;
  return async (tx: Prisma.TransactionClient, created: BotModelColumns) => {
    if (created.modelProvider !== OPENAI_COMPATIBLE_PROVIDER_ID || !created.modelId) return;
    if (!snapshot || snapshot.modelId !== created.modelId) {
      throw new StaleCompatibleModelSnapshotError();
    }
    await assertCompatibleModelSnapshot(tx, scope, snapshot);
  };
}

/** Backups that name OpenAI-compatible models must stay enabled until the list is written. */
export async function prepareCompatibleBackupModels(
  deps: ModelChoiceDeps,
  scope: Scope,
  models: ReadonlyArray<{ provider: string; modelId: string }>,
) {
  const snapshots: CompatibleModelSnapshot[] = [];
  for (const model of models) {
    if (model.provider !== OPENAI_COMPATIBLE_PROVIDER_ID) continue;
    snapshots.push(
      await loadCompatibleModelSnapshot(deps.prisma, deps.secrets, scope, model.modelId),
    );
  }
  return async (tx: Prisma.TransactionClient) => {
    for (const snapshot of snapshots) await assertCompatibleModelSnapshot(tx, scope, snapshot);
  };
}
