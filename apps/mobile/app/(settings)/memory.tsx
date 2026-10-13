import type { MemoryScopeValue, SpaceMemoryConfig } from "@rakazo/contracts";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { MenuPicker } from "../../components/menu-picker";
import { NativeActionButton } from "../../components/native-action-button";
import {
  SettingsFooter,
  SettingsGroup,
  SettingsRow,
  useStackedSettings,
} from "../../components/settings-group";
import type { ApiRequestContext, MobileSpaceNavigation } from "../../lib/api";
import { apiScopeKey, captureApiRequestContext, rpc, subscribeApiBase } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import {
  HINDSIGHT_CLOUD_ORIGIN,
  HINDSIGHT_PROVIDER_ID,
  MEMORY_LOOKUP_TIMEOUT_MS,
  MEMORY_MUTATION_TIMEOUT_MS,
  memoryErrorText,
  memoryFailureReason,
  memoryProviderLabel,
  memoryRequiresServerUpdate,
  memoryScopeLabel,
  readMemoryConfig,
  rpcErrorStatus,
} from "../../lib/memory";
import { native, useThemedStyles } from "../../lib/native";
import { subscribeSessionGeneration } from "../../lib/session";

type MemoryScreenState =
  | { kind: "loading" }
  | { kind: "failed"; error: unknown }
  | { kind: "outdated" }
  | { kind: "ready"; config: SpaceMemoryConfig | null; owner: boolean };

