import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  DEFAULT_MODEL_MAX_TOKENS,
  type OpenAiCompatibleDiscoveredModel,
  type OpenAiCompatibleModelCapabilities,
  OpenAiCompatibleModelCapabilitiesSchema,
  type ThinkingLevel,
  ThinkingLevelSchema,
} from "@rakazo/contracts";
import { normalizeOpenAiCompatibleBaseUrl } from "./openai-compatible-url.js";
import { supplementPiModels } from "./pi-current-models.js";
import { LOCAL_PROVIDER_ID } from "./pi-local-provider.js";
import {
  listOpenAiCompatibleModels,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "./pi-openai-compatible-provider.js";

const NON_NATIVE_PROVIDERS: Record<string, true> = {
  [LOCAL_PROVIDER_ID]: true,
  [OPENAI_COMPATIBLE_PROVIDER_ID]: true,
  scripted: true,
};

type NativeCapabilities = {
  thinkingLevels: ThinkingLevel[];
  supportsImages: boolean;
  contextWindow: number;
  maxTokens: number;
};

type NativeCandidate = { provider: string; capabilities: NativeCapabilities | null };

let nativeIndex: Map<string, NativeCandidate[]> | undefined;

function nativeCapabilities(model: Model<Api>): NativeCapabilities | null {
  const levels = getSupportedThinkingLevels(model);
  const thinkingLevels = ThinkingLevelSchema.options.filter((level) => levels.includes(level));
  if (thinkingLevels.length === 0 || thinkingLevels.length !== new Set(levels).size) return null;
  if (!Number.isInteger(model.contextWindow) || !Number.isInteger(model.maxTokens)) return null;
  if (model.contextWindow < 2 || model.maxTokens < 1) return null;
  return {
    thinkingLevels,
    supportsImages: model.input.includes("image"),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

function nativeModelIndex(): Map<string, NativeCandidate[]> {
  if (nativeIndex) return nativeIndex;
  const index = new Map<string, NativeCandidate[]>();
  for (const provider of supplementPiModels(builtinModels()).getProviders()) {
    if (NON_NATIVE_PROVIDERS[provider.id]) continue;
    for (const model of provider.getModels()) {
      const candidates = index.get(model.id) ?? [];
      candidates.push({ provider: provider.id, capabilities: nativeCapabilities(model) });
      index.set(model.id, candidates);
    }
  }
  nativeIndex = index;
  return index;
}

/**
 * Suggested settings for an exact endpoint model id, from the native Pi registry only.
 * An `owned_by` naming a registry provider that lists the exact id selects that entry;
 * otherwise every native entry with the exact id must agree. Never matches by label,
 * prefix, substring or alias.
 */
export function suggestOpenAiCompatibleCapabilities(
  modelId: string,
  ownedBy?: string,
): OpenAiCompatibleModelCapabilities | null {
  const candidates = nativeModelIndex().get(modelId) ?? [];
  const owned = ownedBy === undefined ? [] : candidates.filter((c) => c.provider === ownedBy);
  const chosen = owned.length > 0 ? owned : candidates;
  const first = chosen[0]?.capabilities;
  if (!first) return null;
  for (const { capabilities } of chosen) {
    if (
      !capabilities ||
      capabilities.supportsImages !== first.supportsImages ||
      capabilities.contextWindow !== first.contextWindow ||
      capabilities.maxTokens !== first.maxTokens ||
      capabilities.thinkingLevels.join() !== first.thinkingLevels.join()
    ) {
      return null;
    }
  }
  const parsed = OpenAiCompatibleModelCapabilitiesSchema.safeParse({
    thinkingLevels: first.thinkingLevels,
    defaultThinkingLevel: null,
    contextWindow: first.contextWindow,
    maxTokens: Math.min(DEFAULT_MODEL_MAX_TOKENS, first.maxTokens, first.contextWindow - 1),
    supportsImages: first.supportsImages,
  });
  return parsed.success ? parsed.data : null;
}

export function describeOpenAiCompatibleModels(
  models: ReadonlyArray<{ id: string; ownedBy?: string }>,
): OpenAiCompatibleDiscoveredModel[] {
  return models.map((model) => ({
    modelId: model.id,
    capabilities: suggestOpenAiCompatibleCapabilities(model.id, model.ownedBy),
  }));
}

export async function discoverOpenAiCompatibleModels(
  input: { baseUrl: string; apiKey?: string },
  fetchImpl?: typeof fetch,
  signal?: AbortSignal,
): Promise<OpenAiCompatibleDiscoveredModel[]> {
  return describeOpenAiCompatibleModels(await listOpenAiCompatibleModels(input, fetchImpl, signal));
}

/** Saved keys and settings follow only their own normalized endpoint. */
export function sameOpenAiCompatibleEndpoint(left: string, right: string): boolean {
  try {
    return normalizeOpenAiCompatibleBaseUrl(left) === normalizeOpenAiCompatibleBaseUrl(right);
  } catch {
    return false;
  }
}
