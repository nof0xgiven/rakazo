import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { CodexLiveCatalog } from "@rakazo/adapters";
import {
  assertCompatibleModelSnapshot,
  assertSupportedCompatibleEffort,
  buildModelConnectPlaintext,
  CompatibleModelChoiceError,
  type CompatibleModelSnapshot,
  codexLiveListsModel,
  defaultCatalogModelId,
  listPiCatalog,
  loadCompatibleModelSnapshot,
  modelCredentialDto,
  openAiCompatibleModelConfig,
  openAiCompatibleModelConfigs,
  parseModelSecret,
  persistPreparedSecret,
  prepareStoredModelAuth,
  StaleCompatibleModelSnapshotError,
  type StoredModelSecret,
  sameOpenAiCompatibleEndpoint,
  selectDefaultCredentialId,
  UNAVAILABLE_MODEL_FOR_AUTH_MESSAGE,
  validateModelAuthAvailability,
} from "@rakazo/adapters";
import type {
  ModelConfigurationUsage,
  ModelConnectInput,
  ModelCredential,
  OpenAiCompatibleModelConfig,
  ThinkingLevel,
} from "@rakazo/contracts";
import {
  effectiveThinkingLevel,
  MODEL_CONFIGURATION_CONFLICT_MESSAGES,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  usableModelId,
} from "@rakazo/contracts";
import { clampCatalogThinkingLevel } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  assertCompatibleReferenceBindingsUnchanged,
  type CompatibleModelReference,
  type CompatibleReferenceBinding,
  type DefaultFollowerBot,
  defaultModelCredentialCandidates,
  deleteUnreferencedCredentialSecret,
  findModelCredential,
  loadCompatibleModelReferences,
  ModelConfigurationConflictError,
  Prisma,
  type SpacePrimaryEffort,
  selectSpaceModelPreference,
  snapshotCompatibleReferenceBindings,
  withModelConfigurationOwnerLock,
  withTransactionRetry,
} from "@rakazo/db";

type Scope = { userId: string; spaceId: string };

export type ModelConfigurationDeps = {
  prisma: PrismaClient;
  secrets: SecretStore;
};

export function modelConfigurationChangedError() {
  return new ORPCError("CONFLICT", {
    message: MODEL_CONFIGURATION_CONFLICT_MESSAGES.model_configuration_changed,
    data: { reason: "model_configuration_changed" as const },
  });
}

/** Structured CONFLICT for clients; anything else passes through unchanged. */
export function modelConfigurationOrpcError(error: unknown): unknown {
  if (error instanceof ModelConfigurationConflictError) {
    return new ORPCError("CONFLICT", {
      message: error.message,
      data: { reason: error.reason, usages: error.usages },
    });
  }
  if (error instanceof StaleCompatibleModelSnapshotError) return modelConfigurationChangedError();
  return error;
}

function serviceErrors(error: unknown): unknown {
  if (error instanceof SecretStoreUnavailableError) {
    return new ORPCError("SERVICE_UNAVAILABLE", { cause: error });
  }
  return modelConfigurationOrpcError(error);
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new Error("Request cancelled");
}

/** `plaintext` is absent when the secret row is missing or cannot be decrypted. */
type LoadedSecret = { ciphertext: string | null; plaintext?: string };

async function loadPlaintext(
  deps: ModelConfigurationDeps,
  userId: string,
  secretId: string,
): Promise<LoadedSecret> {
  const secret = await deps.prisma.secret.findFirst({
    where: { id: secretId, userId, spaceId: null },
    select: { ciphertext: true },
  });
  if (!secret) return { ciphertext: null };
  try {
    return {
      ciphertext: secret.ciphertext,
      plaintext: await deps.secrets.load(secret.ciphertext, secretId),
    };
  } catch (error) {
    if (error instanceof SecretStoreUnavailableError) throw error;
    return { ciphertext: secret.ciphertext };
  }
}

async function assertSecretUnchanged(
  tx: Prisma.TransactionClient,
  userId: string,
  secretId: string,
  ciphertext: string | null,
) {
  const current = await tx.secret.findFirst({
    where: { id: secretId, userId, spaceId: null },
    select: { ciphertext: true },
  });
  if ((current?.ciphertext ?? null) !== ciphertext) throw modelConfigurationChangedError();
}

async function storePreparedSecret(
  deps: ModelConfigurationDeps,
  scope: Scope,
  plaintext: string,
  signal?: AbortSignal,
) {
  const stored = await deps.secrets.put(plaintext, {
    operationId: "cred",
    traceId: "cred",
    spaceId: scope.spaceId,
    userId: scope.userId,
    signal: signal ?? new AbortController().signal,
  });
  return { id: stored.id, ciphertext: stored.ciphertext };
}

