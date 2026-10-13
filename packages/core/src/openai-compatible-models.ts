import type {
  ModelConfigurationConflictData,
  ModelConfigurationUsage,
  ModelConnectInput,
  ModelCredential,
  OpenAiCompatibleDiscoveredModel,
  OpenAiCompatibleModelCapabilities,
  OpenAiCompatibleModelConfig,
  ThinkingLevel,
} from "@rakazo/contracts";
import {
  canonicalThinkingLevels,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  ModelConfigurationConflictDataSchema,
  modelOutputLeavesInputRoom,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  parseModelContextWindow,
  parseModelMaxImagesPerPrompt,
  parseModelMaxTokens,
  thinkingLevelsReason,
} from "@rakazo/contracts";
import { matchesSearchQuery } from "./search.js";

/** Unapplied Advanced values; numeric fields stay text until Apply. */
export type OpenAiCompatibleModelSetup = {
  thinking: boolean;
  thinkingLevels: ThinkingLevel[];
  defaultThinkingLevel: ThinkingLevel | null;
  contextWindow: string;
  maxTokens: string;
  supportsImages: boolean;
  maxImagesPerPrompt: string;
};

export type OpenAiCompatibleModelRow = {
  modelId: string;
  checked: boolean;
  /** Configuration sent while checked; null while setup is pending. */
  config: OpenAiCompatibleModelConfig | null;
  /** Enabled in the persisted connection this draft edits. */
  persisted: boolean;
  saved: OpenAiCompatibleModelConfig | null;
  /** Fresh local suggestion; never persisted. */
  suggestion: OpenAiCompatibleModelCapabilities | null;
  setup: OpenAiCompatibleModelSetup | null;
};

export type OpenAiCompatibleConnectionSnapshot = {
  credentialId: string;
  baseUrl: string;
  configurationVersion: number;
  hasKey: boolean;
  enabledModelIds: string[];
  models: OpenAiCompatibleModelConfig[];
};

export type OpenAiCompatibleModelDraft = {
  baseUrl: string;
  connection: OpenAiCompatibleConnectionSnapshot | null;
  rows: OpenAiCompatibleModelRow[];
  /** Initial default for a new connection or onboarding without a usable default. */
  defaultModelId: string | null;
};

export type OpenAiCompatibleSetupIssue =
  | "context_window"
  | "max_tokens"
  | "output_room"
  | "max_images"
  | "thinking_levels"
  | "default_level";

export type OpenAiCompatibleDraftBlocker =
  | { kind: "no_models" }
  | { kind: "setup_pending"; modelIds: string[] }
  | { kind: "invalid_limits"; modelIds: string[] }
  | { kind: "missing_default" };

export type ModelConfigurationUsageGroup = {
  spaceId: string;
  spaceName: string;
  usages: ModelConfigurationUsage[];
};

const LIMIT_ISSUES: Record<OpenAiCompatibleSetupIssue, boolean> = {
  context_window: true,
  max_tokens: true,
  output_room: true,
  max_images: true,
  thinking_levels: false,
  default_level: false,
};

export const PENDING_OPENAI_COMPATIBLE_MODEL_SETUP: OpenAiCompatibleModelSetup = {
  thinking: false,
  thinkingLevels: [],
  defaultThinkingLevel: null,
  contextWindow: String(DEFAULT_MODEL_CONTEXT_WINDOW),
  maxTokens: String(DEFAULT_MODEL_MAX_TOKENS),
  supportsImages: false,
  maxImagesPerPrompt: "",
};

