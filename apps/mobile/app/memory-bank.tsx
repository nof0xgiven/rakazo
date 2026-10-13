import type { MemoryBank } from "@rakazo/contracts";
import { MemoryBankIdSchema, MemoryBankNameSchema } from "@rakazo/contracts";
import { newClientId } from "@rakazo/core";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, StyleSheet, Text, TextInput, View } from "react-native";
import { NativeActionButton } from "../components/native-action-button";
import { Checkmark } from "../components/row-accessories";
import { SettingsGroup, SettingsRow } from "../components/settings-group";
import type { ApiRequestContext } from "../lib/api";
import { apiScopeKey, captureApiRequestContext, rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import {
  MEMORY_LOOKUP_TIMEOUT_MS,
  MEMORY_MUTATION_TIMEOUT_MS,
  memoryErrorText,
  memoryFailureReason,
  memoryRequiresServerUpdate,
} from "../lib/memory";
import type { MemoryBankSelectionTarget } from "../lib/memory-bank-selection";
import { deliverMemoryBankSelection, memoryBankSelectionDraft } from "../lib/memory-bank-selection";
import { native, useThemedStyles } from "../lib/native";

type MemoryBankPage = { banks: MemoryBank[]; nextOffset: number | null };

type Selection = MemoryBankSelectionTarget & { token: string; selectedBankId: string | null };

type ListState =
  | { kind: "loading" | "failed" | "outdated" }
  | { kind: "ready"; query: string }
  | { kind: "forbidden"; message: string };

type ListQuery = { generation: number; query: string; signal: AbortSignal };

type CreationIntent = { requestId: string; name: string };

const SEARCH_DEBOUNCE_MS = 200;

export default function MemoryBankScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    token: string;
    botId: string;
    configId: string;
    scopeKey: string;
  }>();
  const [selection] = useState(() => openSelection(params));

  useEffect(() => {
    if (!selection) router.back();
  }, [router, selection]);

  return selection ? <MemoryBankPicker selection={selection} /> : null;
}

function openSelection({
  token,
  botId,
  configId,
  scopeKey,
}: {
  token?: string;
  botId?: string;
  configId?: string;
  scopeKey?: string;
}): Selection | null {
  if (!token || !botId || !configId || !scopeKey || apiScopeKey() !== scopeKey) return null;
  const draft = memoryBankSelectionDraft(token, { botId, configId, scopeKey });
  return draft ? { token, botId, configId, scopeKey, selectedBankId: draft.selectedBankId } : null;
}

