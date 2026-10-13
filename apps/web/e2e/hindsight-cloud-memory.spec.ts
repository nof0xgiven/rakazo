import { expect, type Page, test } from "@playwright/test";
import type { Bot } from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  rpc,
  signup,
} from "./helpers";
import {
  bankChooser,
  botMemoryBank,
  closeMemorySettings,
  confirmBankChange,
  connectHindsight,
  createHindsightFixture,
  disposeHindsightFixtures,
  expectBoundBank,
  fillHindsightConnection,
  HINDSIGHT_ORIGIN,
  memoryConfig,
  openBankChooser,
  openBotMemory,
  openMemorySettings,
} from "./hindsight";

test.afterEach(async () => {
  await disposeHindsightFixtures();
});

async function signUpOwner(page: Page, label: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await signup(page, `hindsight-${label}-${stamp}@rakazo.test`, "password12", `Hindsight ${label}`);
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  return activeBotId(page);
}

test("connects Hindsight Cloud and binds existing, created, and direct-ID banks", async ({
  page,
}, testInfo) => {
  const fixture = await createHindsightFixture({
    banks: [{ bankId: "team-notes", name: "Team notes" }, { bankId: "raw-bank-id" }],
  });
  const chiefId = await signUpOwner(page, "connect");

  const providerConfigRoute = "**/rpc/memory/providerConfig";
  await page.route(providerConfigRoute, (route) => route.abort("failed"));
  await page.reload();
  await page.waitForURL(/\/app\/[^/]+$/);
  const memory = await openMemorySettings(page);
  await expect(memory.getByText("Could not load memory settings.")).toBeVisible();
  await expect(memory.getByLabel("Provider")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "hindsight-memory-load-error");
  await page.unroute(providerConfigRoute);
  await memory.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(memory.getByLabel("Provider")).toBeVisible();

  await fillHindsightConnection(memory, fixture.apiKey);
  await expect(memory.getByLabel("Bank ID")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "hindsight-connection-form");
  await memory.getByLabel("API key").fill("hsk_fixture_not_issued");
  await memory.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    memory.getByText("Hindsight Cloud rejected this API key.", { exact: true }),
  ).toBeVisible();
  expect(await memoryConfig(page)).toBeNull();

  await memory.getByLabel("API key").fill(fixture.apiKey);
  await memory.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(memory.getByText("Connected", { exact: true })).toBeVisible();
  await expect(memory.getByText("Hindsight Cloud", { exact: true })).toBeVisible();
  await expect(memory.getByLabel("API key")).toHaveCount(0);
  await expect(memory.getByText(/^Banks stay in Hindsight Cloud\./)).toHaveCount(0);
  await captureScreenshot(page, testInfo, "hindsight-connected");
  const config = await memoryConfig(page);
  expect(config).toMatchObject({
    provider: "hindsight",
    settings: { baseUrl: HINDSIGHT_ORIGIN },
    capabilities: { banks: true, sharedScope: false },
  });
  expect(JSON.stringify(config)).not.toContain(fixture.apiKey);
  await closeMemorySettings(page);

  const field = await openBotMemory(page, "Chief");
  await expectBoundBank(field, "Built-in");
  let chooser = await openBankChooser(field);
  await expect(
    chooser.getByText("Bots using the same bank share memory.", { exact: true }),
  ).toBeVisible();
  await expect(chooser.getByRole("option", { name: /Team notes/ })).toBeVisible();
  await expect(chooser.getByRole("option", { name: "raw-bank-id", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "hindsight-bank-picker");
  await chooser.getByRole("option", { name: /Team notes/ }).click();
  await expect(chooser).toHaveCount(0);
  await expectBoundBank(field, "Team notes", "team-notes");
  const firstBinding = await botMemoryBank(page, chiefId);
  expect(firstBinding).toMatchObject({
    bankId: "team-notes",
    name: "Team notes",
    configId: config!.id,
  });

  chooser = await openBankChooser(field);
  await chooser.getByRole("button", { name: "Create bank", exact: true }).click();
  await expect(
    chooser.getByText("Creates a bank in Hindsight Cloud.", { exact: true }),
  ).toBeVisible();
  await chooser.getByLabel("Bank name").fill("Research archive");
  await captureScreenshot(page, testInfo, "hindsight-create-bank");
  await chooser.getByRole("button", { name: "Create", exact: true }).click();
  await confirmBankChange(page);
  await expectBoundBank(field, "Research archive");
  const createdBinding = await botMemoryBank(page, chiefId);
  expect(createdBinding?.bankId).toMatch(/^rakazo-[0-9a-f]{32}$/);
  expect(createdBinding?.id).not.toBe(firstBinding?.id);
  await expect(field.getByText(createdBinding!.bankId, { exact: true })).toBeVisible();

  chooser = await openBankChooser(field);
  await chooser.getByRole("button", { name: "Use bank ID", exact: true }).click();
  await chooser.getByLabel("Bank ID").fill("missing-bank");
  await chooser.getByRole("button", { name: "Use bank", exact: true }).click();
  await expect(chooser.getByText("This bank is unavailable.", { exact: true })).toBeVisible();
  await chooser.getByLabel("Bank ID").fill("raw-bank-id");
  await chooser.getByRole("button", { name: "Use bank", exact: true }).click();
  await confirmBankChange(page);
  await expectBoundBank(field, "raw-bank-id");
  expect(await botMemoryBank(page, chiefId)).toMatchObject({
    bankId: "raw-bank-id",
    name: "raw-bank-id",
  });

  chooser = await openBankChooser(field);
  await chooser.getByRole("option", { name: "Built-in", exact: true }).click();
  await confirmBankChange(page);
  await expectBoundBank(field, "Built-in");
  expect(await botMemoryBank(page, chiefId)).toBeNull();

  const snapshot = await fixture.snapshot();
  const created = snapshot.banks.find((bank) => bank.bankId === createdBinding!.bankId);
  expect(created?.name).toBe("Research archive");
  expect(snapshot.requests.filter((request) => request.route === "create")).toHaveLength(1);
  expect(snapshot.requests.some((request) => request.method === "DELETE")).toBe(false);
});

test("pages more than 50 banks, searches on the server, and reports denied creation", async ({
  page,
}, testInfo) => {
  const fixture = await createHindsightFixture({ keys: [{ create: false }], seedBanks: 60 });
  await signUpOwner(page, "paging");
  await connectHindsight(page, fixture.apiKey);
  const field = await openBotMemory(page, "Chief");

  await page.route("**/rpc/memory/banks", (route) => route.abort("failed"), { times: 1 });
  await field.getByRole("button", { name: "Change", exact: true }).click();
  const chooser = bankChooser(page);
  const list = chooser.getByTestId("memory-bank-list");
  await expect(list.getByText("Could not reach the server", { exact: true })).toBeVisible();
  const search = chooser.getByLabel("Search banks");
  await search.focus();
  await page.keyboard.press("Tab");
  await expect(list.getByRole("button", { name: "Retry", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(chooser).toBeVisible();

  const rows = list.getByRole("option");
  await expect(rows).toHaveCount(51);
  await expect(list.getByRole("option", { name: /fixture-bank-050/ })).toBeVisible();
  await expect(list.getByRole("option", { name: /fixture-bank-051/ })).toHaveCount(0);
  await search.focus();
  await page.keyboard.press("Tab");
  await expect(list.getByRole("button", { name: "Load more", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(chooser).toBeVisible();
  await expect(rows).toHaveCount(61);
  await expect(list.getByRole("option", { name: /fixture-bank-060/ })).toBeVisible();
  await expect(list.getByRole("button", { name: "Load more", exact: true })).toHaveCount(0);

  await search.fill("fixture-bank-057");
  await expect(rows).toHaveCount(2);
  await expect(list.getByRole("option", { name: /fixture-bank-057/ })).toBeVisible();
  await captureScreenshot(page, testInfo, "hindsight-bank-search");
  await chooser.getByLabel("Search banks").fill("no-such-bank");
  await expect(list.getByText("No banks found.", { exact: true })).toBeVisible();

  const listRequests = (await fixture.snapshot()).requests.filter(
    (request) => request.route === "list",
  );
  expect(listRequests).toContainEqual(
    expect.objectContaining({ query: expect.objectContaining({ q: "fixture-bank-057" }) }),
  );
  expect(listRequests).toContainEqual(
    expect.objectContaining({
      query: expect.objectContaining({ offset: "50", limit: "50" }),
    }),
  );

  await chooser.getByRole("button", { name: "Create bank", exact: true }).click();
  await chooser.getByLabel("Bank name").fill("Not allowed");
  await chooser.getByRole("button", { name: "Create", exact: true }).click();
  await expect(chooser.getByText("This key can't create banks.", { exact: true })).toBeVisible();
  await chooser.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(chooser).toHaveCount(0);
  await expectBoundBank(field, "Built-in");
  expect((await fixture.snapshot()).banks.some((bank) => bank.name === "Not allowed")).toBe(false);
});

test("a key that cannot list banks verifies with a bank ID", async ({ page }, testInfo) => {
  const fixture = await createHindsightFixture({
    keys: [{ label: "scoped", list: false, create: false, banks: ["scoped-bank"] }],
    banks: [
      { bankId: "scoped-bank", name: "Scoped bank" },
      { bankId: "other-bank", name: "Other bank" },
    ],
  });
  const chiefId = await signUpOwner(page, "scoped");
  const memory = await openMemorySettings(page);
  await fillHindsightConnection(memory, fixture.apiKey);
  await memory.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    memory.getByText("This key can't list banks. Use bank ID.", { exact: true }),
  ).toBeVisible();
  expect(await memoryConfig(page)).toBeNull();
  const connect = memory.getByRole("button", { name: "Connect", exact: true });
  await expect(connect).toBeDisabled();
  await memory.getByLabel("Bank ID").fill("scoped-bank");
  await captureScreenshot(page, testInfo, "hindsight-connection-bank-id");
  await connect.click();
  await expect(memory.getByText("Connected", { exact: true })).toBeVisible();
  const config = await memoryConfig(page);
  expect(config?.settings).toEqual({ baseUrl: HINDSIGHT_ORIGIN });
  await closeMemorySettings(page);

  const field = await openBotMemory(page, "Chief");
  const chooser = await openBankChooser(field);
  const list = chooser.getByTestId("memory-bank-list");
  await expect(
    list.getByText("This key can't list banks. Use bank ID.", { exact: true }),
  ).toBeVisible();
  await expect(chooser.getByLabel("Search banks")).toHaveCount(0);
  await expect(list.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await expect(list.getByRole("button", { name: "Load more", exact: true })).toHaveCount(0);
  await expect(chooser.getByRole("button", { name: "Create bank", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "hindsight-bank-picker-scoped");

  await chooser.getByRole("button", { name: "Use bank ID", exact: true }).click();
  await chooser.getByLabel("Bank ID").fill("other-bank");
  await chooser.getByRole("button", { name: "Use bank", exact: true }).click();
  await expect(
    chooser.getByText("This key cannot access this bank.", { exact: true }),
  ).toBeVisible();
  await chooser.getByLabel("Bank ID").fill("scoped-bank");
  await chooser.getByRole("button", { name: "Use bank", exact: true }).click();
  await expect(chooser).toHaveCount(0);
  await expectBoundBank(field, "Scoped bank", "scoped-bank");
  expect(await botMemoryBank(page, chiefId)).toMatchObject({ bankId: "scoped-bank" });

  const requests = (await fixture.snapshot()).requests;
  expect(requests.every((request) => request.keyLabel === "scoped")).toBe(true);
  expect(requests.some((request) => request.route === "create")).toBe(false);
});

test("failed saves, stale connections, and busy creation keep the committed bank", async ({
  page,
}, testInfo) => {
  const fixture = await createHindsightFixture({
    banks: [
      { bankId: "alpha", name: "Alpha" },
      { bankId: "beta", name: "Beta" },
    ],
    failures: [{ route: "profile", status: 503 }],
  });
  const chiefId = await signUpOwner(page, "stale");
  await connectHindsight(page, fixture.apiKey);
  const settings = page.getByTestId("bot-settings");
  const field = await openBotMemory(page, "Chief");

  let chooser = await openBankChooser(field);
  await chooser.getByRole("option", { name: /Alpha/ }).click();
  await expect(
    settings.getByText("Hindsight Cloud is temporarily unavailable.", { exact: true }),
  ).toBeVisible();
  await expectBoundBank(field, "Built-in");
  expect(await botMemoryBank(page, chiefId)).toBeNull();
  await captureScreenshot(page, testInfo, "hindsight-bank-save-failed");

  chooser = await openBankChooser(field);
  await chooser.getByRole("option", { name: /Alpha/ }).click();
  await expectBoundBank(field, "Alpha", "alpha");

  const stale = await memoryConfig(page);
  chooser = await openBankChooser(field);
  await expect(chooser.getByRole("option", { name: /Beta/ })).toBeVisible();
  await rpc(page, "memory/disconnectProvider", { configId: stale!.id });
  const replacement = await rpc<{ id: string }>(page, "memory/connectProvider", {
    provider: "hindsight",
    settings: { baseUrl: HINDSIGHT_ORIGIN },
    credentials: { apiKey: fixture.apiKey },
    defaultMemoryScope: "isolated",
    expectedConfigId: null,
  });
  expect(replacement.id).not.toBe(stale!.id);
  await chooser.getByRole("option", { name: /Beta/ }).click();
  await confirmBankChange(page);
  await expect(
    settings.getByText("Memory settings changed. Review and try again.", { exact: true }),
  ).toBeVisible();
  await expectBoundBank(field, "Built-in");
  expect(await botMemoryBank(page, chiefId)).toBeNull();
  await captureScreenshot(page, testInfo, "hindsight-stale-connection");

  chooser = await openBankChooser(field);
  await chooser.getByRole("option", { name: /Beta/ }).click();
  await expectBoundBank(field, "Beta", "beta");
  expect(await botMemoryBank(page, chiefId)).toMatchObject({
    bankId: "beta",
    configId: replacement.id,
  });

  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  await page.route(
    "**/rpc/memory/createBank",
    async (route) => {
      await createGate;
      await route.continue();
    },
    { times: 1 },
  );
  chooser = await openBankChooser(field);
  await chooser.getByRole("button", { name: "Create bank", exact: true }).click();
  await chooser.getByLabel("Bank name").fill("Pending bank");
  await chooser.getByRole("button", { name: "Create", exact: true }).click();
  try {
    await expect(chooser.getByRole("button", { name: "Creating…", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(chooser).toBeVisible();
    await expect(chooser.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    await expect(chooser.getByRole("button", { name: "Back", exact: true })).toBeDisabled();
    await expect(chooser.getByLabel("Bank name")).toBeDisabled();
    await captureScreenshot(page, testInfo, "hindsight-create-bank-busy");
  } finally {
    releaseCreate();
  }
  await confirmBankChange(page);
  await expectBoundBank(field, "Pending bank");
  expect((await botMemoryBank(page, chiefId))?.name).toBe("Pending bank");
});

test("shared banks and bound-bot deletion keep Cloud memories", async ({ page }, testInfo) => {
  const fixture = await createHindsightFixture({
    banks: [{ bankId: "shared-notes", name: "Shared notes" }],
  });
  const chiefId = await signUpOwner(page, "sharing");
  await connectHindsight(page, fixture.apiKey);

  let field = await openBotMemory(page, "Chief");
  let chooser = await openBankChooser(field);
  await expect(
    chooser.getByText("Bots using the same bank share memory.", { exact: true }),
  ).toBeVisible();
  await chooser.getByRole("option", { name: /Shared notes/ }).click();
  await expectBoundBank(field, "Shared notes", "shared-notes");

  const scoutId = await createNamedBot(page, "Scout");
  field = await openBotMemory(page, "Scout");
  chooser = await openBankChooser(field);
  await chooser.getByRole("option", { name: /Shared notes/ }).click();
  await expectBoundBank(field, "Shared notes", "shared-notes");
  const [chiefBank, scoutBank] = await Promise.all([
    botMemoryBank(page, chiefId),
    botMemoryBank(page, scoutId),
  ]);
  expect(chiefBank?.bankId).toBe("shared-notes");
  expect(scoutBank?.bankId).toBe("shared-notes");
  expect(scoutBank?.id).not.toBe(chiefBank?.id);

  const sidebar = page.locator("aside").first();
  await sidebar.getByRole("button", { name: /^Chief/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Clear conversation", exact: true }).click();
  const clearDialog = page.getByRole("alertdialog", { name: /Clear Chief/ });
  await expect(
    clearDialog.getByText("Cloud memories stay in Hindsight Cloud.", { exact: false }),
  ).toBeVisible();
  await clearDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(clearDialog).toHaveCount(0);

  await sidebar.getByRole("button", { name: /^Scout/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  const deleteDialog = page.getByRole("alertdialog", { name: "Delete Scout?" });
  await expect(
    deleteDialog.getByText("Cloud memories stay in Hindsight Cloud.", { exact: false }),
  ).toBeVisible();
  await expect(deleteDialog.getByText("Keep local notes", { exact: true })).toBeVisible();
  await expect(deleteDialog.getByText("Delete local notes", { exact: true })).toBeVisible();
  await expect(deleteDialog.getByText("Keep memories", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "hindsight-delete-bound-bot");
  await deleteDialog.getByText("Delete local notes", { exact: true }).click();
  await deleteDialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(deleteDialog).toHaveCount(0);
  await expect(sidebar.getByRole("button", { name: /^Scout/ })).toHaveCount(0);
  await expect
    .poll(async () => (await rpc<Bot[]>(page, "bots/list", {})).some((bot) => bot.id === scoutId))
    .toBe(false);
  expect(await botMemoryBank(page, chiefId)).toMatchObject({ bankId: "shared-notes" });

  const memory = await openMemorySettings(page);
  await memory.getByRole("button", { name: "Disconnect", exact: true }).click();
  const disconnectDialog = page.getByRole("alertdialog", { name: "Disconnect Hindsight Cloud?" });
  await expect(
    disconnectDialog.getByText(
      "Banks stay in Hindsight Cloud. Pending memory work stops; processing already started may finish.",
      { exact: true },
    ),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "hindsight-disconnect-confirm");
  await disconnectDialog.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(disconnectDialog).toHaveCount(0);
  await expect(memory.getByLabel("Provider")).toBeVisible();
  expect(await memoryConfig(page)).toBeNull();
  expect(await botMemoryBank(page, chiefId)).toBeNull();

  const snapshot = await fixture.snapshot();
  expect(snapshot.banks.map((bank) => bank.bankId)).toContain("shared-notes");
  expect(snapshot.requests.some((request) => request.method === "DELETE")).toBe(false);
});
