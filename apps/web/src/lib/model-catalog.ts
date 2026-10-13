import { i18n } from "@lingui/core";
import type { ModelCatalogEntry, ModelCredential, ThinkingLevel } from "@rakazo/contracts";
import type { ConnectedModelChoice, ModelEffortChoices } from "@rakazo/core";
import { connectedModelChoices } from "@rakazo/core";

export { modelOptionKey, parseModelOptionKey } from "@rakazo/core";

/** The models the connected credentials can run, as one list for a picker. */
export function connectedModelOptions(
  credentials: ModelCredential[],
  catalog: ModelCatalogEntry[],
): ConnectedModelChoice[] {
  return connectedModelChoices(credentials, catalog);
}

export function thinkingLevelLabel(level: ThinkingLevel) {
  if (level === "off") return i18n._({ id: "Off", message: "Off" });
  if (level === "xhigh") return i18n._({ id: "Extra high", message: "Extra high" });
  if (level === "low") return i18n._({ id: "Low", message: "Low" });
  if (level === "medium") return i18n._({ id: "Medium", message: "Medium" });
  if (level === "high") return i18n._({ id: "High", message: "High" });
  if (level === "minimal") return i18n._({ id: "Minimal", message: "Minimal" });
  return i18n._({ id: "Max", message: "Max" });
}

/** Explicit effort options after Default: a saved unsupported effort stays visible but disabled. */
export function thinkingLevelOptions(
  choices: ModelEffortChoices,
): { value: ThinkingLevel; label: string; disabled: boolean }[] {
  const options = choices.levels.map((level) => ({
    value: level,
    label: thinkingLevelLabel(level),
    disabled: false,
  }));
  if (!choices.unavailable) return options;
  return [
    {
      value: choices.unavailable,
      label: i18n._({
        id: "{label} (unavailable)",
        message: "{label} (unavailable)",
        values: { label: thinkingLevelLabel(choices.unavailable) },
      }),
      disabled: true,
    },
    ...options,
  ];
}
