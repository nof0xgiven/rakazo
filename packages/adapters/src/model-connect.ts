import type {
  ModelConnectInput,
  ModelCredential,
  OpenAiCompatibleModelConfig,
} from "@rakazo/contracts";
import {
  CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE,
  cloudflareGatewayRouting,
  isCloudflareAiGatewayProvider,
  MAX_OPENAI_COMPATIBLE_ENABLED_MODELS,
  modelOutputLeavesInputRoom,
  OPENAI_COMPATIBLE_MODEL_ID_MAX_LENGTH,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  ThinkingLevelSchema,
} from "@rakazo/contracts";
import { sameOpenAiCompatibleEndpoint } from "./openai-compatible-discovery.js";
import { openAiCompatibleModelConfigs } from "./openai-compatible-models.js";
import { modelCredentialAuthKind } from "./pi-catalog-availability.js";
import {
  CHATGPT_OAUTH_PROVIDER,
  type OpenAiCompatibleStoredSecret,
  parseModelSecret,
  type StoredModelSecret,
  serializeModelSecret,
} from "./pi-oauth.js";
import { prepareOpenAiCompatibleConnect } from "./pi-openai-compatible-provider.js";

export type BuildModelConnectOptions = {
  /** Allowlist of the OpenAI-compatible connection being edited; omitted when creating one. */
  previousEnabledModelIds?: readonly string[];
};

export const UNREADABLE_COMPATIBLE_CONNECTION_MESSAGE =
  "The saved connection can't be read. Enter its API key again, or remove the saved key.";

