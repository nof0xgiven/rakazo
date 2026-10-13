import type { ThinkingLevel } from "@rakazo/contracts";
import {
  effectiveThinkingLevel,
  MAX_MODEL_CONTEXT_WINDOW,
  MAX_MODEL_MAX_TOKENS,
  ThinkingLevelSchema,
  thinkingLevelsReason,
} from "@rakazo/contracts";
import type {
  OpenAiCompatibleModelDraft,
  OpenAiCompatibleModelRow,
  OpenAiCompatibleModelSetup,
  OpenAiCompatibleSetupIssue,
} from "@rakazo/core";
import {
  applyDetectedOpenAiCompatibleSettings,
  applyOpenAiCompatibleModelSetup,
  cancelOpenAiCompatibleModelSetup,
  filterOpenAiCompatibleModelRows,
  openAiCompatibleModelSetup,
  openAiCompatibleSetupIssues,
  toggleOpenAiCompatibleModel,
  updateOpenAiCompatibleModelSetup,
} from "@rakazo/core";
import { Fragment, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { thinkingLevelLabel } from "../lib/thinking-level-label";
import { MenuPicker } from "./menu-picker";
import { NativeActionButton } from "./native-action-button";
import { NativeSwitch } from "./native-switch";
import { Chevron } from "./row-accessories";

export function OpenAiCompatibleModelList({
  draft,
  onChange,
  busy,
  adding,
  onAddModel,
}: {
  draft: OpenAiCompatibleModelDraft;
  onChange: (next: OpenAiCompatibleModelDraft) => void;
  busy: boolean;
  adding: boolean;
  onAddModel: (modelId: string) => Promise<boolean>;
}) {
  const styles = useThemedStyles(createStyles);
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherModelId, setOtherModelId] = useState("");
  const visibleRows = filterOpenAiCompatibleModelRows(draft.rows, query);

  function toggleExpanded(modelId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  }

  async function addOtherModel() {
    if (await onAddModel(otherModelId.trim())) setOtherModelId("");
  }

  function issueText(issue: OpenAiCompatibleSetupIssue): string {
    if (issue === "context_window") {
      return t("Enter a whole number from 1 to {max} for the context limit.", {
        max: MAX_MODEL_CONTEXT_WINDOW,
      });
    }
    if (issue === "max_tokens") {
      return t("Enter a whole number from 1 to {max} for maximum output tokens.", {
        max: MAX_MODEL_MAX_TOKENS,
      });
    }
    if (issue === "output_room") return t("Maximum output tokens must leave room for input.");
    if (issue === "max_images")
      return t("Enter a whole number from 1 to 1000 for the image limit.");
    if (issue === "thinking_levels") return t("Choose at least one level other than Off.");
    return t("Choose a supported default effort.");
  }

  function setupField(
    row: OpenAiCompatibleModelRow,
    label: string,
    value: string,
    field: "contextWindow" | "maxTokens" | "maxImagesPerPrompt",
    maxLength: number,
  ) {
    return (
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>{label}</Text>
        <TextInput
          accessibilityLabel={t("{setting} for {model}", { setting: label, model: row.modelId })}
          editable={!busy}
          keyboardType="number-pad"
          maxLength={maxLength}
          onChangeText={(text) =>
            onChange(updateOpenAiCompatibleModelSetup(draft, row.modelId, { [field]: text }))
          }
          style={styles.input}
          value={value}
        />
      </View>
    );
  }

  function switchRow(
    label: string,
    accessibilityLabel: string,
    value: boolean,
    onValueChange: (next: boolean) => void,
  ) {
    return (
      <View style={styles.settingRow}>
        <Text style={styles.settingLabel}>{label}</Text>
        <NativeSwitch
          accessibilityLabel={accessibilityLabel}
          disabled={busy}
          onValueChange={onValueChange}
          value={value}
        />
      </View>
    );
  }

  function advanced(row: OpenAiCompatibleModelRow) {
    const setup: OpenAiCompatibleModelSetup = row.setup ?? openAiCompatibleModelSetup(row.config);
    const issues = row.setup ? openAiCompatibleSetupIssues(row.setup) : [];
    const update = (patch: Partial<OpenAiCompatibleModelSetup>) =>
      onChange(updateOpenAiCompatibleModelSetup(draft, row.modelId, patch));
    const defaultLabel = t("Default ({level})", {
      level: thinkingLevelLabel(effectiveThinkingLevel(setup.thinkingLevels, null, null), t),
    });
    return (
      <View style={styles.advanced}>
        {!row.config ? (
          <Text style={styles.hint}>{t("Set up this model, then Apply.")}</Text>
        ) : null}
        {switchRow(
          t("Supports thinking"),
          t("{setting} for {model}", { setting: t("Supports thinking"), model: row.modelId }),
          setup.thinking,
          (thinking) => update({ thinking, thinkingLevels: thinking ? setup.thinkingLevels : [] }),
        )}
        {setup.thinking ? (
          <>
            <Text style={styles.fieldLabel}>{t("Supported levels")}</Text>
            {ThinkingLevelSchema.options.map((level) => (
              <Fragment key={level}>
                {switchRow(
                  thinkingLevelLabel(level, t),
                  t("{level} for {model}", {
                    level: thinkingLevelLabel(level, t),
                    model: row.modelId,
                  }),
                  setup.thinkingLevels.includes(level),
                  (supported) =>
                    update({
                      thinkingLevels: supported
                        ? [...setup.thinkingLevels, level]
                        : setup.thinkingLevels.filter((candidate) => candidate !== level),
                    }),
                )}
              </Fragment>
            ))}
            {thinkingLevelsReason(setup.thinkingLevels) ? (
              <MenuPicker
                choices={[
                  { key: "", label: defaultLabel },
                  ...setup.thinkingLevels.map((level) => ({
                    key: level,
                    label: thinkingLevelLabel(level, t),
                  })),
                ]}
                label={t("Default reasoning effort")}
                onChange={(key) =>
                  update({ defaultThinkingLevel: key ? (key as ThinkingLevel) : null })
                }
                value={setup.defaultThinkingLevel ?? ""}
              />
            ) : null}
          </>
        ) : null}
        {switchRow(
          t("Supports images"),
          t("{setting} for {model}", { setting: t("Supports images"), model: row.modelId }),
          setup.supportsImages,
          (supportsImages) =>
            update({
              supportsImages,
              maxImagesPerPrompt: supportsImages ? setup.maxImagesPerPrompt : "",
            }),
        )}
        {setup.supportsImages
          ? setupField(
              row,
              t("Maximum images per request"),
              setup.maxImagesPerPrompt,
              "maxImagesPerPrompt",
              4,
            )
          : null}
        {setupField(row, t("Context limit"), setup.contextWindow, "contextWindow", 10)}
        {setupField(row, t("Maximum output tokens"), setup.maxTokens, "maxTokens", 6)}
        {issues.map((issue) => (
          <Text key={issue} style={styles.error}>
            {issueText(issue)}
          </Text>
        ))}
        <View style={styles.actions}>
          {row.suggestion ? (
            <NativeActionButton
              accessibilityLabel={t("Use detected settings for {model}", { model: row.modelId })}
              disabled={busy}
              label={t("Use detected settings")}
              onPress={() => onChange(applyDetectedOpenAiCompatibleSettings(draft, row.modelId))}
              prominence="secondary"
            />
          ) : null}
          {row.setup ? (
            <>
              <NativeActionButton
                accessibilityLabel={t("Cancel changes for {model}", { model: row.modelId })}
                disabled={busy}
                label={t("Cancel")}
                onPress={() => onChange(cancelOpenAiCompatibleModelSetup(draft, row.modelId))}
                prominence="secondary"
              />
              <NativeActionButton
                accessibilityLabel={t("Apply settings for {model}", { model: row.modelId })}
                disabled={busy || issues.length > 0}
                label={t("Apply")}
                onPress={() => onChange(applyOpenAiCompatibleModelSetup(draft, row.modelId))}
              />
            </>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View>
      <Text style={styles.sectionTitle}>{t("Models")}</Text>
      <TextInput
        accessibilityLabel={t("Search models")}
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setQuery}
        placeholder={t("Search models")}
        placeholderTextColor={native.tertiaryLabel}
        returnKeyType="search"
        style={styles.input}
        value={query}
      />
      <View style={styles.card}>
        {visibleRows.map((row) => {
          const open = row.checked && (row.setup !== null || expanded.has(row.modelId));
          return (
            <View key={row.modelId} style={styles.modelBlock}>
              <View style={styles.modelRow}>
                <Text style={styles.modelLabel}>{row.modelId}</Text>
                <NativeSwitch
                  accessibilityLabel={t("Enable {model}", { model: row.modelId })}
                  disabled={busy}
                  onValueChange={(checked) =>
                    onChange(toggleOpenAiCompatibleModel(draft, row.modelId, checked))
                  }
                  value={row.checked}
                />
              </View>
              {row.checked && row.config && !row.setup ? (
                <Pressable
                  accessibilityLabel={t("Advanced settings for {model}", { model: row.modelId })}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: open }}
                  onPress={() => toggleExpanded(row.modelId)}
                  style={({ pressed }) => [styles.disclosure, pressed && styles.pressed]}
                >
                  <Text style={styles.disclosureLabel}>{t("Advanced")}</Text>
                  <Chevron expanded={open} />
                </Pressable>
              ) : null}
              {open ? advanced(row) : null}
            </View>
          );
        })}
        {draft.rows.length === 0 ? (
          <View style={styles.modelRow}>
            <Text style={[styles.modelLabel, styles.muted]}>
              {t("Find models or add one by id.")}
            </Text>
          </View>
        ) : visibleRows.length === 0 ? (
          <View style={styles.modelRow}>
            <Text style={[styles.modelLabel, styles.muted]}>{t("No matching models")}</Text>
          </View>
        ) : null}
        <Pressable
          accessibilityLabel={t("Other model…")}
          accessibilityRole="button"
          accessibilityState={{ expanded: otherOpen }}
          onPress={() => setOtherOpen((value) => !value)}
          style={({ pressed }) => [styles.disclosure, pressed && styles.pressed]}
        >
          <Text style={styles.disclosureLabel}>{t("Other model…")}</Text>
          <Chevron expanded={otherOpen} />
        </Pressable>
        {otherOpen ? (
          <View style={styles.advanced}>
            <TextInput
              accessibilityLabel={t("Model id")}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy && !adding}
              onChangeText={setOtherModelId}
              onSubmitEditing={() => void addOtherModel()}
              placeholder={t("exact-model-id")}
              placeholderTextColor={native.tertiaryLabel}
              style={styles.input}
              value={otherModelId}
            />
            <View style={styles.actions}>
              <NativeActionButton
                disabled={busy || adding || !otherModelId.trim()}
                label={adding ? t("Adding…") : t("Add")}
                onPress={() => void addOtherModel()}
                prominence="secondary"
              />
            </View>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    sectionTitle: {
      color: native.secondaryLabel,
      fontSize: 14,
      marginTop: 12,
      marginBottom: 2,
    },
    card: {
      marginTop: 8,
      borderRadius: 14,
      backgroundColor: native.fill,
      overflow: "hidden",
    },
    modelBlock: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: native.fillPressed,
    },
    modelRow: {
      minHeight: 54,
      paddingHorizontal: 16,
      paddingVertical: 10,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    modelLabel: {
      flex: 1,
      color: native.label,
      fontSize: 15,
    },
    muted: {
      color: native.secondaryLabel,
    },
    disclosure: {
      minHeight: 44,
      paddingHorizontal: 16,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    disclosureLabel: {
      flex: 1,
      color: native.secondaryLabel,
      fontSize: 15,
    },
    advanced: {
      paddingHorizontal: 16,
      paddingBottom: 14,
      gap: 8,
    },
    settingRow: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    settingLabel: {
      flex: 1,
      color: native.label,
      fontSize: 15,
    },
    field: {
      gap: 2,
    },
    fieldLabel: {
      color: native.secondaryLabel,
      fontSize: 14,
      marginTop: 4,
    },
    input: {
      minHeight: 48,
      borderRadius: 12,
      backgroundColor: native.page,
      color: native.label,
      paddingHorizontal: 14,
      paddingVertical: 10,
      marginTop: 4,
      fontSize: 16,
    },
    hint: {
      color: native.secondaryLabel,
      fontSize: 13,
      lineHeight: 19,
    },
    error: {
      color: tokens.destructive,
      fontSize: 14,
    },
    actions: {
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "flex-end",
      gap: 8,
      marginTop: 4,
    },
    pressed: {
      opacity: 0.7,
    },
  });
}