/** Mirrors the server's endpoint normalization so key/config reuse decisions agree. */
export function normalizedOpenAiCompatibleEndpoint(raw: string): string {
  const trimmed = raw.trim();
  const match = /^(https?):\/\/([^/?#]+)([^?#]*)/i.exec(trimmed);
  if (!match) return trimmed;
  const scheme = match[1]!.toLowerCase();
  const host = match[2]!.toLowerCase().replace(scheme === "https" ? /:443$/ : /:80$/, "");
  let path = match[3]!.replace(/\/+$/, "");
  if (!/\/v\d+$/.test(path)) path = `${path}/v1`;
  return `${scheme}://${host}${path}`;
}

export function sameOpenAiCompatibleEndpoint(a: string, b: string): boolean {
  return normalizedOpenAiCompatibleEndpoint(a) === normalizedOpenAiCompatibleEndpoint(b);
}

export function isSavedOpenAiCompatibleEndpoint(draft: OpenAiCompatibleModelDraft): boolean {
  return (
    draft.connection !== null &&
    sameOpenAiCompatibleEndpoint(draft.baseUrl, draft.connection.baseUrl)
  );
}

/** Blank replacement omits the key (same-endpoint reuse); only explicit removal sends "". */
export function openAiCompatibleApiKeyInput(
  typedKey: string,
  removeSavedKey: boolean,
): string | undefined {
  if (removeSavedKey) return "";
  return typedKey.trim() || undefined;
}

/** The compatible connection settings edit: the space default, else the first returned. */
export function openAiCompatibleCredential(
  credentials: readonly ModelCredential[],
): ModelCredential | null {
  const compatible = credentials.filter(
    (credential) => credential.provider === OPENAI_COMPATIBLE_PROVIDER_ID,
  );
  return compatible.find((credential) => credential.isDefault) ?? compatible[0] ?? null;
}

function connectionSnapshot(
  credential: ModelCredential | null | undefined,
): OpenAiCompatibleConnectionSnapshot | null {
  if (!credential || credential.provider !== OPENAI_COMPATIBLE_PROVIDER_ID) return null;
  return {
    credentialId: credential.id,
    baseUrl: credential.baseUrl ?? "",
    configurationVersion: credential.configurationVersion ?? 0,
    hasKey: credential.hasKey,
    enabledModelIds: credential.enabledModelIds ?? [],
    models: credential.models ?? [],
  };
}

function persistedRows(connection: OpenAiCompatibleConnectionSnapshot): OpenAiCompatibleModelRow[] {
  const configs = new Map(connection.models.map((model) => [model.modelId, model]));
  return connection.enabledModelIds.map((modelId) => {
    const saved = configs.get(modelId) ?? null;
    return {
      modelId,
      checked: true,
      config: saved,
      persisted: true,
      saved,
      suggestion: null,
      setup: null,
    };
  });
}

export function createOpenAiCompatibleModelDraft(
  credential?: ModelCredential | null,
): OpenAiCompatibleModelDraft {
  const connection = connectionSnapshot(credential);
  return {
    baseUrl: connection?.baseUrl ?? "",
    connection,
    rows: connection ? persistedRows(connection) : [],
    defaultModelId: null,
  };
}

/**
 * Replaces the draft from persisted state. `discardLocal` drops suggestions and
 * unchecked local rows (stale Reload); otherwise they survive (after a save).
 */
export function reloadOpenAiCompatibleModelDraft(
  draft: OpenAiCompatibleModelDraft,
  credential: ModelCredential | null | undefined,
  options: { discardLocal: boolean },
): OpenAiCompatibleModelDraft {
  const next = createOpenAiCompatibleModelDraft(credential);
  if (options.discardLocal) return next;
  const previous = new Map(draft.rows.map((row) => [row.modelId, row]));
  const rows = next.rows.map((row) => ({
    ...row,
    suggestion: previous.get(row.modelId)?.suggestion ?? null,
  }));
  const kept = new Set(rows.map((row) => row.modelId));
  for (const row of draft.rows) {
    if (kept.has(row.modelId)) continue;
    rows.push({ ...row, checked: false, persisted: false, saved: null, setup: null });
  }
  return { ...next, rows, defaultModelId: draft.defaultModelId };
}

/** Rows belong to one endpoint; changing it clears them unless it returns to the saved endpoint. */
export function setOpenAiCompatibleEndpoint(
  draft: OpenAiCompatibleModelDraft,
  baseUrl: string,
): OpenAiCompatibleModelDraft {
  if (sameOpenAiCompatibleEndpoint(draft.baseUrl, baseUrl)) return { ...draft, baseUrl };
  const connection = draft.connection;
  const rows =
    connection && sameOpenAiCompatibleEndpoint(connection.baseUrl, baseUrl)
      ? persistedRows(connection)
      : [];
  return { ...draft, baseUrl, rows, defaultModelId: null };
}

function emptyRow(modelId: string): OpenAiCompatibleModelRow {
  return {
    modelId,
    checked: false,
    config: null,
    persisted: false,
    saved: null,
    suggestion: null,
    setup: null,
  };
}

/** Unions by exact id; refreshes suggestions without changing checks or configurations. */
export function mergeDiscoveredOpenAiCompatibleModels(
  draft: OpenAiCompatibleModelDraft,
  models: readonly OpenAiCompatibleDiscoveredModel[],
): OpenAiCompatibleModelDraft {
  const suggestions = new Map(models.map((model) => [model.modelId, model.capabilities]));
  const rows = draft.rows.map((row) =>
    suggestions.has(row.modelId)
      ? { ...row, suggestion: suggestions.get(row.modelId) ?? null }
      : row,
  );
  const present = new Set(rows.map((row) => row.modelId));
  for (const model of models) {
    if (present.has(model.modelId)) continue;
    present.add(model.modelId);
    rows.push({ ...emptyRow(model.modelId), suggestion: model.capabilities });
  }
  return { ...draft, rows };
}

function updateRow(
  draft: OpenAiCompatibleModelDraft,
  modelId: string,
  update: (row: OpenAiCompatibleModelRow) => OpenAiCompatibleModelRow,
): OpenAiCompatibleModelDraft {
  return {
    ...draft,
    rows: draft.rows.map((row) => (row.modelId === modelId ? update(row) : row)),
  };
}

function withDefaultFor(
  draft: OpenAiCompatibleModelDraft,
  modelId: string,
): OpenAiCompatibleModelDraft {
  const row = draft.rows.find((candidate) => candidate.modelId === modelId);
  if (row?.checked && row.config && draft.defaultModelId === null) {
    return { ...draft, defaultModelId: modelId };
  }
  if (!row?.checked && draft.defaultModelId === modelId) return { ...draft, defaultModelId: null };
  return draft;
}

/**
 * Checking keeps an existing configuration, else accepts the suggestion
 * snapshot, else opens pending setup. Unchecking keeps the configuration locally.
 */
export function toggleOpenAiCompatibleModel(
  draft: OpenAiCompatibleModelDraft,
  modelId: string,
  checked: boolean,
): OpenAiCompatibleModelDraft {
  const next = updateRow(draft, modelId, (row) => {
    if (!checked) return { ...row, checked: false, setup: null };
    if (row.config) return { ...row, checked: true };
    if (row.suggestion) {
      return { ...row, checked: true, config: { modelId, ...row.suggestion }, setup: null };
    }
    return { ...row, checked: true, setup: { ...PENDING_OPENAI_COMPATIBLE_MODEL_SETUP } };
  });
  return withDefaultFor(next, modelId);
}

/** Adds a manually described model, then follows the same setup path as checking it. */
export function addOpenAiCompatibleModel(
  draft: OpenAiCompatibleModelDraft,
  model: OpenAiCompatibleDiscoveredModel,
): OpenAiCompatibleModelDraft {
  const merged = mergeDiscoveredOpenAiCompatibleModels(draft, [model]);
  const row = merged.rows.find((candidate) => candidate.modelId === model.modelId);
  return row?.checked ? merged : toggleOpenAiCompatibleModel(merged, model.modelId, true);
}

export function openAiCompatibleModelSetup(
  config: OpenAiCompatibleModelConfig | null,
): OpenAiCompatibleModelSetup {
  if (!config) return { ...PENDING_OPENAI_COMPATIBLE_MODEL_SETUP };
  const thinking = thinkingLevelsReason(config.thinkingLevels);
  return {
    thinking,
    thinkingLevels: thinking ? [...config.thinkingLevels] : [],
    defaultThinkingLevel: thinking ? config.defaultThinkingLevel : null,
    contextWindow: String(config.contextWindow),
    maxTokens: String(config.maxTokens),
    supportsImages: config.supportsImages,
    maxImagesPerPrompt:
      config.maxImagesPerPrompt === undefined ? "" : String(config.maxImagesPerPrompt),
  };
}

export function updateOpenAiCompatibleModelSetup(
  draft: OpenAiCompatibleModelDraft,
  modelId: string,
  patch: Partial<OpenAiCompatibleModelSetup>,
): OpenAiCompatibleModelDraft {
  return updateRow(draft, modelId, (row) => {
    const setup = { ...(row.setup ?? openAiCompatibleModelSetup(row.config)), ...patch };
    setup.thinkingLevels = canonicalThinkingLevels(setup.thinkingLevels);
    if (
      setup.defaultThinkingLevel !== null &&
      (!setup.thinking || !setup.thinkingLevels.includes(setup.defaultThinkingLevel))
    ) {
      setup.defaultThinkingLevel = null;
    }
    return { ...row, setup };
  });
}

export function openAiCompatibleSetupIssues(
  setup: OpenAiCompatibleModelSetup,
): OpenAiCompatibleSetupIssue[] {
  const issues: OpenAiCompatibleSetupIssue[] = [];
  const contextWindow = parseModelContextWindow(setup.contextWindow);
  const maxTokens = parseModelMaxTokens(setup.maxTokens);
  if (contextWindow === undefined) issues.push("context_window");
  if (maxTokens === undefined) issues.push("max_tokens");
  if (
    contextWindow !== undefined &&
    maxTokens !== undefined &&
    !modelOutputLeavesInputRoom(maxTokens, contextWindow)
  ) {
    issues.push("output_room");
  }
  if (
    setup.supportsImages &&
    setup.maxImagesPerPrompt.trim() &&
    parseModelMaxImagesPerPrompt(setup.maxImagesPerPrompt.trim()) === undefined
  ) {
    issues.push("max_images");
  }
  if (setup.thinking && !thinkingLevelsReason(setup.thinkingLevels)) issues.push("thinking_levels");
  if (
    setup.defaultThinkingLevel !== null &&
    !(setup.thinking && setup.thinkingLevels.includes(setup.defaultThinkingLevel))
  ) {
    issues.push("default_level");
  }
  return issues;
}

/** Converts valid setup values into a configuration; cache settings come from `base`. */
export function openAiCompatibleConfigFromSetup(
  modelId: string,
  setup: OpenAiCompatibleModelSetup,
  base?: OpenAiCompatibleModelConfig | null,
): OpenAiCompatibleModelConfig | null {
  if (openAiCompatibleSetupIssues(setup).length > 0) return null;
  const maxImagesPerPrompt = setup.supportsImages
    ? parseModelMaxImagesPerPrompt(setup.maxImagesPerPrompt.trim())
    : undefined;
  return {
    modelId,
    thinkingLevels: setup.thinking ? canonicalThinkingLevels(setup.thinkingLevels) : ["off"],
    defaultThinkingLevel: setup.thinking ? setup.defaultThinkingLevel : null,
    contextWindow: parseModelContextWindow(setup.contextWindow)!,
    maxTokens: parseModelMaxTokens(setup.maxTokens)!,
    supportsImages: setup.supportsImages,
    ...(maxImagesPerPrompt === undefined ? {} : { maxImagesPerPrompt }),
    ...(base?.cacheCapabilities ? { cacheCapabilities: base.cacheCapabilities } : {}),
  };
}

/** Apply is the explicit acceptance of the setup; invalid setup leaves the draft unchanged. */
export function applyOpenAiCompatibleModelSetup(
  draft: OpenAiCompatibleModelDraft,
  modelId: string,
): OpenAiCompatibleModelDraft {
  const row = draft.rows.find((candidate) => candidate.modelId === modelId);
  if (!row) return draft;
  const config = openAiCompatibleConfigFromSetup(
    modelId,
    row.setup ?? openAiCompatibleModelSetup(row.config),
    row.config,
  );
  if (!config) return draft;
  return withDefaultFor(
    updateRow(draft, modelId, (current) => ({ ...current, checked: true, config, setup: null })),
    modelId,
  );
}

/** Cancelling pending setup restores the model to unchecked. */
export function cancelOpenAiCompatibleModelSetup(
  draft: OpenAiCompatibleModelDraft,
  modelId: string,
): OpenAiCompatibleModelDraft {
  const next = updateRow(draft, modelId, (row) =>
    row.config ? { ...row, setup: null } : { ...row, checked: false, setup: null },
  );
  return withDefaultFor(next, modelId);
}

export function applyDetectedOpenAiCompatibleSettings(
  draft: OpenAiCompatibleModelDraft,
  modelId: string,
): OpenAiCompatibleModelDraft {
  const next = updateRow(draft, modelId, (row) =>
    row.suggestion ? { ...row, config: { modelId, ...row.suggestion }, setup: null } : row,
  );
  return withDefaultFor(next, modelId);
}

export function filterOpenAiCompatibleModelRows(
  rows: readonly OpenAiCompatibleModelRow[],
  query: string,
): readonly OpenAiCompatibleModelRow[] {
  if (!query.trim()) return rows;
  return rows.filter((row) => matchesSearchQuery(query, row.modelId));
}

/** Checked, configured rows: the complete configuration a save sends. */
export function openAiCompatibleDraftConfigs(
  draft: OpenAiCompatibleModelDraft,
): OpenAiCompatibleModelConfig[] {
  return draft.rows.flatMap((row) => (row.checked && row.config ? [row.config] : []));
}

/** Rows offered as an initial default: checked and configured. */
export function openAiCompatibleDefaultCandidates(
  draft: OpenAiCompatibleModelDraft,
): OpenAiCompatibleModelRow[] {
  return draft.rows.filter((row) => row.checked && row.config && !row.setup);
}

export function openAiCompatibleDraftBlockers(
  draft: OpenAiCompatibleModelDraft,
  options: { requireDefault: boolean },
): OpenAiCompatibleDraftBlocker[] {
  const blockers: OpenAiCompatibleDraftBlocker[] = [];
  const checked = draft.rows.filter((row) => row.checked);
  if (checked.length === 0) blockers.push({ kind: "no_models" });
  const invalid: string[] = [];
  const pending: string[] = [];
  for (const row of checked) {
    if (row.setup && openAiCompatibleSetupIssues(row.setup).some((issue) => LIMIT_ISSUES[issue])) {
      invalid.push(row.modelId);
    } else if (row.setup || !row.config) {
      pending.push(row.modelId);
    }
  }
  if (pending.length > 0) blockers.push({ kind: "setup_pending", modelIds: pending });
  if (invalid.length > 0) blockers.push({ kind: "invalid_limits", modelIds: invalid });
  if (
    options.requireDefault &&
    !openAiCompatibleDefaultCandidates(draft).some((row) => row.modelId === draft.defaultModelId)
  ) {
    blockers.push({ kind: "missing_default" });
  }
  return blockers;
}

/** Restores only blocked rows enabled in this connection's saved snapshot; other edits stay. */
export function restoreBlockedOpenAiCompatibleModels(
  draft: OpenAiCompatibleModelDraft,
  usages: readonly ModelConfigurationUsage[],
): OpenAiCompatibleModelDraft {
  const blocked = new Set(usages.map((usage) => usage.modelId));
  return {
    ...draft,
    rows: draft.rows.map((row) =>
      row.persisted && blocked.has(row.modelId)
        ? { ...row, checked: true, config: row.saved, setup: null }
        : row,
    ),
  };
}

/**
 * Complete connect input. An existing connection always carries its id and
 * last-read version; only a new connection carries the initial default.
 */
export function openAiCompatibleConnectInput(
  draft: OpenAiCompatibleModelDraft,
  options: { apiKey: string | undefined; label?: string },
): ModelConnectInput {
  const models = openAiCompatibleDraftConfigs(draft);
  const base = {
    provider: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseUrl: draft.baseUrl.trim(),
    models,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.label === undefined ? {} : { label: options.label }),
  };
  if (draft.connection) {
    return {
      ...base,
      credentialId: draft.connection.credentialId,
      expectedConfigurationVersion: draft.connection.configurationVersion,
    };
  }
  return { ...base, modelId: draft.defaultModelId ?? undefined };
}

/** Structured model-configuration conflict, independent of the client error class. */
export function modelConfigurationConflict(error: unknown): ModelConfigurationConflictData | null {
  if (!error || typeof error !== "object") return null;
  const { code, status, data } = error as { code?: unknown; status?: unknown; data?: unknown };
  if (code !== "CONFLICT" || status !== 409) return null;
  const parsed = ModelConfigurationConflictDataSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/** Groups blockers by space, keeping the server's stable order. */
export function groupModelConfigurationUsages(
  usages: readonly ModelConfigurationUsage[],
): ModelConfigurationUsageGroup[] {
  const groups = new Map<string, ModelConfigurationUsageGroup>();
  for (const usage of usages) {
    const group = groups.get(usage.spaceId);
    if (group) group.usages.push(usage);
    else
      groups.set(usage.spaceId, {
        spaceId: usage.spaceId,
        spaceName: usage.spaceName,
        usages: [usage],
      });
  }
  return [...groups.values()];
}
