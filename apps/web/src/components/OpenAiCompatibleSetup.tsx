import { i18n } from "@lingui/core";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type {
  ModelConfigurationConflictData,
  ModelConfigurationUsage,
  ModelCredential,
} from "@rakazo/contracts";
import { MAX_MODEL_CONTEXT_WINDOW, MAX_MODEL_MAX_TOKENS } from "@rakazo/contracts";
import {
  addOpenAiCompatibleModel,
  createModelDescription,
  createModelProbe,
  createOpenAiCompatibleModelDraft,
  groupModelConfigurationUsages,
  initialModelProbeState,
  isSavedOpenAiCompatibleEndpoint,
  mergeDiscoveredOpenAiCompatibleModels,
  modelConfigurationConflict,
  type OpenAiCompatibleDraftBlocker,
  type OpenAiCompatibleModelDraft,
  openAiCompatibleApiKeyInput,
  openAiCompatibleDefaultCandidates,
  reloadOpenAiCompatibleModelDraft,
  restoreBlockedOpenAiCompatibleModels,
  setOpenAiCompatibleEndpoint,
} from "@rakazo/core";
import {
  Button,
  Input,
  NativeSelect,
  NativeSelectOption,
  OpenAiCompatibleModelEditor,
  type OpenAiCompatibleModelEditorLabels,
} from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { thinkingLevelLabel } from "../lib/model-catalog";
import {
  classifyModelConnectionFailure,
  type ModelPreflightFailure,
} from "../lib/model-connection-preflight";
import { rpc } from "../lib/rpc";
import { ModelPreflightFeedback } from "./ModelConnectionPreflightNotice";

export type ModelConfigurationConflictAction = "save" | "default" | "disconnect";

export type ModelConfigurationConflictState = {
  data: ModelConfigurationConflictData;
  action: ModelConfigurationConflictAction;
};

export type OpenAiCompatibleSetup = {
  draft: OpenAiCompatibleModelDraft;
  setDraft: (draft: OpenAiCompatibleModelDraft) => void;
  apiKey: string;
  removeSavedKey: boolean;
  /** Omitted reuses a same-endpoint saved key; `""` only after explicit removal. */
  keyInput: string | undefined;
  probing: boolean;
  describing: boolean;
  probeFailure: ModelPreflightFailure | null;
  foundCount: number | null;
  conflict: ModelConfigurationConflictState | null;
  stale: boolean;
  resetLookups: () => void;
  /** Replaces everything from persisted state, discarding local drafts and the typed key. */
  load: (credential: ModelCredential | null) => void;
  saved: (credential: ModelCredential | null) => void;
  setBaseUrl: (baseUrl: string) => void;
  setApiKey: (apiKey: string) => void;
  setRemoveSavedKey: (remove: boolean) => void;
  findModels: () => Promise<void>;
  addModel: (modelId: string) => void;
  clearConflict: () => void;
  /** Records a structured conflict; same-endpoint save conflicts restore only blocked saved rows. */
  handleConflict: (error: unknown, action: ModelConfigurationConflictAction) => boolean;
};