function MemoryBankPicker({ selection }: { selection: Selection }) {
  const { token, botId, configId, scopeKey, selectedBankId } = selection;
  const navigation = useNavigation();
  const router = useRouter();
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim();
  const [rows, setRows] = useState<MemoryBank[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [listState, setListState] = useState<ListState>({ kind: "loading" });
  const [reloadCount, setReloadCount] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const [bankIdOpen, setBankIdOpen] = useState(false);
  const [bankIdInput, setBankIdInput] = useState("");
  const [lookupPending, setLookupPending] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [bankName, setBankName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [exiting, setExiting] = useState(false);
  const exitingRef = useRef(false);
  const creatingRef = useRef(false);
  const lookupRef = useRef(false);
  const intentRef = useRef<CreationIntent | null>(null);
  const contextRef = useRef<Promise<ApiRequestContext | null> | null>(null);
  const screenSignalRef = useRef<AbortSignal | null>(null);
  const generationRef = useRef(0);
  const listQueryRef = useRef<ListQuery | null>(null);
  const loadingMoreRef = useRef(false);
  const immediateLoadRef = useRef(true);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerSearchBarOptions: {
        placeholder: t("Search banks"),
        hideWhenScrolling: false,
        autoCapitalize: "none",
        onChangeText: (event: { nativeEvent: { text: string } }) =>
          setQuery(event.nativeEvent.text),
        onCancelButtonPress: () => setQuery(""),
        onClose: () => setQuery(""),
      },
    });
  }, [navigation, t]);

  useLayoutEffect(() => {
    navigation.setOptions({ gestureEnabled: !creating, headerBackVisible: !creating });
  }, [creating, navigation]);

  usePreventRemove(creating, () => {});

  useEffect(() => {
    const controller = new AbortController();
    screenSignalRef.current = controller.signal;
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (exiting && !creating) router.back();
  }, [creating, exiting, router]);

  const leave = useCallback(() => {
    exitingRef.current = true;
    setExiting(true);
  }, []);

  const leftScope = useCallback(() => {
    if (apiScopeKey() === scopeKey) return false;
    leave();
    return true;
  }, [leave, scopeKey]);

  const requestContext = useCallback(() => {
    if (!contextRef.current) {
      const pending = captureApiRequestContext().then((context) =>
        apiScopeKey() === scopeKey ? context : null,
      );
      contextRef.current = pending;
      pending.catch(() => {
        if (contextRef.current === pending) contextRef.current = null;
      });
    }
    return contextRef.current;
  }, [scopeKey]);

  const fetchPage = useCallback(
    async (q: string, offset: number, signal: AbortSignal) => {
      const context = await requestContext();
      if (!context) return null;
      return rpc<MemoryBankPage>(
        "memory/banks",
        { botId, configId, q: q || undefined, offset },
        { signal, timeoutMs: MEMORY_LOOKUP_TIMEOUT_MS, requestContext: context },
      );
    },
    [botId, configId, requestContext],
  );

  const listFailure = useCallback(
    (error: unknown): ListState => {
      if (memoryFailureReason(error) === "bank_list_forbidden") {
        return { kind: "forbidden", message: memoryErrorText(error, t("Could not load banks.")) };
      }
      return memoryRequiresServerUpdate(error) ? { kind: "outdated" } : { kind: "failed" };
    },
    [t],
  );

  useEffect(() => {
    const generation = ++generationRef.current;
    const controller = new AbortController();
    listQueryRef.current = { generation, query: trimmedQuery, signal: controller.signal };
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setMoreFailed(false);
    setRows([]);
    setNextOffset(null);
    setListState({ kind: "loading" });
    const delay = immediateLoadRef.current ? 0 : SEARCH_DEBOUNCE_MS;
    immediateLoadRef.current = false;
    const timer = setTimeout(() => {
      void fetchPage(trimmedQuery, 0, controller.signal).then(
        (page) => {
          if (generation !== generationRef.current || controller.signal.aborted) return;
          if (leftScope() || !page) return;
          setRows(appendBanks([], page.banks));
          setNextOffset(page.nextOffset);
          setListState({ kind: "ready", query: trimmedQuery });
        },
        (error: unknown) => {
          if (generation !== generationRef.current || controller.signal.aborted) return;
          if (leftScope()) return;
          setListState(listFailure(error));
        },
      );
    }, delay);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [fetchPage, leftScope, listFailure, reloadCount, trimmedQuery]);

  async function loadMore() {
    const current = listQueryRef.current;
    if (!current || nextOffset === null || loadingMoreRef.current || listState.kind !== "ready") {
      return;
    }
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setMoreFailed(false);
    try {
      const page = await fetchPage(current.query, nextOffset, current.signal);
      if (current.generation !== generationRef.current || current.signal.aborted) return;
      if (leftScope() || !page) return;
      setRows((loaded) => appendBanks(loaded, page.banks));
      setNextOffset(page.nextOffset);
    } catch (error) {
      if (current.generation !== generationRef.current || current.signal.aborted) return;
      if (leftScope()) return;
      const failure = listFailure(error);
      if (failure.kind === "failed") setMoreFailed(true);
      else setListState(failure);
    } finally {
      if (current.generation === generationRef.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }

  function retryList() {
    immediateLoadRef.current = true;
    setReloadCount((count) => count + 1);
  }

  function choose(bank: MemoryBank | null) {
    if (exitingRef.current) return;
    exitingRef.current = true;
    deliverMemoryBankSelection(token, { botId, configId, scopeKey: apiScopeKey() }, bank);
    setExiting(true);
  }

  async function lookUpBank() {
    const parsed = MemoryBankIdSchema.safeParse(bankIdInput);
    const signal = screenSignalRef.current;
    if (!parsed.success || !signal) return;
    if (lookupRef.current || creatingRef.current || exitingRef.current) return;
    lookupRef.current = true;
    setLookupPending(true);
    setLookupError(null);
    try {
      const context = await requestContext();
      if (signal.aborted || leftScope() || !context) return;
      const bank = await rpc<MemoryBank>(
        "memory/bank",
        { botId, configId, bankId: parsed.data },
        { signal, timeoutMs: MEMORY_LOOKUP_TIMEOUT_MS, requestContext: context },
      );
      if (signal.aborted || leftScope()) return;
      choose(bank);
    } catch (error) {
      if (signal.aborted || leftScope()) return;
      setLookupError(memoryErrorText(error, t("Could not load banks.")));
    } finally {
      lookupRef.current = false;
      if (!signal.aborted) setLookupPending(false);
    }
  }

  async function createBank() {
    const parsed = MemoryBankNameSchema.safeParse(bankName);
    const signal = screenSignalRef.current;
    if (!parsed.success || !signal || creatingRef.current || exitingRef.current) return;
    const intent =
      intentRef.current?.name === parsed.data
        ? intentRef.current
        : { requestId: newClientId(), name: parsed.data };
    intentRef.current = intent;
    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      const context = await requestContext();
      if (signal.aborted || leftScope() || !context) return;
      const bank = await rpc<MemoryBank>(
        "memory/createBank",
        { botId, configId, requestId: intent.requestId, name: intent.name },
        { signal, timeoutMs: MEMORY_MUTATION_TIMEOUT_MS, requestContext: context },
      );
      if (signal.aborted || leftScope()) return;
      choose(bank);
    } catch (error) {
      if (signal.aborted || leftScope()) return;
      setCreateError(memoryErrorText(error, t("Could not create bank")));
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }

  const listNotice =
    listState.kind === "forbidden"
      ? listState.message
      : listState.kind === "outdated"
        ? t("Memory settings require a server update.")
        : null;

  const header = (
    <View style={styles.header}>
      <SettingsGroup footer={t("Bots using the same bank share memory.")}>
        <SettingsRow
          accessibilityRole="button"
          accessibilityState={{ selected: selectedBankId === null, disabled: creating }}
          dimmed={creating}
          disabled={creating}
          onPress={() => choose(null)}
          title={t("Built-in")}
          trailing={selectedBankId === null ? <Checkmark /> : undefined}
        />
      </SettingsGroup>
      <SettingsGroup>
        <SettingsRow
          accessibilityRole="button"
          accessibilityState={{ expanded: bankIdOpen, disabled: creating }}
          chevron={bankIdOpen ? "down" : "right"}
          dimmed={creating}
          disabled={creating}
          onPress={() => setBankIdOpen((open) => !open)}
          title={t("Use bank ID")}
        />
        {bankIdOpen ? (
          <View style={styles.form}>
            <TextInput
              accessibilityLabel={t("Bank ID")}
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect={false}
              editable={!creating && !lookupPending}
              onChangeText={setBankIdInput}
              onSubmitEditing={() => void lookUpBank()}
              placeholder={t("Bank ID")}
              placeholderTextColor={native.tertiaryLabel}
              returnKeyType="done"
              style={styles.input}
              value={bankIdInput}
            />
            {lookupError ? <Text style={styles.error}>{lookupError}</Text> : null}
            <NativeActionButton
              busy={lookupPending}
              disabled={creating || !MemoryBankIdSchema.safeParse(bankIdInput).success}
              label={t("Use")}
              onPress={() => void lookUpBank()}
            />
          </View>
        ) : null}
        <SettingsRow
          accessibilityRole="button"
          accessibilityState={{ expanded: createOpen, disabled: creating }}
          chevron={createOpen ? "down" : "right"}
          dimmed={creating}
          disabled={creating}
          onPress={() => setCreateOpen((open) => !open)}
          title={t("Create bank")}
        />
        {createOpen ? (
          <View style={styles.form}>
            <TextInput
              accessibilityLabel={t("Bank name")}
              autoCorrect={false}
              editable={!creating}
              onChangeText={setBankName}
              onSubmitEditing={() => void createBank()}
              placeholder={t("Bank name")}
              placeholderTextColor={native.tertiaryLabel}
              returnKeyType="done"
              style={styles.input}
              value={bankName}
            />
            <Text style={styles.caption}>{t("Creates a bank in Hindsight Cloud.")}</Text>
            {createError ? <Text style={styles.error}>{createError}</Text> : null}
            <NativeActionButton
              busy={creating}
              disabled={!MemoryBankNameSchema.safeParse(bankName).success}
              label={t("Create")}
              onPress={() => void createBank()}
            />
          </View>
        ) : null}
      </SettingsGroup>
    </View>
  );

  const empty =
    listState.kind === "loading" ? (
      <ActivityIndicator color={native.secondaryLabel} style={styles.state} />
    ) : listState.kind === "failed" ? (
      <View style={styles.state}>
        <Text style={styles.stateText}>{t("Could not load banks.")}</Text>
        <NativeActionButton label={t("Retry")} onPress={retryList} prominence="plain" />
      </View>
    ) : (
      <View style={styles.state}>
        <Text style={styles.stateText}>
          {listNotice ??
            (listState.kind === "ready" && listState.query
              ? t("No banks found.")
              : t("No banks yet."))}
        </Text>
      </View>
    );

  const footer = loadingMore ? (
    <ActivityIndicator color={native.secondaryLabel} style={styles.state} />
  ) : rows.length > 0 && listNotice ? (
    <View style={styles.state}>
      <Text style={styles.stateText}>{listNotice}</Text>
    </View>
  ) : moreFailed ? (
    <View style={styles.state}>
      <Text style={styles.stateText}>{t("Could not load banks.")}</Text>
      <NativeActionButton label={t("Retry")} onPress={() => void loadMore()} prominence="plain" />
    </View>
  ) : nextOffset !== null && listState.kind === "ready" ? (
    <View style={styles.state}>
      <NativeActionButton
        disabled={creating}
        label={t("Load more")}
        onPress={() => void loadMore()}
        prominence="plain"
      />
    </View>
  ) : null;

  return (
    <FlatList<MemoryBank>
      ItemSeparatorComponent={BankSeparator}
      ListEmptyComponent={empty}
      ListFooterComponent={footer}
      ListHeaderComponent={header}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      data={rows}
      keyExtractor={(bank) => bank.bankId}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      renderItem={({ item, index }) => {
        const selected = item.bankId === selectedBankId;
        return (
          <View
            style={[
              styles.cell,
              index === 0 && styles.firstCell,
              index === rows.length - 1 && styles.lastCell,
            ]}
          >
            <SettingsRow
              accessibilityRole="button"
              accessibilityState={{ selected, disabled: creating }}
              detail={item.bankId !== item.name ? item.bankId : undefined}
              dimmed={creating}
              disabled={creating}
              onPress={() => choose(item)}
              title={item.name}
              trailing={selected ? <Checkmark /> : undefined}
            />
          </View>
        );
      }}
      style={styles.screen}
    />
  );
}

function appendBanks(current: MemoryBank[], page: MemoryBank[]): MemoryBank[] {
  const seen = new Set(current.map((bank) => bank.bankId));
  const added = page.filter((bank) => {
    if (seen.has(bank.bankId)) return false;
    seen.add(bank.bankId);
    return true;
  });
  return added.length ? current.concat(added) : current;
}

function BankSeparator() {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.separatorCell}>
      <View style={styles.separator} />
    </View>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32 },
    header: { gap: 28, marginBottom: 28 },
    form: { paddingHorizontal: 16, paddingVertical: 12, gap: 10 },
    input: {
      borderRadius: 12,
      backgroundColor: native.fill,
      color: native.label,
      fontSize: 17,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    caption: { color: native.secondaryLabel, fontSize: 13 },
    error: { color: tokens.destructive, fontSize: 13 },
    cell: { backgroundColor: native.groupedCell, overflow: "hidden" },
    firstCell: { borderTopLeftRadius: 16, borderTopRightRadius: 16 },
    lastCell: { borderBottomLeftRadius: 16, borderBottomRightRadius: 16 },
    separatorCell: { backgroundColor: native.groupedCell },
    separator: {
      height: StyleSheet.hairlineWidth,
      marginStart: 16,
      backgroundColor: native.separator,
    },
    state: { alignItems: "center", gap: 12, paddingVertical: 24 },
    stateText: { color: native.secondaryLabel, fontSize: 15, textAlign: "center" },
  });
}
