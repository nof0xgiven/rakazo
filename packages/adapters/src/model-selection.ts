import type { AgentRunRequest, CacheCapabilities, SecretStore } from "@rakazo/adapter-kit";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { Actor, ThinkingLevel } from "@rakazo/contracts";
import { thinkingLevelsReason, usableModelId } from "@rakazo/contracts";
import {
  chooseModelCredential,
  credentialEnablesModel,
  type findDefaultModelCredential,
  findModelCredential,
  type PrismaClient,
} from "@rakazo/db";
import { openAiCompatibleModelConfig } from "./openai-compatible-models.js";
import type { ModelCredentialAuthKind } from "./pi-catalog-availability.js";
import {
  catalogModelAvailableForAuth,
  listAvailablePiCatalog,
  modelCredentialAuthKindFromPlaintext,
  UNAVAILABLE_MODEL_FOR_AUTH_MESSAGE,
} from "./pi-catalog-availability.js";
import type { CodexLiveCatalog, CodexLiveReadOptions } from "./pi-codex-catalog.js";
import { codexLiveListsModel } from "./pi-codex-catalog.js";
import { listPiCatalog, scriptedCatalogEntry } from "./pi-models.js";
import { parseModelSecret, secretValuesToRedact } from "./pi-oauth.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./pi-openai-compatible-provider.js";

type ModelCredential = Awaited<ReturnType<typeof findDefaultModelCredential>>;

export function isCatalogModelChoice(provider: string, modelId: string) {
  return [...listPiCatalog(), scriptedCatalogEntry].some(
    (item) => item.provider === provider && item.id === modelId,
  );
}

export function defaultCatalogModelId(
  provider: string,
  credentialPlaintext?: string,
): string | null {
  const authKind = credentialPlaintext
    ? modelCredentialAuthKindFromPlaintext(credentialPlaintext)
    : "disconnected";
  const authByProvider: Partial<Record<string, ModelCredentialAuthKind>> =
    authKind === "disconnected" ? {} : { [provider]: authKind };
  const entry = listAvailablePiCatalog(authByProvider).find((item) => item.provider === provider);
  return usableModelId(entry?.id);
}

export class UnavailableModelForAuthError extends Error {
  constructor(message = UNAVAILABLE_MODEL_FOR_AUTH_MESSAGE) {
    super(message);
    this.name = "UnavailableModelForAuthError";
  }
}

const CONNECT_PROVIDER_MESSAGE = "Connect that model provider first";
const UNKNOWN_MODEL_MESSAGE = "Unknown model for that provider";
const MODEL_NOT_ENABLED_MESSAGE = "This model is not enabled for the connection.";
const MODEL_NOT_CONFIGURED_MESSAGE =
  "This model's settings are missing. Open model settings to configure it.";

export type SpaceCatalogAuth = {
  byProvider: Partial<Record<string, ModelCredentialAuthKind>>;
  /** Model-specific kinds. `"disconnected"` blocks the provider fallback. */
  byModel: Partial<
    Record<string, Partial<Record<string, ModelCredentialAuthKind | "disconnected">>>
  >;
  /**
   * Secret id of the credential governing each provider/model slot, so
   * per-account lookups (like the live Codex catalog) stay keyed to the
   * credential that would actually serve the model.
   */
  secretIdByProvider: Partial<Record<string, string>>;
  secretIdByModel: Partial<Record<string, Partial<Record<string, string>>>>;
};

/**
 * Auth kinds for the credentials `chooseModelCredential` would select in this space.
 * Each catalog model uses the preference that owns that model id, then the provider
 * preference, then the newest account credential. An unreadable selected secret stays
 * disconnected instead of falling through to an older key. OpenAI-compatible
 * availability is per enabled model (`compatibleCatalogModelsForSpace`), not a
 * provider-wide auth kind.
 */
