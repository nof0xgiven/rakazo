import { expect, type Page, test } from "@playwright/test";
import type { Connection, Routine, RoutineHistory } from "@rakazo/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

const fixtureUrl = `${process.env.API_URL ?? "http://127.0.0.1:3110"}/__e2e/linear`;
const SIGNING_SECRET = "lin_wh_e2e_synthetic_signing_secret";

async function fixture<T = unknown>(page: Page, body: Record<string, unknown>): Promise<T> {
  const response = await page.request.post(fixtureUrl, { data: body });
  expect(response.ok()).toBe(true);
  return (await response.json()) as T;
}

async function linearApiKey(page: Page): Promise<string> {
  const response = await page.request.get(fixtureUrl);
  const body: unknown = await response.json();
  if (body && typeof body === "object" && "apiKey" in body && typeof body.apiKey === "string") {
    return body.apiKey;
  }
  throw new Error("Linear fixture returned no API key");
}

async function routineRuns(page: Page, routineId: string) {
  const history = await rpc<RoutineHistory>(page, "routines/history", { routineId });
  return history.runs;
}

async function openLinearAutomations(page: Page) {
  await page.getByText("Integrations").click();
  await page.getByPlaceholder("Search apps").fill("Linear automations");
  return page
    .getByText("Linear automations", { exact: true })
    .locator("xpath=ancestor::*[.//button][1]");
}

async function startRoutine(page: Page, name: string, prompt: string) {
  await page.getByTitle("Agent computer").click();
  await page.getByRole("button", { name: "Create Routine" }).click();
  await page.getByPlaceholder("Name this routine").fill(name);
  await page.getByPlaceholder("What should this routine do each time it runs?").fill(prompt);
  await page.getByRole("button", { name: "Add trigger" }).click();
  await page.getByRole("menuitem", { name: "Linear", exact: true }).click();
  return page.getByTestId("routine-linear-trigger");
}

