import { describe, expect, it } from "vitest";
import { activityNotificationsEnabled, activityPromptSnippet } from "./runs.js";

describe("run activity copy", () => {
  it("presents structured agent messages instead of their internal wake prompt", () => {
    expect(
      activityPromptSnippet({
        trigger: "bot_message",
        prompt: "[bot] A message just arrived from another bot with internal routing data",
        sourceBlocks: [
          {
            kind: "bot_message_received",
            fromBotId: "maya",
            fromBotName: "Maya",
            text: "Please check the release workflow.",
            intent: "request",
          },
        ],
      }),
    ).toBe("Maya asked: Please check the release workflow.");
  });

  it("fails closed when an agent message has no valid structured source", () => {
    expect(
      activityPromptSnippet({
        trigger: "bot_message",
        prompt: "[bot] private internal routing envelope",
        sourceBlocks: [{ kind: "text", text: "not a peer message" }],
      }),
    ).toBe("Message from another agent");
  });
});

describe("run activity notification preference", () => {
  it("silences only direct messages", () => {
    expect(activityNotificationsEnabled(null, false)).toBe(false);
    expect(activityNotificationsEnabled("group-1", false)).toBe(true);
  });

  it("requires the routine notify setting for Linear runs except when they need the user", () => {
    expect(
      activityNotificationsEnabled("group-1", false, { status: "completed", routineNotify: false }),
    ).toBe(false);
    expect(
      activityNotificationsEnabled("group-1", false, { status: "failed", routineNotify: null }),
    ).toBe(false);
    expect(
      activityNotificationsEnabled(null, true, { status: "completed", routineNotify: true }),
    ).toBe(true);
    expect(
      activityNotificationsEnabled(null, true, { status: "waiting_input", routineNotify: false }),
    ).toBe(true);
    expect(
      activityNotificationsEnabled(null, false, { status: "waiting_input", routineNotify: true }),
    ).toBe(false);
  });
});