export default function MemorySettings() {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const stacked = useStackedSettings();
  const [state, setState] = useState<MemoryScreenState>({ kind: "loading" });
  const [apiKey, setApiKey] = useState("");
  const [bankId, setBankId] = useState("");
  const [bankIdShown, setBankIdShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const dataScope = useRef<string | null>(null);
  const mutating = useRef(false);

  function clearSecrets() {
    setApiKey("");
    setBankId("");
    setBankIdShown(false);
  }

  function reload() {
    const generation = ++loadGeneration.current;
    const scope = apiScopeKey();
    if (scope !== dataScope.current) {
      dataScope.current = scope;
      clearSecrets();
      setMutationError(null);
      setState({ kind: "loading" });
    }
    void (async () => {
      const requestContext = await captureApiRequestContext();
      if (generation !== loadGeneration.current) return;
      if (apiScopeKey() !== scope) {
        reload();
        return;
      }
      const [rawConfig, navigation] = await Promise.all([
        rpc<unknown>(
          "memory/providerConfig",
          {},
          { requestContext, timeoutMs: MEMORY_LOOKUP_TIMEOUT_MS },
        ),
        rpc<MobileSpaceNavigation>("spaces/list", {}, { requestContext }),
      ]);
      if (generation !== loadGeneration.current) return;
      if (apiScopeKey() !== scope) {
        reload();
        return;
      }
      const config = readMemoryConfig(rawConfig);
      if (config === "outdated") {
        setState({ kind: "outdated" });
        return;
      }
      if (config) clearSecrets();
      setState({
        kind: "ready",
        config,
        owner:
          navigation.spaces.find((space) => space.id === navigation.current.id)?.canRename === true,
      });
    })().catch((error: unknown) => {
      if (generation !== loadGeneration.current) return;
      if (apiScopeKey() !== scope) {
        reload();
        return;
      }
      setState(
        memoryRequiresServerUpdate(error) ? { kind: "outdated" } : { kind: "failed", error },
      );
    });
  }

  useFocusEffect(
    useCallback(() => {
      reload();
      return () => {
        loadGeneration.current += 1;
        clearSecrets();
        setMutationError(null);
      };
    }, []),
  );

  useEffect(() => {
    const resync = () => {
      if (apiScopeKey() !== dataScope.current) reload();
    };
    const unsubscribeApiBase = subscribeApiBase(resync);
    const unsubscribeSession = subscribeSessionGeneration(resync);
    return () => {
      unsubscribeApiBase();
      unsubscribeSession();
    };
  }, []);

  async function mutate<T>(
    fallback: string,
    request: (requestContext: ApiRequestContext) => Promise<T>,
    onSuccess: (result: T) => void,
    onError?: (error: unknown) => void,
  ) {
    if (mutating.current) return;
    if (apiScopeKey() !== dataScope.current) {
      reload();
      return;
    }
    mutating.current = true;
    setBusy(true);
    setMutationError(null);
    const scope = apiScopeKey();
    try {
      const requestContext = await captureApiRequestContext();
      if (apiScopeKey() !== scope) {
        reload();
        return;
      }
      const result = await request(requestContext);
      if (apiScopeKey() !== scope) {
        reload();
        return;
      }
      onSuccess(result);
    } catch (error) {
      if (apiScopeKey() !== scope || rpcErrorStatus(error) === 409) {
        reload();
      } else {
        onError?.(error);
        setMutationError(memoryErrorText(error, fallback));
      }
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  }

  function connect() {
    const key = apiKey.trim();
    const verificationBankId = bankId.trim();
    if (!key || (bankIdShown && !verificationBankId)) return;
    void mutate(
      t("Could not connect"),
      (requestContext) =>
        rpc<unknown>(
          "memory/connectProvider",
          {
            provider: HINDSIGHT_PROVIDER_ID,
            settings: {
              baseUrl: HINDSIGHT_CLOUD_ORIGIN,
              ...(bankIdShown ? { verificationBankId } : {}),
            },
            credentials: { apiKey: key },
            expectedConfigId: null,
          },
          { requestContext, timeoutMs: MEMORY_MUTATION_TIMEOUT_MS },
        ),
      () => {
        clearSecrets();
        reload();
      },
      (error) => {
        if (memoryFailureReason(error) === "bank_id_required") setBankIdShown(true);
      },
    );
  }

  function confirmDisconnect(config: SpaceMemoryConfig, hindsight: boolean) {
    Alert.alert(
      t("Disconnect memory?"),
      hindsight
        ? t(
            "Banks stay in Hindsight Cloud. Pending memory work stops; processing already started may finish.",
          )
        : t("Pending memory work stops; processing already started may finish."),
      [
        { text: t("Cancel"), style: "cancel" },
        {
          text: t("Disconnect"),
          style: "destructive",
          onPress: () =>
            void mutate(
              t("Could not disconnect"),
              (requestContext) =>
                rpc<unknown>(
                  "memory/disconnectProvider",
                  { configId: config.id },
                  { requestContext, timeoutMs: MEMORY_LOOKUP_TIMEOUT_MS },
                ),
              reload,
            ),
        },
      ],
    );
  }

  function chooseDefaultScope(config: SpaceMemoryConfig, key: string) {
    const defaultMemoryScope: MemoryScopeValue = key === "shared" ? "shared" : "isolated";
    if (defaultMemoryScope === config.defaultMemoryScope) return;
    void mutate(
      t("Could not save that preference"),
      (requestContext) =>
        rpc<unknown>(
          "memory/setDefaultScope",
          { configId: config.id, defaultMemoryScope },
          { requestContext, timeoutMs: MEMORY_LOOKUP_TIMEOUT_MS },
        ),
      (result) => {
        const next = readMemoryConfig(result);
        if (next === null || next === "outdated") {
          reload();
          return;
        }
        setState((current) => (current.kind === "ready" ? { ...current, config: next } : current));
      },
    );
  }

  const inputStyle = [styles.input, stacked && styles.compactInput];

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.container, stacked && styles.compactContainer]}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      {state.kind === "loading" && <ActivityIndicator />}
      {state.kind === "outdated" && (
        <SettingsFooter>{t("Memory settings require a server update.")}</SettingsFooter>
      )}
      {state.kind === "failed" && (
        <>
          <SettingsFooter>
            {memoryErrorText(state.error, t("Could not load memory settings."))}
          </SettingsFooter>
          <SettingsGroup>
            <SettingsRow accessibilityRole="button" onPress={reload} title={t("Retry")} />
          </SettingsGroup>
        </>
      )}
      {state.kind === "ready" && state.config === null && !state.owner && (
        <SettingsGroup>
          <SettingsRow title={t("Memory")} value={t("Not connected")} />
        </SettingsGroup>
      )}
      {state.kind === "ready" && state.config === null && state.owner && (
        <>
          <SettingsGroup
            label="Hindsight Cloud"
            footer={t("Bots in this Space can use banks this key can access.")}
          >
            <TextInput
              accessibilityLabel={t("API key")}
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect={false}
              editable={!busy}
              importantForAutofill="no"
              onChangeText={setApiKey}
              placeholder={t("API key")}
              placeholderTextColor={native.tertiaryLabel}
              secureTextEntry
              style={inputStyle}
              textContentType="none"
              value={apiKey}
            />
            {bankIdShown ? (
              <TextInput
                accessibilityLabel={t("Bank ID")}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy}
                onChangeText={setBankId}
                placeholder={t("Bank ID")}
                placeholderTextColor={native.tertiaryLabel}
                style={inputStyle}
                value={bankId}
              />
            ) : null}
          </SettingsGroup>
          <NativeActionButton
            busy={busy}
            disabled={busy || !apiKey.trim() || (bankIdShown && !bankId.trim())}
            label={t("Connect")}
            onPress={connect}
          />
        </>
      )}
      {state.kind === "ready" && state.config !== null && (
        <ConnectedMemory
          busy={busy}
          config={state.config}
          owner={state.owner}
          onChooseScope={chooseDefaultScope}
          onDisconnect={confirmDisconnect}
        />
      )}
      {state.kind === "ready" && mutationError ? (
        <SettingsFooter>{mutationError}</SettingsFooter>
      ) : null}
    </ScrollView>
  );
}

