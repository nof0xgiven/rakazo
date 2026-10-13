import type { ThinkingLevel } from "@rakazo/contracts";
import { canonicalThinkingLevels, ThinkingLevelSchema } from "@rakazo/contracts";
import {
  applyDetectedOpenAiCompatibleSettings,
  applyOpenAiCompatibleModelSetup,
  cancelOpenAiCompatibleModelSetup,
  filterOpenAiCompatibleModelRows,
  modelEffortChoices,
  type OpenAiCompatibleModelDraft,
  type OpenAiCompatibleModelRow,
  type OpenAiCompatibleModelSetup,
  type OpenAiCompatibleSetupIssue,
  openAiCompatibleModelSetup,
  openAiCompatibleSetupIssues,
  toggleOpenAiCompatibleModel,
  updateOpenAiCompatibleModelSetup,
} from "@rakazo/core";
import { useId, useState } from "react";
import { Button } from "./components/ui/button.js";
import { Checkbox } from "./components/ui/checkbox.js";
import { Input } from "./components/ui/input.js";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select.js";

export type OpenAiCompatibleModelEditorLabels = {
  models: string;
  searchModels: string;
  noModels: string;
  noMatches: string;
  needsSetup: string;
  advanced: string;
  supportsThinking: string;
  supportedLevels: string;
  defaultReasoningEffort: string;
  defaultEffort: (level: string) => string;
  contextWindow: string;
  maxTokens: string;
  images: string;
  maxImages: string;
  apply: string;
  cancel: string;
  useDetectedSettings: string;
  otherModel: string;
  modelId: string;
  add: string;
  issues: Record<OpenAiCompatibleSetupIssue, string>;
};

export function OpenAiCompatibleModelEditor({
  draft,
  onChange,
  busy = false,
  adding = false,
  labels,
  effortLabel,
  onAddModel,
}: {
  draft: OpenAiCompatibleModelDraft;
  onChange: (draft: OpenAiCompatibleModelDraft) => void;
  busy?: boolean;
  adding?: boolean;
  labels: OpenAiCompatibleModelEditorLabels;
  effortLabel: (level: ThinkingLevel) => string;
  onAddModel: (modelId: string) => void;
}) {
  const searchId = useId();
  const otherId = useId();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherModelId, setOtherModelId] = useState("");
  const rows = filterOpenAiCompatibleModelRows(draft.rows, query);

  const setRowExpanded = (modelId: string, open: boolean) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (open) next.add(modelId);
      else next.delete(modelId);
      return next;
    });

  const submitOther = () => {
    if (adding) return;
    const modelId = otherModelId.trim();
    if (!modelId) return;
    onAddModel(modelId);
    setOtherModelId("");
    setRowExpanded(modelId, true);
  };

  return (
    <section className="mt-4 space-y-3 text-sm" aria-label={labels.models}>
      <h3 className="font-medium text-foreground">{labels.models}</h3>
      {draft.rows.length > 0 ? (
        <Input
          id={searchId}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={labels.searchModels}
          aria-label={labels.searchModels}
          className="h-8"
        />
      ) : (
        <p className="text-muted-foreground">{labels.noModels}</p>
      )}
      {draft.rows.length > 0 && rows.length === 0 ? (
        <p className="text-muted-foreground">{labels.noMatches}</p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="max-h-96 divide-y divide-border overflow-y-auto rounded-md border border-border">
          {rows.map((row) => (
            <ModelRow
              key={row.modelId}
              row={row}
              open={expanded.has(row.modelId) || (row.checked && row.config === null)}
              onOpenChange={(open) => setRowExpanded(row.modelId, open)}
              draft={draft}
              onChange={onChange}
              busy={busy}
              labels={labels}
              effortLabel={effortLabel}
            />
          ))}
        </ul>
      ) : null}
      {otherOpen ? (
        <div className="flex items-end gap-2">
          <label htmlFor={otherId} className="min-w-0 flex-1 space-y-1">
            <span className="block text-muted-foreground">{labels.modelId}</span>
            <Input
              id={otherId}
              value={otherModelId}
              onChange={(event) => setOtherModelId(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                submitOther();
              }}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              className="h-8"
            />
          </label>
          <Button
            type="button"
            size="sm"
            disabled={busy || adding || !otherModelId.trim()}
            onClick={submitOther}
          >
            {labels.add}
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => setOtherOpen(true)}
        >
          {labels.otherModel}
        </Button>
      )}
    </section>
  );
}