async function credentialWithPreference(
  tx: Prisma.TransactionClient,
  scope: Scope,
  credential: {
    id: string;
    provider: string;
    label: string;
    supportsImages: boolean;
    enabledModelIds: string[];
    modelConfigurationVersion: number;
  },
) {
  const preference = await tx.spaceModelPreference.findUnique({
    where: {
      spaceId_userId_credentialId: {
        spaceId: scope.spaceId,
        userId: scope.userId,
        credentialId: credential.id,
      },
    },
    select: { isDefault: true, modelId: true, thinkingLevel: true },
  });
  return {
    ...credential,
    isDefault: preference?.isDefault ?? false,
    defaultModel: usableModelId(preference?.modelId),
    thinkingLevel: preference?.thinkingLevel ?? null,
  };
}

/**
 * Whether a capability change drops a level a reference executed with.
 * Equal supported sets are never a reduction, so legacy raw efforts that Pi
 * already clamped keep running after canonical adoption. Without its own
 * effort or model default, a reference runs `inherited` (a backup receives
 * each primary's requested effort) or Pi's default, clamped by Pi.
 */
function removesExecutedEffort(
  prior: OpenAiCompatibleModelConfig,
  next: OpenAiCompatibleModelConfig,
  preferred: ThinkingLevel | null,
  inherited: readonly ThinkingLevel[],
) {
  const { thinkingLevels: before } = prior;
  const { thinkingLevels: after } = next;
  if (before.length === after.length && before.every((level) => after.includes(level)))
    return false;
  const own = preferred ?? prior.defaultThinkingLevel;
  const requested = own ? [own] : [null, ...inherited];
  return requested.some((level) => !after.includes(effectiveThinkingLevel(before, level, null)));
}

function followerUsage(follower: DefaultFollowerBot, modelId: string): ModelConfigurationUsage {
  return {
    kind: "bot",
    spaceId: follower.spaceId,
    spaceName: follower.spaceName,
    id: follower.id,
    name: follower.name,
    modelId,
    thinkingLevel: follower.thinkingLevel,
  };
}

type CompatibleConfiguration = {
  enabledModelIds: readonly string[];
  /** Null when the previous secret could not be read. */
  configs: ReadonlyMap<string, OpenAiCompatibleModelConfig> | null;
};

/**
 * Blockers for replacing one credential's configuration. Only references that
 * resolve to that credential and name a model it enabled count; a never-enabled
 * legacy reference keeps failing at execution instead of blocking edits.
 */
export function compatibleConfigurationConflict(input: {
  credentialId: string;
  references: readonly CompatibleModelReference[];
  bindings: readonly CompatibleReferenceBinding[];
  followers: readonly DefaultFollowerBot[];
  primaryEfforts: readonly SpacePrimaryEffort[];
  before: CompatibleConfiguration;
  after: {
    enabledModelIds: readonly string[];
    configs: ReadonlyMap<string, OpenAiCompatibleModelConfig>;
  };
  endpointChanged: boolean;
}): ModelConfigurationConflictError | null {
  const previous = new Set(input.before.enabledModelIds);
  const next = new Set(input.after.enabledModelIds);
  const connection: ModelConfigurationUsage[] = [];
  const removed: ModelConfigurationUsage[] = [];
  const effort: ModelConfigurationUsage[] = [];
  const reduced = (
    modelId: string,
    preferred: ThinkingLevel | null,
    inherited: readonly ThinkingLevel[] = [],
  ) => {
    const prior = input.before.configs?.get(modelId);
    const updated = input.after.configs.get(modelId);
    return Boolean(prior && updated && removesExecutedEffort(prior, updated, preferred, inherited));
  };
  input.references.forEach((reference, index) => {
    const binding = input.bindings[index];
    if (binding?.credentialId !== input.credentialId || !previous.has(reference.modelId)) return;
    if (input.endpointChanged) {
      connection.push(reference);
    } else if (!next.has(reference.modelId)) {
      removed.push(reference);
    } else if (
      reference.kind === "backup"
        ? reduced(
            reference.modelId,
            binding.preferenceThinkingLevel,
            input.primaryEfforts
              .filter((primary) => primary.spaceId === reference.spaceId)
              .map((primary) => primary.thinkingLevel),
          )
        : reduced(reference.modelId, reference.thinkingLevel ?? binding.preferenceThinkingLevel)
    ) {
      effort.push(reference);
    }
    if (reference.kind !== "default" || input.endpointChanged || !next.has(reference.modelId))
      return;
    for (const follower of input.followers) {
      if (
        follower.spaceId === reference.spaceId &&
        reduced(reference.modelId, follower.thinkingLevel)
      ) {
        effort.push(followerUsage(follower, reference.modelId));
      }
    }
  });
  if (connection.length > 0) {
    return new ModelConfigurationConflictError("model_connection_in_use", connection);
  }
  if (removed.length > 0) return new ModelConfigurationConflictError("models_in_use", removed);
  if (effort.length > 0) return new ModelConfigurationConflictError("model_effort_in_use", effort);
  return null;
}

