import type { Connection, ConnectionCatalogItem, LinearConnectionStatus } from "@rakazo/contracts";
import * as Clipboard from "expo-clipboard";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import {
  LINEAR_RPC_TIMEOUT_MS,
  LINEAR_WEBHOOK_HELP_URL,
  linearNeedsReconnect,
  linearStatusLines,
} from "../lib/linear";
import { native, useThemedStyles } from "../lib/native";
import { errorText } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";
import { Chevron } from "./row-accessories";

type LinearForm =
  | { mode: "add" }
  | { mode: "reconnect"; connectionId: string; revision: number; wasRevoked: boolean };

export type LinearAccountsProps = {
  item: ConnectionCatalogItem;
  accounts: Connection[];
  startWithAdd: boolean;
  pending: string | null;
  uninstalling: boolean;
  labelFor: (row: Connection) => string;
  onLabelChange: (row: Connection, value: string) => void;
  onRename: (row: Connection) => void;
  onRemove: (row: Connection) => Promise<void>;
  captureScope: () => () => boolean;
  onConnected: (row: Connection) => Promise<void>;
};

export function LinearAccounts({
  item,
  accounts,
  startWithAdd,
  pending,
  uninstalling,
  labelFor,
  onLabelChange,
  onRename,
  onRemove,
  captureScope,
  onConnected,
}: LinearAccountsProps) {
  const styles = useThemedStyles(createLinearAccountsStyles);
  const { t } = useI18n();
  const connectedCount = accounts.filter((row) => row.status === "connected").length;
  const defaultLabel = connectedCount <= 0 ? item.name : `${item.name} ${connectedCount + 1}`;
  const [form, setForm] = useState<LinearForm | null>(startWithAdd ? { mode: "add" } : null);
  const [label, setLabel] = useState(startWithAdd ? defaultLabel : "");
  const [apiKey, setApiKey] = useState("");
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [statuses, setStatuses] = useState<Record<string, LinearConnectionStatus>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [webhooksOpen, setWebhooksOpen] = useState<Record<string, boolean>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [webhookBusy, setWebhookBusy] = useState<string | null>(null);
  const [webhookErrors, setWebhookErrors] = useState<Record<string, string>>({});
  const [reenterSecret, setReenterSecret] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const requests = useRef(new Set<AbortController>());
  const formRequest = useRef<AbortController | null>(null);

  function begin() {
    const controller = new AbortController();
    requests.current.add(controller);
    return controller;
  }

  function finish(controller: AbortController) {
    requests.current.delete(controller);
  }

  const dismiss = useCallback(() => {
    for (const controller of requests.current) controller.abort();
    requests.current.clear();
    formRequest.current = null;
    setForm(null);
    setLabel("");
    setApiKey("");
    setFormBusy(false);
    setFormError(null);
    setOpening(null);
    setSecrets({});
    setWebhookBusy(null);
  }, []);

  useFocusEffect(useCallback(() => dismiss, [dismiss]));

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);

  function setRecord<T>(
    update: (fn: (current: Record<string, T>) => Record<string, T>) => void,
    id: string,
    value: T | undefined,
  ) {
    update((current) => {
      const next = { ...current };
      if (value === undefined) delete next[id];
      else next[id] = value;
      return next;
    });
  }

  function cancelForm() {
    formRequest.current?.abort();
    formRequest.current = null;
    setForm(null);
    setLabel("");
    setApiKey("");
    setFormBusy(false);
    setFormError(null);
  }

  function openAdd() {
    cancelForm();
    setForm({ mode: "add" });
    setLabel(defaultLabel);
  }

  async function loadStatus(connectionId: string) {
    const isCurrent = captureScope();
    const controller = begin();
    setRecord(setRowErrors, connectionId, undefined);
    try {
      const status = await rpc<LinearConnectionStatus>(
        "linear/status",
        { connectionId },
        { signal: controller.signal, timeoutMs: LINEAR_RPC_TIMEOUT_MS },
      );
      if (controller.signal.aborted || !isCurrent()) return null;
      setRecord(setStatuses, connectionId, status);
      return status;
    } catch (reason) {
      if (controller.signal.aborted || !isCurrent()) return null;
      setRecord(setRowErrors, connectionId, errorText(reason, t("Could not load status")));
      return null;
    } finally {
      finish(controller);
    }
  }

  async function openReconnect(row: Connection) {
    cancelForm();
    setOpening(row.id);
    const status = await loadStatus(row.id);
    setOpening((current) => (current === row.id ? null : current));
    if (!status) return;
    setForm({
      mode: "reconnect",
      connectionId: row.id,
      revision: status.revision,
      wasRevoked: row.status === "revoked" || status.connectionStatus === "revoked",
    });
    setLabel(row.displayName);
  }

  async function submit() {
    const current = form;
    const key = apiKey.trim();
    const displayName = label.trim();
    if (!current || !key || !displayName) return;
    const isCurrent = captureScope();
    if (!isCurrent()) return;
    formRequest.current?.abort();
    const controller = begin();
    formRequest.current = controller;
    setFormBusy(true);
    setFormError(null);
    try {
      const row = await rpc<Connection>(
        "linear/connect",
        current.mode === "reconnect"
          ? {
              apiKey: key,
              displayName,
              connectionId: current.connectionId,
              expectedRevision: current.revision,
            }
          : { apiKey: key, displayName },
        { signal: controller.signal, timeoutMs: LINEAR_RPC_TIMEOUT_MS },
      );
      if (controller.signal.aborted || !isCurrent()) return;
      setApiKey("");
      setLabel("");
      setForm(null);
      setRecord(setStatuses, row.id, undefined);
      if (current.mode === "reconnect" && current.wasRevoked) {
        setRecord(setReenterSecret, row.id, true);
      }
      await onConnected(row);
      if (expanded[row.id] && isCurrent()) void loadStatus(row.id);
    } catch (reason) {
      if (controller.signal.aborted || !isCurrent()) return;
      setFormError(errorText(reason, t("Could not connect")));
    } finally {
      finish(controller);
      if (formRequest.current === controller) {
        formRequest.current = null;
        setFormBusy(false);
      }
    }
  }

  function toggleExpanded(row: Connection) {
    const open = !expanded[row.id];
    setRecord(setExpanded, row.id, open || undefined);
    if (open) {
      void loadStatus(row.id);
    } else {
      setRecord(setWebhooksOpen, row.id, undefined);
      setRecord(setSecrets, row.id, undefined);
    }
  }

  function toggleWebhooks(connectionId: string) {
    const open = !webhooksOpen[connectionId];
    setRecord(setWebhooksOpen, connectionId, open || undefined);
    if (!open) setRecord(setSecrets, connectionId, undefined);
  }

  async function configureWebhook(connectionId: string, signingSecret: string | null) {
    const status = statuses[connectionId];
    if (!status) return;
    const isCurrent = captureScope();
    if (!isCurrent()) return;
    const controller = begin();
    setWebhookBusy(`${connectionId}:${signingSecret === null ? "remove" : "save"}`);
    setRecord(setWebhookErrors, connectionId, undefined);
    try {
      const next = await rpc<LinearConnectionStatus>(
        "linear/configureWebhook",
        { connectionId, expectedRevision: status.revision, signingSecret },
        { signal: controller.signal, timeoutMs: LINEAR_RPC_TIMEOUT_MS },
      );
      if (controller.signal.aborted || !isCurrent()) return;
      setRecord(setStatuses, connectionId, next);
      setRecord(setSecrets, connectionId, undefined);
      if (signingSecret !== null) setRecord(setReenterSecret, connectionId, undefined);
    } catch (reason) {
      if (controller.signal.aborted || !isCurrent()) return;
      setRecord(setWebhookErrors, connectionId, errorText(reason, t("Could not save webhook")));
      void loadStatus(connectionId);
    } finally {
      finish(controller);
      if (!controller.signal.aborted) setWebhookBusy(null);
    }
  }

  async function remove(row: Connection) {
    const isCurrent = captureScope();
    await onRemove(row);
    if (!isCurrent()) return;
    setRecord(setExpanded, row.id, undefined);
    setRecord(setStatuses, row.id, undefined);
    setRecord(setWebhooksOpen, row.id, undefined);
    setRecord(setSecrets, row.id, undefined);
  }

  function copyWebhookUrl(connectionId: string, url: string) {
    void Clipboard.setStringAsync(url)
      .then(() => setCopied(connectionId))
      .catch(() => undefined);
  }

  function renderWebhooks(row: Connection, status: LinearConnectionStatus) {
    if (status.connectionStatus !== "connected") return null;
    if (!status.webhookUrl) {
      return <Text style={styles.secondary}>{t("Webhooks require a public HTTPS API URL.")}</Text>;
    }
    const open = !!webhooksOpen[row.id];
    const secret = secrets[row.id] ?? "";
    const saving = webhookBusy === `${row.id}:save`;
    const removing = webhookBusy === `${row.id}:remove`;
    return (
      <View style={styles.webhooks}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => toggleWebhooks(row.id)}
          style={styles.toggle}
        >
          <Text style={styles.toggleLabel}>{t("Webhooks")}</Text>
          <Chevron expanded={open} />
        </Pressable>
        {open ? (
          <View style={styles.webhookBody}>
            <Text selectable style={styles.url}>
              {status.webhookUrl}
            </Text>
            <NativeActionButton
              accessibilityLabel={t("Copy webhook URL")}
              fill={false}
              label={copied === row.id ? t("Copied") : t("Copy")}
              onPress={() => copyWebhookUrl(row.id, status.webhookUrl ?? "")}
              prominence="secondary"
            />
            {reenterSecret[row.id] && !status.webhookConfigured ? (
              <Text style={styles.secondary}>
                {t(
                  "Re-enter the signing secret. Re-enable the webhook in Linear if it was disabled.",
                )}
              </Text>
            ) : null}
            <TextInput
              accessibilityLabel={t("Signing secret")}
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect={false}
              editable={!saving && !removing}
              importantForAutofill="no"
              onChangeText={(value) => setRecord(setSecrets, row.id, value)}
              placeholder={t("Signing secret")}
              placeholderTextColor={native.tertiaryLabel}
              secureTextEntry
              style={styles.input}
              textContentType="none"
              value={secret}
            />
            <View style={styles.actions}>
              <NativeActionButton
                busy={saving}
                disabled={!secret.trim() || removing}
                fill={false}
                label={saving ? t("Working…") : t("Save")}
                onPress={() => void configureWebhook(row.id, secret.trim())}
                prominence="secondary"
              />
              {status.webhookConfigured ? (
                <NativeActionButton
                  busy={removing}
                  disabled={saving}
                  fill={false}
                  label={removing ? t("Working…") : t("Remove webhook")}
                  onPress={() => void configureWebhook(row.id, null)}
                  prominence="destructive"
                />
              ) : null}
            </View>
            <Pressable
              accessibilityRole="link"
              onPress={() => void Linking.openURL(LINEAR_WEBHOOK_HELP_URL)}
              style={styles.toggle}
            >
              <Text style={styles.link}>{t("Webhook setup")}</Text>
            </Pressable>
            {webhookErrors[row.id] ? (
              <Text style={styles.error}>{webhookErrors[row.id]}</Text>
            ) : null}
          </View>
        ) : null}
      </View>
    );
  }

  function renderDetails(row: Connection) {
    const status = statuses[row.id];
    if (rowErrors[row.id]) return <Text style={styles.error}>{rowErrors[row.id]}</Text>;
    if (!status) return <Text style={styles.secondary}>{t("Loading…")}</Text>;
    return (
      <View style={styles.details}>
        {linearStatusLines(status).map((line) => (
          <Text key={line} style={styles.secondary}>
            {line}
          </Text>
        ))}
        {renderWebhooks(row, status)}
      </View>
    );
  }

  function renderAccount(row: Connection) {
    const status = statuses[row.id];
    const open = !!expanded[row.id];
    const editable = row.status === "connected" || row.status === "pending";
    const reconnect =
      row.status === "error" ||
      row.status === "revoked" ||
      (status ? linearNeedsReconnect(status) : false);
    const reconnecting =
      opening === row.id || (form?.mode === "reconnect" && form.connectionId === row.id);
    return (
      <View key={row.id} style={styles.account}>
        <View style={styles.accountRow}>
          {editable ? (
            <TextInput
              accessibilityLabel={t("Account label")}
              onChangeText={(value) => onLabelChange(row, value)}
              onEndEditing={() => onRename(row)}
              style={styles.accountLabel}
              value={labelFor(row)}
            />
          ) : (
            <Text numberOfLines={2} style={styles.accountName}>
              {row.displayName}
            </Text>
          )}
          <Pressable
            accessibilityLabel={t("Details")}
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            onPress={() => toggleExpanded(row)}
            style={styles.disclosure}
          >
            <Chevron expanded={open} />
          </Pressable>
        </View>
        <View style={styles.actions}>
          {reconnect ? (
            <NativeActionButton
              accessibilityLabel={t("Reconnect")}
              busy={opening === row.id}
              disabled={reconnecting || formBusy}
              fill={false}
              label={opening === row.id ? t("Working…") : t("Reconnect")}
              onPress={() => void openReconnect(row)}
              prominence="secondary"
            />
          ) : null}
          {row.status !== "revoked" ? (
            <NativeActionButton
              accessibilityLabel={t("Remove {name}", { name: row.displayName })}
              disabled={pending === row.id || uninstalling}
              fill={false}
              label={pending === row.id ? t("Working…") : t("Remove")}
              onPress={() => void remove(row)}
              prominence="destructive"
            />
          ) : null}
        </View>
        {open ? renderDetails(row) : null}
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <Text style={styles.section}>{t("Accounts")}</Text>
      {accounts.map(renderAccount)}
      {form ? (
        <View style={styles.form}>
          <TextInput
            accessibilityLabel={t("Account label")}
            editable={!formBusy}
            maxLength={80}
            onChangeText={setLabel}
            placeholder={t("Account label")}
            placeholderTextColor={native.tertiaryLabel}
            style={styles.input}
            value={label}
          />
          <TextInput
            accessibilityLabel={t("API key")}
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect={false}
            editable={!formBusy}
            importantForAutofill="no"
            onChangeText={setApiKey}
            placeholder={t("API key")}
            placeholderTextColor={native.tertiaryLabel}
            secureTextEntry
            style={styles.input}
            textContentType="none"
            value={apiKey}
          />
          {formError ? <Text style={styles.error}>{formError}</Text> : null}
          <View style={styles.actions}>
            <NativeActionButton
              busy={formBusy}
              disabled={!apiKey.trim() || !label.trim()}
              fill={false}
              label={formBusy ? t("Working…") : t("Connect")}
              onPress={() => void submit()}
            />
            <NativeActionButton
              fill={false}
              label={t("Cancel")}
              onPress={cancelForm}
              prominence="secondary"
            />
          </View>
        </View>
      ) : (
        <NativeActionButton
          accessibilityLabel={t("Add another {name}", { name: item.name })}
          label={t("Add another")}
          onPress={openAdd}
          prominence="secondary"
        />
      )}
    </View>
  );
}