export async function modelCredentialAuthKindsForSpace(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  scope: Pick<Actor, "userId" | "spaceId">,
): Promise<SpaceCatalogAuth> {
  const [credentials, preferences] = await Promise.all([
    prisma.userModelCredential.findMany({
      where: { userId: scope.userId },
      select: {
        id: true,
        provider: true,
        secretId: true,
        updatedAt: true,
        createdAt: true,
      },
    }),
    prisma.spaceModelPreference.findMany({
      where: { userId: scope.userId, spaceId: scope.spaceId },
      select: {
        id: true,
        modelId: true,
        thinkingLevel: true,
        isDefault: true,
        updatedAt: true,
        credential: {
          select: {
            id: true,
            provider: true,
            secretId: true,
            updatedAt: true,
            createdAt: true,
          },
        },
      },
    }),
  ]);
  const connectedProviders = new Set([
    ...credentials.map((credential) => credential.provider),
    ...preferences.map((preference) => preference.credential.provider),
  ]);
  const selections: Array<{
    provider: string;
    modelId: string;
    secretId: string;
    modelSpecific: boolean;
  }> = [];
  for (const entry of listPiCatalog()) {
    if (entry.provider === OPENAI_COMPATIBLE_PROVIDER_ID) continue;
    if (!connectedProviders.has(entry.provider)) continue;
    const choice = chooseModelCredential({
      provider: entry.provider,
      modelId: entry.id,
      preferences,
      credentials,
    });
    if (!choice) continue;
    const secretId =
      choice.source === "preference"
        ? choice.preference.credential.secretId
        : choice.credential.secretId;
    const requestedModelId = usableModelId(entry.id);
    selections.push({
      provider: entry.provider,
      modelId: entry.id,
      secretId,
      modelSpecific:
        choice.source === "preference" &&
        requestedModelId !== null &&
        choice.preference.modelId === requestedModelId,
    });
  }
  const empty: SpaceCatalogAuth = {
    byProvider: {},
    byModel: {},
    secretIdByProvider: {},
    secretIdByModel: {},
  };
  if (selections.length === 0) return empty;

  const secrets = await prisma.secret.findMany({
    where: {
      id: { in: [...new Set(selections.map((selection) => selection.secretId))] },
      userId: scope.userId,
      spaceId: null,
    },
    select: { id: true, ciphertext: true },
  });
  const ciphertextById = new Map(secrets.map((secret) => [secret.id, secret.ciphertext]));
  // Every catalog model of a provider shares one secret; load each once per operation.
  const kindBySecretId = new Map<string, Promise<ModelCredentialAuthKind | undefined>>();
  const decryptKind = async (secretId: string): Promise<ModelCredentialAuthKind | undefined> => {
    const ciphertext = ciphertextById.get(secretId);
    if (!ciphertext) return undefined;
    try {
      return modelCredentialAuthKindFromPlaintext(await secretStore.load(ciphertext, secretId));
    } catch (error) {
      if (error instanceof SecretStoreUnavailableError) throw error;
      return undefined;
    }
  };
  const readKind = (secretId: string): Promise<ModelCredentialAuthKind | undefined> => {
    if (!kindBySecretId.has(secretId)) kindBySecretId.set(secretId, decryptKind(secretId));
    return kindBySecretId.get(secretId)!;
  };

  const auth: SpaceCatalogAuth = {
    byProvider: {},
    byModel: {},
    secretIdByProvider: {},
    secretIdByModel: {},
  };
  for (const selection of selections) {
    const kind = await readKind(selection.secretId);
    if (selection.modelSpecific) {
      const models = auth.byModel[selection.provider] ?? {};
      models[selection.modelId] = kind ?? "disconnected";
      auth.byModel[selection.provider] = models;
      const secrets = auth.secretIdByModel[selection.provider] ?? {};
      secrets[selection.modelId] = selection.secretId;
      auth.secretIdByModel[selection.provider] = secrets;
      continue;
    }
    if (kind) auth.byProvider[selection.provider] = kind;
    auth.secretIdByProvider[selection.provider] = selection.secretId;
  }
  return auth;
}

export function validateModelAuthAvailability(
  provider: string,
  modelId: string,
  credentialPlaintext?: string,
): string | undefined {
  if (!credentialPlaintext) return undefined;
  const authKind = modelCredentialAuthKindFromPlaintext(credentialPlaintext);
  const catalogEntry = listPiCatalog().find(
    (item) => item.provider === provider && item.id === modelId,
  );
  if (!catalogModelAvailableForAuth(provider, modelId, authKind, catalogEntry?.auth)) {
    return UNAVAILABLE_MODEL_FOR_AUTH_MESSAGE;
  }
  return undefined;
}