/** Explicit efforts of bots following the space default must be supported by the new default. */
export function defaultFollowerConflict(
  followers: readonly DefaultFollowerBot[],
  proposed: { modelId: string; thinkingLevels: readonly string[] | undefined },
): ModelConfigurationConflictError | null {
  const supported = proposed.thinkingLevels;
  if (!supported) return null;
  const blocked = followers.filter((follower) => !supported.includes(follower.thinkingLevel));
  if (blocked.length === 0) return null;
  return new ModelConfigurationConflictError(
    "model_effort_in_use",
    blocked.map((follower) => followerUsage(follower, proposed.modelId)),
    MODEL_CONFIGURATION_CONFLICT_MESSAGES.model_default_effort_in_use,
  );
}

/** Compatible references of the actor's space, their bindings, and its compatible default if any. */
async function loadSpaceGuardState(tx: Prisma.TransactionClient, scope: Scope) {
  const { references, followers } = await loadCompatibleModelReferences(tx, scope.userId, {
    spaceIds: [scope.spaceId],
  });
  const snapshot = await snapshotCompatibleReferenceBindings(tx, scope.userId, { references });
  const defaultIndex = references.findIndex((reference) => reference.kind === "default");
  return {
    followers,
    snapshot,
    compatibleDefault:
      defaultIndex < 0
        ? null
        : {
            modelId: references[defaultIndex]?.modelId,
            credentialId: snapshot.bindings[defaultIndex]?.credentialId ?? null,
          },
  };
}

const excludeSpaceDefault = (scope: Scope) => (reference: CompatibleModelReference) =>
  reference.kind === "default" && reference.spaceId === scope.spaceId;

function configMap(configs: readonly OpenAiCompatibleModelConfig[]) {
  return new Map(configs.map((config) => [config.modelId, config]));
}

type PreparedCompatibleConnect = {
  plaintext: string;
  baseUrl: string;
  previous: {
    credentialId: string;
    secretId: string;
    ciphertext: string | null;
    version: number;
    configuration: CompatibleConfiguration;
    baseUrl: string | null;
  } | null;
};

async function prepareCompatibleConnect(
  deps: ModelConfigurationDeps,
  scope: Scope,
  input: ModelConnectInput,
): Promise<PreparedCompatibleConnect> {
  let previous: PreparedCompatibleConnect["previous"] = null;
  let previousPlaintext: string | undefined;
  if (input.credentialId !== undefined) {
    const credential = await deps.prisma.userModelCredential.findFirst({
      where: {
        id: input.credentialId,
        userId: scope.userId,
        provider: OPENAI_COMPATIBLE_PROVIDER_ID,
      },
    });
    if (
      !credential ||
      credential.modelConfigurationVersion !== input.expectedConfigurationVersion
    ) {
      throw modelConfigurationChangedError();
    }
    const loaded = await loadPlaintext(deps, scope.userId, credential.secretId);
    previousPlaintext = loaded.plaintext;
    let saved: StoredModelSecret | undefined;
    try {
      saved = loaded.plaintext === undefined ? undefined : parseModelSecret(loaded.plaintext);
    } catch {
      saved = undefined;
    }
    const compatible = saved?.kind === "openai_compatible" ? saved : undefined;
    previous = {
      credentialId: credential.id,
      secretId: credential.secretId,
      ciphertext: loaded.ciphertext,
      version: credential.modelConfigurationVersion,
      baseUrl: compatible?.baseUrl ?? null,
      configuration: {
        enabledModelIds: credential.enabledModelIds,
        configs: compatible
          ? configMap(
              openAiCompatibleModelConfigs(compatible, {
                enabledModelIds: credential.enabledModelIds,
                supportsImages: credential.supportsImages,
              }),
            )
          : null,
      },
    };
  } else {
    const existing = await deps.prisma.userModelCredential.findFirst({
      where: { userId: scope.userId, provider: OPENAI_COMPATIBLE_PROVIDER_ID },
      select: { id: true },
    });
    if (existing) throw modelConfigurationChangedError();
  }
  let plaintext: string;
  let baseUrl: string;
  try {
    plaintext = buildModelConnectPlaintext(
      input,
      previousPlaintext,
      previous ? { previousEnabledModelIds: previous.configuration.enabledModelIds } : undefined,
    );
    const written = parseModelSecret(plaintext);
    if (written.kind !== "openai_compatible") throw new Error("Invalid model connection");
    baseUrl = written.baseUrl;
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "Invalid model connection",
    });
  }
  return { plaintext, baseUrl, previous };
}