test("connects Linear, configures a webhook, and runs a filtered Linear routine", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const team = `eng-${stamp}`;
  const otherTeam = `ops-${stamp}`;
  await fixture(page, { action: "team", id: team, name: `Engineering ${stamp}` });
  await fixture(page, { action: "team", id: otherTeam, name: `Operations ${stamp}` });
  const apiKey = await linearApiKey(page);

  await signup(page, `linear-${stamp}@rakazo.test`, "password12", "Linear Routine");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  const tile = await openLinearAutomations(page);
  await tile.getByRole("button", { name: "Add", exact: true }).click();
  const detail = page.getByTestId("connection-detail");
  await expect(detail.getByPlaceholder("Account label")).toBeFocused();
  await detail.getByLabel("API key").fill(apiKey);
  const connected = page.waitForResponse(
    (response) => response.url().includes("/rpc/linear/connect") && response.ok(),
  );
  await detail.getByRole("button", { name: "Connect", exact: true }).click();
  await connected;
  await expect(detail.getByLabel("API key")).toHaveCount(0);
  await expect(detail.getByLabel("Account label")).toHaveValue("Linear automations");
  await expect(detail.getByTestId("connection-tools")).toHaveCount(0);

  const [connection] = (await rpc<Connection[]>(page, "connections/list", {})).filter(
    (row) => row.connectorId === "linear",
  );
  expect(connection).toMatchObject({ status: "connected", provider: "linear" });

  await detail.getByRole("button", { name: "Account details" }).click();
  await expect(detail.getByText("No active automations")).toBeVisible();
  await detail.getByRole("button", { name: "Webhooks" }).click();
  await expect(detail.getByLabel("Webhook URL")).toHaveValue(
    `https://rakazo.example.com/api/integrations/linear/${connection!.id}/webhook`,
  );
  await expect(detail.getByRole("link", { name: "Webhook setup" })).toHaveAttribute(
    "href",
    "https://linear.app/developers/webhooks",
  );
  await detail.getByLabel("Signing secret").fill(SIGNING_SECRET);
  const webhookSaved = page.waitForResponse(
    (response) => response.url().includes("/rpc/linear/configureWebhook") && response.ok(),
  );
  await detail.getByRole("button", { name: "Save", exact: true }).click();
  await webhookSaved;
  await expect(detail.getByLabel("Signing secret")).toHaveValue("");
  await expect(detail.getByRole("button", { name: "Remove webhook" })).toBeVisible();
  await captureScreenshot(page, testInfo, "linear-connection-webhook");
  await page.getByRole("button", { name: "Close integrations" }).click();

  const card = await startRoutine(
    page,
    "Linear triage",
    "Summarize linear-run-ok for the team lead",
  );
  await expect(card.getByLabel("Account", { exact: true })).toHaveValue(connection!.id);
  await card.getByLabel("Team", { exact: true }).selectOption({ label: `Engineering ${stamp}` });
  await card.getByText("Comment added", { exact: true }).click();
  await card.getByRole("button", { name: "Filters" }).click();
  await card.getByLabel("Status", { exact: true }).selectOption({ label: "Todo" });
  await card.getByRole("combobox", { name: "Labels" }).click();
  await page.getByRole("option", { name: "Bug", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(card.getByRole("combobox", { name: "Labels" })).toContainText("Bug");
  await captureScreenshot(page, testInfo, "linear-trigger-card");

  const created = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/create") && response.ok(),
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await created;
  const [routine] = await rpc<Routine[]>(page, "routines/list", { botId });
  expect(routine).toMatchObject({
    name: "Linear triage",
    crons: [],
    nextRunAt: null,
    linearTrigger: {
      connectionId: connection!.id,
      teamId: team,
      events: ["issue.created", "comment.created"],
      projectId: null,
      assigneeId: null,
      stateId: `${team}-todo`,
      labelIds: [`${team}-bug`],
    },
  });

  await page.reload();
  await page.getByTitle("Agent computer").click();
  const row = page.getByRole("button", { name: /Linear triage/ });
  await expect(row).toContainText("Linear");
  await row.click();
  const reloaded = page.getByTestId("routine-linear-trigger");
  await expect(reloaded.getByLabel("Team", { exact: true })).toHaveValue(team);
  await expect(reloaded.getByLabel("Status", { exact: true })).toHaveValue(`${team}-todo`);
  await expect(reloaded.getByRole("combobox", { name: "Labels" })).toContainText("Bug");
  await expect(reloaded.getByRole("checkbox", { name: "Comment added" })).toBeChecked();
  await expect(reloaded.getByRole("checkbox", { name: "Issue updated" })).not.toBeChecked();

  await fixture(page, {
    action: "createIssue",
    teamId: otherTeam,
    title: "Other team request",
    stateId: `${otherTeam}-todo`,
    labelIds: [`${otherTeam}-bug`],
  });
  await fixture(page, {
    action: "createIssue",
    teamId: team,
    title: "Unlabeled request",
    stateId: `${team}-todo`,
  });
  const issue = await fixture<{ id: string }>(page, {
    action: "createIssue",
    teamId: team,
    title: "Checkout button stuck",
    stateId: `${team}-todo`,
    labelIds: [`${team}-bug`],
  });

  const settled = async (count: number, poll: boolean) => {
    await expect
      .poll(
        async () => {
          if (poll) await fixture(page, { action: "pollNow" });
          const runs = await routineRuns(page, routine!.id);
          return runs.filter((run) => run.status === "completed").length;
        },
        { timeout: 90_000, intervals: [1_000, 2_000, 3_000] },
      )
      .toBe(count);
  };
  const quietPoll = async () => {
    await page.waitForTimeout(6_000);
    await fixture(page, { action: "pollNow" });
    await page.waitForTimeout(4_000);
  };
  await settled(1, true);
  await quietPoll();
  expect(await routineRuns(page, routine!.id)).toHaveLength(1);

  await fixture(page, { action: "createComment", issueId: issue.id, body: "Seen on mobile too" });
  await settled(2, true);

  const hooked = await fixture<{ id: string }>(page, {
    action: "createIssue",
    teamId: team,
    title: "Signed delivery request",
    stateId: `${team}-todo`,
    labelIds: [`${team}-bug`],
  });
  const delivery = await fixture<{ status: number }>(page, {
    action: "webhook",
    connectionId: connection!.id,
    signingSecret: SIGNING_SECRET,
    type: "Issue",
    webhookAction: "create",
    entityId: hooked.id,
  });
  expect(delivery.status).toBe(200);
  await settled(3, false);
  await quietPoll();
  expect(await routineRuns(page, routine!.id)).toHaveLength(3);

  await page.reload();
  await page.getByTitle("Agent computer").click();
  await page.getByRole("button", { name: /Linear triage/ }).click();
  const history = page.getByTestId("routine-run-history");
  await expect(history.getByText("Done", { exact: true }).first()).toBeVisible();
  await captureScreenshot(page, testInfo, "linear-routine-history");
  await history.getByRole("link", { name: "View chat" }).first().click();
  await expect(page.getByText(/linear-run-ok/i).first()).toBeVisible();
  await captureScreenshot(page, testInfo, "linear-routine-result");
});

test("Linear trigger connects from the editor, survives failed metadata, and fits narrow screens", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const team = `qa-${stamp}`;
  await fixture(page, { action: "team", id: team, name: `Quality ${stamp}` });
  const apiKey = await linearApiKey(page);

  await signup(page, `linear-editor-${stamp}@rakazo.test`, "password12", "Linear Editor");
  await completeOnboarding(page);

  const card = await startRoutine(page, "Keyboard Linear", "Summarize linear-editor-ok");
  const connect = card.getByRole("button", { name: "Connect Linear" });
  await expect(connect).toBeVisible();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await captureScreenshot(page, testInfo, "linear-trigger-no-account");

  await connect.focus();
  await page.keyboard.press("Enter");
  const detail = page.getByTestId("connection-detail");
  await expect(detail.getByPlaceholder("Account label")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(detail.getByLabel("API key")).toBeFocused();
  await page.keyboard.type(apiKey);
  const connected = page.waitForResponse(
    (response) => response.url().includes("/rpc/linear/connect") && response.ok(),
  );
  await page.keyboard.press("Enter");
  await connected;
  await expect(detail.getByLabel("Account label")).toHaveValue("Linear automations");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("connection-detail")).toHaveCount(0);

  const account = card.getByLabel("Account", { exact: true });
  await expect(account).toBeFocused();
  await expect(page.getByPlaceholder("Name this routine")).toHaveValue("Keyboard Linear");
  await expect(page.getByPlaceholder("What should this routine do each time it runs?")).toHaveValue(
    "Summarize linear-editor-ok",
  );
  await card.getByLabel("Team", { exact: true }).selectOption({ label: `Quality ${stamp}` });
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();

  await page.route("**/rpc/linear/options", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          defined: false,
          code: "SERVICE_UNAVAILABLE",
          status: 503,
          message: "Linear is temporarily unavailable",
        },
      }),
    }),
  );
  await card.getByRole("button", { name: "Filters" }).click();
  await expect(card.getByText("Linear is temporarily unavailable").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(card.getByLabel("Team", { exact: true })).toHaveValue(team);
  await captureScreenshot(page, testInfo, "linear-trigger-metadata-failed");

  await page.unroute("**/rpc/linear/options");
  await card.getByRole("button", { name: "Retry" }).click();
  await expect(card.getByText("Linear is temporarily unavailable")).toHaveCount(0);
  await card.getByLabel("Project", { exact: true }).selectOption({ label: "Checkout" });
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  const created = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/create") && response.ok(),
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await created;
  const [routine] = await rpc<Routine[]>(page, "routines/list", { botId: activeBotId(page) });
  expect(routine?.linearTrigger).toMatchObject({
    teamId: team,
    events: ["issue.created"],
    projectId: `${team}-project`,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card).toBeVisible();
  await captureScreenshot(page, testInfo, "linear-trigger-narrow");
});