export function buildModelConnectPlaintext(
  input: ModelConnectInput,
  previousPlaintext?: string,
  options?: BuildModelConnectOptions,
): string {
  const previous = tryParseModelSecret(previousPlaintext);
  if (input.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
    return buildOpenAiCompatiblePlaintext(input, previous, options?.previousEnabledModelIds);
  }
  const inherited = previous?.kind === "api_key" ? previous : undefined;
  const cacheCapabilities = input.cacheCapabilities ?? inherited?.cacheCapabilities;
  const contextWindow = input.contextWindow ?? inherited?.contextWindow;
  const limits = {
    ...(cacheCapabilities !== undefined ? { cacheCapabilities } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
  const apiKey = input.apiKey?.trim();
  // The Codex transport authenticates with the OAuth JWT from ChatGPT sign-in,
  // which carries the chatgpt account id it requires. A plain API key can never
  // work there, so reject it instead of persisting a credential that only fails
  // at request time.
  if (input.provider === CHATGPT_OAUTH_PROVIDER && apiKey) {
    throw new Error(CHATGPT_SUBSCRIPTION_REQUIRED_MESSAGE);
  }
  const maxTokens = connectMaxTokens(
    input.maxTokens,
    previous && previous.kind !== "openai_compatible" ? previous.maxTokens : undefined,
  );
  if (!modelOutputLeavesInputRoom(maxTokens, contextWindow)) {
    throw new Error("Maximum output tokens must leave room for input");
  }
  const routing = cloudflareRoutingForConnect(input, previous);
  if (apiKey) {
    if (apiKey.length < 8) throw new Error("API key must contain at least 8 characters");
    return serializeModelSecret({
      kind: "api_key",
      key: apiKey,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...limits,
      ...routing,
    });
  }
  if (previous?.kind === "api_key" && previous.key.trim().length >= 8) {
    if (input.provider === CHATGPT_OAUTH_PROVIDER) {
      throw new Error(CHATGPT_SUBSCRIPTION_REQUIRED_MESSAGE);
    }
    return serializeModelSecret({
      kind: "api_key",
      key: previous.key,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...limits,
      ...routing,
    });
  }
  if (previous?.kind === "oauth") {
    return serializeModelSecret({
      kind: "oauth",
      credential: previous.credential,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    });
  }
  if (input.provider === CHATGPT_OAUTH_PROVIDER) {
    throw new Error(CHATGPT_SUBSCRIPTION_REQUIRED_MESSAGE);
  }
  throw new Error("API key must contain at least 8 characters");
}

const CHATGPT_SUBSCRIPTION_REQUIRED_MESSAGE =
  "ChatGPT subscription sign-in is required for this provider.";

/**
 * Writes only the canonical `{kind, baseUrl, apiKey?, models}` shape. An
 * omitted key is inherited from the same normalized endpoint only; a changed
 * endpoint inherits neither key nor model settings, and an unreadable previous
 * secret needs an explicit key (or `""` for keyless). Ids not already enabled
 * on the same endpoint are new and bounded; the enabled-model cap only blocks
 * additions so a larger legacy set can be kept or reduced.
 */
function buildOpenAiCompatiblePlaintext(
  input: ModelConnectInput,
  previous: StoredModelSecret | undefined,
  previousEnabledModelIds: readonly string[] | undefined,
): string {
  const models: OpenAiCompatibleModelConfig[] = input.models ?? [];
  if (models.length === 0) throw new Error("Choose at least one model");
  const prepared = prepareOpenAiCompatibleConnect({ baseUrl: input.baseUrl, apiKey: input.apiKey });
  const editing = previousEnabledModelIds !== undefined;
  const saved: OpenAiCompatibleStoredSecret | undefined =
    previous?.kind === "openai_compatible" ? previous : undefined;
  if (editing && !saved && input.apiKey === undefined) {
    throw new Error(UNREADABLE_COMPATIBLE_CONNECTION_MESSAGE);
  }
  const sameEndpoint =
    saved !== undefined && sameOpenAiCompatibleEndpoint(saved.baseUrl, prepared.baseUrl);
  let apiKey = prepared.apiKey;
  if (input.apiKey === undefined && sameEndpoint && saved.apiKey) {
    // Revalidate the inherited key: a public endpoint must still use HTTPS.
    apiKey = prepareOpenAiCompatibleConnect({
      baseUrl: prepared.baseUrl,
      apiKey: saved.apiKey,
    }).apiKey;
  }
  const retained = new Set(editing && (sameEndpoint || !saved) ? previousEnabledModelIds : []);
  const added = models.filter((model) => !retained.has(model.modelId));
  if (added.some((model) => model.modelId.length > OPENAI_COMPATIBLE_MODEL_ID_MAX_LENGTH)) {
    throw new Error(`Model id must be at most ${OPENAI_COMPATIBLE_MODEL_ID_MAX_LENGTH} characters`);
  }
  if (added.length > 0 && models.length > MAX_OPENAI_COMPATIBLE_ENABLED_MODELS) {
    throw new Error(`Enable at most ${MAX_OPENAI_COMPATIBLE_ENABLED_MODELS} models`);
  }
  return serializeModelSecret({
    kind: "openai_compatible",
    format: "canonical",
    baseUrl: prepared.baseUrl,
    ...(apiKey ? { apiKey } : {}),
    models,
  });
}

/** Inherited fields come from the previous secret; a corrupt one counts as absent. */
function tryParseModelSecret(plaintext?: string): StoredModelSecret | undefined {
  if (!plaintext) return undefined;
  try {
    return parseModelSecret(plaintext);
  } catch {
    return undefined;
  }
}

/**
 * Cloudflare AI Gateway routing is part of the saved key. Omitted fields keep
 * the previous connection's ids; a blank or unsafe value is rejected.
 */
function cloudflareRoutingForConnect(
  input: ModelConnectInput,
  previous: ReturnType<typeof tryParseModelSecret>,
): { accountId: string; gatewayId: string } | undefined {
  if (!isCloudflareAiGatewayProvider(input.provider)) return undefined;
  const accountId =
    input.accountId !== undefined
      ? input.accountId
      : previous?.kind === "api_key"
        ? previous.accountId
        : undefined;
  const gatewayId =
    input.gatewayId !== undefined
      ? input.gatewayId
      : previous?.kind === "api_key"
        ? previous.gatewayId
        : undefined;
  const routing = cloudflareGatewayRouting({ accountId, gatewayId });
  if (!routing) throw new Error(CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE);
  return routing;
}

/** An unreadable secret is never reported as holding a key. */
function storedModelSecretHasApiKey(parsed: StoredModelSecret | undefined): boolean {
  if (parsed?.kind === "api_key") return parsed.key.trim().length > 0;
  if (parsed?.kind === "openai_compatible") return Boolean(parsed.apiKey?.trim());
  return false;
}

/** `null` clears a saved limit. Omitting it keeps the previous connection's limit. */
function connectMaxTokens(
  input: number | null | undefined,
  previous: number | undefined,
): number | undefined {
  if (input === null) return undefined;
  if (input !== undefined) return input;
  return previous;
}

/**
 * `modelId`/`thinkingLevel`/`isDefault` describe the current space preference
 * only. Compatible connections report their allowlist and version even when
 * the secret is unreadable, with no invented model settings or key state.
 */
export function modelCredentialDto(
  row: {
    id: string;
    provider: string;
    label: string;
    isDefault: boolean;
    defaultModel?: string | null;
    thinkingLevel?: string | null;
    supportsImages?: boolean;
    enabledModelIds?: readonly string[];
    modelConfigurationVersion?: number;
  },
  plaintext?: string,
): ModelCredential {
  const parsed = tryParseModelSecret(plaintext);
  const thinkingLevel = ThinkingLevelSchema.safeParse(row.thinkingLevel);
  const credential: ModelCredential = {
    id: row.id,
    provider: row.provider,
    label: row.label,
    hasKey: storedModelSecretHasApiKey(parsed),
    isDefault: row.isDefault,
    ...(row.defaultModel ? { modelId: row.defaultModel } : {}),
    ...(thinkingLevel.success ? { thinkingLevel: thinkingLevel.data } : {}),
  };
  if (row.provider !== OPENAI_COMPATIBLE_PROVIDER_ID) {
    if (!parsed) return credential;
    return {
      ...credential,
      authKind: modelCredentialAuthKind(parsed),
      ...(parsed.kind !== "openai_compatible" && parsed.maxTokens !== undefined
        ? { maxTokens: parsed.maxTokens }
        : {}),
      ...(parsed.kind === "api_key"
        ? {
            cacheCapabilities: parsed.cacheCapabilities,
            contextWindow: parsed.contextWindow,
          }
        : {}),
      ...(parsed.kind === "api_key" && parsed.accountId ? { accountId: parsed.accountId } : {}),
      ...(parsed.kind === "api_key" && parsed.gatewayId ? { gatewayId: parsed.gatewayId } : {}),
    };
  }
  const enabledModelIds = [...(row.enabledModelIds ?? [])];
  const compatible: ModelCredential = {
    ...credential,
    enabledModelIds,
    configurationVersion: row.modelConfigurationVersion ?? 0,
    models: [],
  };
  if (!parsed) return compatible;
  if (parsed.kind !== "openai_compatible") {
    return { ...compatible, authKind: modelCredentialAuthKind(parsed) };
  }
  return {
    ...compatible,
    authKind: "openai_compatible",
    baseUrl: parsed.baseUrl,
    models: openAiCompatibleModelConfigs(parsed, {
      enabledModelIds,
      supportsImages: row.supportsImages ?? false,
    }),
  };
}
