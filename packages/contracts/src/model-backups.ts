import type { ModelBackupChoice, ModelCatalogEntry, ModelCredential } from "./domain.js";

export type ConnectedBackupOption = ModelBackupChoice & {
  label: string;
  providerName: string;
};

export function backupChoiceKey(choice: ModelBackupChoice): string {
  return JSON.stringify([choice.provider, choice.modelId]);
}

/**
 * Compatible options come only from the actor-scoped catalog rows the runtime
 * authorizes; a credential only proves its provider is connected.
 */
export function connectedBackupOptions(
  catalog: ModelCatalogEntry[],
  credentials: ModelCredential[],
): ConnectedBackupOption[] {
  const connected = new Set(credentials.map((credential) => credential.provider));
  const seen = new Set<string>();
  const options: ConnectedBackupOption[] = [];
  for (const entry of catalog) {
    if (!connected.has(entry.provider) || entry.placeholder) continue;
    const option = {
      provider: entry.provider,
      modelId: entry.id,
      label: entry.label,
      providerName: entry.providerName ?? entry.provider,
    };
    const key = backupChoiceKey(option);
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(option);
  }
  return options;
}

export function moveBackupChoice(
  choices: ModelBackupChoice[],
  index: number,
  direction: -1 | 1,
): ModelBackupChoice[] {
  const target = index + direction;
  if (index < 0 || index >= choices.length || target < 0 || target >= choices.length) {
    return choices;
  }
  const next = [...choices];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function sameBackupChoices(left: ModelBackupChoice[], right: ModelBackupChoice[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (choice, index) =>
        choice.provider === right[index]?.provider && choice.modelId === right[index]?.modelId,
    )
  );
}