/**
 * Saves the complete enabled set of an OpenAI-compatible connection. Creating
 * one writes its explicit initial default; editing one preserves every
 * preference and default and must name the version it last read.
 */
export async function connectOpenAiCompatible(
  deps: ModelConfigurationDeps,
  scope: Scope,
  input: ModelConnectInput,
  signal?: AbortSignal,
): Promise<ModelCredential> {
  let prepared: PreparedCompatibleConnect;
  try {
    prepared = await prepareCompatibleConnect(deps, scope, input);
  } catch (error) {
    throw serviceErrors(error);
  }
  const models = input.models ?? [];
  const enabledModelIds = models.map((model) => model.modelId);
  const { previous } = prepared;
  throwIfAborted(signal);
  const written = await storePreparedSecret(deps, scope, prepared.plaintext, signal);
  throwIfAborted(signal);
  const row = await persistPreparedSecret(deps.prisma, deps.secrets, written, () =>
    withModelConfigurationOwnerLock(deps.prisma, scope.userId, async (tx) => {
      const credentials = await tx.userModelCredential.findMany({
        where: { userId: scope.userId, provider: OPENAI_COMPATIBLE_PROVIDER_ID },
      });
      const existing = previous
        ? credentials.find((credential) => credential.id === previous.credentialId)
        : undefined;
      if (previous) {
        if (
          !existing ||
          existing.modelConfigurationVersion !== previous.version ||
          existing.secretId !== previous.secretId
        ) {
          throw modelConfigurationChangedError();
        }
        await assertSecretUnchanged(tx, scope.userId, previous.secretId, previous.ciphertext);
      } else if (credentials.length > 0) {
        throw modelConfigurationChangedError();
      }
      throwIfAborted(signal);
      const { references, followers, primaryEfforts } = await loadCompatibleModelReferences(
        tx,
        scope.userId,
      );
      const snapshot = await snapshotCompatibleReferenceBindings(tx, scope.userId, { references });
      if (previous) {
        const conflict = compatibleConfigurationConflict({
          credentialId: previous.credentialId,
          references,
          bindings: snapshot.bindings,
          followers,
          primaryEfforts,
          before: previous.configuration,
          after: { enabledModelIds, configs: configMap(models) },
          endpointChanged:
            previous.baseUrl !== null &&
            !sameOpenAiCompatibleEndpoint(previous.baseUrl, prepared.baseUrl),
        });
        if (conflict) throw conflict;
      } else {
        const initial = models.find((model) => model.modelId === input.modelId);
        const conflict = defaultFollowerConflict(
          followers.filter((follower) => follower.spaceId === scope.spaceId),
          { modelId: input.modelId ?? "", thinkingLevels: initial?.thinkingLevels ?? [] },
        );
        if (conflict) throw conflict;
      }
      await tx.secret.create({
        data: {
          id: written.id,
          userId: scope.userId,
          spaceId: null,
          kind: "model",
          ciphertext: written.ciphertext,
        },
      });
      const credential = existing
        ? await tx.userModelCredential.update({
            where: { id: existing.id },
            data: {
              label: input.label ?? existing.label,
              secretId: written.id,
              enabledModelIds,
              modelConfigurationVersion: { increment: 1 },
            },
          })
        : await tx.userModelCredential.create({
            data: {
              userId: scope.userId,
              provider: OPENAI_COMPATIBLE_PROVIDER_ID,
              label: input.label ?? OPENAI_COMPATIBLE_PROVIDER_ID,
              secretId: written.id,
              enabledModelIds,
            },
          });
      if (existing) {
        await deleteUnreferencedCredentialSecret(tx, {
          credentialKind: "model",
          credentialId: existing.id,
          secretId: existing.secretId,
        });
      } else {
        await selectSpaceModelPreference(
          tx,
          scope,
          credential.id,
          input.modelId,
          input.thinkingLevel ?? null,
        );
      }
      await assertCompatibleReferenceBindingsUnchanged(
        tx,
        scope.userId,
        snapshot,
        existing ? undefined : excludeSpaceDefault(scope),
      );
      throwIfAborted(signal);
      return credentialWithPreference(tx, scope, credential);
    }),
  ).catch((error: unknown) => {
    throw serviceErrors(error);
  });
  return modelCredentialDto(row, prepared.plaintext);
}

