import { Trans, useLingui } from "@lingui/react/macro";
import type { Connection, LinearConnectionStatus } from "@rakazo/contracts";
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from "@rakazo/ui-web";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

const LINEAR_WEBHOOK_HELP_URL = "https://linear.app/developers/webhooks";

type KeyForm = { mode: "add" } | { mode: "reconnect"; row: Connection };

export function LinearAccounts({
  accounts,
  defaultLabel,
  addRequest,
  busy,
  labelValue,
  onLabelChange,
  onLabelCommit,
  removingId,
  onRemove,
  onChanged,
}: {
  accounts: Connection[];
  defaultLabel: string;
  addRequest: number;
  busy: boolean;
  labelValue: (row: Connection) => string;
  onLabelChange: (row: Connection, value: string) => void;
  onLabelCommit: (row: Connection) => void;
  removingId: string | null;
  onRemove: (row: Connection) => void;
  onChanged: () => Promise<void>;
}) {
  const { t } = useLingui();
  const formId = useId();
  const [form, setForm] = useState<KeyForm | null>(null);
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [reconnectedId, setReconnectedId] = useState<string | null>(null);
  const [statusTick, setStatusTick] = useState(0);
  const attempt = useRef<AbortController | null>(null);
  const labelRef = useRef<HTMLInputElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const rows = [...accounts].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );

  useEffect(() => () => attempt.current?.abort(), []);

  useEffect(() => {
    if (addRequest > 0) openForm({ mode: "add" });
  }, [addRequest]);

  useEffect(() => {
    if (form) labelRef.current?.focus();
  }, [form]);

  function openForm(next: KeyForm) {
    attempt.current?.abort();
    attempt.current = null;
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSubmitting(false);
    setFormError(null);
    setApiKey("");
    setLabel(next.mode === "add" ? defaultLabel : next.row.displayName);
    setForm(next);
  }

  function dismiss() {
    attempt.current?.abort();
    attempt.current = null;
    setSubmitting(false);
    setFormError(null);
    setApiKey("");
    setForm(null);
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target?.isConnected) window.setTimeout(() => target.focus(), 0);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const current = form;
    const key = apiKey.trim();
    const displayName = label.trim();
    if (!current || submitting || !key || !displayName) return;
    attempt.current?.abort();
    const controller = new AbortController();
    attempt.current = controller;
    setSubmitting(true);
    setFormError(null);
    try {
      if (current.mode === "reconnect") {
        const status = await rpc.linear.status(
          { connectionId: current.row.id },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        await rpc.linear.connect(
          {
            apiKey: key,
            displayName,
            connectionId: current.row.id,
            expectedRevision: status.revision,
          },
          { signal: controller.signal },
        );
      } else {
        await rpc.linear.connect({ apiKey: key, displayName }, { signal: controller.signal });
      }
      if (controller.signal.aborted) return;
      setApiKey("");
      setForm(null);
      returnFocus.current = null;
      if (current.mode === "reconnect") {
        setExpandedId(current.row.id);
        setReconnectedId(current.row.status === "revoked" ? current.row.id : null);
      }
      setStatusTick((tick) => tick + 1);
      await onChanged();
    } catch (err) {
      if (controller.signal.aborted) return;
      setFormError(errorText(err, t`Could not connect`));
    } finally {
      if (attempt.current === controller) {
        attempt.current = null;
        setSubmitting(false);
      }
    }
  }

  function renderForm() {
    return (
      <form
        className="space-y-2 rounded-xl border border-border p-3"
        aria-labelledby={`${formId}-title`}
        onSubmit={(event) => void submit(event)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            dismiss();
          }
        }}
      >
        <div id={`${formId}-title`} className="sr-only">
          {form?.mode === "reconnect" ? <Trans>Reconnect</Trans> : <Trans>Add</Trans>}
        </div>
        <Input
          ref={labelRef}
          value={label}
          aria-label={t`Account label`}
          placeholder={t`Account label`}
          maxLength={80}
          disabled={submitting}
          onChange={(event) => setLabel(event.target.value)}
        />
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          aria-label={t`API key`}
          placeholder={t`API key`}
          disabled={submitting}
          onChange={(event) => setApiKey(event.target.value)}
        />
        {formError ? (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            variant="secondary"
            className="rounded-full"
            size="sm"
            disabled={submitting || !apiKey.trim() || !label.trim()}
          >
            {submitting ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="rounded-full"
            size="sm"
            onClick={dismiss}
          >
            <Trans>Cancel</Trans>
          </Button>
        </div>
      </form>
    );
  }

  return (
    <Card data-testid="connection-accounts">
      <CardHeader>
        <CardTitle>
          <Trans>Accounts</Trans>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.map((row) => {
          const expanded = expandedId === row.id;
          const needsReconnect = row.status === "revoked" || row.status === "error";
          const reconnecting = form?.mode === "reconnect" && form.row.id === row.id;
          const detailsId = `${formId}-details-${row.id}`;
          return (
            <div key={row.id} className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={labelValue(row)}
                  aria-label={t`Account label`}
                  className="h-9 min-w-0 flex-1 basis-40 rounded-lg px-3 text-[13px]"
                  onChange={(event) => onLabelChange(row, event.target.value)}
                  onBlur={() => onLabelCommit(row)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
                {needsReconnect ? (
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-9 shrink-0 rounded-full px-3 text-[12px]"
                    size="sm"
                    disabled={busy || reconnecting}
                    onClick={() => openForm({ mode: "reconnect", row })}
                  >
                    <Trans>Reconnect</Trans>
                  </Button>
                ) : null}
                {row.status !== "revoked" ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-9 shrink-0 rounded-full px-2 text-[12px]"
                    size="sm"
                    disabled={busy || removingId === row.id}
                    onClick={() => onRemove(row)}
                  >
                    {removingId === row.id ? <Trans>Removing…</Trans> : <Trans>Remove</Trans>}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-muted-foreground"
                  aria-label={t`Account details`}
                  aria-expanded={expanded}
                  aria-controls={detailsId}
                  onClick={() => setExpandedId(expanded ? null : row.id)}
                >
                  {expanded ? <ChevronUp /> : <ChevronDown />}
                </Button>
              </div>
              {reconnecting ? renderForm() : null}
              {expanded ? (
                <div id={detailsId}>
                  <LinearAccountDetails
                    key={`${row.id}:${row.status}:${statusTick}`}
                    row={row}
                    reconnected={reconnectedId === row.id}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
        {form?.mode === "add" ? (
          renderForm()
        ) : (
          <Button
            type="button"
            variant="secondary"
            className="rounded-full"
            size="sm"
            disabled={busy}
            onClick={() => openForm({ mode: "add" })}
          >
            {rows.length === 0 ? <Trans>Add</Trans> : <Trans>Add another</Trans>}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function LinearAccountDetails({ row, reconnected }: { row: Connection; reconnected: boolean }) {
  const { t, i18n } = useLingui();
  const sectionId = useId();
  const [status, setStatus] = useState<LinearConnectionStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [webhooksOpen, setWebhooksOpen] = useState(reconnected);
  const [signingSecret, setSigningSecret] = useState("");
  const [saving, setSaving] = useState<"save" | "remove" | null>(null);
  const [webhookError, setWebhookError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void rpc.linear
      .status({ connectionId: row.id }, { signal: controller.signal })
      .then((next) => {
        if (!controller.signal.aborted) setStatus(next);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setLoadError(errorText(err, t`Could not load status`));
      });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [row.id]);

  function formatDate(iso: string) {
    return new Date(iso).toLocaleString(i18n.locale || "en");
  }

  function stateLine(value: LinearConnectionStatus): string {
    if (
      value.connectionStatus === "revoked" ||
      value.connectionStatus === "error" ||
      value.errorCode === "auth"
    ) {
      return t`Reconnect Linear`;
    }
    if (value.rateLimitedUntil && Date.parse(value.rateLimitedUntil) > Date.now()) {
      const until = formatDate(value.rateLimitedUntil);
      return t`Waiting for Linear until ${until}`;
    }
    if (value.errorCode === "rate_limit") return t`Waiting for Linear`;
    if (value.errorCode === "unavailable" || value.errorCode === "invalid_response") {
      return t`Linear is temporarily unavailable`;
    }
    if (value.monitoring === "idle") return t`No active automations`;
    return t`Polling`;
  }

  async function saveWebhook(secret: string | null) {
    if (!status || saving) return;
    setSaving(secret === null ? "remove" : "save");
    setWebhookError(null);
    try {
      const next = await rpc.linear.configureWebhook({
        connectionId: row.id,
        expectedRevision: status.revision,
        signingSecret: secret,
      });
      if (!mounted.current) return;
      setStatus(next);
      setSigningSecret("");
    } catch (err) {
      if (!mounted.current) return;
      setWebhookError(errorText(err, t`Could not save webhook`));
    } finally {
      if (mounted.current) setSaving(null);
    }
  }

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      if (!mounted.current) return;
      setCopied(true);
      window.setTimeout(() => {
        if (mounted.current) setCopied(false);
      }, 1500);
    } catch {
      if (mounted.current) setWebhookError(t`Could not copy`);
    }
  }

  if (loadError) return <p className="text-sm text-destructive">{loadError}</p>;
  if (!status) {
    return (
      <p className="text-sm text-muted-foreground">
        <Trans>Loading…</Trans>
      </p>
    );
  }
  const lastPolled = status.lastPolledAt ? formatDate(status.lastPolledAt) : null;
  const lastWebhook = status.lastWebhookAt ? formatDate(status.lastWebhookAt) : null;
  const connected = status.connectionStatus === "connected";

  return (
    <div className="space-y-2 rounded-xl bg-muted/50 p-3 text-[13px]">
      <p className="text-foreground" aria-live="polite">
        {stateLine(status)}
      </p>
      {lastPolled ? (
        <p className="text-muted-foreground">
          <Trans>Last successful poll {lastPolled}</Trans>
        </p>
      ) : null}
      {lastWebhook ? (
        <p className="text-muted-foreground">
          <Trans>Last verified webhook {lastWebhook}</Trans>
        </p>
      ) : null}
      {connected ? (
        <div>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 rounded-md py-1 text-start text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            aria-expanded={webhooksOpen}
            aria-controls={sectionId}
            onClick={() => {
              setWebhooksOpen((open) => !open);
              setSigningSecret("");
              setWebhookError(null);
            }}
          >
            <span>
              <Trans>Webhooks</Trans>
            </span>
            {webhooksOpen ? (
              <ChevronUp className="size-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="size-4 text-muted-foreground" />
            )}
          </button>
          {webhooksOpen ? (
            <div id={sectionId} className="mt-2 space-y-2">
              {status.webhookUrl ? (
                <>
                  {reconnected ? (
                    <p className="text-muted-foreground">
                      <Trans>
                        Re-enter the signing secret. Re-enable the webhook in Linear if it was
                        disabled.
                      </Trans>
                    </p>
                  ) : null}
                  <div className="flex items-center gap-2">
                    <Input
                      readOnly
                      value={status.webhookUrl}
                      aria-label={t`Webhook URL`}
                      className="h-9 min-w-0 flex-1 font-mono text-xs"
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      className="shrink-0 rounded-full"
                      size="sm"
                      onClick={() => void copyUrl(status.webhookUrl ?? "")}
                    >
                      {copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
                    </Button>
                  </div>
                  <form
                    className="flex flex-wrap items-center gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const secret = signingSecret.trim();
                      if (secret) void saveWebhook(secret);
                    }}
                  >
                    <Input
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={signingSecret}
                      aria-label={t`Signing secret`}
                      placeholder={t`Signing secret`}
                      disabled={saving !== null}
                      className="h-9 min-w-0 flex-1 basis-40"
                      onChange={(event) => setSigningSecret(event.target.value)}
                    />
                    <Button
                      type="submit"
                      variant="secondary"
                      className="shrink-0 rounded-full"
                      size="sm"
                      disabled={saving !== null || !signingSecret.trim()}
                    >
                      {saving === "save" ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
                    </Button>
                    {status.webhookConfigured ? (
                      <Button
                        type="button"
                        variant="ghost"
                        className="shrink-0 rounded-full"
                        size="sm"
                        disabled={saving !== null}
                        onClick={() => void saveWebhook(null)}
                      >
                        {saving === "remove" ? (
                          <Trans>Removing…</Trans>
                        ) : (
                          <Trans>Remove webhook</Trans>
                        )}
                      </Button>
                    ) : null}
                  </form>
                  <a
                    href={LINEAR_WEBHOOK_HELP_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-block text-muted-foreground underline-offset-4 hover:underline"
                  >
                    <Trans>Webhook setup</Trans>
                  </a>
                </>
              ) : (
                <p className="text-muted-foreground">
                  <Trans>Webhooks require a public HTTPS API URL.</Trans>
                </p>
              )}
              {webhookError ? (
                <p role="alert" className="text-destructive">
                  {webhookError}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