function modelAuthIsRestricted(provider: string, modelId: string): boolean {
  const entry = listPiCatalog().find((item) => item.provider === provider && item.id === modelId);
  if (!entry) return false;
  return (["oauth", "api_key", "openai_compatible", "disconnected"] as const).some(
    (kind) => !catalogModelAvailableForAuth(provider, modelId, kind, entry.auth),
  );
}

/**
 * Ready credential to save as the space default.
 * The first ready credential in `orderedIds` wins, unless it already stores an
 * auth-restricted model and another ready credential can take the new default.
 */
export function selectDefaultCredentialId(input: {
  provider: string;
  modelId: string;
  orderedIds: readonly string[];
  readyIds: readonly string[];
  savedModelId: (credentialId: string) => string | null | undefined;
}): string | undefined {
  const ready = new Set(input.readyIds);
  const preferred = input.orderedIds.find((id) => ready.has(id));
  if (!preferred) return undefined;
  const saved = usableModelId(input.savedModelId(preferred));
  const requested = usableModelId(input.modelId);
  if (!saved || saved === requested) return preferred;
  const alternate = input.orderedIds.find((id) => id !== preferred && ready.has(id));
  if (!alternate || !modelAuthIsRestricted(input.provider, saved)) return preferred;
  return alternate;
}

export type StoredModelAuthRead =
  | { status: "ready" }
  | { status: "unreadable" }
  | { status: "rejected"; message: string };

/** Load credential auth outside transactions; retain the ref for a transactional recheck. */
export async function prepareStoredModelAuth(
  prisma: Pick<PrismaClient, "secret">,
  secretStore: Pick<SecretStore, "load">,
  userId: string,
  secretId: string,
  provider: string,
  modelId: string,
  live?: CodexLiveCatalog,
  liveOpts?: CodexLiveReadOptions,
): Promise<{ ref: string | null; auth: StoredModelAuthRead }> {
  const secret = await prisma.secret.findFirst({
    where: { id: secretId, userId, spaceId: null },
    select: { id: true, ciphertext: true },
  });
  if (!secret) return { ref: null, auth: { status: "unreadable" } };
  let plaintext: string;
  try {
    plaintext = await secretStore.load(secret.ciphertext, secret.id);
  } catch (error) {
    if (error instanceof SecretStoreUnavailableError) throw error;
    return { ref: secret.ciphertext, auth: { status: "unreadable" } };
  }
  let message: string | undefined;
  try {
    message = validateModelAuthAvailability(provider, modelId, plaintext);
  } catch {
    // A secret that decrypts but does not parse is as unreadable as a corrupt one.
    return { ref: secret.ciphertext, auth: { status: "unreadable" } };
  }
  // validateModelAuthAvailability already parsed the secret without throwing.
  if (
    message &&
    (await codexLiveListsModel(live, userId, parseModelSecret(plaintext), modelId, liveOpts))
  ) {
    return { ref: secret.ciphertext, auth: { status: "ready" } };
  }
  return {
    ref: secret.ciphertext,
    auth: message ? { status: "rejected", message } : { status: "ready" },
  };
}

export async function readStoredModelAuth(
  ...args: Parameters<typeof prepareStoredModelAuth>
): Promise<StoredModelAuthRead> {
  return (await prepareStoredModelAuth(...args)).auth;
}

/** Readable rejection when a stored credential cannot call this catalog model. */
export async function validateStoredModelAuth(
  prisma: Pick<PrismaClient, "secret">,
  secretStore: Pick<SecretStore, "load">,
  userId: string,
  secretId: string,
  provider: string,
  modelId: string,
  live?: CodexLiveCatalog,
  liveOpts?: CodexLiveReadOptions,
): Promise<string | undefined> {
  const auth = await readStoredModelAuth(
    prisma,
    secretStore,
    userId,
    secretId,
    provider,
    modelId,
    live,
    liveOpts,
  );
  // Unreadable credentials fail when the run loads them, not as an auth mismatch.
  return auth.status === "rejected" ? auth.message : undefined;
}