function createLinearAccountsStyles() {
  const destructive = mobileTokens().destructive;
  return StyleSheet.create({
    card: { padding: 16, borderRadius: 16, backgroundColor: native.fill, gap: 12 },
    section: { color: native.secondaryLabel, fontSize: 14, fontWeight: "600" },
    account: { gap: 8 },
    accountRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    accountLabel: {
      flex: 1,
      minHeight: 44,
      borderRadius: 10,
      backgroundColor: native.fillPressed,
      color: native.label,
      paddingHorizontal: 10,
      fontSize: 15,
    },
    accountName: { flex: 1, color: native.label, fontSize: 15, fontWeight: "600" },
    disclosure: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
    actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
    details: { gap: 6 },
    webhooks: { gap: 8 },
    webhookBody: { gap: 10 },
    toggle: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
    },
    toggleLabel: { color: native.label, fontSize: 15, fontWeight: "600" },
    url: { color: native.label, fontSize: 13 },
    form: { gap: 10 },
    input: {
      minHeight: 48,
      borderRadius: 12,
      backgroundColor: native.fillPressed,
      color: native.label,
      paddingHorizontal: 14,
      fontSize: 15,
    },
    secondary: { color: native.secondaryLabel, fontSize: 13 },
    link: { color: native.label, fontSize: 14, fontWeight: "600" },
    error: { color: destructive, fontSize: 14 },
  });
}
