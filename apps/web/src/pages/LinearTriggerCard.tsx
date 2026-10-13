import { Trans, useLingui } from "@lingui/react/macro";
import type {
  Connection,
  LinearEventKind,
  LinearOption,
  LinearOptionKind,
  LinearTrigger,
} from "@rakazo/contracts";
import {
  LINEAR_CONNECTOR_ID,
  LINEAR_EVENT_KINDS,
  LINEAR_MAX_LABELS,
  LINEAR_PROVIDER,
} from "@rakazo/contracts";
import {
  Button,
  Checkbox,
  NativeSelect,
  NativeSelectOption,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@rakazo/ui-web";
import { ChevronDown, ChevronUp, CircleDot, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

export type LinearTriggerDraft = {
  connectionId: string;
  teamId: string;
  events: LinearEventKind[];
  projectId: string | null;
  assigneeId: string | null;
  stateId: string | null;
  labelIds: string[];
};

export function newLinearTriggerDraft(): LinearTriggerDraft {
  return {
    connectionId: "",
    teamId: "",
    events: ["issue.created"],
    projectId: null,
    assigneeId: null,
    stateId: null,
    labelIds: [],
  };
}

/** Saveable trigger, or null while account, team or events are missing. */
export function linearTriggerFromDraft(draft: LinearTriggerDraft): LinearTrigger | null {
  if (!draft.connectionId || !draft.teamId || draft.events.length === 0) return null;
  return {
    ...draft,
    events: LINEAR_EVENT_KINDS.filter((kind) => draft.events.includes(kind)),
    labelIds: [...draft.labelIds].sort(),
  };
}

export function sameLinearTrigger(a: LinearTrigger | null, b: LinearTrigger | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.connectionId === b.connectionId &&
    a.teamId === b.teamId &&
    a.projectId === b.projectId &&
    a.assigneeId === b.assigneeId &&
    a.stateId === b.stateId &&
    a.events.join() === b.events.join() &&
    a.labelIds.join() === b.labelIds.join()
  );
}

type FilterKind = Exclude<LinearOptionKind, "teams">;
type OptionList = { items: LinearOption[]; loading: boolean; error: string | null };

const FILTER_KINDS: readonly FilterKind[] = ["projects", "assignees", "states", "labels"];
const LOADING_LIST: OptionList = { items: [], loading: true, error: null };
const IDLE_LIST: OptionList = { items: [], loading: false, error: null };

async function loadAllOptions(
  input: { connectionId: string; kind: LinearOptionKind; teamId?: string },
  signal: AbortSignal,
): Promise<LinearOption[]> {
  const items: LinearOption[] = [];
  let cursor: string | undefined;
  do {
    const page = await rpc.linear.options(cursor ? { ...input, cursor } : input, { signal });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && !signal.aborted);
  return items;
}

export function LinearTriggerCard({
  value,
  connectionsTick,
  onChange,
  onRemove,
  onConnect,
  onBlockedChange,
}: {
  value: LinearTriggerDraft;
  connectionsTick: number;
  onChange: (next: LinearTriggerDraft) => void;
  onRemove: () => void;
  onConnect: () => void;
  onBlockedChange: (blocked: boolean) => void;
}) {
  const { t } = useLingui();
  const fieldId = useId();
  const [accounts, setAccounts] = useState<Connection[] | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [teams, setTeams] = useState<OptionList & { key: string }>({ key: "", ...IDLE_LIST });
  const [filtersOpen, setFiltersOpen] = useState(
    Boolean(value.projectId || value.assigneeId || value.stateId || value.labelIds.length),
  );
  const [filterOptions, setFilterOptions] = useState<{
    key: string;
    lists: Record<FilterKind, OptionList>;
  } | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const accountSelectRef = useRef<HTMLSelectElement | null>(null);
  const connectRef = useRef<HTMLButtonElement | null>(null);
  const initialTick = useRef(connectionsTick);

  const connected = (accounts ?? []).filter((row) => row.status === "connected");
  const accountConnected = connected.some((row) => row.id === value.connectionId);
  const selectedAccount = accounts?.find((row) => row.id === value.connectionId);
  const filterKey = `${value.connectionId}:${value.teamId}`;
  const lists = filterOptions?.key === filterKey ? filterOptions.lists : null;
  const teamsCurrent = teams.key === value.connectionId;

  useEffect(() => {
    const controller = new AbortController();
    setAccountsError(null);
    void rpc.connections
      .list(undefined, { signal: controller.signal })
      .then((rows) => {
        if (controller.signal.aborted) return;
        setAccounts(
          rows.filter(
            (row) => row.connectorId === LINEAR_CONNECTOR_ID && row.provider === LINEAR_PROVIDER,
          ),
        );
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setAccountsError(errorText(err, t`Linear is temporarily unavailable`));
        }
      });
    return () => controller.abort();
  }, [connectionsTick, retryTick]);

  useEffect(() => {
    if (!accounts) return;
    if (!value.connectionId && connected.length === 1 && connected[0]) {
      onChange({ ...value, connectionId: connected[0].id });
    }
    if (connectionsTick === initialTick.current) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    (accountSelectRef.current ?? connectRef.current)?.focus();
  }, [accounts]);

  useEffect(() => {
    if (!value.connectionId || !accountConnected) {
      setTeams({ key: "", ...IDLE_LIST });
      return;
    }
    const key = value.connectionId;
    const controller = new AbortController();
    setTeams({ key, ...LOADING_LIST });
    loadAllOptions({ connectionId: key, kind: "teams" }, controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) setTeams({ key, items, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setTeams({
          key,
          items: [],
          loading: false,
          error: errorText(err, t`Linear is temporarily unavailable`),
        });
      });
    return () => controller.abort();
  }, [value.connectionId, accountConnected, retryTick]);

  useEffect(() => {
    if (!teamsCurrent || teams.loading || teams.error || value.teamId) return;
    const only = teams.items.length === 1 ? teams.items[0] : undefined;
    if (only) onChange({ ...value, teamId: only.id });
  }, [teams]);

  useEffect(() => {
    if (!filtersOpen || !value.teamId || !accountConnected) return;
    const key = filterKey;
    const connectionId = value.connectionId;
    const teamId = value.teamId;
    const controller = new AbortController();
    setFilterOptions({
      key,
      lists: {
        projects: LOADING_LIST,
        assignees: LOADING_LIST,
        states: LOADING_LIST,
        labels: LOADING_LIST,
      },
    });
    for (const kind of FILTER_KINDS) {
      const settle = (list: OptionList) => {
        if (controller.signal.aborted) return;
        setFilterOptions((current) =>
          current?.key === key ? { key, lists: { ...current.lists, [kind]: list } } : current,
        );
      };
      loadAllOptions({ connectionId, kind, teamId }, controller.signal)
        .then((items) => settle({ items, loading: false, error: null }))
        .catch((err: unknown) =>
          settle({
            items: [],
            loading: false,
            error: errorText(err, t`Linear is temporarily unavailable`),
          }),
        );
    }
    return () => controller.abort();
  }, [filtersOpen, filterKey, accountConnected, retryTick]);

  const filterFailed = lists ? FILTER_KINDS.some((kind) => Boolean(lists[kind].error)) : false;
  const blocked =
    Boolean(accountsError) ||
    (accounts !== null && Boolean(value.connectionId) && !accountConnected) ||
    (teamsCurrent && Boolean(teams.error)) ||
    filterFailed;

  useEffect(() => {
    onBlockedChange(blocked);
  }, [blocked]);

  useEffect(() => () => onBlockedChange(false), []);

  function fallbackLabel(id: string, list: OptionList | null) {
    return !list || list.loading ? t`Loading…` : t`Unavailable (${id})`;
  }

  function toggleEvent(kind: LinearEventKind, checked: boolean) {
    const events = checked
      ? LINEAR_EVENT_KINDS.filter((entry) => entry === kind || value.events.includes(entry))
      : value.events.filter((entry) => entry !== kind);
    onChange({ ...value, events });
  }

  function retryButton() {
    return (
      <Button
        type="button"
        variant="link"
        size="xs"
        className="px-0 text-muted-foreground"
        onClick={() => setRetryTick((tick) => tick + 1)}
      >
        <Trans>Retry</Trans>
      </Button>
    );
  }

  const eventLabels: Record<LinearEventKind, string> = {
    "issue.created": t`Issue created`,
    "issue.updated": t`Issue updated`,
    "comment.created": t`Comment added`,
  };
  const accountError = accountsError
    ? accountsError
    : accounts !== null && value.connectionId && !accountConnected
      ? t`Reconnect Linear`
      : null;
  const teamError = teamsCurrent ? teams.error : null;
  const teamMissing = Boolean(value.connectionId) && accountConnected && !value.teamId;
  const labelsList = lists?.labels ?? null;

  function renderSingleFilter(
    kind: Exclude<FilterKind, "labels">,
    label: string,
    selected: string | null,
    apply: (id: string | null) => void,
  ) {
    const list = lists?.[kind] ?? null;
    const id = `${fieldId}-${kind}`;
    return (
      <div className="block text-sm text-muted-foreground">
        <label htmlFor={id}>{label}</label>
        <NativeSelect
          id={id}
          className="mt-2 w-full"
          value={selected ?? ""}
          aria-invalid={list?.error ? true : undefined}
          aria-describedby={list?.error ? `${id}-error` : undefined}
          onChange={(event) => apply(event.target.value || null)}
        >
          <NativeSelectOption value="">{t`Any`}</NativeSelectOption>
          {selected && !list?.items.some((option) => option.id === selected) ? (
            <NativeSelectOption value={selected}>
              {fallbackLabel(selected, list)}
            </NativeSelectOption>
          ) : null}
          {list?.items.map((option) => (
            <NativeSelectOption key={option.id} value={option.id}>
              {option.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {list?.error ? (
          <p id={`${id}-error`} className="mt-1 text-[13px] text-destructive">
            {list.error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border p-3" data-testid="routine-linear-trigger">
      <div className="flex items-center gap-2.5 px-0.5">
        <CircleDot size={16} strokeWidth={1.6} className="text-muted-foreground" aria-hidden />
        <span className="flex-1 text-[14.5px] text-foreground">
          <Trans>Linear</Trans>
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t`Remove Linear trigger`}
          onClick={onRemove}
          className="text-muted-foreground"
        >
          <X />
        </Button>
      </div>

      <div className="mt-2.5 space-y-3">
        {accounts !== null && connected.length === 0 ? (
          <Button
            ref={connectRef}
            type="button"
            variant="secondary"
            className="rounded-full"
            size="sm"
            onClick={onConnect}
          >
            <Trans>Connect Linear</Trans>
          </Button>
        ) : null}

        {accounts !== null && (connected.length > 0 || value.connectionId) ? (
          <div className="block text-sm text-muted-foreground">
            <label htmlFor={`${fieldId}-account`}>
              <Trans>Account</Trans>
            </label>
            <NativeSelect
              ref={accountSelectRef}
              id={`${fieldId}-account`}
              className="mt-2 w-full"
              value={value.connectionId}
              aria-invalid={accountError ? true : undefined}
              aria-describedby={accountError ? `${fieldId}-account-error` : undefined}
              onChange={(event) =>
                onChange({
                  ...value,
                  connectionId: event.target.value,
                  teamId: "",
                  projectId: null,
                  assigneeId: null,
                  stateId: null,
                  labelIds: [],
                })
              }
            >
              {!value.connectionId ? (
                <NativeSelectOption value="" disabled>
                  {t`Choose`}
                </NativeSelectOption>
              ) : null}
              {value.connectionId && !accountConnected ? (
                <NativeSelectOption value={value.connectionId}>
                  {selectedAccount?.displayName ?? t`Unavailable (${value.connectionId})`}
                </NativeSelectOption>
              ) : null}
              {connected.map((row) => (
                <NativeSelectOption key={row.id} value={row.id}>
                  {row.displayName}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {accountError ? (
              <p id={`${fieldId}-account-error`} className="mt-1 text-[13px] text-destructive">
                {accountError}
              </p>
            ) : null}
          </div>
        ) : accountsError ? (
          <div>
            <p className="text-[13px] text-destructive">{accountsError}</p>
            {retryButton()}
          </div>
        ) : null}

        {value.connectionId && accountConnected ? (
          <div className="block text-sm text-muted-foreground">
            <label htmlFor={`${fieldId}-team`}>
              <Trans>Team</Trans>
            </label>
            <NativeSelect
              id={`${fieldId}-team`}
              className="mt-2 w-full"
              value={value.teamId}
              aria-invalid={teamError || teamMissing ? true : undefined}
              aria-describedby={teamError ? `${fieldId}-team-error` : undefined}
              onChange={(event) =>
                onChange({
                  ...value,
                  teamId: event.target.value,
                  projectId: null,
                  assigneeId: null,
                  stateId: null,
                  labelIds: [],
                })
              }
            >
              {!value.teamId ? (
                <NativeSelectOption value="" disabled>
                  {t`Choose`}
                </NativeSelectOption>
              ) : null}
              {value.teamId &&
              !(teamsCurrent && teams.items.some((option) => option.id === value.teamId)) ? (
                <NativeSelectOption value={value.teamId}>
                  {fallbackLabel(value.teamId, teamsCurrent ? teams : null)}
                </NativeSelectOption>
              ) : null}
              {teamsCurrent
                ? teams.items.map((option) => (
                    <NativeSelectOption key={option.id} value={option.id}>
                      {option.name}
                    </NativeSelectOption>
                  ))
                : null}
            </NativeSelect>
            {teamError ? (
              <div id={`${fieldId}-team-error`}>
                <p className="mt-1 text-[13px] text-destructive">{teamError}</p>
                {retryButton()}
              </div>
            ) : null}
          </div>
        ) : null}

        <fieldset className="space-y-2">
          <legend className="sr-only">
            <Trans>Events</Trans>
          </legend>
          {LINEAR_EVENT_KINDS.map((kind) => (
            <div key={kind} className="flex items-center gap-2.5 text-[13.5px] text-foreground">
              <Checkbox
                id={`${fieldId}-${kind}`}
                checked={value.events.includes(kind)}
                onCheckedChange={(checked) => toggleEvent(kind, checked)}
              />
              <label htmlFor={`${fieldId}-${kind}`}>{eventLabels[kind]}</label>
            </div>
          ))}
          {value.events.length === 0 ? (
            <p className="text-[13px] text-destructive">
              <Trans>Choose an event</Trans>
            </p>
          ) : null}
        </fieldset>

        {value.teamId && value.connectionId ? (
          <div>
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 rounded-md py-1 text-start text-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              aria-expanded={filtersOpen}
              aria-controls={`${fieldId}-filters`}
              onClick={() => setFiltersOpen((open) => !open)}
            >
              <Trans>Filters</Trans>
              {filtersOpen ? (
                <ChevronUp className="size-4" aria-hidden />
              ) : (
                <ChevronDown className="size-4" aria-hidden />
              )}
            </button>
            {filtersOpen ? (
              <div id={`${fieldId}-filters`} className="mt-2 space-y-3">
                {renderSingleFilter("projects", t`Project`, value.projectId, (projectId) =>
                  onChange({ ...value, projectId }),
                )}
                {renderSingleFilter("assignees", t`Assignee`, value.assigneeId, (assigneeId) =>
                  onChange({ ...value, assigneeId }),
                )}
                {renderSingleFilter("states", t`Status`, value.stateId, (stateId) =>
                  onChange({ ...value, stateId }),
                )}
                <div className="block text-sm text-muted-foreground">
                  <div id={`${fieldId}-labels-label`}>
                    <Trans>Labels</Trans>
                  </div>
                  <Select
                    multiple
                    value={value.labelIds}
                    onValueChange={(labelIds: string[]) =>
                      onChange({ ...value, labelIds: [...labelIds].sort() })
                    }
                  >
                    <SelectTrigger
                      aria-labelledby={`${fieldId}-labels-label`}
                      aria-invalid={labelsList?.error ? true : undefined}
                      aria-describedby={labelsList?.error ? `${fieldId}-labels-error` : undefined}
                      className="mt-2 w-full"
                    >
                      <SelectValue className="min-w-0 truncate">
                        {(ids: string[]) =>
                          ids.length > 0
                            ? ids
                                .map(
                                  (id) =>
                                    labelsList?.items.find((option) => option.id === id)?.name ??
                                    fallbackLabel(id, labelsList),
                                )
                                .join(", ")
                            : t`Any`
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      {value.labelIds
                        .filter((id) => !labelsList?.items.some((option) => option.id === id))
                        .map((id) => (
                          <SelectItem key={id} value={id}>
                            {fallbackLabel(id, labelsList)}
                          </SelectItem>
                        ))}
                      {labelsList?.items.map((option) => (
                        <SelectItem
                          key={option.id}
                          value={option.id}
                          disabled={
                            value.labelIds.length >= LINEAR_MAX_LABELS &&
                            !value.labelIds.includes(option.id)
                          }
                        >
                          {option.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {labelsList?.error ? (
                    <p id={`${fieldId}-labels-error`} className="mt-1 text-[13px] text-destructive">
                      {labelsList.error}
                    </p>
                  ) : null}
                </div>
                {filterFailed ? retryButton() : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