/**
 * Why a connected model cannot be chosen, or undefined. OpenAI-compatible
 * membership is checked on the exact credential the chooser picks for this id,
 * before any catalog match, so a static entry such as `custom` never authorizes.
 */
export async function validateConnectedModelChoice(
  prisma: Pick<PrismaClient, "spaceModelPreference" | "userModelCredential">,
  actor: Pick<Actor, "userId" | "spaceId">,
  provider: string,
  modelId: string,
): Promise<string | undefined> {
  const compatible = provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  const credential = await findModelCredential(
    prisma,
    actor,
    provider,
    compatible ? modelId : undefined,
  );
  if (!credential) return CONNECT_PROVIDER_MESSAGE;
  if (!usableModelId(modelId)) return UNKNOWN_MODEL_MESSAGE;
  if (compatible) {
    return credentialEnablesModel(credential, modelId) ? undefined : MODEL_NOT_ENABLED_MESSAGE;
  }
  return isCatalogModelChoice(provider, modelId) ? undefined : UNKNOWN_MODEL_MESSAGE;
}

export type ModelChoice = {
  modelProvider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
};

/**
 * The model a queued run will use. `modelPinned` is the choice captured when the
 * run was created. Model columns written later only record the attempt, so a
 * routine that follows its bot still follows the bot after a resume.
 */
export function runModelChoice(
  run: ModelChoice & { modelPinned?: boolean },
  bot: ModelChoice,
): ModelChoice {
  if (run.modelPinned && run.modelProvider && usableModelId(run.modelId)) {
    return {
      modelProvider: run.modelProvider,
      modelId: run.modelId,
      thinkingLevel: run.thinkingLevel,
    };
  }
  return {
    modelProvider: bot.modelProvider,
    modelId: bot.modelId,
    thinkingLevel: bot.thinkingLevel,
  };
}

/** The model columns a routine's run starts with; empty when it follows the bot. */
export function routineRunModelPin(routine: ModelChoice): {
  modelProvider?: string;
  modelId?: string;
  thinkingLevel?: string | null;
  modelPinned?: true;
} {
  if (!routine.modelProvider || !routine.modelId) return {};
  return {
    modelProvider: routine.modelProvider,
    modelId: routine.modelId,
    thinkingLevel: routine.thinkingLevel,
    modelPinned: true,
  };
}

/** Why a pinned model cannot run on the credential that was found for it. */
export function pinnedModelCredentialError(
  choice: ModelChoice,
  credential: {
    provider: string;
    enabledModelIds: readonly string[];
    defaultModel: string | null;
  } | null,
): string | undefined {
  const modelId = usableModelId(choice.modelId);
  if (!choice.modelProvider || !modelId) return undefined;
  if (!credential) return CONNECT_PROVIDER_MESSAGE;
  if (choice.modelProvider === OPENAI_COMPATIBLE_PROVIDER_ID) {
    return credentialEnablesModel(credential, modelId) ? undefined : MODEL_NOT_ENABLED_MESSAGE;
  }
  if (!isCatalogModelChoice(choice.modelProvider, modelId) && credential.defaultModel !== modelId) {
    return UNKNOWN_MODEL_MESSAGE;
  }
  return undefined;
}

/**
 * Select configuration without loading secrets or applying a runtime-specific fallback.
 * `unavailable` is set when an explicit OpenAI-compatible choice cannot run on
 * its chosen credential; that choice never falls back to the space default.
 */