/** Screen state for one OpenAI-compatible connection draft, its key and lookups. */
export function useOpenAiCompatibleSetup(): OpenAiCompatibleSetup {
  const [draft, setDraft] = useState(() => createOpenAiCompatibleModelDraft());
  const [apiKey, setApiKey] = useState("");
  const [removeSavedKey, setRemoveSavedKey] = useState(false);
  const [{ probing }, setProbe] = useState(initialModelProbeState);
  const [probe] = useState(() => createModelProbe(setProbe));
  const [describing, setDescribing] = useState(false);
  const [describer] = useState(() => createModelDescription(setDescribing));
  const [probeFailure, setProbeFailure] = useState<ModelPreflightFailure | null>(null);
  const [foundCount, setFoundCount] = useState<number | null>(null);
  const [conflict, setConflict] = useState<ModelConfigurationConflictState | null>(null);

  useEffect(
    () => () => {
      probe.invalidate();
      describer.invalidate();
    },
    [probe, describer],
  );

  const resetLookups = () => {
    probe.reset();
    describer.reset();
    setProbeFailure(null);
    setFoundCount(null);
  };
  const keyInput = openAiCompatibleApiKeyInput(apiKey, removeSavedKey);
  const stale = conflict?.data.reason === "model_configuration_changed";

  return {
    draft,
    setDraft,
    apiKey,
    removeSavedKey,
    keyInput,
    probing,
    describing,
    probeFailure,
    foundCount,
    conflict,
    stale,
    resetLookups,
    load(credential: ModelCredential | null) {
      resetLookups();
      setDraft(createOpenAiCompatibleModelDraft(credential));
      setApiKey("");
      setRemoveSavedKey(false);
      setConflict(null);
    },
    saved(credential: ModelCredential | null) {
      resetLookups();
      setDraft((current) =>
        reloadOpenAiCompatibleModelDraft(current, credential, { discardLocal: false }),
      );
      setApiKey("");
      setRemoveSavedKey(false);
      setConflict(null);
    },
    setBaseUrl(baseUrl: string) {
      const next = setOpenAiCompatibleEndpoint(draft, baseUrl);
      if (isSavedOpenAiCompatibleEndpoint(draft) && !isSavedOpenAiCompatibleEndpoint(next)) {
        setApiKey("");
        setRemoveSavedKey(false);
      }
      setDraft(next);
      resetLookups();
      if (conflict && !stale) setConflict(null);
    },
    setApiKey(nextApiKey: string) {
      setApiKey(nextApiKey);
      resetLookups();
    },
    setRemoveSavedKey(remove: boolean) {
      setRemoveSavedKey(remove);
      if (remove) setApiKey("");
      resetLookups();
    },
    async findModels() {
      setProbeFailure(null);
      setFoundCount(null);
      await probe.probe({
        baseUrl: draft.baseUrl,
        apiKey: keyInput,
        credentialId: draft.connection?.credentialId,
        request: rpc.models.probeOpenAiCompatible,
        onSuccess: (models) => {
          setDraft((current) => mergeDiscoveredOpenAiCompatibleModels(current, models));
          setFoundCount(models.length);
        },
        onError: (error) => setProbeFailure(classifyModelConnectionFailure(error)),
      });
    },
    addModel(modelId: string) {
      void describer.describe({
        baseUrl: draft.baseUrl,
        credentialId: draft.connection?.credentialId,
        modelId,
        request: rpc.models.describeOpenAiCompatible,
        onSuccess: (model) => setDraft((current) => addOpenAiCompatibleModel(current, model)),
        onError: () =>
          setDraft((current) => addOpenAiCompatibleModel(current, { modelId, capabilities: null })),
      });
    },
    clearConflict() {
      if (!stale) setConflict(null);
    },
    handleConflict(error: unknown, action: ModelConfigurationConflictAction): boolean {
      const data = modelConfigurationConflict(error);
      if (!data) return false;
      setConflict({ data, action });
      if (
        action === "save" &&
        (data.reason === "models_in_use" || data.reason === "model_effort_in_use")
      ) {
        setDraft((current) =>
          isSavedOpenAiCompatibleEndpoint(current)
            ? restoreBlockedOpenAiCompatibleModels(current, data.usages)
            : current,
        );
      }
      return true;
    },
  };
}

function useEditorLabels(): OpenAiCompatibleModelEditorLabels {
  const { t } = useLingui();
  return {
    models: t`Models`,
    searchModels: t`Search models`,
    noModels: t`Find models, or add one by its id.`,
    noMatches: t`No models match.`,
    needsSetup: t`Needs setup`,
    advanced: t`Advanced`,
    supportsThinking: t`Supports thinking`,
    supportedLevels: t`Supported reasoning levels`,
    defaultReasoningEffort: t`Default reasoning effort`,
    defaultEffort: (level) =>
      i18n._({ id: "Default ({0})", message: "Default ({0})", values: { "0": level } }),
    contextWindow: t`Context limit`,
    maxTokens: t`Maximum output tokens`,
    images: t`Supports images`,
    maxImages: t`Maximum images per request`,
    apply: t`Apply`,
    cancel: t`Cancel`,
    useDetectedSettings: t`Use detected settings`,
    otherModel: t`Other model…`,
    modelId: t`Model id`,
    add: t`Add`,
    issues: {
      context_window: t`Enter a whole number from 1 to ${MAX_MODEL_CONTEXT_WINDOW} for the context limit.`,
      max_tokens: t`Enter a whole number from 1 to ${MAX_MODEL_MAX_TOKENS} for maximum output tokens.`,
      output_room: t`Maximum output tokens must be below the context limit.`,
      max_images: t`Enter a whole number from 1 to 1000 for the image limit.`,
      thinking_levels: t`Choose a reasoning level other than Off.`,
      default_level: t`Choose a supported default reasoning effort.`,
    },
  };
}

