import { Trans } from "@lingui/react/macro";
import { Button, Field, FieldLabel, Input } from "@rakazo/ui-web";
import { useId, useState } from "react";
import type { MemoryProviderSettingsFormProps } from "./registry";

const HINDSIGHT_CLOUD_ORIGIN = "https://api.hindsight.vectorize.io";

export function HindsightSettingsForm({ busy, onConnect }: MemoryProviderSettingsFormProps) {
  const apiKeyId = useId();
  const bankId = useId();
  const [apiKey, setApiKey] = useState("");
  const [verificationBankId, setVerificationBankId] = useState("");
  const [bankIdRequired, setBankIdRequired] = useState(false);
  const trimmedKey = apiKey.trim();
  const trimmedBankId = verificationBankId.trim();

  async function connect() {
    if (!trimmedKey || (bankIdRequired && !trimmedBankId)) return;
    const result = await onConnect({
      settings: {
        baseUrl: HINDSIGHT_CLOUD_ORIGIN,
        ...(bankIdRequired ? { verificationBankId: trimmedBankId } : {}),
      },
      credentials: { apiKey: trimmedKey },
    });
    if (result.ok) {
      setApiKey("");
      setVerificationBankId("");
      setBankIdRequired(false);
      return;
    }
    if (result.reason === "bank_id_required") setBankIdRequired(true);
  }

  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        void connect();
      }}
    >
      <Field>
        <FieldLabel htmlFor={apiKeyId}>
          <Trans>API key</Trans>
        </FieldLabel>
        <Input
          id={apiKeyId}
          value={apiKey}
          disabled={busy}
          onChange={(event) => setApiKey(event.target.value)}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
        />
      </Field>

      {bankIdRequired ? (
        <Field className="mt-4">
          <FieldLabel htmlFor={bankId}>
            <Trans>Bank ID</Trans>
          </FieldLabel>
          <Input
            id={bankId}
            value={verificationBankId}
            disabled={busy}
            onChange={(event) => setVerificationBankId(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
        </Field>
      ) : null}

      <p className="mt-4 text-[13px] text-muted-foreground">
        <Trans>Bots in this Space can use banks this key can access.</Trans>
      </p>

      <Button
        type="submit"
        variant="secondary"
        className="mt-4 rounded-full"
        size="sm"
        disabled={busy || !trimmedKey || (bankIdRequired && !trimmedBankId)}
      >
        {busy ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
      </Button>
    </form>
  );
}
