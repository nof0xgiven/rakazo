import { Plural, Trans, useLingui } from "@lingui/react/macro";
import {
  CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
  cloudflareGatewayRouting,
  effectiveThinkingLevel,
  type IntegrationSetupState,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  type ThinkingLevel,
} from "@rakazo/contracts";
import {
  clampCatalogThinkingLevel,
  openAiCompatibleConnectInput,
  openAiCompatibleCredential,
  openAiCompatibleDraftBlockers,
  pickCatalogModelId,
} from "@rakazo/core";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@rakazo/ui-web";
import { Check, Copy } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { IntegrationSetup } from "../components/integrations/IntegrationSetup";
import {
  ModelPreflightFeedback,
  modelPreflightTestingLabel,
} from "../components/ModelConnectionPreflightNotice";
import {
  ModelConfigurationConflictNotice,
  OpenAiCompatibleSetupFields,
  useOpenAiCompatibleSetup,
} from "../components/OpenAiCompatibleSetup";
import { useCopyText } from "../lib/copy-text";
import type { ModelCatalogEntry } from "../lib/model-auth";
import { thinkingLevelLabel } from "../lib/model-catalog";
import type { ModelPreflightFailure } from "../lib/model-connection-preflight";
import {
  loadStoredModelAuth,
  modelPreflightSuccessMessage,
  runModelConnectionPreflight,
} from "../lib/model-connection-preflight";
import { rpc } from "../lib/rpc";
import { useModelOAuthSignIn } from "../lib/use-model-oauth-signin";
import { errorText } from "../lib/user-error";

const DEFAULT_THINKING_LEVEL_OPTION = "__rakazo_default_thinking__";
const FIRST_BOT_NAME = "Chief";
const FIRST_BOT_SPAWN_KEY = "onboarding:first";
const FIRST_BOT_LOCK = "rakazo:onboarding-first-bot";

/** Survives StrictMode remounts; concurrent first-bot creates share one in-flight attempt. */
let firstBotEnsure: Promise<{ id: string }> | null = null;

function findFirstBot(
  bots: Array<{ id: string; name: string; spawnKey: string | null }>,
): { id: string } | undefined {
  const bySpawnKey = bots.find((bot) => bot.spawnKey === FIRST_BOT_SPAWN_KEY);
  if (bySpawnKey) return { id: bySpawnKey.id };
  // Legacy first-run Chief created before spawnKey was set.
  const byName = bots.find((bot) => bot.name === FIRST_BOT_NAME);
  return byName ? { id: byName.id } : undefined;
}

async function createOrReuseFirstBot(): Promise<{ id: string }> {
  const existing = await rpc.bots.list();
  const reuse = findFirstBot(existing);
  if (reuse) return reuse;
  try {
    const created = await rpc.bots.create({
      name: FIRST_BOT_NAME,
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
      spawnKey: FIRST_BOT_SPAWN_KEY,
    });
    return { id: created.id };
  } catch (error) {
    // Another tab won the unique (spaceId, spawnKey) race; reuse that bot only.
    const afterConflict = await rpc.bots.list();
    const winner = afterConflict.find((bot) => bot.spawnKey === FIRST_BOT_SPAWN_KEY);
    if (winner) return { id: winner.id };
    throw error;
  }
}

async function withFirstBotLock<T>(run: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) return run();
  return locks.request(FIRST_BOT_LOCK, run);
}

async function ensureFirstBot(): Promise<{ id: string }> {
  if (firstBotEnsure) return firstBotEnsure;
  // Web Lock serializes cross-tab creates; module promise covers same-tab StrictMode.
  // spawnKey makes create idempotent when locks are unavailable.
  // Clear after settle so a later empty-space visit re-lists instead of reusing a deleted id.
  firstBotEnsure = withFirstBotLock(createOrReuseFirstBot).finally(() => {
    firstBotEnsure = null;
  });
  return firstBotEnsure;
}

function providerLabel(entry: ModelCatalogEntry): string {
  return entry.provider === "openai-codex" ? "ChatGPT" : (entry.providerName ?? entry.provider);
}

function nextStepAfterModel(needsIntegrationSetup: boolean): "integrations" | "bot" {
  return needsIntegrationSetup ? "integrations" : "bot";
}

