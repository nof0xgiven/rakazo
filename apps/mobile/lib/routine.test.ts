import type { Routine } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { routineStatusLine } from "./routine.js";

function routine(partial: Partial<Routine>): Routine {
  return {
    id: "routine-1",
    botId: "bot-1",
    name: "Weekly review",
    prompt: "Review the week.",
    crons: [],
    timezone: "UTC",
    active: true,
    notify: true,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    linearTrigger: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("routineStatusLine", () => {
  it("shows readable schedules instead of cron expressions", () => {
    expect(routineStatusLine(routine({ crons: ["0 6 * * *"] }))).toBe(
      "Active · Every day at 6:00 AM · UTC",
    );
    expect(routineStatusLine(routine({ crons: ["0 6 * * 0"] }))).toBe(
      "Active · Every Sunday at 6:00 AM · UTC",
    );
    expect(routineStatusLine(routine({ crons: ["30 8 * * 1-5"] }))).toBe(
      "Active · Weekdays at 8:30 AM · UTC",
    );
    expect(routineStatusLine(routine({ crons: ["0 * * * *"] }))).toBe("Active · Every hour · UTC");
  });

  it("keeps the routine's time zone and other triggers", () => {
    expect(
      routineStatusLine(
        routine({
          active: false,
          crons: ["0 9 * * 1"],
          timezone: "Europe/Berlin",
          webhookEnabled: true,
        }),
      ),
    ).toBe("Paused · Every Monday at 9:00 AM, Webhook · Europe/Berlin");
  });

  it("adds Linear without changing the paused summary", () => {
    const linearTrigger = {
      connectionId: "connection-1",
      teamId: "team-1",
      events: ["issue.created" as const],
      projectId: null,
      assigneeId: null,
      stateId: null,
      labelIds: [],
    };
    expect(routineStatusLine(routine({ linearTrigger }))).toBe("Active · Linear · UTC");
    expect(routineStatusLine(routine({ active: false, crons: ["0 9 * * 1"], linearTrigger }))).toBe(
      "Paused · Every Monday at 9:00 AM, Linear · UTC",
    );
  });

  it("omits the trigger segment when there are no triggers", () => {
    expect(routineStatusLine(routine({}))).toBe("Active · UTC");
  });
});