function hostedThinkingLevels(provider: string, modelId: string): string[] | undefined {
  return listPiCatalog().find((item) => item.provider === provider && item.id === modelId)
    ?.thinkingLevels;
}

type HostedPersistInput = {
  provider: string;
  plaintext: string;
  label?: string;
  modelId?: string;
  thinkingLevel?: string | null;
  signal?: AbortSignal;
  /**
   * Credential whose secret the plaintext was built from: `null` when none
   * existed, omitted when the chooser picks the credential inside the lock.
   */
  previous?: { credentialId: string; secretId: string; ciphertext: string | null } | null;
};

/**
 * Hosted connect and OAuth completion. The credential written is exactly the
 * one prepared (or chosen under the owner lock), and the space default it
 * selects must not rebind any compatible reference.
 */
export async function persistHostedModelCredential(
  deps: ModelConfigurationDeps & { env: { defaultModel: string } },
  scope: Scope,
  input: HostedPersistInput,
  codexCatalog: CodexLiveCatalog,
): Promise<ModelCredential> {
  throwIfAborted(input.signal);
  const requestedModelId = usableModelId(input.modelId);
  const authError = requestedModelId
    ? validateModelAuthAvailability(input.provider, requestedModelId, input.plaintext)
    : undefined;
  // The backend's live catalog can clear a static OAuth exclusion for the
  // account this credential signs into (e.g. Codex Spark on ChatGPT plans).
  if (
    authError &&
    requestedModelId &&
    !(await codexLiveListsModel(
      codexCatalog,
      scope.userId,
      parseModelSecret(input.plaintext),
      requestedModelId,
    ))
  ) {
    throw new ORPCError("BAD_REQUEST", { message: authError });
  }
  const defaultModel =
    requestedModelId ??
    defaultCatalogModelId(input.provider, input.plaintext) ??
    usableModelId(deps.env.defaultModel);
  const allowedThinking = defaultModel
    ? hostedThinkingLevels(input.provider, defaultModel)
    : undefined;
  const written = await storePreparedSecret(deps, scope, input.plaintext, input.signal);
  throwIfAborted(input.signal);
  const row = await persistPreparedSecret(deps.prisma, deps.secrets, written, () =>
    withModelConfigurationOwnerLock(deps.prisma, scope.userId, async (tx) => {
      throwIfAborted(input.signal);
      let existing: { id: string; secretId: string; label: string } | null;
      if (input.previous === undefined) {
        existing = await findModelCredential(tx, scope, input.provider);
      } else if (input.previous === null) {
        if (await findModelCredential(tx, scope, input.provider))
          throw modelConfigurationChangedError();
        existing = null;
      } else {
        existing = await tx.userModelCredential.findFirst({
          where: {
            id: input.previous.credentialId,
            userId: scope.userId,
            provider: input.provider,
          },
        });
        if (!existing || existing.secretId !== input.previous.secretId) {
          throw modelConfigurationChangedError();
        }
        await assertSecretUnchanged(tx, scope.userId, existing.secretId, input.previous.ciphertext);
      }
      const guard = await loadSpaceGuardState(tx, scope);
      await tx.secret.create({
        data: {
          id: written.id,
          userId: scope.userId,
          spaceId: null,
          kind: "model",
          ciphertext: written.ciphertext,
        },
      });
      throwIfAborted(input.signal);
      const credential = existing
        ? await tx.userModelCredential.update({
            where: { id: existing.id },
            data: { label: input.label ?? input.provider, secretId: written.id },
          })
        : await tx.userModelCredential.create({
            data: {
              userId: scope.userId,
              provider: input.provider,
              label: input.label ?? input.provider,
              secretId: written.id,
            },
          });
      let thinkingLevel = input.thinkingLevel;
      if (thinkingLevel === undefined) {
        // A stored effort only carries over while it still names this model.
        const previous = await tx.spaceModelPreference.findFirst({
          where: { spaceId: scope.spaceId, userId: scope.userId, credentialId: credential.id },
          select: { modelId: true, thinkingLevel: true },
        });
        thinkingLevel =
          previous?.modelId === usableModelId(defaultModel) ? previous.thinkingLevel : null;
      }
      thinkingLevel = defaultModel
        ? clampCatalogThinkingLevel(thinkingLevel, allowedThinking)
        : null;
      if (guard.compatibleDefault && defaultModel) {
        const conflict = defaultFollowerConflict(guard.followers, {
          modelId: defaultModel,
          thinkingLevels: allowedThinking,
        });
        if (conflict) throw conflict;
      }
      await selectSpaceModelPreference(tx, scope, credential.id, defaultModel, thinkingLevel);
      throwIfAborted(input.signal);
      if (existing) {
        await deleteUnreferencedCredentialSecret(tx, {
          credentialKind: "model",
          credentialId: existing.id,
          secretId: existing.secretId,
        });
      }
      await assertCompatibleReferenceBindingsUnchanged(
        tx,
        scope.userId,
        guard.snapshot,
        excludeSpaceDefault(scope),
      );
      return { ...credential, isDefault: true, defaultModel, thinkingLevel };
    }),
  ).catch((error: unknown) => {
    throw serviceErrors(error);
  });
  return modelCredentialDto(row, input.plaintext);
}