export function OnboardingPage() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const fieldId = useId();
  const [step, setStep] = useState<"loading" | "model" | "integrations" | "bot">("loading");
  const [integrationSetup, setIntegrationSetup] = useState<IntegrationSetupState | null>(null);
  const needsIntegrationSetup = integrationSetup?.needsSetup ?? false;
  const [integrationServers, setIntegrationServers] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [provider, setProvider] = useState("openrouter");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [accountId, setAccountId] = useState("");
  const [gatewayId, setGatewayId] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | null>(null);
  const compatible = useOpenAiCompatibleSetup();
  const [savingModel, setSavingModel] = useState(false);
  const createStartedRef = useRef(false);
  const deploymentDefaultModelRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preflightTesting, setPreflightTesting] = useState(false);
  const [preflightTarget, setPreflightTarget] = useState<"api-key" | "sign-in" | null>(null);
  const [preflightSuccess, setPreflightSuccess] = useState<string | null>(null);
  const [preflightFailure, setPreflightFailure] = useState<ModelPreflightFailure | null>(null);
  const preflightRevisionRef = useRef(0);
  const [codeCopied, copyOAuthCode] = useCopyText();

  const {
    oauth,
    pasteCode,
    setPasteCode,
    oauthPending,
    popupBlocked,
    cancelOAuthAttempt,
    startSubscriptionSignIn,
    submitOAuthCode,
  } = useModelOAuthSignIn({
    onClearError: () => setError(null),
    onError: setError,
    onFinished: async () => {
      // OAuth connect ignores thinkingLevel; persist the staged catalog choice.
      const level = clampCatalogThinkingLevel(
        thinkingLevel,
        catalog.find((entry) => entry.provider === provider && entry.id === modelId)
          ?.thinkingLevels,
      );
      if (level && provider !== OPENAI_COMPATIBLE_PROVIDER_ID && modelId) {
        try {
          await rpc.models.setDefault({ provider, modelId, thinkingLevel: level as ThinkingLevel });
        } catch {
          // The connection itself succeeded; the effort stays adjustable in Models.
        }
      }
      setStep(nextStepAfterModel(needsIntegrationSetup));
    },
  });

  useEffect(() => {
    void Promise.all([
      rpc.me(),
      rpc.models.list().catch(() => []),
      rpc.integrationSetup.get().catch(() => null),
      rpc.models.credentials().catch(() => []),
    ])
      .then(([me, models, integrations, credentials]) => {
        setIntegrationSetup(integrations);
        setCatalog(models);
        compatible.load(openAiCompatibleCredential(credentials));
        deploymentDefaultModelRef.current = me.defaultModel;
        const preferred =
          models.find(
            (entry) => entry.provider === me.defaultProvider && entry.id === me.defaultModel,
          ) ??
          models.find((entry) => entry.provider === me.defaultProvider) ??
          models[0];
        if (preferred) {
          setProvider(preferred.provider);
          setModelId(preferred.provider === OPENAI_COMPATIBLE_PROVIDER_ID ? "" : preferred.id);
        }
        setStep(me.needsModel ? "model" : integrations?.needsSetup ? "integrations" : "bot");
      })
      .catch(() => setStep("bot"));
  }, []);

  const providers = useMemo(() => {
    const seen = new Map<string, ModelCatalogEntry>();
    for (const entry of catalog) {
      if (!seen.has(entry.provider)) seen.set(entry.provider, entry);
    }
    return [...seen.values()];
  }, [catalog]);

  const modelsForProvider = useMemo(
    () => catalog.filter((entry) => entry.provider === provider),
    [catalog, provider],
  );

  const selected = modelsForProvider.find((entry) => entry.id === modelId) ?? modelsForProvider[0];
  const isOpenAiCompatible = provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  const isCloudflareGateway = provider === CLOUDFLARE_AI_GATEWAY_PROVIDER_ID;
  const cloudflareRoutingReady =
    !isCloudflareGateway || cloudflareGatewayRouting({ accountId, gatewayId }) !== undefined;
  // Effort levels for the staged catalog model — "off" stays out, matching the
  // model settings and per-bot Thinking pickers.
  const catalogThinkingLevels =
    !isOpenAiCompatible && selected
      ? (selected.thinkingLevels ?? []).filter((level) => level !== "off")
      : [];
  const subscriptionSignIn = selected?.signIn !== undefined;
  const acceptsKey = selected?.auth !== "oauth";
  const signInLabel = selected?.oauthLabel ?? t`Sign in`;
  const compatibleBlockers = openAiCompatibleDraftBlockers(compatible.draft, {
    requireDefault: true,
  });
  const canSaveModel = Boolean(
    selected &&
      !oauthPending &&
      !savingModel &&
      cloudflareRoutingReady &&
      (isOpenAiCompatible
        ? compatibleBlockers.length === 0 &&
          !compatible.stale &&
          compatible.draft.baseUrl.trim() !== ""
        : modelId.trim() && acceptsKey && apiKey.trim()),
  );
  // Base UI Select.Value only resolves labels when Root gets `items`.
  const providerItems = useMemo(
    () => providers.map((entry) => ({ value: entry.provider, label: providerLabel(entry) })),
    [providers],
  );
  const modelItems = useMemo(
    () => modelsForProvider.map((entry) => ({ value: entry.id, label: entry.label })),
    [modelsForProvider],
  );
  const defaultThinkingLabel = t`Default (${thinkingLevelLabel(
    effectiveThinkingLevel(selected?.thinkingLevels ?? [], null, null),
  )})`;
  const thinkingLevelItems = useMemo(
    () => [
      { value: DEFAULT_THINKING_LEVEL_OPTION, label: defaultThinkingLabel },
      ...catalogThinkingLevels.map((level) => ({ value: level, label: thinkingLevelLabel(level) })),
    ],
    [catalogThinkingLevels, defaultThinkingLabel],
  );

  function invalidatePreflight() {
    preflightRevisionRef.current += 1;
    setPreflightTesting(false);
    setPreflightTarget(null);
    setPreflightSuccess(null);
    setPreflightFailure(null);
  }

  function updateApiKey(nextApiKey: string) {
    setApiKey(nextApiKey);
    invalidatePreflight();
  }

  function selectProvider(nextProvider: string) {
    if (nextProvider === provider) return;
    cancelOAuthAttempt();
    setProvider(nextProvider);
    setApiKey("");
    setAccountId("");
    setGatewayId("");
    setModelId(
      nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID
        ? ""
        : pickCatalogModelId(catalog, nextProvider, deploymentDefaultModelRef.current),
    );
    setThinkingLevel(null);
    compatible.resetLookups();
    compatible.clearConflict();
    invalidatePreflight();
    setError(null);
    setNotice(null);
  }

  function preflightStillCurrent(revision: number): boolean {
    return revision === preflightRevisionRef.current;
  }

  async function testApiKeyConnection() {
    if (!selected?.catalogProbe) return;
    const revision = preflightRevisionRef.current;
    setPreflightTarget("api-key");
    setPreflightTesting(true);
    setPreflightSuccess(null);
    setPreflightFailure(null);
    setError(null);
    setNotice(null);
    const result = await runModelConnectionPreflight({
      authKind: "api-key",
      provider: selected.provider,
      apiKey,
      modelId: selected.id,
      catalogProbe: true,
      probeCatalog: rpc.models.probeCatalog,
    });
    if (!preflightStillCurrent(revision)) return;
    setPreflightTesting(false);
    if (result.ok) {
      setPreflightSuccess(modelPreflightSuccessMessage(result.discoveredModels.length));
      return;
    }
    setPreflightFailure(result.failure);
  }

  async function testOAuthConnection() {
    if (!selected) return;
    const revision = preflightRevisionRef.current;
    setPreflightTarget("sign-in");
    setPreflightTesting(true);
    setPreflightSuccess(null);
    setPreflightFailure(null);
    setError(null);
    setNotice(null);
    const stored = await loadStoredModelAuth(
      selected.provider,
      () => rpc.models.credentials(),
      selected.id,
    );
    if (!preflightStillCurrent(revision)) return;
    const result = await runModelConnectionPreflight({
      authKind: "oauth",
      provider: selected.provider,
      ...stored,
    });
    if (!preflightStillCurrent(revision)) return;
    setPreflightTesting(false);
    if (result.ok) {
      setPreflightSuccess(t`A subscription credential is stored securely.`);
      return;
    }
    setPreflightFailure(result.failure);
  }

  async function saveCompatibleModels() {
    const draft = compatible.draft;
    const defaultModelId = draft.defaultModelId;
    if (!defaultModelId) return;
    try {
      await rpc.models.connect(
        openAiCompatibleConnectInput(draft, {
          apiKey: compatible.keyInput,
          label: selected?.providerName ?? provider,
        }),
      );
    } catch (err) {
      if (!compatible.handleConflict(err, "save")) {
        setError(errorText(err, t`Could not save model`));
      }
      return;
    }
    if (draft.connection) {
      try {
        compatible.saved(openAiCompatibleCredential(await rpc.models.credentials()));
        await rpc.models.setDefault({ provider, modelId: defaultModelId });
      } catch (err) {
        if (!compatible.handleConflict(err, "default")) {
          setError(errorText(err, t`Models saved, but the default model was not set. Try again.`));
        }
        return;
      }
    }
    setStep(nextStepAfterModel(needsIntegrationSetup));
  }

  async function saveCatalogModel() {
    const level = clampCatalogThinkingLevel(
      thinkingLevel,
      selected?.thinkingLevels,
    ) as ThinkingLevel | null;
    try {
      if (apiKey) {
        await rpc.models.connect({
          provider,
          apiKey,
          ...(isCloudflareGateway
            ? { accountId: accountId.trim(), gatewayId: gatewayId.trim() }
            : {}),
          modelId,
          thinkingLevel: level,
          label: selected?.providerName ?? provider,
        });
      }
      // Catalog providers keep the staged effort on the saved model preference.
      if (level && modelId) {
        await rpc.models.setDefault({ provider, modelId, thinkingLevel: level });
      }
      setStep(nextStepAfterModel(needsIntegrationSetup));
    } catch (err) {
      if (!compatible.handleConflict(err, "default")) {
        setError(errorText(err, t`Could not save model`));
      }
    }
  }

  async function saveModel() {
    if (!canSaveModel) return;
    setError(null);
    setNotice(null);
    compatible.clearConflict();
    setSavingModel(true);
    try {
      await (isOpenAiCompatible ? saveCompatibleModels() : saveCatalogModel());
    } finally {
      setSavingModel(false);
    }
  }

  async function reloadCompatibleModels() {
    setError(null);
    try {
      compatible.load(openAiCompatibleCredential(await rpc.models.credentials()));
    } catch (err) {
      setError(errorText(err, t`Could not load model settings`));
    }
  }

  function beginSelectedSubscriptionSignIn() {
    if (!selected?.id) return;
    void startSubscriptionSignIn({
      provider: selected.provider,
      modelId: selected.id,
      thinkingLevel: clampCatalogThinkingLevel(
        thinkingLevel,
        selected.thinkingLevels,
      ) as ThinkingLevel | null,
      label: selected.providerName ?? selected.provider,
    });
  }

  async function createFirstBot() {
    if (createStartedRef.current) return;
    createStartedRef.current = true;
    setError(null);
    try {
      const bot = await ensureFirstBot();
      for (const serverId of integrationServers) {
        await rpc.mcp.assignments.approve({ botId: bot.id, serverId });
      }
      // Onboarding continues conversationally in the thread: greeting first,
      // then the focus choice (immediate for the first bot).
      const started = await rpc.onboarding
        .start({ botId: bot.id })
        .then(() => true)
        .catch(() => false);
      if (started) {
        await rpc.onboarding.promptFocus({ botId: bot.id }).catch(() => undefined);
      }
      navigate(`/app/${bot.id}`);
    } catch (err) {
      createStartedRef.current = false;
      setError(errorText(err, t`Could not create your bot`));
    }
  }

  useEffect(() => {
    if (step !== "bot") return;
    void createFirstBot();
  }, [step]);

  return (
    <div className="min-h-full bg-background px-6 py-12">
      <div className="mx-auto w-full max-w-[560px]">
        {step === "loading" ? (
          <p className="text-muted-foreground">
            <Trans>Loading…</Trans>
          </p>
        ) : null}
        {step === "model" ? (
          <div>
            <h1 className="text-[32px] font-medium text-foreground">
              <Trans>Connect a model</Trans>
            </h1>
            <div className="mt-8 block text-sm font-medium text-foreground">
              <span>
                <Trans>Provider</Trans>
              </span>
              <Select
                value={provider}
                onValueChange={(value) => {
                  if (typeof value !== "string" || !value) return;
                  selectProvider(value);
                }}
                items={providerItems}
              >
                <SelectTrigger aria-label={t`Provider`} className="mt-2 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {providers.map((entry) => (
                    <SelectItem key={entry.provider} value={entry.provider}>
                      {providerLabel(entry)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="mt-6 block text-sm text-foreground">
              {isOpenAiCompatible ? (
                <OpenAiCompatibleSetupFields
                  setup={compatible}
                  busy={savingModel}
                  blockers={compatibleBlockers}
                  chooseDefault
                  inputClassName="mt-2"
                />
              ) : (
                <>
                  <span className="font-medium">
                    <Trans>Model</Trans>
                  </span>
                  <Select
                    value={selected?.id ?? modelId}
                    onValueChange={(value) => {
                      if (typeof value !== "string" || !value) return;
                      if (value === modelId) return;
                      cancelOAuthAttempt();
                      setModelId(value);
                      setThinkingLevel(null);
                      invalidatePreflight();
                    }}
                    items={modelItems}
                  >
                    <SelectTrigger aria-label={t`Model`} className="mt-2 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {modelsForProvider.map((entry) => (
                        <SelectItem key={`${entry.provider}:${entry.id}`} value={entry.id}>
                          {entry.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {catalogThinkingLevels.length ? (
                    <div className="mt-4 block">
                      <span className="font-medium">
                        <Trans>Thinking</Trans>
                      </span>
                      <Select
                        value={thinkingLevel ?? DEFAULT_THINKING_LEVEL_OPTION}
                        onValueChange={(value) => {
                          const next = String(value);
                          setThinkingLevel(
                            next === DEFAULT_THINKING_LEVEL_OPTION ? null : (next as ThinkingLevel),
                          );
                        }}
                        items={thinkingLevelItems}
                      >
                        <SelectTrigger aria-label={t`Thinking`} className="mt-2 w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={DEFAULT_THINKING_LEVEL_OPTION}>
                            {defaultThinkingLabel}
                          </SelectItem>
                          {catalogThinkingLevels.map((level) => (
                            <SelectItem key={level} value={level}>
                              {thinkingLevelLabel(level)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}
                </>
              )}
            </div>
            {subscriptionSignIn ? (
              <div className="mt-4">
                {oauth ? (
                  <div className="rounded-lg border border-border px-3.5 py-3">
                    {oauth.mode === "auth-url" ? (
                      <>
                        <p className="text-sm text-muted-foreground">
                          {popupBlocked ? (
                            <Trans>
                              Open{" "}
                              <a
                                href={oauth.verificationUri}
                                target="_blank"
                                rel="noreferrer"
                                className="text-foreground underline"
                              >
                                {new URL(oauth.verificationUri).hostname}
                              </a>{" "}
                              to finish signing in.
                            </Trans>
                          ) : (
                            <Trans>
                              Finish signing in at{" "}
                              <a
                                href={oauth.verificationUri}
                                target="_blank"
                                rel="noreferrer"
                                className="text-foreground underline"
                              >
                                {new URL(oauth.verificationUri).hostname}
                              </a>
                              . The final page may not load; paste its URL or code here.
                            </Trans>
                          )}
                        </p>
                        <div className="mt-3 flex items-center gap-2">
                          <Input
                            value={pasteCode}
                            onChange={(e) => setPasteCode(e.target.value)}
                            aria-label={t`Authorization code or callback URL`}
                            autoComplete="off"
                            spellCheck={false}
                            placeholder="http://localhost:53692/callback?code=…"
                          />
                          <Button
                            disabled={!pasteCode.trim()}
                            onClick={() => void submitOAuthCode()}
                          >
                            <Trans>Submit</Trans>
                          </Button>
                        </div>
                        <p className="mt-2 text-sm text-muted-foreground">
                          <Plural
                            value={Math.ceil(oauth.expiresInSeconds / 60)}
                            one="Waiting for sign-in — the link expires in about # minute."
                            other="Waiting for sign-in — the link expires in about # minutes."
                          />
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-sm text-muted-foreground">
                          {popupBlocked ? (
                            <Trans>
                              Open{" "}
                              <a
                                href={oauth.verificationUri}
                                target="_blank"
                                rel="noreferrer"
                                className="text-foreground underline"
                              >
                                {oauth.verificationUri.replace(/^https:\/\//, "")}
                              </a>{" "}
                              and enter this code:
                            </Trans>
                          ) : (
                            <Trans>
                              A sign-in tab opened at{" "}
                              <a
                                href={oauth.verificationUri}
                                target="_blank"
                                rel="noreferrer"
                                className="text-foreground underline"
                              >
                                {oauth.verificationUri.replace(/^https:\/\//, "")}
                              </a>
                              . Enter this code there — this window keeps waiting:
                            </Trans>
                          )}
                        </p>
                        <div className="mt-2 flex items-center gap-3">
                          <p className="font-mono text-[22px] tracking-[0.2em] text-foreground">
                            {oauth.userCode}
                          </p>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => copyOAuthCode(oauth.userCode)}
                          >
                            {codeCopied ? (
                              <Check size={14} strokeWidth={1.8} aria-hidden="true" />
                            ) : (
                              <Copy size={14} strokeWidth={1.8} aria-hidden="true" />
                            )}
                            {codeCopied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
                          </Button>
                        </div>
                        <p className="mt-2 text-sm text-muted-foreground">
                          <Plural
                            value={Math.ceil(oauth.expiresInSeconds / 60)}
                            one="Waiting for sign-in — the code expires in about # minute."
                            other="Waiting for sign-in — the code expires in about # minutes."
                          />
                        </p>
                      </>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-2 -ml-2 text-muted-foreground"
                      onClick={() => cancelOAuthAttempt()}
                    >
                      <Trans>Cancel</Trans>
                    </Button>
                  </div>
                ) : (
                  <Button disabled={oauthPending} onClick={() => beginSelectedSubscriptionSignIn()}>
                    {oauthPending ? <Trans>Starting…</Trans> : signInLabel}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  className="mt-3"
                  disabled={oauthPending || preflightTesting}
                  onClick={() => void testOAuthConnection()}
                >
                  {modelPreflightTestingLabel(
                    preflightTesting && preflightTarget === "sign-in",
                    "sign-in",
                  )}
                </Button>
                {preflightTarget === "sign-in" ? (
                  <ModelPreflightFeedback success={preflightSuccess} failure={preflightFailure} />
                ) : null}
              </div>
            ) : null}
            {isCloudflareGateway && acceptsKey ? (
              <div className="mt-4 grid gap-4">
                <label
                  htmlFor={`${fieldId}-account-id`}
                  className="block text-sm font-medium text-foreground"
                >
                  <Trans>Account ID</Trans>
                  <Input
                    id={`${fieldId}-account-id`}
                    value={accountId}
                    onChange={(event) => setAccountId(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    className="mt-2"
                  />
                </label>
                <label
                  htmlFor={`${fieldId}-gateway-id`}
                  className="block text-sm font-medium text-foreground"
                >
                  <Trans>Gateway ID</Trans>
                  <Input
                    id={`${fieldId}-gateway-id`}
                    value={gatewayId}
                    onChange={(event) => setGatewayId(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    className="mt-2"
                  />
                </label>
              </div>
            ) : null}
            {acceptsKey && !isOpenAiCompatible ? (
              <label
                htmlFor={`${fieldId}-api-key`}
                className="mt-4 block text-sm font-medium text-foreground"
              >
                {subscriptionSignIn ? <Trans>Or paste an API key</Trans> : <Trans>API key</Trans>}
                <Input
                  id={`${fieldId}-api-key`}
                  value={apiKey}
                  onChange={(e) => updateApiKey(e.target.value)}
                  placeholder="sk-…"
                  type="password"
                  autoComplete="new-password"
                  className="mt-2"
                />
              </label>
            ) : null}
            {acceptsKey && !isOpenAiCompatible && selected?.catalogProbe ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  className="mt-3"
                  disabled={preflightTesting || apiKey.trim().length < 8}
                  onClick={() => void testApiKeyConnection()}
                >
                  {modelPreflightTestingLabel(
                    preflightTesting && preflightTarget === "api-key",
                    "api-key",
                  )}
                </Button>
                {preflightTarget === "api-key" ? (
                  <ModelPreflightFeedback success={preflightSuccess} failure={preflightFailure} />
                ) : null}
              </>
            ) : null}
            {notice ? (
              <p className="mt-3 text-sm text-success" role="status">
                {notice}
              </p>
            ) : null}
            <div className="mt-3">
              <ModelConfigurationConflictNotice
                conflict={compatible.conflict}
                busy={savingModel}
                onReload={() => void reloadCompatibleModels()}
              />
            </div>
            {error ? (
              <p className="mt-3 text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            <div className="mt-6 flex gap-3">
              <Button disabled={!canSaveModel} onClick={() => void saveModel()}>
                <Trans>Continue</Trans>
              </Button>
            </div>
          </div>
        ) : null}
        {step === "integrations" ? (
          <IntegrationSetup
            serverSetup
            initialState={integrationSetup}
            onDone={() => setStep("bot")}
            onServerConnected={(id) =>
              setIntegrationServers((current) => [...new Set([...current, id])])
            }
          />
        ) : null}
        {step === "bot" ? (
          <div>
            {error ? (
              <div>
                <p className="text-sm text-destructive">{error}</p>
                <Button className="mt-4" onClick={() => void createFirstBot()}>
                  <Trans>Try again</Trans>
                </Button>
              </div>
            ) : (
              <p className="text-muted-foreground">
                <Trans>Opening chat…</Trans>
              </p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
