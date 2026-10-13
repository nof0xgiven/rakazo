import type {
  MemoryConnectionFailureReason,
  MemoryScopeValue,
  SpaceMemoryConfig,
} from "@rakazo/contracts";
import {
  MEMORY_FAILURE_MESSAGES,
  MemoryConnectionFailureReasonSchema,
  SpaceMemoryConfigSchema,
} from "@rakazo/contracts";
import { t } from "./i18n";
import { errorText } from "./user-error";

export const HINDSIGHT_PROVIDER_ID = "hindsight";
export const HINDSIGHT_CLOUD_ORIGIN = "https://api.hindsight.vectorize.io";
export const MEMORY_LOOKUP_TIMEOUT_MS = 25_000;
export const MEMORY_MUTATION_TIMEOUT_MS = 70_000;

export type MemoryConfigRead = SpaceMemoryConfig | null | "outdated";

export function readMemoryConfig(value: unknown): MemoryConfigRead {
  if (value === null) return null;
  return SpaceMemoryConfigSchema.safeParse(value).data ?? "outdated";
}

function errorField(error: unknown, field: "status" | "code" | "reason"): unknown {
  return error instanceof Error ? Reflect.get(error, field) : undefined;
}

export function rpcErrorStatus(error: unknown): number | undefined {
  const status = errorField(error, "status");
  return typeof status === "number" ? status : undefined;
}

export function memoryFailureReason(error: unknown): MemoryConnectionFailureReason | undefined {
  return MemoryConnectionFailureReasonSchema.safeParse(errorField(error, "reason")).data;
}

/** A server without the procedure answers 404 with no oRPC error code; authorization failures carry one. */
export function memoryRequiresServerUpdate(error: unknown): boolean {
  return rpcErrorStatus(error) === 404 && errorField(error, "code") === undefined;
}

export function memoryErrorText(error: unknown, fallback: string): string {
  const reason = memoryFailureReason(error);
  if (reason) return t(MEMORY_FAILURE_MESSAGES[reason]);
  if (memoryRequiresServerUpdate(error)) return t("Memory settings require a server update.");
  return errorText(error, fallback);
}

export function memoryProviderLabel(config: SpaceMemoryConfig): string {
  if (config.provider === HINDSIGHT_PROVIDER_ID) return "Hindsight Cloud";
  if (config.provider === "supermemory")
    return config.settings.mode === "cloud"
      ? "Supermemory Cloud"
      : `Supermemory · ${config.settings.baseUrl ?? ""}`;
  if (config.provider === "serenity")
    return `Serenity · ${config.settings.brainLabel?.trim() || config.settings.endpoint || ""}`;
  return config.provider;
}

export function memoryScopeLabel(scope: MemoryScopeValue | null): string {
  if (scope === "isolated") return t("Isolated");
  if (scope === "shared") return t("Shared");
  return t("Inherit default");
}
