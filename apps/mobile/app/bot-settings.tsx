import type {
  ComputerMode,
  MemoryBank,
  MemoryScopeValue,
  SpaceMemoryConfig,
  ThinkingLevel,
} from "@rakazo/contracts";
import {
  BOT_COLORS,
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
  MemoryScopeSchema,
  normalizeCreateBotProfile,
} from "@rakazo/contracts";
import {
  connectedModelChoices,
  modelOptionKey,
  parseModelOptionKey,
  resolveSelectableModelId,
} from "@rakazo/core";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import type { Voice } from "expo-speech";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { BotAvatar } from "../components/bot-avatar";
import { ComputerModePicker } from "../components/computer-mode-picker";
import { glassHeaderOptions } from "../components/glass-title";
import type { MenuPickerChoice } from "../components/menu-picker";
import { MenuPicker, MenuPickerMenu } from "../components/menu-picker";
import { NativeActionButton } from "../components/native-action-button";
import { NativeSwitch } from "../components/native-switch";
import { NativeSymbol } from "../components/native-symbol";
import { Chevron } from "../components/row-accessories";
import type {
  ApiRequestContext,
  MobileBot,
  MobileMe,
  MobileModel,
  MobileModelCredential,
} from "../lib/api";
import { apiScopeKey, captureApiRequestContext, rpc } from "../lib/api";
import { deviceVoices, setVoiceForBot, voiceForBot, voiceLabel } from "../lib/bot-voices";
import { COMPUTER_LIFECYCLE_TIMEOUT_MS } from "../lib/computer";
import { loadDeviceVoiceEnabled } from "../lib/device-voice";
import { useI18n } from "../lib/i18n";
import {
  MEMORY_LOOKUP_TIMEOUT_MS,
  MEMORY_MUTATION_TIMEOUT_MS,
  memoryErrorText,
  memoryRequiresServerUpdate,
  memoryScopeLabel,
  readMemoryConfig,
} from "../lib/memory";
import { registerMemoryBankSelection } from "../lib/memory-bank-selection";
import { native, useMobileTokens, useThemedStyles } from "../lib/native";
import { errorText } from "../lib/user-error";
import { stopVoicePlayback } from "../lib/voice";

type BotSettingsRecord = MobileBot & {
  description?: string;
  memoryScope?: MemoryScopeValue | null;
};

type MemoryConfigState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; config: SpaceMemoryConfig | null }
  | { status: "outdated" };

type MemoryBankUpdate = {
  configId: string;
  expectedBindingId: string | null;
  bankId: string | null;
};