/** Hosted connect: build from the chooser's credential, then persist exactly that one. */
export async function connectHostedModel(
  deps: ModelConfigurationDeps & { env: { defaultModel: string } },
  scope: Scope,
  input: ModelConnectInput,
  codexCatalog: CodexLiveCatalog,
  signal?: AbortSignal,
): Promise<ModelCredential> {
  let plaintext: string;
  let previous: HostedPersistInput["previous"] = null;
  try {
    let previousPlaintext: string | undefined;
    const credential = await findModelCredential(deps.prisma, scope, input.provider);
    if (credential) {
      const secret = await deps.prisma.secret.findFirst({
        where: { id: credential.secretId, userId: scope.userId, spaceId: null },
        select: { ciphertext: true },
      });
      previous = {
        credentialId: credential.id,
        secretId: credential.secretId,
        ciphertext: secret?.ciphertext ?? null,
      };
      if (secret) {
        try {
          previousPlaintext = await deps.secrets.load(secret.ciphertext, credential.secretId);
        } catch (error) {
          // Explicit key replacement must still succeed when the prior ciphertext is unreadable.
          if (input.apiKey === undefined) throw error;
        }
      }
    }
    plaintext = buildModelConnectPlaintext(input, previousPlaintext);
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "Invalid model connection",
    });
  }
  return persistHostedModelCredential(
    deps,
    scope,
    {
      provider: input.provider,
      plaintext,
      label: input.label,
      modelId: input.modelId,
      thinkingLevel: input.thinkingLevel,
      signal,
      previous,
    },
    codexCatalog,
  );
}

async function setCompatibleDefault(
  deps: ModelConfigurationDeps,
  scope: Scope,
  input: { modelId: string; thinkingLevel?: ThinkingLevel | null },
) {
  let snapshot: CompatibleModelSnapshot;
  try {
    snapshot = await loadCompatibleModelSnapshot(deps.prisma, deps.secrets, scope, input.modelId);
    assertSupportedCompatibleEffort(snapshot.config, input.thinkingLevel);
  } catch (error) {
    if (error instanceof CompatibleModelChoiceError) {
      if (error.problem === "not_connected") {
        throw new ORPCError("NOT_FOUND", {
          message: `No model credential is connected for ${OPENAI_COMPATIBLE_PROVIDER_ID}.`,
        });
      }
      throw new ORPCError("BAD_REQUEST", { message: error.message });
    }
    throw serviceErrors(error);
  }
  await withModelConfigurationOwnerLock(deps.prisma, scope.userId, async (tx) => {
    await assertCompatibleModelSnapshot(tx, scope, snapshot);
    const guard = await loadSpaceGuardState(tx, scope);
    let thinkingLevel: string | null | undefined = input.thinkingLevel;
    if (thinkingLevel === undefined) {
      // The level belongs to the preference's modelId — keep it only when the
      // stored choice already names this model.
      const existing = await tx.spaceModelPreference.findUnique({
        where: {
          spaceId_userId_credentialId: {
            spaceId: scope.spaceId,
            userId: scope.userId,
            credentialId: snapshot.credentialId,
          },
        },
        select: { modelId: true, thinkingLevel: true },
      });
      thinkingLevel =
        usableModelId(existing?.modelId) === input.modelId
          ? (existing?.thinkingLevel ?? null)
          : null;
    }
    const unchanged =
      guard.compatibleDefault?.credentialId === snapshot.credentialId &&
      guard.compatibleDefault.modelId === input.modelId;
    if (!unchanged) {
      const conflict = defaultFollowerConflict(guard.followers, {
        modelId: input.modelId,
        thinkingLevels: snapshot.config.thinkingLevels,
      });
      if (conflict) throw conflict;
    }
    await selectSpaceModelPreference(
      tx,
      scope,
      snapshot.credentialId,
      input.modelId,
      thinkingLevel,
    );
    await assertCompatibleReferenceBindingsUnchanged(
      tx,
      scope.userId,
      guard.snapshot,
      excludeSpaceDefault(scope),
    );
  }).catch((error: unknown) => {
    throw serviceErrors(error);
  });
}

