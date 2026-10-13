import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { OpenAiCompatibleModelConfig, ThinkingLevel } from "@rakazo/contracts";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  modelOutputLeavesInputRoom,
  OpenAiCompatibleModelConfigSchema,
  ThinkingLevelSchema,
  thinkingLevelsReason,
} from "@rakazo/contracts";
import type { OpenAiCompatibleStoredSecret } from "./pi-oauth.js";

/** Levels Pi exposed for an endpoint-wide `reasoning: true` connection before per-model settings. */
export const LEGACY_REASONING_THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
];

/** Output limit the runtime used for an OpenAI-compatible model without a saved one. */
export const LEGACY_COMPATIBLE_MAX_TOKENS = 4096;

/** Supported levels for an unsaved deployment-only connection, from its `reasoning` flag. */
export function deploymentCompatibleThinkingLevels(
  reasoning: boolean | undefined,
): ThinkingLevel[] {
  return reasoning ? [...LEGACY_REASONING_THINKING_LEVELS] : ["off"];
}

/**
 * Complete Pi map: every unsupported level is `null` so Pi neither treats a
 * missing key as ordinary support nor clamps an explicitly supported xhigh/max.
 * Supported Off travels as `"none"`; other levels keep their canonical name.
 */
export function compatibleThinkingLevelMap(levels: readonly ThinkingLevel[]): ThinkingLevelMap {
  const map: ThinkingLevelMap = {};
  for (const level of ThinkingLevelSchema.options) {
    map[level] = levels.includes(level) ? (level === "off" ? "none" : level) : null;
  }
  return map;
}

type CredentialEnablement = {
  /** Authorization allowlist from the credential row. */
  enabledModelIds: readonly string[];
  /** Legacy row-level image flag, used only when a legacy secret has no per-model list. */
  supportsImages: boolean;
};

function legacyDefaultThinkingLevel(
  levels: readonly ThinkingLevel[],
  saved: ThinkingLevel | null | undefined,
): ThinkingLevel | null {
  if (saved === undefined || saved === null) return null;
  if (saved === "xhigh" || saved === "max") return levels.includes("high") ? "high" : null;
  return levels.includes(saved) ? saved : null;
}

function legacyModelConfig(
  secret: Extract<OpenAiCompatibleStoredSecret, { format: "legacy" }>,
  credential: CredentialEnablement,
  modelId: string,
): OpenAiCompatibleModelConfig | undefined {
  const { legacy } = secret;
  const contextWindow = legacy.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW;
  const maxTokens = legacy.maxTokens ?? LEGACY_COMPATIBLE_MAX_TOKENS;
  // A saved limit pair that never left room for input needs manual repair, not a guess.
  if (!modelOutputLeavesInputRoom(maxTokens, contextWindow)) return undefined;
  const thinkingLevels = deploymentCompatibleThinkingLevels(legacy.reasoning);
  const supportsImages =
    legacy.visionModelIds !== undefined
      ? legacy.visionModelIds.some((id) => id.trim() === modelId)
      : credential.supportsImages;
  const config = OpenAiCompatibleModelConfigSchema.safeParse({
    modelId,
    thinkingLevels,
    defaultThinkingLevel: thinkingLevelsReason(thinkingLevels)
      ? legacyDefaultThinkingLevel(thinkingLevels, legacy.thinkingLevel)
      : null,
    contextWindow,
    maxTokens,
    supportsImages,
    ...(supportsImages && legacy.maxImagesPerPrompt !== undefined
      ? { maxImagesPerPrompt: legacy.maxImagesPerPrompt }
      : {}),
    ...(legacy.cacheCapabilities !== undefined
      ? { cacheCapabilities: legacy.cacheCapabilities }
      : {}),
  });
  return config.success ? config.data : undefined;
}

/**
 * Per-model settings for every enabled id that has valid configuration, in
 * allowlist order. The DB allowlist is the authority: a canonical entry for
 * an id outside it is ignored, and an enabled id without valid settings is
 * unavailable rather than synthesized. Legacy secrets project only onto the
 * allowlist seeded from their historical selections.
 */
export function openAiCompatibleModelConfigs(
  secret: OpenAiCompatibleStoredSecret,
  credential: CredentialEnablement,
): OpenAiCompatibleModelConfig[] {
  if (secret.format === "canonical") {
    const byId = new Map(secret.models.map((model) => [model.modelId, model]));
    return credential.enabledModelIds.flatMap((modelId) => {
      const model = byId.get(modelId);
      return model ? [model] : [];
    });
  }
  return credential.enabledModelIds.flatMap((modelId) => {
    const model = legacyModelConfig(secret, credential, modelId);
    return model ? [model] : [];
  });
}

/** Settings for one enabled model, or undefined when it is not enabled or not configured. */
export function openAiCompatibleModelConfig(
  secret: OpenAiCompatibleStoredSecret,
  credential: CredentialEnablement,
  modelId: string,
): OpenAiCompatibleModelConfig | undefined {
  if (!credential.enabledModelIds.includes(modelId)) return undefined;
  return openAiCompatibleModelConfigs(secret, { ...credential, enabledModelIds: [modelId] })[0];
}
