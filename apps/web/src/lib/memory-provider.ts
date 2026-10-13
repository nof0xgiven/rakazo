import { t } from "@lingui/core/macro";
import type { MemoryConnectionFailureReason, SpaceMemoryConfig } from "@rakazo/contracts";
import { MemoryConnectionErrorDataSchema } from "@rakazo/contracts";
import { errorText } from "./user-error";

export type MemoryConfigState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; config: SpaceMemoryConfig | null };

function errorField(error: unknown, field: "code" | "data"): unknown {
  return error && typeof error === "object" && field in error
    ? (error as Record<string, unknown>)[field]
    : undefined;
}

export function memoryFailureReason(error: unknown): MemoryConnectionFailureReason | null {
  if (errorField(error, "code") !== "BAD_REQUEST") return null;
  const parsed = MemoryConnectionErrorDataSchema.safeParse(errorField(error, "data"));
  return parsed.success ? parsed.data.reason : null;
}

export function isConflictError(error: unknown): boolean {
  return errorField(error, "code") === "CONFLICT";
}

export function memoryFailureText(reason: MemoryConnectionFailureReason): string {
  switch (reason) {
    case "invalid_request":
      return t`Hindsight Cloud rejected this request.`;
    case "unauthorized":
      return t`Hindsight Cloud rejected this API key.`;
    case "quota":
      return t`Hindsight Cloud is out of credits.`;
    case "forbidden":
      return t`This key cannot access this bank.`;
    case "not_found":
      return t`This bank is unavailable.`;
    case "conflict":
      return t`Hindsight Cloud reported a conflict.`;
    case "rate_limited":
    case "unavailable":
    case "timeout":
      return t`Hindsight Cloud is temporarily unavailable.`;
    case "invalid_response":
      return t`Hindsight Cloud returned an unexpected response.`;
    case "binding_retired":
      return t`The memory connection changed. Choose a bank again.`;
    case "bank_id_required":
    case "bank_list_forbidden":
      return t`This key can't list banks. Use bank ID.`;
    case "bank_create_forbidden":
      return t`This key can't create banks.`;
  }
}

export function memoryErrorText(error: unknown, fallback: string): string {
  const reason = memoryFailureReason(error);
  if (reason) return memoryFailureText(reason);
  if (isConflictError(error)) return t`Memory settings changed. Review and try again.`;
  return errorText(error, fallback);
}