async function setHostedDefault(
  deps: ModelConfigurationDeps,
  scope: Scope,
  input: { provider: string; modelId: string; thinkingLevel?: ThinkingLevel | null },
  codexCatalog: CodexLiveCatalog,
  onExpiredToken: (secretId: string) => void,
) {
  const loadSpaceModelState = async (
    client: Pick<PrismaClient, "spaceModelPreference" | "userModelCredential">,
  ) => {
    const [preferences, credentials] = await Promise.all([
      client.spaceModelPreference.findMany({
        where: {
          spaceId: scope.spaceId,
          userId: scope.userId,
          credential: { provider: input.provider },
        },
        include: { credential: true },
      }),
      client.userModelCredential.findMany({
        where: { userId: scope.userId, provider: input.provider },
      }),
    ]);
    return {
      preferences,
      candidates: defaultModelCredentialCandidates({
        provider: input.provider,
        modelId: input.modelId,
        preferences,
        credentials,
      }),
    };
  };
  const preparedState = await loadSpaceModelState(deps.prisma);
  const preparedAuth = new Map(
    await Promise.all(
      preparedState.candidates.map(
        async (candidate) =>
          [
            candidate.secretId,
            await prepareStoredModelAuth(
              deps.prisma,
              deps.secrets,
              scope.userId,
              candidate.secretId,
              input.provider,
              input.modelId,
              codexCatalog,
              { onExpiredToken: () => onExpiredToken(candidate.secretId) },
            ),
          ] as const,
      ),
    ),
  );
  const allowed = hostedThinkingLevels(input.provider, input.modelId);
  await withModelConfigurationOwnerLock(deps.prisma, scope.userId, async (tx) => {
    const { preferences, candidates } = await loadSpaceModelState(tx);
    if (candidates.length === 0) {
      throw new ORPCError("NOT_FOUND", {
        message: `No model credential is connected for ${input.provider}.`,
      });
    }
    const savedModelId = new Map(
      preferences.map((preference) => [preference.credential.id, preference.modelId]),
    );
    const readyIds: string[] = [];
    let authFailure: string | undefined;
    let sawReadable = false;
    for (const candidate of candidates) {
      const prepared = preparedAuth.get(candidate.secretId);
      if (!prepared) throw modelConfigurationChangedError();
      await assertSecretUnchanged(tx, scope.userId, candidate.secretId, prepared.ref);
      const auth = prepared.auth;
      if (auth.status === "unreadable") continue;
      sawReadable = true;
      if (auth.status === "rejected") {
        authFailure ??= auth.message;
        continue;
      }
      readyIds.push(candidate.id);
    }
    const chosenId = selectDefaultCredentialId({
      provider: input.provider,
      modelId: input.modelId,
      orderedIds: candidates.map((candidate) => candidate.id),
      readyIds,
      savedModelId: (credentialId) => savedModelId.get(credentialId),
    });
    const credentialId = chosenId ?? (!sawReadable ? candidates[0]?.id : undefined);
    if (!credentialId) {
      throw new ORPCError("BAD_REQUEST", {
        message: authFailure ?? UNAVAILABLE_MODEL_FOR_AUTH_MESSAGE,
      });
    }
    let thinkingLevel: string | null | undefined = input.thinkingLevel;
    if (thinkingLevel === undefined) {
      // The level belongs to the preference's modelId — keep it only when the
      // stored choice already names this model.
      const existing = preferences.find((preference) => preference.credential.id === credentialId);
      thinkingLevel =
        existing?.modelId === usableModelId(input.modelId) ? existing.thinkingLevel : null;
    }
    if (thinkingLevel) thinkingLevel = clampCatalogThinkingLevel(thinkingLevel, allowed);
    const guard = await loadSpaceGuardState(tx, scope);
    if (guard.compatibleDefault) {
      const conflict = defaultFollowerConflict(guard.followers, {
        modelId: input.modelId,
        thinkingLevels: allowed,
      });
      if (conflict) throw conflict;
    }
    await selectSpaceModelPreference(tx, scope, credentialId, input.modelId, thinkingLevel);
    await assertCompatibleReferenceBindingsUnchanged(
      tx,
      scope.userId,
      guard.snapshot,
      excludeSpaceDefault(scope),
    );
  }).catch((error: unknown) => {
    throw serviceErrors(error);
  });
}

