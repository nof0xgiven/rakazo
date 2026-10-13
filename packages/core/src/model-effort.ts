import type { ThinkingLevel } from "@rakazo/contracts";
import { effectiveThinkingLevel, thinkingLevelsReason } from "@rakazo/contracts";

export type ModelEffortCapabilities = {
  thinkingLevels: readonly ThinkingLevel[];
  defaultThinkingLevel: ThinkingLevel | null;
};

export type ModelEffortChoices = {
  /** Level a Default (null) effort executes on this model. */
  defaultLevel: ThinkingLevel;
  /** Explicit levels the model supports; Off appears only when supported. */
  levels: ThinkingLevel[];
  /** Saved effort outside the supported set: shown, never offered as a choice. */
  unavailable: ThinkingLevel | null;
};

/**
 * Reasoning effort choices for one model's own support. Null when the model
 * does not reason or its support is unknown, so no effort selector is shown.
 */
export function modelEffortChoices(
  capabilities: ModelEffortCapabilities | undefined,
  saved: ThinkingLevel | null | undefined,
): ModelEffortChoices | null {
  if (!capabilities || !thinkingLevelsReason(capabilities.thinkingLevels)) return null;
  const levels = [...capabilities.thinkingLevels];
  return {
    defaultLevel: effectiveThinkingLevel(levels, null, capabilities.defaultThinkingLevel),
    levels,
    unavailable: saved && !levels.includes(saved) ? saved : null,
  };
}
