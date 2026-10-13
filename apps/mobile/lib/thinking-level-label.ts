import type { ThinkingLevel } from "@rakazo/contracts";

export function thinkingLevelLabel(level: ThinkingLevel, t: (message: string) => string): string {
  if (level === "off") return t("Off");
  if (level === "minimal") return t("Minimal");
  if (level === "low") return t("Low");
  if (level === "medium") return t("Medium");
  if (level === "high") return t("High");
  if (level === "xhigh") return t("Extra high");
  return t("Max");
}
