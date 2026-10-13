import type { OpenAiCompatibleDiscoveredModel } from "@rakazo/contracts";

export type ModelProbeState = {
  models: OpenAiCompatibleDiscoveredModel[];
  baseUrl: string | null;
  probing: boolean;
};

export const initialModelProbeState: ModelProbeState = {
  models: [],
  baseUrl: null,
  probing: false,
};

/** Omitted `apiKey` reuses a same-endpoint saved key; `""` is an explicit keyless request. */
export type OpenAiCompatibleModelLookupInput = {
  baseUrl: string;
  apiKey?: string;
  credentialId?: string;
};

export type OpenAiCompatibleModelLookup = (
  input: OpenAiCompatibleModelLookupInput,
) => Promise<{ models: OpenAiCompatibleDiscoveredModel[] }>;

function lookupInput(options: {
  baseUrl: string;
  apiKey?: string | undefined;
  credentialId?: string | undefined;
}): OpenAiCompatibleModelLookupInput {
  return {
    baseUrl: options.baseUrl,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.credentialId === undefined ? {} : { credentialId: options.credentialId }),
  };
}

/** Keep only the latest probe, including when its connection changes or its screen closes. */
export function createModelProbe(onChange: (state: ModelProbeState) => void) {
  let revision = 0;
  return {
    invalidate() {
      revision += 1;
    },
    reset() {
      revision += 1;
      onChange(initialModelProbeState);
    },
    async probe(options: {
      baseUrl: string;
      apiKey?: string | undefined;
      credentialId?: string | undefined;
      request: OpenAiCompatibleModelLookup;
      onSuccess: (models: OpenAiCompatibleDiscoveredModel[]) => void;
      onError: (error: unknown) => void;
    }) {
      const baseUrl = options.baseUrl.trim();
      if (!baseUrl) return;
      const requestRevision = ++revision;
      onChange({ models: [], baseUrl: null, probing: true });
      try {
        const { models } = await options.request(lookupInput({ ...options, baseUrl }));
        if (requestRevision !== revision) return;
        onChange({ models, baseUrl, probing: false });
        options.onSuccess(models);
      } catch (error) {
        if (requestRevision !== revision) return;
        onChange(initialModelProbeState);
        options.onError(error);
      }
    },
  };
}

/** Local metadata lookup for manually entered ids; only the latest request reports. */
export function createModelDescription(onBusyChange: (busy: boolean) => void) {
  let revision = 0;
  return {
    invalidate() {
      revision += 1;
    },
    reset() {
      revision += 1;
      onBusyChange(false);
    },
    async describe(options: {
      baseUrl: string;
      credentialId?: string | undefined;
      modelId: string;
      request: (
        input: Omit<OpenAiCompatibleModelLookupInput, "apiKey"> & { modelIds: string[] },
      ) => Promise<{ models: OpenAiCompatibleDiscoveredModel[] }>;
      onSuccess: (model: OpenAiCompatibleDiscoveredModel) => void;
      onError: (error: unknown) => void;
    }) {
      const baseUrl = options.baseUrl.trim();
      const modelId = options.modelId.trim();
      if (!baseUrl || !modelId) return;
      const requestRevision = ++revision;
      onBusyChange(true);
      try {
        const { models } = await options.request({
          ...lookupInput({ baseUrl, credentialId: options.credentialId }),
          modelIds: [modelId],
        });
        if (requestRevision !== revision) return;
        onBusyChange(false);
        options.onSuccess(
          models.find((model) => model.modelId === modelId) ?? { modelId, capabilities: null },
        );
      } catch (error) {
        if (requestRevision !== revision) return;
        onBusyChange(false);
        options.onError(error);
      }
    },
  };
}