function BlockerHint({ blocker }: { blocker: OpenAiCompatibleDraftBlocker }) {
  switch (blocker.kind) {
    case "no_models":
      return <Trans>Choose at least one model.</Trans>;
    case "setup_pending":
      return <Trans>Apply or cancel each model's setup.</Trans>;
    case "invalid_limits":
      return <Trans>Fix the model limits.</Trans>;
    case "missing_default":
      return <Trans>Choose a default model.</Trans>;
  }
}

/** Server URL, optional key, model list and initial default for one compatible connection. */
export function OpenAiCompatibleSetupFields({
  setup,
  busy,
  blockers,
  chooseDefault,
  inputClassName = "mt-2 h-10 text-foreground",
}: {
  setup: OpenAiCompatibleSetup;
  busy: boolean;
  blockers: OpenAiCompatibleDraftBlocker[];
  chooseDefault: boolean;
  inputClassName?: string;
}) {
  const { t } = useLingui();
  const fieldId = useId();
  const labels = useEditorLabels();
  const { draft } = setup;
  const savedEndpoint = isSavedOpenAiCompatibleEndpoint(draft);
  const savedKey = savedEndpoint && draft.connection?.hasKey === true;
  const candidates = chooseDefault ? openAiCompatibleDefaultCandidates(draft) : [];
  return (
    <div className="block text-[13.5px] text-muted-foreground">
      <label className="block" htmlFor={`${fieldId}-base-url`}>
        <Trans>Server URL</Trans>
        <Input
          id={`${fieldId}-base-url`}
          value={draft.baseUrl}
          onChange={(event) => setup.setBaseUrl(event.target.value)}
          aria-label={t`OpenAI-compatible server URL`}
          placeholder="http://127.0.0.1:8000/v1"
          autoComplete="off"
          disabled={busy}
          className={inputClassName}
        />
      </label>
      <details className="mt-2 text-[13px] leading-[1.5]">
        <summary className="w-fit cursor-pointer select-none">
          <Trans>Setup help</Trans>
        </summary>
        <p className="mt-1">
          {t`Paste the OpenAI-compatible address from your server. Rakazo adds /v1 if needed.`}
        </p>
      </details>
      <details className="mt-3">
        <summary className="w-fit cursor-pointer select-none">
          <Trans>API key</Trans>
        </summary>
        <Input
          aria-label={t`API key`}
          value={setup.apiKey}
          onChange={(event) => setup.setApiKey(event.target.value)}
          placeholder={
            setup.removeSavedKey
              ? t`The saved key will be removed`
              : savedKey
                ? t`Paste a replacement key`
                : t`Optional`
          }
          disabled={busy || setup.removeSavedKey}
          type="password"
          autoComplete="new-password"
          className={inputClassName}
        />
        {savedKey ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="mt-1 h-auto px-0 text-[13px] text-muted-foreground underline"
            disabled={busy}
            onClick={() => setup.setRemoveSavedKey(!setup.removeSavedKey)}
          >
            {setup.removeSavedKey ? <Trans>Keep saved key</Trans> : <Trans>Remove saved key</Trans>}
          </Button>
        ) : null}
      </details>
      <div className="mt-3 flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || setup.probing || !draft.baseUrl.trim()}
          onClick={() => void setup.findModels()}
        >
          {setup.probing ? <Trans>Finding…</Trans> : <Trans>Find models</Trans>}
        </Button>
      </div>
      <ModelPreflightFeedback success={null} failure={setup.probeFailure} />
      {setup.foundCount !== null ? (
        <p className="mt-2 text-sm text-success" role="status">
          {setup.foundCount === 0 ? (
            <Trans>Server found. Add a model by its id.</Trans>
          ) : (
            <Plural value={setup.foundCount} one="Found # model." other="Found # models." />
          )}
        </p>
      ) : null}
      <OpenAiCompatibleModelEditor
        draft={draft}
        onChange={setup.setDraft}
        busy={busy}
        adding={setup.describing}
        labels={labels}
        effortLabel={thinkingLevelLabel}
        onAddModel={setup.addModel}
      />
      {chooseDefault ? (
        <label className="mt-4 block" htmlFor={`${fieldId}-default-model`}>
          <Trans>Default model</Trans>
          <NativeSelect
            id={`${fieldId}-default-model`}
            className="mt-2 w-full text-foreground"
            value={draft.defaultModelId ?? ""}
            disabled={busy || candidates.length === 0}
            onChange={(event) =>
              setup.setDraft({ ...draft, defaultModelId: event.target.value || null })
            }
          >
            <NativeSelectOption value="" disabled>
              {t`Choose a checked model`}
            </NativeSelectOption>
            {candidates.map((row) => (
              <NativeSelectOption key={row.modelId} value={row.modelId}>
                {row.modelId}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      ) : null}
      {draft.rows.length > 0 && blockers[0] ? (
        <p className="mt-3 text-[13px]" data-testid="compatible-model-blocker">
          <BlockerHint blocker={blockers[0]} />
        </p>
      ) : null}
    </div>
  );
}

function usageKindLabel(kind: ModelConfigurationUsage["kind"]): string {
  switch (kind) {
    case "default":
      return i18n._({ id: "Space default", message: "Space default" });
    case "bot":
      return i18n._({ id: "Bot", message: "Bot" });
    case "routine":
      return i18n._({ id: "Routine", message: "Routine" });
    case "backup":
      return i18n._({ id: "Backup model", message: "Backup model" });
    case "run":
      return i18n._({ id: "Running task", message: "Running task" });
    case "steering":
      return i18n._({ id: "Queued message", message: "Queued message" });
  }
}

/** Server-reported blockers grouped by space, plus Reload when the settings changed elsewhere. */
export function ModelConfigurationConflictNotice({
  conflict,
  busy,
  onReload,
}: {
  conflict: ModelConfigurationConflictState | null;
  busy: boolean;
  onReload: () => void;
}) {
  const { t } = useLingui();
  if (!conflict) return null;
  const { data, action } = conflict;
  const message =
    data.reason === "models_in_use"
      ? t`Reassign models before disabling them.`
      : data.reason === "model_connection_in_use"
        ? t`Reassign models before changing their connection.`
        : data.reason === "model_effort_in_use"
          ? action === "save"
            ? t`Change reasoning effort before changing supported levels.`
            : t`Change bot reasoning effort before changing the default model.`
          : t`Model settings changed; reload before saving.`;
  return (
    <div className="mb-4 space-y-2 text-sm" role="alert">
      <p className="text-destructive">{message}</p>
      {data.reason === "model_configuration_changed" ? (
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onReload}>
          <Trans>Reload</Trans>
        </Button>
      ) : (
        groupModelConfigurationUsages(data.usages).map((group) => (
          <div key={group.spaceId}>
            <p className="font-medium text-foreground">{group.spaceName}</p>
            <ul className="mt-1 space-y-0.5 text-muted-foreground">
              {group.usages.map((usage) => (
                <li key={`${usage.kind}:${usage.id}:${usage.modelId}`}>
                  {usageKindLabel(usage.kind)} · {usage.name} ·{" "}
                  <span className="break-all font-mono text-xs">{usage.modelId}</span>
                  {usage.thinkingLevel ? ` · ${thinkingLevelLabel(usage.thinkingLevel)}` : null}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  );
}