function ModelRow({
  row,
  open,
  onOpenChange,
  draft,
  onChange,
  busy,
  labels,
  effortLabel,
}: {
  row: OpenAiCompatibleModelRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: OpenAiCompatibleModelDraft;
  onChange: (draft: OpenAiCompatibleModelDraft) => void;
  busy: boolean;
  labels: OpenAiCompatibleModelEditorLabels;
  effortLabel: (level: ThinkingLevel) => string;
}) {
  const checkboxId = useId();
  const advancedId = useId();
  const pending = row.checked && row.config === null;
  const canConfigure = row.checked || row.config !== null;
  return (
    <li className="px-3 py-2">
      <div className="flex min-h-8 items-center gap-2">
        <Checkbox
          id={checkboxId}
          checked={row.checked}
          disabled={busy}
          onCheckedChange={(checked) =>
            onChange(toggleOpenAiCompatibleModel(draft, row.modelId, checked === true))
          }
        />
        <label
          htmlFor={checkboxId}
          className="min-w-0 flex-1 break-all font-mono text-xs text-foreground"
        >
          {row.modelId}
        </label>
        {pending ? (
          <span className="text-xs text-muted-foreground">{labels.needsSetup}</span>
        ) : null}
        {canConfigure ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-expanded={open}
            aria-controls={advancedId}
            aria-label={`${labels.advanced}: ${row.modelId}`}
            disabled={busy}
            onClick={() => onOpenChange(!open)}
          >
            {labels.advanced}
          </Button>
        ) : null}
      </div>
      {open && canConfigure ? (
        <ModelSetupForm
          id={advancedId}
          row={row}
          setup={row.setup ?? openAiCompatibleModelSetup(row.config)}
          draft={draft}
          onChange={onChange}
          onClose={() => onOpenChange(false)}
          busy={busy}
          labels={labels}
          effortLabel={effortLabel}
        />
      ) : null}
    </li>
  );
}

