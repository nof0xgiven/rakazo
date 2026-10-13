import { expect, type Locator, type Page } from "@playwright/test";
import type { Bot, SpaceMemoryConfig } from "@rakazo/contracts";
import { openUserSettings, rpc } from "./helpers";

const FIXTURES_PATH = "/__e2e/hindsight/fixtures";
const TOKEN_HEADER = "x-rakazo-fixture-token";
export const HINDSIGHT_ORIGIN = "https://api.hindsight.vectorize.io";

export interface HindsightKeyOptions {
  label?: string;
  list?: boolean;
  create?: boolean;
  banks?: string[] | "*";
}

export interface HindsightFixtureOptions {
  keys?: HindsightKeyOptions[];
  banks?: Array<{ bankId: string; name?: string | null }>;
  seedBanks?: number;
  failures?: Array<{ route: string; status: number }>;
}

export interface HindsightFixtureSnapshot {
  id: string;
  banks: Array<{
    bankId: string;
    name: string | null;
    documents: Array<{ documentId: string; content: string }>;
  }>;
  operations: Array<{ operationId: string; bankId: string; status: string }>;
  requests: Array<{
    method: string;
    path: string;
    query: Record<string, string>;
    keyLabel: string;
    route: string | null;
    bankId: string | null;
    status: number;
  }>;
}

export interface HindsightFixture {
  id: string;
  apiKey: string;
  keys: Array<{ label: string; apiKey: string }>;
  snapshot(): Promise<HindsightFixtureSnapshot>;
}

const created = new Set<string>();

function control() {
  const origin = process.env.E2E_HINDSIGHT_FIXTURE_ORIGIN;
  const token = process.env.E2E_HINDSIGHT_FIXTURE_TOKEN;
  if (!origin || !token) {
    throw new Error("Run Hindsight specs through pnpm test:e2e so the fixture server is available");
  }
  return { url: `${origin}${FIXTURES_PATH}`, headers: { [TOKEN_HEADER]: token } };
}

export async function createHindsightFixture(
  options: HindsightFixtureOptions = {},
): Promise<HindsightFixture> {
  const { url, headers } = control();
  const response = await fetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(options),
  });
  if (response.status !== 201) {
    throw new Error(`Hindsight fixture creation failed: ${response.status}`);
  }
  const body = (await response.json()) as {
    id: string;
    apiKey: string;
    keys: Array<{ label: string; apiKey: string }>;
  };
  created.add(body.id);
  return {
    ...body,
    async snapshot() {
      const read = await fetch(`${url}/${encodeURIComponent(body.id)}`, { headers });
      if (!read.ok) throw new Error(`Hindsight fixture read failed: ${read.status}`);
      return (await read.json()) as HindsightFixtureSnapshot;
    },
  };
}

export async function disposeHindsightFixtures() {
  const { url, headers } = control();
  const ids = [...created];
  created.clear();
  await Promise.all(
    ids.map((id) =>
      fetch(`${url}/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { ...headers, "content-type": "application/json" },
      }),
    ),
  );
}

export async function openMemorySettings(page: Page) {
  await openUserSettings(page, "memory");
  const memory = page.getByTestId("memory-settings");
  await expect(memory).toBeVisible();
  return memory;
}

export async function closeMemorySettings(page: Page) {
  await page.getByLabel("Close memory settings").click();
  await expect(page.getByTestId("memory-settings")).toHaveCount(0);
}

export async function fillHindsightConnection(memory: Locator, apiKey: string) {
  await memory.getByLabel("Provider").selectOption("hindsight");
  await memory.getByLabel("API key").fill(apiKey);
  await expect(
    memory.getByText("Bots in this Space can use banks this key can access.", { exact: true }),
  ).toBeVisible();
}

export async function connectHindsight(page: Page, apiKey: string) {
  const memory = await openMemorySettings(page);
  await fillHindsightConnection(memory, apiKey);
  await memory.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(memory.getByText("Connected", { exact: true })).toBeVisible();
  await closeMemorySettings(page);
}

export async function openBotMemory(page: Page, botName: string) {
  await page
    .locator("main")
    .getByRole("button", { name: new RegExp(`^${botName}`) })
    .click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  const field = settings.getByTestId("bot-memory-bank");
  if (!(await field.isVisible())) await settings.getByText("Advanced", { exact: true }).click();
  await expect(field).toBeVisible();
  return field;
}

export function bankChooser(page: Page) {
  return page.getByRole("dialog", { name: "Memory bank" });
}

export async function openBankChooser(field: Locator) {
  await expect(field.getByRole("button", { name: "Change", exact: true })).toBeEnabled();
  await field.getByRole("button", { name: "Change", exact: true }).click();
  const chooser = bankChooser(field.page());
  await expect(chooser).toBeVisible();
  await expect(chooser.getByText("Loading…", { exact: true })).toHaveCount(0);
  return chooser;
}

export async function confirmBankChange(page: Page) {
  const confirm = page.getByRole("alertdialog", { name: "Change memory bank?" });
  await expect(
    confirm.getByText(
      "Existing memories stay in their current bank; processing already started may finish.",
      { exact: true },
    ),
  ).toBeVisible();
  await confirm.getByRole("button", { name: "Change", exact: true }).click();
  await expect(confirm).toHaveCount(0);
}

export async function expectBoundBank(field: Locator, name: string, bankId?: string) {
  await expect(field.getByRole("button", { name: "Change", exact: true })).toBeEnabled();
  await expect(field.getByText(name, { exact: true })).toBeVisible();
  if (bankId && bankId !== name)
    await expect(field.getByText(bankId, { exact: true })).toBeVisible();
}

export async function botMemoryBank(page: Page, botId: string) {
  return (await rpc<Bot>(page, "bots/get", { botId })).memoryBank;
}

export async function memoryConfig(page: Page) {
  return rpc<SpaceMemoryConfig | null>(page, "memory/providerConfig", {});
}
