import { Trans, useLingui } from "@lingui/react/macro";
import type { BotMemoryBank, MemoryBank, MemoryConnectionFailureReason } from "@rakazo/contracts";
import { newClientId } from "@rakazo/core";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Command,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@rakazo/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import { isConflictError, memoryErrorText, memoryFailureReason } from "../../lib/memory-provider";
import { rpc } from "../../lib/rpc";

const SEARCH_DEBOUNCE_MS = 200;

type BankList = {
  banks: MemoryBank[];
  nextOffset: number | null;
  loading: boolean;
  loaded: boolean;
  failure: { offset: number; reason: MemoryConnectionFailureReason | null; text: string } | null;
};

export function BotMemoryBankField({
  botId,
  configId,
  committed,
  current,
  saving,
  resetKey,
  onOpen,
  onConflict,
  onChoose,
}: {
  botId: string;
  configId: string;
  committed: BotMemoryBank | null;
  current: MemoryBank | null;
  saving: boolean;
  resetKey: number;
  onOpen: () => void;
  onConflict: () => void;
  onChoose: (configId: string, bank: MemoryBank | null) => void;
}) {
  const [chooserOpen, setChooserOpen] = useState(false);
  const [confirmBank, setConfirmBank] = useState<{ bank: MemoryBank | null } | null>(null);

  useEffect(() => {
    setChooserOpen(false);
    setConfirmBank(null);
  }, [resetKey, botId, configId]);

  function select(bank: MemoryBank | null) {
    setChooserOpen(false);
    const nextId = bank?.bankId ?? null;
    if (nextId === (current?.bankId ?? null)) return;
    const replacing = saving ? current : committed;
    if (replacing && replacing.bankId !== nextId) {
      setConfirmBank({ bank });
      return;
    }
    onChoose(configId, bank);
  }

  return (
    <div className="mt-4 text-[14px] text-muted-foreground" data-testid="bot-memory-bank">
      <Trans>Memory</Trans>
      <div className="mt-2 flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-[14px] text-foreground">
            {current ? current.name : <Trans>Built-in</Trans>}
          </div>
          {current && current.name !== current.bankId ? (
            <div className="truncate font-mono text-[12px] text-muted-foreground">
              {current.bankId}
            </div>
          ) : null}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={saving}
          onClick={() => {
            onOpen();
            setChooserOpen(true);
          }}
        >
          {saving ? <Trans>Saving…</Trans> : <Trans>Change</Trans>}
        </Button>
      </div>
      {chooserOpen ? (
        <BankChooserDialog
          key={`${resetKey}:${botId}:${configId}`}
          botId={botId}
          configId={configId}
          selectedBankId={current?.bankId ?? null}
          onSelect={select}
          onConflict={onConflict}
          onClose={() => setChooserOpen(false)}
        />
      ) : null}
      {confirmBank ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirmBank(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                <Trans>Change memory bank?</Trans>
              </AlertDialogTitle>
              <AlertDialogDescription>
                <Trans>
                  Existing memories stay in their current bank; processing already started may
                  finish.
                </Trans>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                <Trans>Cancel</Trans>
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  const { bank } = confirmBank;
                  setConfirmBank(null);
                  onChoose(configId, bank);
                }}
              >
                <Trans>Change</Trans>
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}

function BankChooserDialog({
  botId,
  configId,
  selectedBankId,
  onSelect,
  onConflict,
  onClose,
}: {
  botId: string;
  configId: string;
  selectedBankId: string | null;
  onSelect: (bank: MemoryBank | null) => void;
  onConflict: () => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const ids = useId();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [list, setList] = useState<BankList>({
    banks: [],
    nextOffset: null,
    loading: true,
    loaded: false,
    failure: null,
  });
  const listGeneration = useRef(0);
  const listAbort = useRef<AbortController | null>(null);
  const [mode, setMode] = useState<"list" | "id" | "create">("list");
  const [directId, setDirectId] = useState("");
  const [directBusy, setDirectBusy] = useState(false);
  const [directError, setDirectError] = useState<string | null>(null);
  const directAbort = useRef<AbortController | null>(null);
  const [createName, setCreateName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const createRequestId = useRef<string | null>(null);
  const createAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    void loadPage(debouncedQuery, 0);
  }, [debouncedQuery]);

  useEffect(
    () => () => {
      listGeneration.current += 1;
      listAbort.current?.abort();
      directAbort.current?.abort();
      createAbort.current?.abort();
    },
    [],
  );

  function failureState(error: unknown, offset: number): BankList["failure"] {
    if (isConflictError(error)) onConflict();
    return {
      offset,
      reason: memoryFailureReason(error),
      text: memoryErrorText(error, t`Could not load banks.`),
    };
  }

  async function loadPage(q: string, offset: number) {
    listAbort.current?.abort();
    const controller = new AbortController();
    listAbort.current = controller;
    const generation = ++listGeneration.current;
    setList((current) =>
      offset === 0
        ? { banks: [], nextOffset: null, loading: true, loaded: false, failure: null }
        : { ...current, loading: true, failure: null },
    );
    try {
      const page = await rpc.memory.banks(
        { botId, configId, offset, ...(q ? { q } : {}) },
        { signal: controller.signal },
      );
      if (generation !== listGeneration.current) return;
      setList((current) => {
        const banks = offset === 0 ? [] : [...current.banks];
        const seen = new Set(banks.map((bank) => bank.bankId));
        for (const bank of page.banks) {
          if (seen.has(bank.bankId)) continue;
          seen.add(bank.bankId);
          banks.push(bank);
        }
        return { banks, nextOffset: page.nextOffset, loading: false, loaded: true, failure: null };
      });
    } catch (error) {
      if (generation !== listGeneration.current) return;
      const failure = failureState(error, offset);
      setList((current) => ({ ...current, loading: false, failure }));
    }
  }

  async function lookupBankId() {
    const bankId = directId.trim();
    if (!bankId || directBusy) return;
    directAbort.current?.abort();
    const controller = new AbortController();
    directAbort.current = controller;
    setDirectBusy(true);
    setDirectError(null);
    try {
      const bank = await rpc.memory.bank(
        { botId, configId, bankId },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      onSelect(bank);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (isConflictError(error)) onConflict();
      setDirectError(memoryErrorText(error, t`Something went wrong. Try again.`));
    } finally {
      if (!controller.signal.aborted) setDirectBusy(false);
    }
  }

  async function createBank() {
    const name = createName.trim();
    if (!name || creating) return;
    createRequestId.current ??= newClientId();
    const requestId = createRequestId.current;
    const controller = new AbortController();
    createAbort.current = controller;
    setCreating(true);
    setCreateError(null);
    try {
      const bank = await rpc.memory.createBank(
        { botId, configId, requestId, name },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      onSelect(bank);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (isConflictError(error)) onConflict();
      setCreateError(memoryErrorText(error, t`Something went wrong. Try again.`));
    } finally {
      if (!controller.signal.aborted) setCreating(false);
    }
  }

  const forbidden = list.failure?.reason === "bank_list_forbidden";
  const searching = debouncedQuery.length > 0;

  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (open) return;
        if (creating) {
          details.cancel();
          return;
        }
        onClose();
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            <Trans>Memory bank</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Bots using the same bank share memory.</Trans>
          </DialogDescription>
        </DialogHeader>

        {mode === "list" ? (
          <>
            <Command
              shouldFilter={false}
              label={forbidden ? undefined : t`Search banks`}
              tabIndex={forbidden ? 0 : -1}
              className="rounded-none border-0 bg-transparent p-0"
            >
              {!forbidden ? (
                <CommandInput
                  placeholder={t`Search banks`}
                  value={query}
                  onValueChange={setQuery}
                  autoFocus
                />
              ) : null}
              <div className="mt-2" data-testid="memory-bank-list">
                <CommandList label={t`Memory bank`} className="p-0">
                  <BankRow
                    value="builtin"
                    label={t`Built-in`}
                    selected={selectedBankId === null}
                    onSelect={() => onSelect(null)}
                  />
                  {list.banks.map((bank) => (
                    <BankRow
                      key={bank.bankId}
                      value={`bank:${bank.bankId}`}
                      label={bank.name}
                      detail={bank.name !== bank.bankId ? bank.bankId : undefined}
                      selected={bank.bankId === selectedBankId}
                      onSelect={() => onSelect(bank)}
                    />
                  ))}
                </CommandList>
                {list.loading ? (
                  <p className="px-3 py-2 text-[13px] text-muted-foreground">
                    <Trans>Loading…</Trans>
                  </p>
                ) : null}
                {list.loaded && !list.loading && !list.failure && list.banks.length === 0 ? (
                  <p className="px-3 py-2 text-[13px] text-muted-foreground">
                    {searching ? <Trans>No banks found.</Trans> : <Trans>No banks yet.</Trans>}
                  </p>
                ) : null}
                {list.failure ? (
                  <div className="flex items-center justify-between gap-3 px-3 py-2 text-[13px] text-muted-foreground">
                    <span>{list.failure.text}</span>
                    {!forbidden ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const failure = list.failure;
                          if (failure) void loadPage(debouncedQuery, failure.offset);
                        }}
                      >
                        <Trans>Retry</Trans>
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {!forbidden && !list.loading && !list.failure && list.nextOffset !== null ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="mt-1"
                    onClick={() => {
                      const offset = list.nextOffset;
                      if (offset !== null) void loadPage(debouncedQuery, offset);
                    }}
                  >
                    <Trans>Load more</Trans>
                  </Button>
                ) : null}
              </div>
            </Command>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setMode("id")}>
                <Trans>Use bank ID</Trans>
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setMode("create")}>
                <Trans>Create bank</Trans>
              </Button>
            </div>
          </>
        ) : null}

        {mode === "id" ? (
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault();
              void lookupBankId();
            }}
          >
            <label htmlFor={`${ids}-bank-id`} className="block text-[13.5px] text-foreground/75">
              <Trans>Bank ID</Trans>
              <Input
                id={`${ids}-bank-id`}
                value={directId}
                onChange={(event) => setDirectId(event.target.value)}
                maxLength={255}
                spellCheck={false}
                autoComplete="off"
                className="mt-2 font-mono"
                autoFocus
              />
            </label>
            {directError ? <p className="text-[13px] text-destructive">{directError}</p> : null}
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setMode("list")}>
                <Trans>Back</Trans>
              </Button>
              <Button type="submit" size="sm" disabled={directBusy || !directId.trim()}>
                {directBusy ? <Trans>Checking…</Trans> : <Trans>Use bank</Trans>}
              </Button>
            </div>
          </form>
        ) : null}

        {mode === "create" ? (
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault();
              void createBank();
            }}
          >
            <label htmlFor={`${ids}-bank-name`} className="block text-[13.5px] text-foreground/75">
              <Trans>Bank name</Trans>
              <Input
                id={`${ids}-bank-name`}
                value={createName}
                disabled={creating}
                onChange={(event) => {
                  setCreateName(event.target.value);
                  createRequestId.current = null;
                }}
                maxLength={80}
                className="mt-2"
                autoFocus
              />
            </label>
            <p className="text-[12.5px] text-muted-foreground">
              <Trans>Creates a bank in Hindsight Cloud.</Trans>
            </p>
            {createError ? <p className="text-[13px] text-destructive">{createError}</p> : null}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={creating}
                onClick={() => setMode("list")}
              >
                <Trans>Back</Trans>
              </Button>
              <Button type="submit" size="sm" disabled={creating || !createName.trim()}>
                {creating ? <Trans>Creating…</Trans> : <Trans>Create</Trans>}
              </Button>
            </div>
          </form>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" disabled={creating} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BankRow({
  value,
  label,
  detail,
  selected,
  onSelect,
}: {
  value: string;
  label: string;
  detail?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      value={value}
      aria-checked={selected}
      data-checked={selected}
      onSelect={onSelect}
      className="gap-3 px-3 py-2"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] text-foreground">{label}</span>
        {detail ? (
          <span className="block truncate font-mono text-[12px] text-muted-foreground">
            {detail}
          </span>
        ) : null}
      </span>
    </CommandItem>
  );
}
