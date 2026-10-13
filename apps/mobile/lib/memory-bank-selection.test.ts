import { describe, expect, it, vi } from "vitest";
import {
  deliverMemoryBankSelection,
  memoryBankSelectionDraft,
  registerMemoryBankSelection,
} from "./memory-bank-selection";

const target = { botId: "bot-1", configId: "config-1", scopeKey: "scope-a" };
const bank = { bankId: "team-notes", name: "Team notes" };

describe("memory bank selection", () => {
  it("delivers one verified selection and then rejects repeats", () => {
    const deliver = vi.fn();
    const { token } = registerMemoryBankSelection({ ...target, selectedBankId: null, deliver });

    expect(memoryBankSelectionDraft(token, target)).toEqual({ selectedBankId: null });
    expect(deliverMemoryBankSelection(token, target, bank)).toBe(true);
    expect(deliverMemoryBankSelection(token, target, null)).toBe(false);
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith(bank);
    expect(memoryBankSelectionDraft(token, target)).toBeUndefined();
  });

  it.each([
    ["another bot", { ...target, botId: "bot-2" }],
    ["a replaced connection", { ...target, configId: "config-2" }],
    ["another account, server or Space", { ...target, scopeKey: "scope-b" }],
  ])("refuses a selection made for %s without consuming the registration", (_case, other) => {
    const deliver = vi.fn();
    const { token } = registerMemoryBankSelection({ ...target, selectedBankId: "old", deliver });

    expect(memoryBankSelectionDraft(token, other)).toBeUndefined();
    expect(deliverMemoryBankSelection(token, other, bank)).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
    expect(deliverMemoryBankSelection(token, target, bank)).toBe(true);
    expect(deliver).toHaveBeenCalledWith(bank);
  });

  it("drops a late selection after the settings screen unregistered", () => {
    const deliver = vi.fn();
    const { token, unregister } = registerMemoryBankSelection({
      ...target,
      selectedBankId: null,
      deliver,
    });

    unregister();

    expect(deliverMemoryBankSelection(token, target, bank)).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("keeps a replacement registration when the earlier one unregisters late", () => {
    const first = vi.fn();
    const second = vi.fn();
    const earlier = registerMemoryBankSelection({
      ...target,
      selectedBankId: null,
      deliver: first,
    });
    const later = registerMemoryBankSelection({ ...target, selectedBankId: null, deliver: second });

    earlier.unregister();
    later.unregister();
    const replacement = registerMemoryBankSelection({
      ...target,
      selectedBankId: null,
      deliver: second,
    });
    earlier.unregister();

    expect(deliverMemoryBankSelection(earlier.token, target, bank)).toBe(false);
    expect(deliverMemoryBankSelection(later.token, target, bank)).toBe(false);
    expect(deliverMemoryBankSelection(replacement.token, target, null)).toBe(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledWith(null);
  });
});
