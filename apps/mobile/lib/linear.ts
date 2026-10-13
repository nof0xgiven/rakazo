import type {
  Connection,
  LinearConnectionStatus,
  LinearEventKind,
  LinearOptionKind,
  LinearOptions,
  LinearTrigger,
} from "@rakazo/contracts";
import { LINEAR_CONNECTOR_ID } from "@rakazo/contracts";
import { dateLocaleForUi, t } from "./i18n";

export const LINEAR_RPC_TIMEOUT_MS = 30_000;
export const LINEAR_WEBHOOK_HELP_URL = "https://linear.app/developers/webhooks";

export function isNativeLinear(item: { connectorId: string }): boolean {
  return item.connectorId === LINEAR_CONNECTOR_ID;
}

export function formatLinearDate(iso: string): string {
  return new Date(iso).toLocaleString(dateLocaleForUi());
}

export function linearNeedsReconnect(status: {
  connectionStatus: LinearConnectionStatus["connectionStatus"];
  errorCode: LinearConnectionStatus["errorCode"];
}): boolean {
  return (
    status.connectionStatus === "revoked" ||
    status.connectionStatus === "error" ||
    status.errorCode === "auth"
  );
}

export function linearStatusLines(
  status: LinearConnectionStatus,
  now: number = Date.now(),
  formatDate: (iso: string) => string = formatLinearDate,
): string[] {
  const lines: string[] = [];
  const limited = status.rateLimitedUntil !== null && Date.parse(status.rateLimitedUntil) > now;
  if (linearNeedsReconnect(status)) {
    lines.push(t("Reconnect Linear"));
  } else if (limited || status.errorCode === "rate_limit") {
    lines.push(
      status.rateLimitedUntil
        ? t("Waiting for Linear until {date}", { date: formatDate(status.rateLimitedUntil) })
        : t("Waiting for Linear"),
    );
  } else if (status.errorCode === "unavailable" || status.errorCode === "invalid_response") {
    lines.push(t("Linear is temporarily unavailable"));
  } else if (status.monitoring === "idle") {
    lines.push(t("No active automations"));
  } else {
    lines.push(t("Polling"));
  }
  if (status.lastPolledAt) {
    lines.push(t("Last successful poll {date}", { date: formatDate(status.lastPolledAt) }));
  }
  if (status.lastWebhookAt) {
    lines.push(t("Last verified webhook {date}", { date: formatDate(status.lastWebhookAt) }));
  }
  return lines;
}

export function linearEventLabel(kind: LinearEventKind): string {
  if (kind === "issue.created") return t("Issue created");
  if (kind === "issue.updated") return t("Issue updated");
  return t("Comment added");
}

export function linearOptionLabel(id: string, names: ReadonlyMap<string, string>): string {
  return names.get(id) ?? t("Unavailable ({id})", { id });
}

export async function resolveLinearOptionNames(
  loadPage: (cursor: string | undefined) => Promise<LinearOptions>,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const wanted = new Set(ids);
  const names = new Map<string, string>();
  const seen = new Set<string>();
  let cursor: string | undefined;
  while (names.size < wanted.size) {
    const page = await loadPage(cursor);
    for (const option of page.items) {
      if (wanted.has(option.id)) names.set(option.id, option.name);
    }
    if (!page.nextCursor || seen.has(page.nextCursor)) break;
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  return names;
}

export type LinearRpc = <T>(proc: string, body: unknown) => Promise<T>;

export type LinearTriggerDetails = {
  accountLabel: string | null;
  names: Map<string, string>;
};

export async function loadLinearTriggerDetails(
  trigger: LinearTrigger,
  call: LinearRpc,
): Promise<LinearTriggerDetails> {
  const connections = await call<Connection[]>("connections/list", {});
  const connection = connections.find((row) => row.id === trigger.connectionId);
  const details: LinearTriggerDetails = {
    accountLabel: connection?.displayName ?? null,
    names: new Map(),
  };
  if (connection?.status !== "connected") return details;
  const resolve = (kind: LinearOptionKind, ids: readonly string[]) =>
    ids.length === 0
      ? Promise.resolve(new Map<string, string>())
      : resolveLinearOptionNames(
          (cursor) =>
            call<LinearOptions>("linear/options", {
              connectionId: trigger.connectionId,
              kind,
              ...(kind === "teams" ? {} : { teamId: trigger.teamId }),
              ...(cursor ? { cursor } : {}),
            }),
          ids,
        ).catch(() => new Map<string, string>());
  const pages = await Promise.all([
    resolve("teams", [trigger.teamId]),
    resolve("projects", trigger.projectId ? [trigger.projectId] : []),
    resolve("assignees", trigger.assigneeId ? [trigger.assigneeId] : []),
    resolve("states", trigger.stateId ? [trigger.stateId] : []),
    resolve("labels", trigger.labelIds),
  ]);
  for (const names of pages) {
    for (const [id, name] of names) details.names.set(id, name);
  }
  return details;
}

export function linearTriggerRows(
  trigger: LinearTrigger,
  details: LinearTriggerDetails,
): Array<{ label: string; value: string }> {
  const rows = [
    {
      label: t("Account"),
      value: details.accountLabel ?? t("Unavailable ({id})", { id: trigger.connectionId }),
    },
    { label: t("Team"), value: linearOptionLabel(trigger.teamId, details.names) },
    { label: t("Events"), value: trigger.events.map(linearEventLabel).join(", ") },
  ];
  if (trigger.projectId) {
    rows.push({ label: t("Project"), value: linearOptionLabel(trigger.projectId, details.names) });
  }
  if (trigger.assigneeId) {
    rows.push({
      label: t("Assignee"),
      value: linearOptionLabel(trigger.assigneeId, details.names),
    });
  }
  if (trigger.stateId) {
    rows.push({ label: t("Status"), value: linearOptionLabel(trigger.stateId, details.names) });
  }
  if (trigger.labelIds.length > 0) {
    rows.push({
      label: t("Labels"),
      value: trigger.labelIds.map((id) => linearOptionLabel(id, details.names)).join(", "),
    });
  }
  return rows;
}
