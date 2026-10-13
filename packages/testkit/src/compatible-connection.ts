import {
  type ModelConnectInput,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  type OpenAiCompatibleModelConfig,
} from "@rakazo/contracts";

export type CompatibleConnectionInput = {
  baseUrl: string;
  modelId: string;
  apiKey?: string;
  label?: string;
} & Partial<Omit<OpenAiCompatibleModelConfig, "modelId">>;

export function compatibleConnection({
  baseUrl,
  modelId,
  apiKey,
  label,
  ...capabilities
}: CompatibleConnectionInput): ModelConnectInput {
  const model: OpenAiCompatibleModelConfig = {
    modelId,
    thinkingLevels: capabilities.thinkingLevels ?? ["off"],
    defaultThinkingLevel: capabilities.defaultThinkingLevel ?? null,
    contextWindow: capabilities.contextWindow ?? 160_000,
    maxTokens: capabilities.maxTokens ?? 4096,
    supportsImages: capabilities.supportsImages ?? false,
    ...(capabilities.maxImagesPerPrompt === undefined
      ? {}
      : { maxImagesPerPrompt: capabilities.maxImagesPerPrompt }),
    ...(capabilities.cacheCapabilities === undefined
      ? {}
      : { cacheCapabilities: capabilities.cacheCapabilities }),
  };
  return {
    provider: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseUrl,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(label === undefined ? {} : { label }),
    modelId,
    models: [model],
  };
}

export function connectionModelLimits(connection: ModelConnectInput) {
  const model = connection.models?.find((entry) => entry.modelId === connection.modelId);
  if (model)
    return {
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      maxImagesPerPrompt: model.maxImagesPerPrompt,
      cacheCapabilities: model.cacheCapabilities,
      thinkingLevels: model.thinkingLevels,
      acceptsImages: model.supportsImages,
    };
  return {
    contextWindow: connection.contextWindow ?? undefined,
    maxTokens: connection.maxTokens ?? undefined,
    maxImagesPerPrompt: undefined,
    cacheCapabilities: connection.cacheCapabilities,
    thinkingLevels: undefined,
    acceptsImages: undefined,
  };
}