export async function setModelDefault(
  deps: ModelConfigurationDeps,
  scope: Scope,
  input: { provider: string; modelId: string; thinkingLevel?: ThinkingLevel | null },
  codexCatalog: CodexLiveCatalog,
  onExpiredToken: (secretId: string) => void,
): Promise<void> {
  try {
    if (input.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
      await setCompatibleDefault(deps, scope, input);
    } else {
      await setHostedDefault(deps, scope, input, codexCatalog, onExpiredToken);
    }
  } catch (error) {
    throw serviceErrors(error);
  }
}

/**
 * Removes every connection of a provider account-wide. For OpenAI-compatible
 * connections, explicit references block the removal before anything is
 * deleted; the space default is exempt because it is deleted with the
 * connection and its followers fall back to setup.
 */
export async function disconnectModelProvider(
  deps: Pick<ModelConfigurationDeps, "prisma">,
  userId: string,
  provider: string,
): Promise<void> {
  const remove = async (tx: Prisma.TransactionClient) => {
    const existing = await tx.userModelCredential.findMany({ where: { userId, provider } });
    if (provider === OPENAI_COMPATIBLE_PROVIDER_ID && existing.length > 0) {
      const enabled = new Map(existing.map((row) => [row.id, new Set(row.enabledModelIds)]));
      const { references, bindings } = await snapshotCompatibleReferenceBindings(tx, userId);
      const blockers = references.filter((reference, index) => {
        const credentialId = bindings[index]?.credentialId;
        return (
          reference.kind !== "default" &&
          credentialId !== null &&
          credentialId !== undefined &&
          enabled.get(credentialId)?.has(reference.modelId) === true
        );
      });
      if (blockers.length > 0) {
        throw new ModelConfigurationConflictError("models_in_use", blockers);
      }
    }
    await tx.spaceBackupModel.deleteMany({ where: { userId, provider } });
    if (existing.length === 0) return;
    const ids = existing.map((row) => row.id);
    // Credentials belong to the account, not the space — disconnecting
    // removes them everywhere. Linked preferences in other spaces go with
    // their credential.
    await tx.spaceModelPreference.deleteMany({ where: { userId, credentialId: { in: ids } } });
    await tx.userModelCredential.deleteMany({ where: { userId, id: { in: ids } } });
    for (const row of existing) {
      await deleteUnreferencedCredentialSecret(tx, {
        credentialKind: "model",
        credentialId: row.id,
        secretId: row.secretId,
      });
    }
  };
  if (provider !== OPENAI_COMPATIBLE_PROVIDER_ID) {
    await withTransactionRetry(() =>
      deps.prisma.$transaction(remove, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      }),
    );
    return;
  }
  await withModelConfigurationOwnerLock(deps.prisma, userId, remove).catch((error: unknown) => {
    throw modelConfigurationOrpcError(error);
  });
}

/**
 * An explicitly selected OpenAI-compatible default is ready only when that
 * model is enabled and configured on its credential. Secret-store outages do
 * not flip readiness; membership alone decides then.
 */
export async function compatibleDefaultReady(
  deps: ModelConfigurationDeps,
  userId: string,
  credential: {
    secretId: string;
    defaultModel: string | null;
    enabledModelIds: string[];
    supportsImages: boolean;
  },
): Promise<boolean> {
  const modelId = credential.defaultModel;
  if (!modelId || !credential.enabledModelIds.includes(modelId)) return false;
  let loaded: LoadedSecret;
  try {
    loaded = await loadPlaintext(deps, userId, credential.secretId);
  } catch (error) {
    if (error instanceof SecretStoreUnavailableError) return true;
    throw error;
  }
  if (loaded.plaintext === undefined) return false;
  try {
    const parsed = parseModelSecret(loaded.plaintext);
    return (
      parsed.kind === "openai_compatible" &&
      openAiCompatibleModelConfig(parsed, credential, modelId) !== undefined
    );
  } catch {
    return false;
  }
}