export function selectConfiguredModel(input: {
  /** The bot's or the run's own model; null follows the space default. */
  override: ModelChoice | null;
  overrideCredential: ModelCredential;
  defaultCredential: ModelCredential;
  settings: { defaultModelProvider: string | null; defaultModelId: string | null } | null;
  deployment: { provider: string; model: string } | null;
}) {
  const { override: bot, overrideCredential, defaultCredential, settings, deployment } = input;
  const hasOverride = Boolean(bot?.modelProvider && usableModelId(bot.modelId));
  const compatibleOverride = hasOverride && bot?.modelProvider === OPENAI_COMPATIBLE_PROVIDER_ID;
  // The override provider, model and credential must win together.
  const useOverride = Boolean(hasOverride && (overrideCredential || compatibleOverride));
  const credential = useOverride ? overrideCredential : defaultCredential;
  const id =
    usableModelId(useOverride ? bot!.modelId : null) ??
    usableModelId(credential?.defaultModel) ??
    (credential ? defaultCatalogModelId(credential.provider) : null) ??
    usableModelId(settings?.defaultModelId) ??
    usableModelId(deployment?.model);
  let unavailable: string | undefined;
  if (compatibleOverride) {
    if (!overrideCredential) unavailable = CONNECT_PROVIDER_MESSAGE;
    else if (!id || !credentialEnablesModel(overrideCredential, id)) {
      unavailable = MODEL_NOT_ENABLED_MESSAGE;
    }
  }
  // A preference's thinking level is bound to its stored modelId, so it only applies
  // when that model is the one being run.
  const credentialThinkingLevel =
    credential && id && credential.defaultModel === id ? credential.thinkingLevel : null;
  return {
    provider:
      (useOverride ? bot!.modelProvider : null) ??
      credential?.provider ??
      settings?.defaultModelProvider ??
      deployment?.provider,
    id,
    credential,
    // Preserve bot thinking for the Space default; drop it for an unavailable override.
    thinkingLevel:
      hasOverride && !useOverride
        ? null
        : (((bot?.thinkingLevel ??
            credentialThinkingLevel) as AgentRunRequest["model"]["thinkingLevel"]) ?? null),
    ...(unavailable ? { unavailable } : {}),
  };
}

export type CompatibleModelRuntime = {
  apiKey?: string;
  baseUrl: string;
  cacheCapabilities?: CacheCapabilities;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  thinkingLevels: ThinkingLevel[];
  defaultThinkingLevel: ThinkingLevel | null;
  acceptsImages: boolean;
  maxImagesPerPrompt?: number;
  redact: string[];
};

/**
 * Runtime settings for one OpenAI-compatible model on the exact credential the
 * chooser picked. The row is reread by its stable id so every fresh resolution
 * sees current enablement, and only that credential's own secret is loaded.
 * A missing row, disabled id or missing configuration is a terminal setup error.
 */
export async function loadCompatibleModelRuntime(
  prisma: Pick<PrismaClient, "userModelCredential" | "secret">,
  secretStore: Pick<SecretStore, "load">,
  userId: string,
  credentialId: string,
  modelId: string,
): Promise<CompatibleModelRuntime> {
  const credential = await prisma.userModelCredential.findFirst({
    where: { id: credentialId, userId, provider: OPENAI_COMPATIBLE_PROVIDER_ID },
    select: { provider: true, secretId: true, enabledModelIds: true, supportsImages: true },
  });
  if (!credential) throw new UnavailableModelForAuthError(CONNECT_PROVIDER_MESSAGE);
  if (!credentialEnablesModel(credential, modelId)) {
    throw new UnavailableModelForAuthError(MODEL_NOT_ENABLED_MESSAGE);
  }
  const row = await prisma.secret.findFirst({
    where: { id: credential.secretId, userId, spaceId: null },
    select: { id: true, ciphertext: true },
  });
  if (!row) throw new UnavailableModelForAuthError(MODEL_NOT_CONFIGURED_MESSAGE);
  const secret = parseModelSecret(await secretStore.load(row.ciphertext, row.id));
  const config =
    secret.kind === "openai_compatible"
      ? openAiCompatibleModelConfig(secret, credential, modelId)
      : undefined;
  if (secret.kind !== "openai_compatible" || !config) {
    throw new UnavailableModelForAuthError(MODEL_NOT_CONFIGURED_MESSAGE);
  }
  return {
    ...(secret.apiKey ? { apiKey: secret.apiKey } : {}),
    baseUrl: secret.baseUrl,
    ...(config.cacheCapabilities ? { cacheCapabilities: config.cacheCapabilities } : {}),
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    reasoning: thinkingLevelsReason(config.thinkingLevels),
    thinkingLevels: config.thinkingLevels,
    defaultThinkingLevel: config.defaultThinkingLevel,
    acceptsImages: config.supportsImages,
    ...(config.maxImagesPerPrompt !== undefined
      ? { maxImagesPerPrompt: config.maxImagesPerPrompt }
      : {}),
    redact: secretValuesToRedact(secret),
  };
}