export default function BotSettingsScreen() {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const router = useRouter();
  const { botId } = useLocalSearchParams<{ botId: string }>();
  const [bot, setBot] = useState<BotSettingsRecord | null>(null);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState<string>(BOT_COLORS[0]);
  const [computerMode, setComputerMode] = useState<ComputerMode>("team");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [modelKey, setModelKey] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("");
  const [autoSpeak, setAutoSpeak] = useState(false);
  const [credentials, setCredentials] = useState<MobileModelCredential[]>([]);
  const [catalog, setCatalog] = useState<MobileModel[]>([]);
  const [me, setMe] = useState<MobileMe | null>(null);
  const [modelMetaReady, setModelMetaReady] = useState(false);
  const [modelMetaError, setModelMetaError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deviceVoiceEnabled, setDeviceVoiceEnabled] = useState(false);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceId, setVoiceId] = useState<string | undefined>();
  const savedVoiceId = useRef<string | undefined>(undefined);
  const voiceChoice = useRef(0);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [memory, setMemory] = useState<{ state: MemoryConfigState; scopeKey: string }>(() => ({
    state: { status: "loading" },
    scopeKey: apiScopeKey(),
  }));
  const [memoryBankDraft, setMemoryBankDraft] = useState<MemoryBank | null | undefined>();
  const [memoryScopeDraft, setMemoryScopeDraft] = useState<MemoryScopeValue | null>(null);
  const memoryLoad = useRef(0);
  const memoryConfigId = useRef<string | null>(null);
  const memoryRegistration = useRef<{ unregister: () => void } | null>(null);

  useEffect(() => {
    if (!botId) return;
    void rpc<BotSettingsRecord>("bots/get", { botId })
      .then((next) => {
        setBot(next);
        setName(next.name);
        setTitle(next.title);
        setDescription(next.description ?? "");
        setColor(next.color);
        setComputerMode(next.computerMode);
        setModelKey(
          next.modelProvider && next.modelId
            ? modelOptionKey(next.modelProvider, next.modelId)
            : "",
        );
        setThinkingLevel(next.thinkingLevel ?? "");
        setAutoSpeak(next.autoSpeak);
        setMemoryScopeDraft(next.memoryScope ?? null);
      })
      .catch((err) => setError(errorText(err, t("Could not load bot"))));
  }, [botId]);

  useEffect(() => {
    void Promise.all([
      rpc<MobileMe>("me"),
      rpc<MobileModel[]>("models/list"),
      rpc<MobileModelCredential[]>("models/credentials"),
    ])
      .then(([nextMe, nextCatalog, nextCredentials]) => {
        setMe(nextMe);
        setCatalog(nextCatalog);
        setCredentials(nextCredentials);
        setModelMetaError(null);
        setModelMetaReady(true);
      })
      .catch((err) => {
        setModelMetaReady(false);
        setModelMetaError(errorText(err, t("Could not load model settings")));
      });
  }, [t]);

  const loadMemoryConfig = useCallback(async () => {
    const load = ++memoryLoad.current;
    const scopeKey = apiScopeKey();
    let state: MemoryConfigState;
    try {
      const requestContext = await captureApiRequestContext();
      if (load !== memoryLoad.current || apiScopeKey() !== scopeKey) return;
      const config = readMemoryConfig(
        await rpc<unknown>(
          "memory/providerConfig",
          {},
          { timeoutMs: MEMORY_LOOKUP_TIMEOUT_MS, requestContext },
        ),
      );
      state = config === "outdated" ? { status: "outdated" } : { status: "ready", config };
    } catch (err) {
      state = memoryRequiresServerUpdate(err)
        ? { status: "outdated" }
        : { status: "error", message: memoryErrorText(err, t("Could not load memory settings.")) };
    }
    if (load !== memoryLoad.current || apiScopeKey() !== scopeKey) return;
    if (state.status !== "error") {
      const configId = state.status === "ready" ? (state.config?.id ?? null) : null;
      if (configId !== memoryConfigId.current) setMemoryBankDraft(undefined);
      memoryConfigId.current = configId;
    }
    setMemory({ state, scopeKey });
  }, [t]);

  useFocusEffect(
    useCallback(() => {
      void loadMemoryConfig();
    }, [loadMemoryConfig]),
  );

  useEffect(() => () => memoryRegistration.current?.unregister(), []);

  const connectedOptions = useMemo(
    () => connectedModelChoices(credentials, catalog),
    [catalog, credentials],
  );
  const storedModel = modelKey ? parseModelOptionKey(modelKey) : null;
  const selectedModel = storedModel
    ? {
        provider: storedModel.provider,
        modelId: resolveSelectableModelId(catalog, storedModel.provider, storedModel.modelId),
      }
    : null;
  const selectedModelKey = selectedModel
    ? modelOptionKey(selectedModel.provider, selectedModel.modelId)
    : "";

  const effectiveProvider = selectedModel?.provider ?? me?.defaultProvider ?? null;
  const effectiveModelId = selectedModel?.modelId ?? me?.defaultModel ?? null;
  const effectiveEntry =
    effectiveProvider && effectiveModelId
      ? catalog.find(
          (entry) =>
            entry.provider === effectiveProvider &&
            resolveSelectableModelId(catalog, entry.provider, entry.id) === effectiveModelId,
        )
      : undefined;
  const effectiveCredential = credentials.find(
    (entry) => entry.provider === effectiveProvider && entry.modelId === effectiveModelId,
  );
  const thinkingOptions = (
    effectiveCredential?.thinkingLevels ??
    effectiveEntry?.thinkingLevels ??
    []
  ).filter((level) => level !== "off");

  const spaceDefaultLabel = me?.defaultModel
    ? `${t("Space default")} (${catalogLabel(catalog, me.defaultProvider, me.defaultModel) ?? me.defaultModel})`
    : t("Space default");

  const modelChoices: MenuPickerChoice[] = useMemo(() => {
    const choices: MenuPickerChoice[] = [{ key: "", label: spaceDefaultLabel }];
    if (selectedModelKey && !connectedOptions.some((option) => option.key === selectedModelKey)) {
      choices.push({
        key: selectedModelKey,
        label: selectedModel?.modelId ?? selectedModelKey,
      });
    }
    for (const option of connectedOptions) {
      choices.push({ key: option.key, label: option.label });
    }
    return choices;
  }, [connectedOptions, selectedModel?.modelId, selectedModelKey, spaceDefaultLabel]);

  const thinkingChoices: MenuPickerChoice[] = useMemo(
    () => [
      { key: "", label: t("Default (medium)") },
      ...thinkingOptions.map((level) => ({
        key: level,
        label: thinkingLevelLabel(level, t),
      })),
    ],
    [t, thinkingOptions],
  );

  function selectModel(key: string) {
    if (key === selectedModelKey) return;
    setModelKey(key);
    setThinkingLevel("");
  }

  function applyVoices(available: Voice[], assigned: string | undefined) {
    setVoices(available);
    savedVoiceId.current = assigned;
    setVoiceId(assigned);
    setVoiceError(null);
  }

  function failVoices() {
    setVoices([]);
    setVoiceError(t("Could not load voices"));
  }

  useFocusEffect(
    useCallback(() => {
      let current = true;
      void loadDeviceVoiceEnabled()
        .then((enabled) => {
          if (current) setDeviceVoiceEnabled(enabled);
        })
        .catch(() => {
          if (current) setDeviceVoiceEnabled(false);
        });
      return () => {
        current = false;
      };
    }, []),
  );

  useEffect(() => {
    if (!botId || !deviceVoiceEnabled) return;
    let current = true;
    void Promise.all([deviceVoices(), voiceForBot(botId)])
      .then(([available, assigned]) => {
        if (!current) return;
        applyVoices(available, assigned);
      })
      .catch(() => {
        if (!current) return;
        failVoices();
      });
    return () => {
      current = false;
    };
  }, [botId, deviceVoiceEnabled, t]);

  async function chooseVoice(voice: Voice) {
    if (!botId) return;
    // Picking a voice cuts off a reply in progress before the sample starts.
    stopVoicePlayback();
    const choice = ++voiceChoice.current;
    setVoiceId(voice.identifier);
    setError(null);
    try {
      await setVoiceForBot(botId, voice.identifier);
      savedVoiceId.current = voice.identifier;
    } catch {
      if (choice !== voiceChoice.current) return;
      setVoiceId(savedVoiceId.current);
      setError(t("Could not save that voice"));
      return;
    }
    if (choice !== voiceChoice.current) return;
    try {
      const Speech = await import("expo-speech");
      if (choice !== voiceChoice.current) return;
      await Speech.stop();
      if (choice !== voiceChoice.current) return;
      const sampleName = name.trim();
      Speech.speak(
        sampleName ? t("Hi, I'm {name}.", { name: sampleName }) : t("Hi, this is how I'll sound."),
        { voice: voice.identifier },
      );
    } catch {
      // The choice is already saved. A sample that cannot play is not a failed save.
    }
  }

  const currentVoice = voices.find((voice) => voice.identifier === voiceId);
  const currentVoiceLabel = currentVoice ? voiceLabel(currentVoice) : t("Default");

  async function retryDeviceVoices() {
    if (!botId) return;
    try {
      const [available, assigned] = await Promise.all([deviceVoices(), voiceForBot(botId)]);
      applyVoices(available, assigned);
    } catch {
      failVoices();
    }
  }

  const memoryConfig = memory.state.status === "ready" ? memory.state.config : null;
  const memoryOutdated =
    memory.state.status === "outdated" || (bot !== null && !("memoryBank" in bot));
  const committedMemoryBank = bot?.memoryBank ?? null;
  const shownMemoryBank = memoryBankDraft === undefined ? committedMemoryBank : memoryBankDraft;
  const memoryBankChanged =
    memoryBankDraft !== undefined &&
    (memoryBankDraft?.bankId ?? null) !== (committedMemoryBank?.bankId ?? null);
  const memoryScopeEditable =
    !memoryOutdated &&
    memoryConfig !== null &&
    !memoryConfig.capabilities.banks &&
    memoryConfig.capabilities.sharedScope;

  function openMemoryBank(config: SpaceMemoryConfig) {
    if (!botId) return;
    const scopeKey = apiScopeKey();
    if (scopeKey !== memory.scopeKey) {
      void loadMemoryConfig();
      return;
    }
    const configId = config.id;
    memoryRegistration.current?.unregister();
    const registration = registerMemoryBankSelection({
      botId,
      configId,
      scopeKey,
      selectedBankId: shownMemoryBank?.bankId ?? null,
      deliver: (bank) => {
        if (memoryConfigId.current === configId) setMemoryBankDraft(bank);
      },
    });
    memoryRegistration.current = registration;
    router.push({
      pathname: "/memory-bank",
      params: { token: registration.token, botId, configId, scopeKey },
    });
  }

  function save() {
    if (!botId || !bot || pending) return;
    if (!memoryBankChanged) {
      void persist(undefined);
      return;
    }
    if (memory.state.status === "error") {
      setError(memory.state.message);
      return;
    }
    if (memoryOutdated || !memoryConfig?.capabilities.banks || memory.scopeKey !== apiScopeKey()) {
      setMemoryBankDraft(undefined);
      setError(t("The memory connection changed. Choose a bank again."));
      return;
    }
    const memoryBank: MemoryBankUpdate = {
      configId: memoryConfig.id,
      expectedBindingId: committedMemoryBank?.id ?? null,
      bankId: memoryBankDraft?.bankId ?? null,
    };
    if (!committedMemoryBank) {
      void persist(memoryBank);
      return;
    }
    Alert.alert(
      t("Change memory bank?"),
      t("Existing memories stay in their current bank; processing already started may finish."),
      [
        { text: t("Cancel"), style: "cancel" },
        { text: t("Continue"), onPress: () => void persist(memoryBank) },
      ],
    );
  }

  async function persist(memoryBank: MemoryBankUpdate | undefined) {
    if (!botId || !bot || pending) return;
    setPending(true);
    setError(null);
    const memoryScopeKey = memory.scopeKey;
    const memoryConnectionChanged = () => {
      if (apiScopeKey() === memoryScopeKey && memoryConfigId.current === memoryBank?.configId) {
        return false;
      }
      setMemoryBankDraft(undefined);
      setError(t("The memory connection changed. Choose a bank again."));
      return true;
    };
    let memoryContext: ApiRequestContext | undefined;
    let memoryBankSent = false;
    try {
      if (memoryBank && memoryConnectionChanged()) return;
      const profile = normalizeCreateBotProfile({ name, title, description });
      const selected = selectedModel;
      const input: {
        botId: string;
        name?: string;
        title?: string;
        description?: string;
        instructions?: string;
        color?: string;
        modelProvider?: string | null;
        modelId?: string | null;
        thinkingLevel?: ThinkingLevel | null;
        autoSpeak?: boolean;
        memoryScope?: MemoryScopeValue | null;
        memoryBank?: MemoryBankUpdate;
      } = { botId };
      if (profile.name !== bot.name) input.name = profile.name;
      if (profile.title !== bot.title) input.title = profile.title;
      if (profile.description !== (bot.description ?? "")) {
        input.description = profile.description;
        // Keep instructions in sync with description (same as web BotSettings).
        input.instructions = profile.instructions;
      }
      if (color !== bot.color) input.color = color;
      const modelChanged =
        (selected?.provider ?? null) !== (bot.modelProvider ?? null) ||
        (selected?.modelId ?? null) !== (bot.modelId ?? null);
      const thinkingChanged = (thinkingLevel || null) !== (bot.thinkingLevel ?? null);
      if (modelChanged) {
        input.modelProvider = selected?.provider ?? null;
        input.modelId = selected?.modelId ?? null;
      }
      if (modelMetaReady && (modelChanged || thinkingChanged)) {
        input.thinkingLevel = thinkingOptions.length
          ? ((thinkingLevel || null) as ThinkingLevel | null)
          : null;
      }
      if (autoSpeak !== bot.autoSpeak) input.autoSpeak = autoSpeak;
      if (memoryScopeEditable && memoryScopeDraft !== (bot.memoryScope ?? null)) {
        input.memoryScope = memoryScopeDraft;
      }
      if (memoryBank) input.memoryBank = memoryBank;
      if (computerMode !== bot.computerMode) {
        await rpc(
          "bots/setComputer",
          { botId, mode: computerMode },
          { timeoutMs: COMPUTER_LIFECYCLE_TIMEOUT_MS },
        );
      }
      // Use key presence so clearing title/description to "" still persists.
      if (Object.keys(input).length > 1) {
        if (memoryBank) {
          memoryContext = await captureApiRequestContext();
          if (memoryConnectionChanged()) return;
        }
        memoryBankSent = memoryContext !== undefined;
        await rpc(
          "bots/update",
          input,
          memoryContext
            ? { timeoutMs: MEMORY_MUTATION_TIMEOUT_MS, requestContext: memoryContext }
            : {},
        );
      }
      router.back();
    } catch (err) {
      if (memoryBankSent) {
        setMemoryBankDraft(undefined);
        void rpc<BotSettingsRecord>("bots/get", { botId })
          .then((next) => {
            if (apiScopeKey() === memoryScopeKey) setBot(next);
          })
          .catch(() => undefined);
        void loadMemoryConfig();
        setError(memoryErrorText(err, t("Could not save bot")));
      } else {
        setError(errorText(err, t("Could not save bot")));
      }
    } finally {
      setPending(false);
    }
  }

  const voiceValue = (
    <Text
      numberOfLines={1}
      style={[styles.rowValue, { color: voiceError ? tokens.destructive : tokens.foreground }]}
    >
      {voiceError ?? currentVoiceLabel}
    </Text>
  );
  const voiceRow = (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: tokens.mutedForeground }]}>{t("Device voice")}</Text>
      {!voiceError && voices.length > 1 ? (
        <MenuPickerMenu
          choices={voices.map((voice) => ({
            key: voice.identifier,
            label: voiceLabel(voice),
          }))}
          label={t("Device voice")}
          onChange={(key) => {
            const voice = voices.find((candidate) => candidate.identifier === key);
            if (voice) void chooseVoice(voice);
          }}
          value={voiceId ?? ""}
        >
          <View
            accessibilityLabel={t("Device voice")}
            accessibilityRole="button"
            accessibilityValue={{ text: currentVoiceLabel }}
            accessible
            style={styles.voiceTrigger}
          >
            {voiceValue}
            <NativeSymbol
              android="chevron-expand"
              color={native.tertiaryLabel}
              ios="chevron.up.chevron.down"
              size={13}
            />
          </View>
        </MenuPickerMenu>
      ) : (
        voiceValue
      )}
    </View>
  );

  function memoryControl(): ReactNode {
    const state = memory.state;
    if (state.status === "ready" && state.config === null) return null;
    if (memoryOutdated) {
      return (
        <MemorySettingRow
          label={t("Memory")}
          value={t("Memory settings require a server update.")}
        />
      );
    }
    if (state.status === "error") {
      return (
        <MemorySettingRow
          label={t("Memory")}
          onPress={() => void loadMemoryConfig()}
          value={t("Could not load memory settings.")}
        />
      );
    }
    if (state.status !== "ready" || !state.config) return null;
    const config = state.config;
    if (config.capabilities.banks) {
      return (
        <MemorySettingRow
          chevron
          disabled={pending}
          label={t("Memory")}
          onPress={() => openMemoryBank(config)}
          value={shownMemoryBank?.name ?? t("Built-in")}
        />
      );
    }
    if (!config.capabilities.sharedScope) return null;
    return (
      <MenuPicker
        choices={[
          { key: "", label: memoryScopeLabel(null) },
          { key: "isolated", label: memoryScopeLabel("isolated") },
          { key: "shared", label: memoryScopeLabel("shared") },
        ]}
        label={t("Memory scope")}
        onChange={(key) => setMemoryScopeDraft(MemoryScopeSchema.safeParse(key).data ?? null)}
        value={memoryScopeDraft ?? ""}
      />
    );
  }
  const memoryRow = memoryControl();

  return (
    <>
      <Stack.Screen options={glassHeaderOptions(t("Chat settings"))} />
      <ScrollView
        style={{ flex: 1, backgroundColor: tokens.background }}
        contentContainerStyle={{ padding: 24 }}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {bot ? (
          <View style={{ alignItems: "center", marginBottom: 24 }}>
            <BotAvatar color={color} identity={bot.id} size={64} status={bot.status} />
          </View>
        ) : null}
        <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{t("Name")}</Text>
        <TextInput
          value={name}
          maxLength={BOT_NAME_MAX_LENGTH}
          onChangeText={setName}
          placeholder={t("Name this bot")}
          placeholderTextColor={tokens.mutedForeground}
          style={{
            marginTop: 8,
            backgroundColor: native.fill,
            borderRadius: 11,
            padding: 16,
            color: tokens.foreground,
          }}
        />
        <Text style={{ color: tokens.mutedForeground, marginTop: 16, fontSize: 14 }}>
          {t("Title")}
        </Text>
        <TextInput
          value={title}
          maxLength={BOT_TITLE_MAX_LENGTH}
          onChangeText={setTitle}
          placeholder={t("Describe what this bot does")}
          placeholderTextColor={tokens.mutedForeground}
          style={{
            marginTop: 8,
            backgroundColor: native.fill,
            borderRadius: 11,
            padding: 16,
            color: tokens.foreground,
          }}
        />
        <Text style={{ color: tokens.mutedForeground, marginTop: 16, fontSize: 14 }}>
          {t("Description")}
        </Text>
        <TextInput
          value={description}
          maxLength={BOT_DESCRIPTION_MAX_LENGTH}
          onChangeText={setDescription}
          placeholder={t("What this bot is for")}
          placeholderTextColor={tokens.mutedForeground}
          multiline
          style={{
            marginTop: 8,
            backgroundColor: native.fill,
            borderRadius: 11,
            padding: 16,
            color: tokens.foreground,
            minHeight: 120,
            textAlignVertical: "top",
          }}
        />
        <Text style={{ color: tokens.mutedForeground, marginTop: 16, fontSize: 14 }}>
          {t("Color")}
        </Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 10, marginTop: 8 }}
          accessibilityRole="radiogroup"
        >
          {BOT_COLORS.map((option, index) => (
            <Pressable
              key={option}
              accessibilityRole="radio"
              accessibilityLabel={t("Color {number}", { number: index + 1 })}
              accessibilityState={{ checked: color === option }}
              onPress={() => setColor(option)}
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: option,
                borderWidth: 3,
                borderColor: color === option ? tokens.foreground : "transparent",
              }}
            />
          ))}
        </ScrollView>
        <ComputerModePicker value={computerMode} onChange={setComputerMode} />
        <View style={[styles.row, { marginTop: 20 }]}>
          <Text style={[styles.rowLabel, { color: tokens.mutedForeground }]}>
            {t("Read replies aloud")}
          </Text>
          <NativeSwitch
            accessibilityLabel={t("Read replies aloud")}
            onValueChange={setAutoSpeak}
            value={autoSpeak}
          />
        </View>
        {deviceVoiceEnabled ? (
          voiceError ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Device voice")}
              accessibilityValue={{ text: voiceError }}
              onPress={() => void retryDeviceVoices()}
            >
              {voiceRow}
            </Pressable>
          ) : (
            voiceRow
          )
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Advanced")}
          accessibilityState={{ expanded: advancedOpen }}
          onPress={() => setAdvancedOpen((open) => !open)}
          style={{
            marginTop: 20,
            minHeight: 44,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{t("Advanced")}</Text>
          <Chevron expanded={advancedOpen} />
        </Pressable>
        {advancedOpen ? (
          <View>
            <View
              style={{
                marginTop: 8,
                borderRadius: 14,
                backgroundColor: native.fill,
                overflow: "hidden",
              }}
            >
              <MenuPicker
                choices={modelChoices}
                label={t("Model")}
                onChange={selectModel}
                value={selectedModelKey}
              />
              {thinkingOptions.length ? (
                <MenuPicker
                  choices={thinkingChoices}
                  divider
                  label={t("Thinking")}
                  onChange={setThinkingLevel}
                  value={thinkingLevel}
                />
              ) : null}
            </View>
            {modelMetaError ? (
              <Text style={{ color: tokens.mutedForeground, marginTop: 12, fontSize: 13 }}>
                {modelMetaError}
              </Text>
            ) : null}
            {memoryRow ? (
              <View
                style={{
                  marginTop: 12,
                  borderRadius: 14,
                  backgroundColor: native.fill,
                  overflow: "hidden",
                }}
              >
                {memoryRow}
              </View>
            ) : null}
          </View>
        ) : null}
        {error ? <Text style={{ color: tokens.destructive, marginTop: 16 }}>{error}</Text> : null}
        <NativeActionButton
          disabled={!name.trim() || pending || !bot}
          label={pending ? t("Saving…") : t("Save")}
          onPress={save}
          style={{ marginTop: 24 }}
        />
      </ScrollView>
    </>
  );
}

function catalogLabel(
  catalog: MobileModel[],
  provider: string | null | undefined,
  modelId: string,
) {
  if (!provider) return undefined;
  return catalog.find((entry) => entry.provider === provider && entry.id === modelId)?.label;
}

function thinkingLevelLabel(level: ThinkingLevel, t: (message: string) => string) {
  if (level === "xhigh") return t("Extra high");
  if (level === "low") return t("Low");
  if (level === "medium") return t("Medium");
  if (level === "high") return t("High");
  if (level === "minimal") return t("Minimal");
  if (level === "max") return t("Max");
  return `${level.slice(0, 1).toUpperCase()}${level.slice(1)}`;
}

function MemorySettingRow({
  label,
  value,
  chevron = false,
  disabled = false,
  onPress,
}: {
  label: string;
  value: string;
  chevron?: boolean;
  disabled?: boolean;
  onPress?: () => void;
}) {
  const memoryStyles = useThemedStyles(createMemoryRowStyles);
  const content = (
    <>
      <Text style={memoryStyles.label}>{label}</Text>
      <Text numberOfLines={1} style={memoryStyles.value}>
        {value}
      </Text>
      {chevron ? <Chevron /> : null}
    </>
  );
  if (!onPress) {
    return (
      <View
        accessibilityLabel={label}
        accessibilityValue={{ text: value }}
        accessible
        style={memoryStyles.row}
      >
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      accessibilityValue={{ text: value }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        memoryStyles.row,
        pressed && memoryStyles.pressed,
        disabled && memoryStyles.disabled,
      ]}
    >
      {content}
    </Pressable>
  );
}

function createMemoryRowStyles() {
  return StyleSheet.create({
    row: {
      minHeight: 52,
      paddingHorizontal: 16,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    label: { color: native.label, fontSize: 16 },
    value: { flex: 1, color: native.secondaryLabel, textAlign: "right", fontSize: 16 },
    pressed: { backgroundColor: native.fillPressed },
    disabled: { opacity: 0.45 },
  });
}

const styles = StyleSheet.create({
  row: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  rowLabel: { fontSize: 14, flex: 1 },
  voiceTrigger: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  rowValue: { fontSize: 14, flexShrink: 1, textAlign: "right" },
});