function ConnectedMemory({
  busy,
  config,
  owner,
  onChooseScope,
  onDisconnect,
}: {
  busy: boolean;
  config: SpaceMemoryConfig;
  owner: boolean;
  onChooseScope: (config: SpaceMemoryConfig, key: string) => void;
  onDisconnect: (config: SpaceMemoryConfig, hindsight: boolean) => void;
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const hindsight = config.provider === HINDSIGHT_PROVIDER_ID || config.capabilities.banks;
  return (
    <>
      <SettingsGroup
        label={t("Connected")}
        footer={!hindsight && owner ? t("Disconnect to connect Hindsight Cloud.") : undefined}
      >
        <SettingsRow title={memoryProviderLabel(config)} />
        {config.capabilities.sharedScope && owner ? (
          <View style={busy && styles.inactive}>
            <MenuPicker
              choices={[
                { key: "isolated", label: memoryScopeLabel("isolated") },
                { key: "shared", label: memoryScopeLabel("shared") },
              ]}
              label={t("Default scope")}
              onChange={(key) => onChooseScope(config, key)}
              value={config.defaultMemoryScope}
            />
          </View>
        ) : null}
        {config.capabilities.sharedScope && !owner ? (
          <SettingsRow
            title={t("Default scope")}
            value={memoryScopeLabel(config.defaultMemoryScope)}
          />
        ) : null}
      </SettingsGroup>
      {owner ? (
        <SettingsGroup>
          <SettingsRow
            accessibilityRole="button"
            destructive
            dimmed={busy}
            disabled={busy}
            onPress={() => onDisconnect(config, hindsight)}
            title={t("Disconnect")}
          />
        </SettingsGroup>
      ) : null}
    </>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    container: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32, gap: 28 },
    compactContainer: { paddingHorizontal: 8 },
    input: {
      minHeight: 52,
      paddingHorizontal: 16,
      paddingVertical: 12,
      color: native.label,
      fontSize: 17,
    },
    compactInput: { paddingHorizontal: 12 },
    inactive: { opacity: 0.45, pointerEvents: "none" },
  });
}
