import { describe, expect, it } from "vitest";
import { modelEffortChoices } from "./model-effort.js";

describe("modelEffortChoices", () => {
  it("labels Default with the level the model actually executes", () => {
    expect(
      modelEffortChoices({ thinkingLevels: ["low", "high"], defaultThinkingLevel: null }, null),
    ).toEqual({ defaultLevel: "high", levels: ["low", "high"], unavailable: null });
    expect(
      modelEffortChoices(
        { thinkingLevels: ["off", "low", "medium", "high"], defaultThinkingLevel: null },
        undefined,
      )?.defaultLevel,
    ).toBe("medium");
    expect(
      modelEffortChoices({ thinkingLevels: ["low", "medium"], defaultThinkingLevel: "low" }, null)
        ?.defaultLevel,
    ).toBe("low");
  });

  it("offers Off only when the model supports it", () => {
    expect(
      modelEffortChoices(
        { thinkingLevels: ["off", "low", "high", "xhigh"], defaultThinkingLevel: null },
        "off",
      ),
    ).toEqual({ defaultLevel: "high", levels: ["off", "low", "high", "xhigh"], unavailable: null });
    expect(
      modelEffortChoices({ thinkingLevels: ["low", "medium"], defaultThinkingLevel: null }, null)
        ?.levels,
    ).toEqual(["low", "medium"]);
  });

  it("shows a saved unsupported effort as unavailable without offering it", () => {
    expect(
      modelEffortChoices(
        { thinkingLevels: ["off", "minimal", "low", "medium", "high"], defaultThinkingLevel: null },
        "xhigh",
      ),
    ).toEqual({
      defaultLevel: "medium",
      levels: ["off", "minimal", "low", "medium", "high"],
      unavailable: "xhigh",
    });
    expect(
      modelEffortChoices({ thinkingLevels: ["low", "medium"], defaultThinkingLevel: null }, "off")
        ?.unavailable,
    ).toBe("off");
  });

  it("has no selector for nonreasoning or undescribed models", () => {
    expect(
      modelEffortChoices({ thinkingLevels: ["off"], defaultThinkingLevel: null }, "high"),
    ).toBe(null);
    expect(modelEffortChoices(undefined, "high")).toBe(null);
  });
});