function ModelSetupForm({
  id,
  row,
  setup,
  draft,
  onChange,
  onClose,
  busy,
  labels,
  effortLabel,
}: {
  id: string;
  row: OpenAiCompatibleModelRow;
  setup: OpenAiCompatibleModelSetup;
  draft: OpenAiCompatibleModelDraft;
  onChange: (draft: OpenAiCompatibleModelDraft) => void;
  onClose: () => void;
  busy: boolean;
  labels: OpenAiCompatibleModelEditorLabels;
  effortLabel: (level: ThinkingLevel) => string;
}) {
  const fieldId = useId();
  const issues = openAiCompatibleSetupIssues(setup);
  const update = (patch: Partial<OpenAiCompatibleModelSetup>) =>
    onChange(updateOpenAiCompatibleModelSetup(draft, row.modelId, patch));
  const effort = setup.thinking
    ? modelEffortChoices(
        {
          thinkingLevels: canonicalThinkingLevels(setup.thinkingLevels),
          defaultThinkingLevel: null,
        },
        null,
      )
    : null;
  const pending = row.config === null;
  return (
    <fieldset
      id={id}
      aria-label={`${labels.advanced}: ${row.modelId}`}
      className="mt-2 space-y-3 rounded-md bg-muted/40 p-3 text-muted-foreground"
    >
      <label htmlFor={`${fieldId}-thinking`} className="flex items-center gap-2">
        <Checkbox
          id={`${fieldId}-thinking`}
          checked={setup.thinking}
          disabled={busy}
          onCheckedChange={(checked) => update({ thinking: checked === true })}
        />
        {labels.supportsThinking}
      </label>
      {setup.thinking ? (
        <fieldset className="space-y-2">
          <legend>{labels.supportedLevels}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {ThinkingLevelSchema.options.map((level) => (
              <label
                key={level}
                htmlFor={`${fieldId}-${level}`}
                className="flex items-center gap-2"
              >
                <Checkbox
                  id={`${fieldId}-${level}`}
                  checked={setup.thinkingLevels.includes(level)}
                  disabled={busy}
                  onCheckedChange={(checked) =>
                    update({
                      thinkingLevels:
                        checked === true
                          ? [...setup.thinkingLevels, level]
                          : setup.thinkingLevels.filter((current) => current !== level),
                    })
                  }
                />
                {effortLabel(level)}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      {effort ? (
        <label htmlFor={`${fieldId}-default`} className="flex items-center gap-2">
          <span className="min-w-0 flex-1">{labels.defaultReasoningEffort}</span>
          <NativeSelect
            id={`${fieldId}-default`}
            value={setup.defaultThinkingLevel ?? ""}
            disabled={busy}
            onChange={(event) =>
              update({
                defaultThinkingLevel: (event.target.value || null) as ThinkingLevel | null,
              })
            }
            className="h-8 w-36 text-foreground"
          >
            <NativeSelectOption value="">
              {labels.defaultEffort(effortLabel(effort.defaultLevel))}
            </NativeSelectOption>
            {effort.levels.map((level) => (
              <NativeSelectOption key={level} value={level}>
                {effortLabel(level)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      ) : null}
      <NumberField
        id={`${fieldId}-context`}
        label={labels.contextWindow}
        value={setup.contextWindow}
        onChange={(contextWindow) => update({ contextWindow })}
        disabled={busy}
      />
      <NumberField
        id={`${fieldId}-output`}
        label={labels.maxTokens}
        value={setup.maxTokens}
        onChange={(maxTokens) => update({ maxTokens })}
        disabled={busy}
      />
      <label htmlFor={`${fieldId}-images`} className="flex items-center gap-2">
        <Checkbox
          id={`${fieldId}-images`}
          checked={setup.supportsImages}
          disabled={busy}
          onCheckedChange={(checked) => update({ supportsImages: checked === true })}
        />
        {labels.images}
      </label>
      {setup.supportsImages ? (
        <NumberField
          id={`${fieldId}-max-images`}
          label={labels.maxImages}
          value={setup.maxImagesPerPrompt}
          onChange={(maxImagesPerPrompt) => update({ maxImagesPerPrompt })}
          disabled={busy}
        />
      ) : null}
      {issues.length > 0 ? (
        <ul className="space-y-1 text-destructive" aria-live="polite">
          {issues.map((issue) => (
            <li key={issue}>{labels.issues[issue]}</li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy || issues.length > 0 || (!pending && row.setup === null)}
          onClick={() => {
            onChange(applyOpenAiCompatibleModelSetup(draft, row.modelId));
            onClose();
          }}
        >
          {labels.apply}
        </Button>
        {pending || row.setup ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              onChange(cancelOpenAiCompatibleModelSetup(draft, row.modelId));
              onClose();
            }}
          >
            {labels.cancel}
          </Button>
        ) : null}
        {row.suggestion ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => onChange(applyDetectedOpenAiCompatibleSettings(draft, row.modelId))}
          >
            {labels.useDetectedSettings}
          </Button>
        ) : null}
      </div>
    </fieldset>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <label htmlFor={id} className="flex items-center gap-2">
      <span className="min-w-0 flex-1">{label}</span>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={1}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-28 text-center text-foreground"
      />
    </label>
  );
}
