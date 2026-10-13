import type { MemoryBank } from "@rakazo/contracts";
import { newClientId } from "@rakazo/core";

export type MemoryBankSelectionTarget = { botId: string; configId: string; scopeKey: string };

type Registration = MemoryBankSelectionTarget & {
  selectedBankId: string | null;
  deliver: (bank: MemoryBank | null) => void;
};

const registrations = new Map<string, Registration>();

function registrationFor(token: string, target: MemoryBankSelectionTarget) {
  const registration = registrations.get(token);
  return registration &&
    registration.botId === target.botId &&
    registration.configId === target.configId &&
    registration.scopeKey === target.scopeKey
    ? registration
    : undefined;
}

export function registerMemoryBankSelection(registration: Registration): {
  token: string;
  unregister: () => void;
} {
  const token = newClientId();
  registrations.set(token, registration);
  return {
    token,
    unregister: () => {
      if (registrations.get(token) === registration) registrations.delete(token);
    },
  };
}

export function memoryBankSelectionDraft(
  token: string,
  target: MemoryBankSelectionTarget,
): { selectedBankId: string | null } | undefined {
  const registration = registrationFor(token, target);
  return registration ? { selectedBankId: registration.selectedBankId } : undefined;
}

export function deliverMemoryBankSelection(
  token: string,
  target: MemoryBankSelectionTarget,
  bank: MemoryBank | null,
): boolean {
  const registration = registrationFor(token, target);
  if (!registration) return false;
  registrations.delete(token);
  registration.deliver(bank);
  return true;
}
