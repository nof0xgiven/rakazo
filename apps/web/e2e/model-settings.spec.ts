import { createServer, type IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { expect, type Locator, type Page, type TestInfo, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  openUserSettings,
  rpc,
  rpcResult,
  signup,
} from "./helpers";

type PgClient = {
  connect: () => Promise<void>;
  query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  end: () => Promise<void>;
};

async function queryDatabase(sql: string, params: unknown[]) {
  const connectionString = process.env.DATABASE_URL;
  expect(connectionString, "the E2E harness supplies its disposable DATABASE_URL").toBeTruthy();
  const requireFromDb = createRequire(
    path.resolve(process.cwd(), "../../packages/db/package.json"),
  );
  const pg: { Client: new (options: { connectionString: string }) => PgClient } =
    requireFromDb("pg");
  const client = new pg.Client({ connectionString: connectionString! });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows;
  } finally {
    await client.end();
  }
}

const COMPATIBLE = "openai-compatible";
const MODEL_A = "rakazo-e2e-alpha";
const MODEL_B = "rakazo-e2e-bravo";
const MODEL_C = "rakazo-e2e-charlie";
const DECOY_MODELS = Array.from(
  { length: 60 },
  (_, index) => `decoy-${String(index).padStart(2, "0")}-embedding`,
);
const PI_CONTEXT_WINDOW = 160_000;
const NARROW_VIEWPORT = { width: 390, height: 844 };

type CompatibleModel = {
  modelId: string;
  thinkingLevels: string[];
  defaultThinkingLevel: string | null;
  contextWindow: number;
  maxTokens: number;
  supportsImages: boolean;
  maxImagesPerPrompt?: number;
};

type CompatibleCredential = {
  id: string;
  provider: string;
  hasKey: boolean;
  isDefault: boolean;
  modelId?: string | null;
  enabledModelIds?: string[];
  models?: CompatibleModel[];
  configurationVersion?: number;
};

type CatalogEntry = { provider: string; id: string; placeholder?: boolean };

type Wire = { model: string; reasoning_effort?: unknown };

type CapturedCompletion = {
  wire: Wire;
  marker: string | null;
  hasTools: boolean;
  toolResults: string[];
  status: number;
};

type CompatibleFixture = {
  baseUrl: string;
  completions: CapturedCompletion[];
  listRequests: Array<{ authorization: string | undefined }>;
  setListed: (listed: readonly string[] | "fail") => void;
  failFor: (model: string, marker: string) => void;
  replyWithToolCall: (marker: string, name: string, args: Record<string, unknown>) => void;
  agentCalls: (marker: string) => Wire[];
  toolResults: (marker: string) => string[];
  assertComplete: () => void;
  close: () => Promise<void>;
};

function readBody(request: IncomingMessage): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  request.on("error", reject);
  return promise;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .join("\n");
}

function latestUserTurn(messages: unknown): { text: string; toolResults: string[] } {
  if (!Array.isArray(messages)) return { text: "", toolResults: [] };
  const records = messages.filter(isRecord);
  const index = records.findLastIndex((message) => message.role === "user");
  if (index < 0) return { text: "", toolResults: [] };
  return {
    text: messageText(records[index]!.content),
    toolResults: records
      .slice(index + 1)
      .filter((message) => message.role === "tool")
      .map((message) => messageText(message.content)),
  };
}

function sseChunk(model: string, delta: Record<string, unknown>, finish: string | null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-rakazo-e2e",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1_000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(finish ? { usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 } } : {}),
  })}\n\n`;
}

function fixtureReply(model: string, marker: string | null) {
  return marker ? `Fixture reply from ${model} for ${marker}.` : `Fixture reply from ${model}.`;
}

async function startCompatibleFixture(options: {
  apiKey: string;
  listed: readonly string[] | "fail";
  served: readonly string[];
}): Promise<CompatibleFixture> {
  let listed = options.listed;
  const failures: Array<{ model: string; marker: string }> = [];
  const completions: CapturedCompletion[] = [];
  const listRequests: Array<{ authorization: string | undefined }> = [];
  const problems: string[] = [];
  const toolCalls = new Map<string, { name: string; args: Record<string, unknown> }>();
  const server = createServer(async (request, response) => {
    const authorization = request.headers.authorization;
    const authorized = authorization === `Bearer ${options.apiKey}`;
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && request.url === "/v1/models") {
      listRequests.push({ authorization });
      if (!authorized) {
        json(401, { error: { message: "Incorrect API key", type: "invalid_request_error" } });
        return;
      }
      if (listed === "fail") {
        json(500, { error: { message: "Model listing is down", type: "server_error" } });
        return;
      }
      json(200, {
        object: "list",
        data: listed.map((id) => ({ id, object: "model", owned_by: "rakazo-e2e" })),
      });
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      const model = String(body.model);
      const turn = latestUserTurn(body.messages);
      const markers = turn.text.match(/MARK-[A-Za-z0-9]+/g);
      const marker = markers?.at(-1) ?? null;
      const wire: Wire = {
        model,
        ...("reasoning_effort" in body ? { reasoning_effort: body.reasoning_effort } : {}),
      };
      const capture: CapturedCompletion = {
        wire,
        marker,
        hasTools: Array.isArray(body.tools) && body.tools.length > 0,
        toolResults: turn.toolResults,
        status: 200,
      };
      completions.push(capture);
      if (!authorized) {
        problems.push(`completion for ${model} arrived without the fixture key`);
        capture.status = 401;
        json(401, { error: { message: "Incorrect API key", type: "invalid_request_error" } });
        return;
      }
      if (!options.served.includes(model)) {
        problems.push(`completion requested a model the fixture does not serve: ${model}`);
        capture.status = 404;
        json(404, {
          error: { message: "The model does not exist", type: "invalid_request_error" },
        });
        return;
      }
      if (failures.some((failure) => failure.model === model && failure.marker === marker)) {
        capture.status = 503;
        json(503, { error: { message: "The server is overloaded", type: "server_error" } });
        return;
      }
      const scripted = marker ? toolCalls.get(marker) : undefined;
      if (scripted && capture.toolResults.length === 0) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          sseChunk(
            model,
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  index: 0,
                  id: `call-${marker}`,
                  type: "function",
                  function: { name: scripted.name, arguments: JSON.stringify(scripted.args) },
                },
              ],
            },
            null,
          ),
        );
        response.write(sseChunk(model, {}, "tool_calls"));
        response.end("data: [DONE]\n\n");
        return;
      }
      response.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      });
      response.write(
        sseChunk(model, { role: "assistant", content: fixtureReply(model, marker) }, null),
      );
      response.write(sseChunk(model, {}, "stop"));
      response.end("data: [DONE]\n\n");
      return;
    }
    problems.push(`unexpected ${request.method} ${request.url}`);
    response.writeHead(404);
    response.end();
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    completions,
    listRequests,
    setListed(next) {
      listed = next;
    },
    failFor(model, marker) {
      failures.push({ model, marker });
    },
    replyWithToolCall(marker, name, args) {
      toolCalls.set(marker, { name, args });
    },
    agentCalls(marker) {
      return completions
        .filter((completion) => completion.marker === marker && completion.hasTools)
        .map((completion) => completion.wire);
    },
    toolResults(marker) {
      return completions
        .filter((completion) => completion.marker === marker)
        .flatMap((completion) => completion.toolResults);
    },
    assertComplete() {
      if (problems.length) throw new Error(`Compatible fixture problems:\n${problems.join("\n")}`);
    },
    close() {
      const closed = Promise.withResolvers<void>();
      server.closeAllConnections();
      server.close(() => closed.resolve());
      return closed.promise;
    },
  };
}

function compatibleConfig(
  modelId: string,
  thinkingLevels: string[],
  extra: Partial<CompatibleModel> = {},
): CompatibleModel {
  return {
    modelId,
    thinkingLevels,
    defaultThinkingLevel: null,
    contextWindow: PI_CONTEXT_WINDOW,
    maxTokens: 4096,
    supportsImages: false,
    ...extra,
  };
}

function optionKey(modelId: string) {
  return `${COMPATIBLE}::${modelId}`;
}

function modelCheckbox(page: Page, modelId: string) {
  return page.getByRole("checkbox", { name: modelId, exact: true });
}

async function compatibleConnection(page: Page) {
  const credentials = await rpc<CompatibleCredential[]>(page, "models/credentials", {});
  const connection = credentials.find((entry) => entry.provider === COMPATIBLE);
  expect(connection, "expected an OpenAI-compatible connection").toBeDefined();
  return connection!;
}

async function compatibleCatalogIds(page: Page, spaceId?: string) {
  const result = await rpcResult<CatalogEntry[]>(page, "models/list", {}, { spaceId });
  expect(result.ok).toBe(true);
  return result
    .json!.filter((entry) => entry.provider === COMPATIBLE && !entry.placeholder)
    .map((entry) => entry.id)
    .sort();
}

async function keyedTestProvider(page: Page) {
  const catalog = await rpc<Array<CatalogEntry & { providerName?: string }>>(
    page,
    "models/list",
    {},
  );
  const entry =
    catalog.find((candidate) => candidate.provider === "scripted") ??
    catalog.find((candidate) => candidate.provider === "openrouter" && !candidate.placeholder);
  expect(entry, "expected a key-only catalog provider").toBeDefined();
  const name = entry!.providerName ?? entry!.provider;
  return { provider: entry!.provider, name, search: entry!.provider, row: new RegExp(name) };
}

async function openCompatibleSettings(page: Page) {
  const settings = await openUserSettings(page, "models");
  await page.getByPlaceholder("Search providers").fill("openai-compatible");
  await page.getByRole("button", { name: /^OpenAI-compatible/ }).click();
  await expect(page.getByLabel("OpenAI-compatible server URL")).toBeVisible();
  return settings;
}

async function expectNoSecretRendered(page: Page, secrets: readonly string[]) {
  const rendered = await page.evaluate(() =>
    [
      document.body.innerText,
      ...Array.from(
        document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
          "input:not([type=password]), textarea",
        ),
        (element) => element.value,
      ),
    ].join("\n"),
  );
  for (const secret of secrets) expect(rendered).not.toContain(secret);
}

async function captureDesktopAndNarrow(
  page: Page,
  testInfo: TestInfo,
  name: string,
  target: Locator,
  secrets: readonly string[],
) {
  const desktop = page.viewportSize();
  await target.scrollIntoViewIfNeeded();
  await expectNoSecretRendered(page, secrets);
  await captureScreenshot(page, testInfo, `${name}-desktop`);
  await page.setViewportSize(NARROW_VIEWPORT);
  await expect(target).toBeVisible();
  await target.scrollIntoViewIfNeeded();
  await expectNoSecretRendered(page, secrets);
  await captureScreenshot(page, testInfo, `${name}-narrow`);
  if (desktop) await page.setViewportSize(desktop);
}

async function configureThinking(setup: Locator, levels: readonly string[]) {
  await setup.getByRole("checkbox", { name: "Supports thinking" }).check();
  for (const level of levels) {
    await setup.getByRole("checkbox", { name: level, exact: true }).check();
  }
}

async function expectThinkingLevels(setup: Locator, checked: readonly string[]) {
  await expect(setup.getByRole("checkbox", { name: "Supports thinking" })).toBeChecked();
  for (const level of ["Off", "Minimal", "Low", "Medium", "High", "Extra high", "Max"]) {
    const box = setup.getByRole("checkbox", { name: level, exact: true });
    if (checked.includes(level)) await expect(box).toBeChecked();
    else await expect(box).not.toBeChecked();
  }
}

async function openBotSettings(page: Page, botName: string) {
  const trigger = page.locator("main").getByRole("button", { name: botName, exact: true });
  const settings = page.getByTestId("bot-settings");
  await expect(trigger).toBeAttached();
  if (!(await settings.isVisible())) await trigger.click();
  await expect(settings).toBeVisible();
  await settings.getByTestId("bot-settings-advanced").evaluate((element: HTMLDetailsElement) => {
    element.open = true;
  });
  const model = settings.getByRole("combobox", { name: "Model", exact: true });
  await expect(model).toBeEnabled();
  return {
    settings,
    model,
    effort: settings.getByRole("combobox", { name: "Reasoning effort", exact: true }),
  };
}

async function expectRpcOk(page: Page, procedure: string, action: () => Promise<void>) {
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url().includes(`/rpc/${procedure}`) && candidate.request().method() === "POST",
  );
  await action();
  const settled = await response;
  expect(settled.ok(), `${procedure}: ${await settled.text()}`).toBe(true);
}

async function optionValues(select: Locator) {
  return select
    .locator("option")
    .evaluateAll((options: HTMLOptionElement[]) => options.map((option) => option.value));
}

async function sendAndAwaitReply(
  page: Page,
  bot: { id: string; name: string },
  marker: string,
  replyModel: string,
) {
  await page.goto(`/app/${bot.id}`);
  const composer = page.getByPlaceholder(`Message ${bot.name}`);
  await composer.fill(`${marker} reply with the fixture verification message.`);
  await page.keyboard.press("Enter");
  await expect(
    page.getByTestId("transcript").getByText(fixtureReply(replyModel, marker)),
  ).toBeVisible({ timeout: 90_000 });
}

async function expectRunCompleted(page: Page, botId: string, marker: string) {
  let runId = "";
  await expect
    .poll(
      async () => {
        const { runs } = await rpc<{
          runs: Array<{ runId: string; botId: string; status: string; promptSnippet: string }>;
        }>(page, "runs/list", { filter: "recent" });
        const run = runs.find(
          (candidate) => candidate.botId === botId && candidate.promptSnippet.includes(marker),
        );
        runId = run?.runId ?? "";
        return run?.status;
      },
      { timeout: 60_000 },
    )
    .toBe("completed");
  return runId;
}

function marker(label: string) {
  return `MARK-${label}${Date.now().toString(36)}`;
}

async function addDailyTrigger(page: Page) {
  await page.getByRole("button", { name: "Add trigger" }).click();
  await page.getByRole("menuitem", { name: "On a schedule" }).hover();
  await page.getByRole("menuitem", { name: "Every day", exact: true }).click();
}

test("enabled endpoint models keep their own reasoning per bot, routine and backup", async ({
  page,
}, testInfo) => {
  test.skip(process.env.AGENT_RUNTIME !== "pi", "Runs real Pi turns against the fixture endpoint.");
  test.setTimeout(900_000);
  const stamp = Date.now();
  const apiKey = `fake-e2e-compatible-key-${stamp}`;
  const secrets = [apiKey];
  const fixture = await startCompatibleFixture({
    apiKey,
    listed: [MODEL_A, MODEL_B, MODEL_C, MODEL_A, MODEL_B, ...DECOY_MODELS],
    served: [MODEL_A, MODEL_B],
  });
  const otherServer = await startCompatibleFixture({
    apiKey: `fake-e2e-other-server-key-${stamp}`,
    listed: [MODEL_A],
    served: [],
  });
  const discovered = 3 + DECOY_MODELS.length;
  try {
    await signup(page, `compatible-enable-${stamp}@rakazo.test`, "password12", `Enable ${stamp}`);
    await completeOnboarding(page);
    const userSettings = page.getByTestId("user-settings");

    await openCompatibleSettings(page);
    const save = page.getByRole("button", { name: "Save", exact: true });
    await page.getByLabel("OpenAI-compatible server URL").fill(fixture.baseUrl);
    await page
      .locator("summary")
      .filter({ hasText: /^API key$/ })
      .click();
    await page.getByLabel("API key", { exact: true }).fill(apiKey);
    await page.getByRole("button", { name: "Find models" }).click();
    await expect(page.getByText(`Found ${discovered} models.`)).toBeVisible();
    expect(fixture.listRequests.at(-1)?.authorization).toBe(`Bearer ${apiKey}`);
    for (const id of [MODEL_A, MODEL_B, MODEL_C, DECOY_MODELS[0]!, DECOY_MODELS.at(-1)!]) {
      await expect(modelCheckbox(page, id)).toHaveCount(1);
      await expect(modelCheckbox(page, id)).not.toBeChecked();
    }
    await expect(save).toBeDisabled();

    await modelCheckbox(page, MODEL_A).check();
    const setupA = page.getByRole("group", { name: `Advanced: ${MODEL_A}` });
    await expect(setupA).toBeVisible();
    await expect(page.getByText("Needs setup", { exact: true })).toBeVisible();
    await expect(save).toBeDisabled();
    await configureThinking(setupA, ["Off", "Low", "High", "Extra high"]);
    await setupA.getByLabel("Context limit").fill(String(PI_CONTEXT_WINDOW));
    await captureDesktopAndNarrow(
      page,
      testInfo,
      "openai-compatible-unknown-model-advanced",
      setupA,
      secrets,
    );
    await expect(setupA.getByRole("checkbox", { name: "Extra high", exact: true })).toBeChecked();
    await setupA.getByRole("button", { name: "Apply" }).click();
    await expect(setupA).toBeHidden();

    await modelCheckbox(page, MODEL_B).check();
    const setupB = page.getByRole("group", { name: `Advanced: ${MODEL_B}` });
    await configureThinking(setupB, ["Low", "Medium"]);
    await setupB.getByLabel("Context limit").fill(String(PI_CONTEXT_WINDOW));
    await setupB.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByLabel("Default model")).toHaveValue(MODEL_A);
    await expect(page.getByLabel("Default model").locator("option")).toHaveText([
      "Choose a checked model",
      MODEL_A,
      MODEL_B,
    ]);
    await expect(modelCheckbox(page, MODEL_C)).not.toBeChecked();
    await expect(save).toBeEnabled();
    await captureDesktopAndNarrow(
      page,
      testInfo,
      "openai-compatible-checkbox-list",
      modelCheckbox(page, MODEL_A),
      secrets,
    );
    await save.click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
    await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");

    const credentialsResult = await rpcResult<CompatibleCredential[]>(
      page,
      "models/credentials",
      {},
    );
    expect(credentialsResult.text).not.toContain(apiKey);
    const saved = await compatibleConnection(page);
    expect(saved.hasKey).toBe(true);
    expect(saved.enabledModelIds).toEqual([MODEL_A, MODEL_B]);
    expect(saved.models).toEqual([
      compatibleConfig(MODEL_A, ["off", "low", "high", "xhigh"]),
      compatibleConfig(MODEL_B, ["low", "medium"]),
    ]);
    expect(await rpc(page, "me", {})).toMatchObject({
      defaultProvider: COMPATIBLE,
      defaultModel: MODEL_A,
    });
    expect(await compatibleCatalogIds(page)).toEqual([MODEL_A, MODEL_B].sort());

    let probes = 0;
    page.on("request", (request) => {
      if (request.url().includes("/rpc/models/probeOpenAiCompatible")) probes += 1;
    });
    const listsBeforeReload = fixture.listRequests.length;
    await page.reload();
    await openCompatibleSettings(page);
    await expect(modelCheckbox(page, MODEL_A)).toBeChecked();
    await expect(modelCheckbox(page, MODEL_B)).toBeChecked();
    await expect(modelCheckbox(page, MODEL_C)).toHaveCount(0);
    expect(probes).toBe(0);
    expect(fixture.listRequests.length).toBe(listsBeforeReload);
    await page.getByRole("button", { name: `Advanced: ${MODEL_A}` }).click();
    await expectThinkingLevels(setupA, ["Off", "Low", "High", "Extra high"]);
    await expect(setupA.getByLabel("Context limit")).toHaveValue(String(PI_CONTEXT_WINDOW));
    await page.getByRole("button", { name: `Advanced: ${MODEL_A}` }).click();
    await page.getByRole("button", { name: `Advanced: ${MODEL_B}` }).click();
    await expectThinkingLevels(setupB, ["Low", "Medium"]);
    await page.getByRole("button", { name: `Advanced: ${MODEL_B}` }).click();
    await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");

    await page.getByRole("button", { name: "Find models" }).click();
    await expect(page.getByText(`Found ${discovered} models.`)).toBeVisible();
    expect(probes).toBe(1);
    expect(fixture.listRequests.at(-1)?.authorization).toBe(`Bearer ${apiKey}`);
    await expect(modelCheckbox(page, MODEL_A)).toBeChecked();
    await expect(modelCheckbox(page, MODEL_C)).not.toBeChecked();

    await page.getByLabel("OpenAI-compatible server URL").fill(otherServer.baseUrl);
    await expect(modelCheckbox(page, MODEL_A)).toHaveCount(0);
    await page.getByRole("button", { name: "Find models" }).click();
    const probeFailure = userSettings.getByRole("alert");
    await expect(probeFailure).toBeVisible();
    await expect(probeFailure).not.toContainText(apiKey);
    expect(otherServer.listRequests).toEqual([{ authorization: undefined }]);
    await page.getByLabel("OpenAI-compatible server URL").fill(fixture.baseUrl);
    await expect(modelCheckbox(page, MODEL_A)).toBeChecked();
    await expect(modelCheckbox(page, MODEL_B)).toBeChecked();
    await page.getByRole("button", { name: "Close model settings" }).click();

    const alpha = { name: "Alpha bot", id: await createNamedBot(page, "Alpha bot") };
    let panel = await openBotSettings(page, alpha.name);
    const alphaChoices = await optionValues(panel.model);
    expect(alphaChoices).toEqual(expect.arrayContaining([optionKey(MODEL_A), optionKey(MODEL_B)]));
    expect(alphaChoices).not.toContain(optionKey(MODEL_C));
    await panel.model.selectOption(optionKey(MODEL_A));
    await expect(panel.effort.locator("option")).toHaveText([
      "Default (High)",
      "Off",
      "Low",
      "High",
      "Extra high",
    ]);
    await panel.effort.selectOption("xhigh");
    await panel.effort.scrollIntoViewIfNeeded();
    await expectNoSecretRendered(page, secrets);
    await captureScreenshot(page, testInfo, "openai-compatible-per-bot-effort-desktop");
    await expectRpcOk(page, "bots/update", () =>
      panel.settings.getByRole("button", { name: "Save", exact: true }).click(),
    );
    expect(await rpc(page, "bots/get", { botId: alpha.id })).toMatchObject({
      modelProvider: COMPATIBLE,
      modelId: MODEL_A,
      thinkingLevel: "xhigh",
    });

    const bravo = { name: "Bravo bot", id: await createNamedBot(page, "Bravo bot") };
    panel = await openBotSettings(page, bravo.name);
    await panel.model.selectOption(optionKey(MODEL_B));
    await expect(panel.effort.locator("option")).toHaveText(["Default (Medium)", "Low", "Medium"]);
    await panel.effort.selectOption("low");
    await expectRpcOk(page, "bots/update", () =>
      panel.settings.getByRole("button", { name: "Save", exact: true }).click(),
    );
    expect(await rpc(page, "bots/get", { botId: bravo.id })).toMatchObject({
      modelProvider: COMPATIBLE,
      modelId: MODEL_B,
      thinkingLevel: "low",
    });

    const desktop = page.viewportSize()!;
    await page.setViewportSize(NARROW_VIEWPORT);
    await page.goto(`/app/${alpha.id}`);
    panel = await openBotSettings(page, alpha.name);
    await expect(panel.model).toHaveValue(optionKey(MODEL_A));
    await expect(panel.effort).toHaveValue("xhigh");
    await panel.effort.scrollIntoViewIfNeeded();
    await expectNoSecretRendered(page, secrets);
    await captureScreenshot(page, testInfo, "openai-compatible-per-bot-effort-narrow");
    await page.setViewportSize(desktop);

    const alphaMarker = marker("alpha");
    const bravoMarker = marker("bravo");
    await sendAndAwaitReply(page, alpha, alphaMarker, MODEL_A);
    await sendAndAwaitReply(page, bravo, bravoMarker, MODEL_B);
    expect(fixture.agentCalls(alphaMarker)).toEqual([
      { model: MODEL_A, reasoning_effort: "xhigh" },
    ]);
    expect(fixture.agentCalls(bravoMarker)).toEqual([{ model: MODEL_B, reasoning_effort: "low" }]);
    await expectRunCompleted(page, alpha.id, alphaMarker);
    await expectRunCompleted(page, bravo.id, bravoMarker);
    await page.goto(`/app/${alpha.id}`);
    await expect(
      page.getByTestId("transcript").getByText(fixtureReply(MODEL_A, alphaMarker)),
    ).toBeVisible();
    await expect(page.getByTestId("transcript")).not.toContainText(apiKey);
    expect(await rpc(page, "me", {})).toMatchObject({ defaultModel: MODEL_A });

    const routineBot = { name: "Routine bot", id: await createNamedBot(page, "Routine bot") };
    await rpc(page, "bots/update", {
      botId: routineBot.id,
      modelProvider: COMPATIBLE,
      modelId: MODEL_B,
      thinkingLevel: null,
    });
    const routineMarker = marker("routine");
    await page.getByTitle("Agent computer").click();
    await page.getByRole("button", { name: "Create Routine" }).click();
    await page.locator("label:has-text('Name') input").fill("Pinned bravo");
    await page
      .locator("label:has-text('Instruction') textarea")
      .fill(`${routineMarker} report on the pinned model.`);
    await addDailyTrigger(page);
    await page.getByRole("button", { name: "Advanced", exact: true }).click();
    const routineModel = page.getByRole("combobox", { name: "Model", exact: true });
    await expect(routineModel).toBeEnabled();
    const routineChoices = await optionValues(routineModel);
    expect(routineChoices).toEqual(
      expect.arrayContaining([optionKey(MODEL_A), optionKey(MODEL_B)]),
    );
    expect(routineChoices).not.toContain(optionKey(MODEL_C));
    await routineModel.selectOption(optionKey(MODEL_B));
    const routineEffort = page.getByRole("combobox", { name: "Reasoning effort", exact: true });
    await expect(routineEffort.locator("option")).toHaveText(["Default (Medium)", "Low", "Medium"]);
    await routineEffort.selectOption("medium");
    await page.keyboard.press("Escape");
    await expectRpcOk(page, "routines/create", () =>
      page.getByRole("button", { name: "Save", exact: true }).click(),
    );
    const [routine] = await rpc<Array<{ id: string; modelId: string; thinkingLevel: string }>>(
      page,
      "routines/list",
      { botId: routineBot.id },
    );
    expect(routine).toMatchObject({ modelId: MODEL_B, thinkingLevel: "medium" });
    await rpc(page, "bots/update", {
      botId: routineBot.id,
      modelProvider: COMPATIBLE,
      modelId: MODEL_A,
      thinkingLevel: null,
    });
    await rpc(page, "routines/testRun", { routineId: routine!.id });
    await expect
      .poll(() => fixture.agentCalls(routineMarker), { timeout: 90_000 })
      .toEqual([{ model: MODEL_B, reasoning_effort: "medium" }]);

    await openUserSettings(page, "models");
    const backups = page.getByTestId("model-backups");
    await backups.scrollIntoViewIfNeeded();
    const backupPicker = backups.getByRole("combobox", { name: "Add connected model" });
    const backupChoices = await optionValues(backupPicker);
    expect(backupChoices).toContain(JSON.stringify([COMPATIBLE, MODEL_B]));
    expect(backupChoices).not.toContain(JSON.stringify([COMPATIBLE, MODEL_C]));
    await backupPicker.selectOption(JSON.stringify([COMPATIBLE, MODEL_B]));
    await backups.getByRole("button", { name: "Add", exact: true }).click();
    await expectRpcOk(page, "models/setBackups", () =>
      backups.getByRole("button", { name: "Save backups", exact: true }).click(),
    );
    expect(await rpc(page, "models/backups", {})).toEqual([
      { provider: COMPATIBLE, modelId: MODEL_B },
    ]);
    await page.getByRole("button", { name: "Close model settings" }).click();
    const failoverMarker = marker("failover");
    fixture.failFor(MODEL_A, failoverMarker);
    await sendAndAwaitReply(page, alpha, failoverMarker, MODEL_B);
    const failoverCalls = fixture.agentCalls(failoverMarker);
    expect(failoverCalls.at(-1)).toEqual({ model: MODEL_B, reasoning_effort: "medium" });
    expect(failoverCalls.length).toBeGreaterThan(1);
    for (const call of failoverCalls.slice(0, -1)) {
      expect(call).toEqual({ model: MODEL_A, reasoning_effort: "xhigh" });
    }
    const failoverRunId = await expectRunCompleted(page, alpha.id, failoverMarker);
    expect(
      await queryDatabase(
        `SELECT "status", "error", "modelProvider", "modelId" FROM "runs" WHERE "id" = $1`,
        [failoverRunId],
      ),
    ).toEqual([{ status: "completed", error: null, modelProvider: COMPATIBLE, modelId: MODEL_B }]);
    expect(
      await queryDatabase(
        `SELECT "status", "error" FROM "attempts" WHERE "runId" = $1 ORDER BY "startedAt"`,
        [failoverRunId],
      ),
    ).toEqual([{ status: "completed", error: null }]);
    const failoverUsage = await queryDatabase(
      `SELECT "provider", "model" FROM "usage_records" WHERE "runId" = $1 AND "operationKind" = 'answer'`,
      [failoverRunId],
    );
    expect(failoverUsage).toContainEqual({ provider: COMPATIBLE, model: MODEL_B });

    const beforeBlocked = await compatibleConnection(page);
    await openCompatibleSettings(page);
    await modelCheckbox(page, MODEL_B).uncheck();
    await save.click();
    const blockers = userSettings.getByRole("alert").filter({
      hasText: "Reassign models before disabling them.",
    });
    await expect(blockers).toBeVisible();
    await expect(blockers).toContainText(`Bot · ${bravo.name} · ${MODEL_B} · Low`);
    await expect(blockers).toContainText(`Routine · Pinned bravo · ${MODEL_B} · Medium`);
    await expect(blockers).toContainText(`Backup model · ${MODEL_B}`);
    await expect(blockers).not.toContainText(`${MODEL_B} · ${MODEL_B}`);
    await expect(blockers).not.toContainText(apiKey);
    await expect(modelCheckbox(page, MODEL_B)).toBeChecked();
    await captureDesktopAndNarrow(page, testInfo, "openai-compatible-blockers", blockers, secrets);
    expect(await compatibleConnection(page)).toEqual(beforeBlocked);

    const removeDefault = await rpcResult(page, "models/connect", {
      provider: COMPATIBLE,
      baseUrl: fixture.baseUrl,
      credentialId: beforeBlocked.id,
      expectedConfigurationVersion: beforeBlocked.configurationVersion,
      models: [compatibleConfig(MODEL_B, ["low", "medium"])],
    });
    expect(removeDefault.status).toBe(409);
    expect(removeDefault.text).not.toContain(apiKey);
    expect(removeDefault.error).toMatchObject({
      code: "CONFLICT",
      data: { reason: "models_in_use" },
    });
    expect(removeDefault.error?.data).toHaveProperty(
      "usages",
      expect.arrayContaining([
        expect.objectContaining({ kind: "default", modelId: MODEL_A }),
        expect.objectContaining({ kind: "bot", name: alpha.name, modelId: MODEL_A }),
      ]),
    );
    expect(await compatibleConnection(page)).toEqual(beforeBlocked);

    await rpc(page, "bots/update", {
      botId: bravo.id,
      modelProvider: COMPATIBLE,
      modelId: MODEL_A,
      thinkingLevel: null,
    });
    await rpc(page, "routines/update", {
      routineId: routine!.id,
      modelProvider: null,
      modelId: null,
      thinkingLevel: null,
    });
    await rpc(page, "models/setBackups", []);
    await modelCheckbox(page, MODEL_B).uncheck();
    await save.click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
    const afterRemoval = await compatibleConnection(page);
    expect(afterRemoval.enabledModelIds).toEqual([MODEL_A]);
    expect(afterRemoval.configurationVersion).toBe((beforeBlocked.configurationVersion ?? 0) + 1);
    expect(await compatibleCatalogIds(page)).toEqual([MODEL_A]);
    await page.getByRole("button", { name: "Close model settings" }).click();
    await page.goto(`/app/${bravo.id}`);
    panel = await openBotSettings(page, bravo.name);
    await expect(panel.model).toHaveValue(optionKey(MODEL_A));
    expect(await optionValues(panel.model)).toEqual(["", optionKey(MODEL_A)]);

    const tampered = [
      await rpcResult(page, "bots/update", {
        botId: bravo.id,
        modelProvider: COMPATIBLE,
        modelId: MODEL_B,
        thinkingLevel: "low",
      }),
      await rpcResult(page, "routines/create", {
        botId: routineBot.id,
        name: "Tampered routine",
        prompt: "Should never save",
        crons: ["0 9 * * *"],
        modelProvider: COMPATIBLE,
        modelId: MODEL_B,
        thinkingLevel: null,
      }),
      await rpcResult(page, "models/setBackups", [{ provider: COMPATIBLE, modelId: MODEL_B }]),
      await rpcResult(page, "models/setDefault", { provider: COMPATIBLE, modelId: MODEL_B }),
    ];
    for (const result of tampered) {
      expect(result.ok, result.text).toBe(false);
      expect(result.text).not.toContain(apiKey);
    }
    expect(await rpc(page, "bots/get", { botId: bravo.id })).toMatchObject({ modelId: MODEL_A });
    expect(await rpc(page, "models/backups", {})).toEqual([]);
    expect(await rpc(page, "me", {})).toMatchObject({ defaultModel: MODEL_A });

    const completionsBeforeHelpers = fixture.completions.length;
    const deniedHelper = marker("helperdenied");
    const deniedTask = marker("helperdeniedtask");
    fixture.replyWithToolCall(deniedHelper, "run_subagent", {
      name: "helper",
      task: `${deniedTask} summarize the fixture.`,
      model_provider: COMPATIBLE,
      model_id: MODEL_B,
    });
    await sendAndAwaitReply(page, alpha, deniedHelper, MODEL_A);
    const deniedResults = fixture.toolResults(deniedHelper);
    expect(deniedResults).toHaveLength(1);
    expect(deniedResults[0]).toContain("Subagent failed");
    expect(deniedResults[0]).not.toContain(apiKey);
    expect(fixture.completions.filter((completion) => completion.marker === deniedTask)).toEqual(
      [],
    );

    const allowedHelper = marker("helperallowed");
    const allowedTask = marker("helperallowedtask");
    fixture.replyWithToolCall(allowedHelper, "run_subagent", {
      name: "helper",
      task: `${allowedTask} summarize the fixture.`,
      model_provider: COMPATIBLE,
      model_id: MODEL_A,
    });
    await sendAndAwaitReply(page, alpha, allowedHelper, MODEL_A);
    expect(fixture.agentCalls(allowedTask).map((call) => call.model)).toEqual([MODEL_A]);
    expect(fixture.toolResults(allowedHelper)).toEqual([
      expect.stringContaining(fixtureReply(MODEL_A, allowedTask)),
    ]);
    expect(
      fixture.completions
        .slice(completionsBeforeHelpers)
        .some((completion) => completion.wire.model === MODEL_B),
    ).toBe(false);
    await expect(page.getByTestId("transcript")).not.toContainText(apiKey);
    expect(fixture.completions.some((completion) => completion.wire.model === MODEL_C)).toBe(false);
    fixture.assertComplete();
    otherServer.assertComplete();
  } finally {
    await fixture.close();
    await otherServer.close();
  }
});

test("per-model reasoning reaches the wire exactly as each model supports it", async ({
  page,
}, testInfo) => {
  test.skip(process.env.AGENT_RUNTIME !== "pi", "Runs real Pi turns against the fixture endpoint.");
  test.setTimeout(600_000);
  const stamp = Date.now();
  const apiKey = `fake-e2e-wire-key-${stamp}`;
  const offable = "rakazo-e2e-offable";
  const plain = "rakazo-e2e-plain";
  const maximal = "rakazo-e2e-max";
  const lowHigh = "rakazo-e2e-low-high";
  const fixture = await startCompatibleFixture({
    apiKey,
    listed: [offable, plain, maximal, lowHigh],
    served: [offable, plain, maximal, lowHigh],
  });
  try {
    await signup(page, `compatible-wire-${stamp}@rakazo.test`, "password12", `Wire ${stamp}`);
    await completeOnboarding(page);
    await rpc(page, "models/connect", {
      provider: COMPATIBLE,
      baseUrl: fixture.baseUrl,
      apiKey,
      modelId: offable,
      models: [
        compatibleConfig(offable, ["off", "low", "high", "xhigh"]),
        compatibleConfig(plain, ["off"]),
        compatibleConfig(maximal, ["medium", "max"]),
        compatibleConfig(lowHigh, ["low", "high"]),
      ],
    });
    const bots: Record<string, { id: string; name: string }> = {};
    for (const [name, modelId, thinkingLevel] of [
      ["Off bot", offable, "off"],
      ["Plain bot", plain, null],
      ["Max bot", maximal, "max"],
      ["Low high bot", lowHigh, null],
    ] as const) {
      const bot = await rpc<{ id: string }>(page, "bots/create", {
        name,
        title: "",
        description: "",
        notifyOnFinish: true,
        computerMode: "team",
      });
      await rpc(page, "bots/update", {
        botId: bot.id,
        modelProvider: COMPATIBLE,
        modelId,
        thinkingLevel,
      });
      bots[name] = { id: bot.id, name };
    }

    const lowHighBot = bots["Low high bot"]!;
    for (const thinkingLevel of ["medium", "xhigh", "max"] as const) {
      const rejected = await rpcResult(page, "bots/update", {
        botId: lowHighBot.id,
        modelProvider: COMPATIBLE,
        modelId: lowHigh,
        thinkingLevel,
      });
      expect(rejected.ok, rejected.text).toBe(false);
      expect(rejected.text).not.toContain(apiKey);
    }
    const unsupportedRoutine = await rpcResult(page, "routines/create", {
      botId: lowHighBot.id,
      name: "Unsupported effort",
      prompt: "Should never save",
      crons: ["0 9 * * *"],
      modelProvider: COMPATIBLE,
      modelId: plain,
      thinkingLevel: "low",
    });
    expect(unsupportedRoutine.ok, unsupportedRoutine.text).toBe(false);
    expect(await rpc(page, "routines/list", { botId: lowHighBot.id })).toEqual([]);
    expect(await rpc(page, "bots/get", { botId: lowHighBot.id })).toMatchObject({
      modelId: lowHigh,
      thinkingLevel: null,
    });

    await page.goto(`/app/${lowHighBot.id}`);
    const panel = await openBotSettings(page, lowHighBot.name);
    await expect(panel.model).toHaveValue(optionKey(lowHigh));
    await expect(panel.effort).toHaveValue("");
    await expect(panel.effort.locator("option")).toHaveText(["Default (High)", "Low", "High"]);
    await panel.effort.scrollIntoViewIfNeeded();
    await expectNoSecretRendered(page, [apiKey]);
    await captureScreenshot(page, testInfo, "openai-compatible-low-high-default");
    await page.goto(`/app/${bots["Plain bot"]!.id}`);
    const plainPanel = await openBotSettings(page, "Plain bot");
    await expect(plainPanel.model).toHaveValue(optionKey(plain));
    await expect(plainPanel.effort).toHaveCount(0);

    const expected: Array<[string, Wire]> = [
      ["Off bot", { model: offable, reasoning_effort: "none" }],
      ["Plain bot", { model: plain }],
      ["Max bot", { model: maximal, reasoning_effort: "max" }],
      ["Low high bot", { model: lowHigh, reasoning_effort: "high" }],
    ];
    for (const [name, wire] of expected) {
      const runMarker = marker(name.replaceAll(" ", ""));
      await rpc(page, "threads/send", {
        botId: bots[name]!.id,
        text: `${runMarker} reply with the fixture verification message.`,
      });
      await expect.poll(() => fixture.agentCalls(runMarker), { timeout: 90_000 }).toEqual([wire]);
      await expectRunCompleted(page, bots[name]!.id, runMarker);
    }
    fixture.assertComplete();
  } finally {
    await fixture.close();
  }
});

test("manual models survive failed and empty discovery across spaces and accounts", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  const apiKey = `fake-e2e-manual-key-${stamp}`;
  const manual = "manual-only-model";
  const longId = `long-${"x".repeat(240)}-alpha-model`.slice(0, 256);
  const fixture = await startCompatibleFixture({ apiKey, listed: [], served: [] });
  const otherContext = await browser.newContext();
  try {
    await signup(page, `compatible-manual-${stamp}@rakazo.test`, "password12", `Manual ${stamp}`);
    await completeOnboarding(page);
    const userSettings = await openCompatibleSettings(page);
    const serverUrl = page.getByLabel("OpenAI-compatible server URL");
    const save = page.getByRole("button", { name: "Save", exact: true });
    const setupHelp = page.getByText("Paste the OpenAI-compatible address", { exact: false });
    await expect(setupHelp).toBeHidden();
    await page.getByText("Setup help", { exact: true }).click();
    await expect(setupHelp).toBeVisible();
    await page.getByText("Setup help", { exact: true }).click();
    await expect(setupHelp).toBeHidden();

    await serverUrl.fill(fixture.baseUrl);
    await page
      .locator("summary")
      .filter({ hasText: /^API key$/ })
      .click();
    await page.getByLabel("API key", { exact: true }).fill(apiKey);
    await page.getByRole("button", { name: "Find models" }).click();
    await expect(page.getByText("Server found. Add a model by its id.")).toBeVisible();

    await page.getByRole("button", { name: "Other model…" }).click();
    await page.getByLabel("Model id").fill(manual);
    await page
      .getByRole("region", { name: "Models", exact: true })
      .getByRole("button", { name: "Add", exact: true })
      .click();
    const manualSetup = page.getByRole("group", { name: `Advanced: ${manual}` });
    await expect(manualSetup).toBeVisible();
    await expect(modelCheckbox(page, manual)).toBeChecked();
    await expect(save).toBeDisabled();
    await configureThinking(manualSetup, ["Low", "High"]);
    await manualSetup.getByLabel("Default reasoning effort").selectOption("low");
    await manualSetup.getByLabel("Maximum output tokens").fill("8192");
    await manualSetup.getByLabel("Context limit").fill(String(PI_CONTEXT_WINDOW));
    await manualSetup.getByRole("checkbox", { name: "Supports images" }).check();
    await manualSetup.getByLabel("Maximum images per request").fill("1");
    await manualSetup.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByLabel("Default model")).toHaveValue(manual);

    fixture.setListed("fail");
    await page.getByRole("button", { name: "Find models" }).click();
    await expect(userSettings.getByRole("alert")).toBeVisible();
    await expect(userSettings.getByRole("alert")).not.toContainText(apiKey);
    await expect(modelCheckbox(page, manual)).toBeChecked();

    fixture.setListed([
      "team-alpha-chat",
      "alpha-vision",
      "bravo-coder",
      longId,
      "team-alpha-chat",
    ]);
    await page.getByRole("button", { name: "Find models" }).click();
    await expect(page.getByText("Found 4 models.")).toBeVisible();
    const search = page.getByLabel("Search models");
    await search.fill("alpha");
    for (const id of ["team-alpha-chat", "alpha-vision", longId]) {
      await expect(modelCheckbox(page, id)).toHaveCount(1);
    }
    await expect(modelCheckbox(page, "bravo-coder")).toHaveCount(0);
    await expect(modelCheckbox(page, manual)).toHaveCount(0);
    await modelCheckbox(page, longId).check();
    const longSetup = page.getByRole("group", { name: `Advanced: ${longId}` });
    await longSetup.getByLabel("Context limit").fill(String(PI_CONTEXT_WINDOW));
    await longSetup.getByRole("button", { name: "Apply" }).click();
    await search.fill("no-such-model");
    await expect(page.getByText("No models match.")).toBeVisible();
    await search.fill("");
    await expect(modelCheckbox(page, manual)).toBeChecked();
    await expect(modelCheckbox(page, longId)).toBeChecked();
    await expect(modelCheckbox(page, "bravo-coder")).not.toBeChecked();
    await expectNoSecretRendered(page, [apiKey]);
    await captureScreenshot(page, testInfo, "openai-compatible-manual-and-search");
    await save.click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();

    const credentials = await rpcResult<CompatibleCredential[]>(page, "models/credentials", {});
    expect(credentials.text).not.toContain(apiKey);
    const connection = await compatibleConnection(page);
    expect(connection.enabledModelIds).toEqual([manual, longId]);
    expect(connection.models).toEqual([
      compatibleConfig(manual, ["low", "high"], {
        defaultThinkingLevel: "low",
        maxTokens: 8192,
        supportsImages: true,
        maxImagesPerPrompt: 1,
      }),
      compatibleConfig(longId, ["off"]),
    ]);

    await page.reload();
    await openCompatibleSettings(page);
    await expect(modelCheckbox(page, manual)).toBeChecked();
    await expect(modelCheckbox(page, longId)).toBeChecked();
    await page.getByRole("button", { name: `Advanced: ${manual}` }).click();
    await expectThinkingLevels(manualSetup, ["Low", "High"]);
    await expect(manualSetup.getByLabel("Default reasoning effort")).toHaveValue("low");
    await expect(manualSetup.getByLabel("Maximum images per request")).toHaveValue("1");
    await manualSetup.getByLabel("Maximum images per request").fill("");
    await manualSetup.getByRole("button", { name: "Apply" }).click();
    await save.click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
    expect((await compatibleConnection(page)).models?.[0]?.maxImagesPerPrompt).toBeUndefined();

    await serverUrl.fill("");
    await expect(page.getByRole("button", { name: "Find models" })).toBeDisabled();
    await expect(save).toBeDisabled();
    await serverUrl.fill(fixture.baseUrl);
    await expect(modelCheckbox(page, manual)).toBeChecked();
    await page.getByRole("button", { name: "Close model settings" }).click();

    const chief = await openBotSettings(page, "Chief");
    const choices = await optionValues(chief.model);
    expect(choices).toEqual(expect.arrayContaining([optionKey(manual), optionKey(longId)]));
    expect(choices).not.toContain(optionKey("bravo-coder"));
    await chief.model.selectOption(optionKey(manual));
    await expect(chief.effort.locator("option")).toHaveText(["Default (Low)", "Low", "High"]);
    await chief.model.selectOption(optionKey(longId));
    await expect(chief.effort).toHaveCount(0);

    const otherSpace = await rpc<{ id: string }>(page, "spaces/create", { name: "Second space" });
    expect(await compatibleCatalogIds(page, otherSpace.id)).toEqual([manual, longId].sort());
    const spaceDefault = await rpcResult(
      page,
      "models/setDefault",
      { provider: COMPATIBLE, modelId: longId },
      { spaceId: otherSpace.id },
    );
    expect(spaceDefault.ok, spaceDefault.text).toBe(true);
    const otherMe = await rpcResult<{ defaultModel: string }>(
      page,
      "me",
      {},
      { spaceId: otherSpace.id },
    );
    expect(otherMe.json?.defaultModel).toBe(longId);
    expect(await rpc(page, "me", {})).toMatchObject({ defaultModel: manual });

    const stranger = await otherContext.newPage();
    await signup(stranger, `compatible-stranger-${stamp}@rakazo.test`, "password12", "Stranger");
    await completeOnboarding(stranger);
    const strangerCredentials = await rpc<CompatibleCredential[]>(
      stranger,
      "models/credentials",
      {},
    );
    expect(strangerCredentials.some((entry) => entry.provider === COMPATIBLE)).toBe(false);
    expect(await compatibleCatalogIds(stranger)).toEqual([]);
    const listsBefore = fixture.listRequests.length;
    const strangerProbe = await rpcResult(stranger, "models/probeOpenAiCompatible", {
      baseUrl: fixture.baseUrl,
      credentialId: connection.id,
    });
    expect(strangerProbe.ok).toBe(false);
    expect(strangerProbe.text).not.toContain(apiKey);
    expect(
      fixture.listRequests
        .slice(listsBefore)
        .some((request) => request.authorization === `Bearer ${apiKey}`),
    ).toBe(false);
    const strangerDescribe = await rpcResult(stranger, "models/describeOpenAiCompatible", {
      baseUrl: fixture.baseUrl,
      credentialId: connection.id,
      modelIds: [manual],
    });
    expect(strangerDescribe.ok).toBe(false);
    const strangerBots = await rpc<Array<{ id: string }>>(stranger, "bots/list", {});
    const strangerSelect = await rpcResult(stranger, "bots/update", {
      botId: strangerBots[0]!.id,
      modelProvider: COMPATIBLE,
      modelId: manual,
      thinkingLevel: null,
    });
    expect(strangerSelect.ok).toBe(false);
    expect(strangerSelect.text).not.toContain(apiKey);
    fixture.assertComplete();
  } finally {
    await otherContext.close();
    await fixture.close();
  }
});

test("model settings connect, replace, and cancel provider authentication", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const userName = `Models ${stamp}`;
  await signup(page, `models-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);

  await openUserSettings(page, "models");
  await expect(page.getByRole("button", { name: "Close model settings" })).toBeVisible();

  const keyed = await keyedTestProvider(page);
  const keyedRow = () => page.getByRole("button", { name: keyed.row }).first();
  const providerSearch = page.getByPlaceholder("Search providers");
  await providerSearch.fill(keyed.search);
  await keyedRow().click();
  const modelPicker = page.getByRole("combobox", { name: "Model", exact: true });
  if (keyed.provider === "scripted") await expect(modelPicker).toHaveText(/Scripted runtime/);
  const modelText = (await modelPicker.textContent())?.trim() ?? "";
  expect(modelText).not.toBe("");
  const apiKeyInput = page.getByLabel("API key");
  await expect(apiKeyInput).toHaveAttribute("autocomplete", "new-password");
  await apiKeyInput.fill(`fake-${keyed.provider}-key-one`);
  await page.getByText("Advanced", { exact: true }).click();
  await page.getByLabel("Maximum output tokens").fill("8192");
  await captureScreenshot(page, testInfo, "builtin-provider-max-tokens");
  await page.getByRole("button", { name: "Connect API key" }).click();
  await expect(page.getByText(/Connected and using/)).toBeVisible();
  const connected = await rpc<Array<{ provider: string; maxTokens?: number }>>(
    page,
    "models/credentials",
    {},
  );
  expect(connected.find((entry) => entry.provider === keyed.provider)?.maxTokens).toBe(8192);
  // Connecting preserves the open disclosure; only open it if the form remounted.
  const outputLimit = page.getByLabel("Maximum output tokens");
  if (!(await outputLimit.isVisible())) {
    await page.getByText("Advanced", { exact: true }).click();
  }
  await outputLimit.fill("16384");
  await page.getByRole("button", { name: "Save limits", exact: true }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  const updated = await rpc<Array<{ provider: string; maxTokens?: number }>>(
    page,
    "models/credentials",
    {},
  );
  expect(updated.find((entry) => entry.provider === keyed.provider)?.maxTokens).toBe(16384);
  await page.reload();
  await openUserSettings(page, "models");
  await providerSearch.fill(keyed.search);
  await keyedRow().click();
  await expect(modelPicker).toHaveText(modelText);
  const storedKey = page.getByLabel("Replace API key");
  await expect(storedKey).toHaveValue("");
  await expect(storedKey).toHaveAttribute("placeholder", "Paste a replacement key");
  await captureScreenshot(page, testInfo, "stored-provider-api-key");
  await page.getByText("Advanced", { exact: true }).click();
  await expect(page.getByLabel("Maximum output tokens")).toHaveValue("16384");

  // Connected providers get their own section with the saved model inline;
  // searching flattens back to one ranked list.
  await providerSearch.fill("");
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.getByText("All providers", { exact: true })).toBeVisible();
  const providerRow = page.getByRole("button", { name: new RegExp(`^${keyed.name}`) });
  await expect(providerRow).toContainText(modelText);
  await providerSearch.fill(keyed.search);
  await expect(page.getByText("All providers", { exact: true })).toBeHidden();
  await expect(keyedRow()).toContainText("Connected");
  await keyedRow().click();

  await page.getByLabel("Replace API key").fill(`fake-${keyed.provider}-key-two`);
  await page.getByRole("button", { name: "Replace API key" }).click();
  await expect(page.getByText(/Connected and using/)).toBeVisible();

  const codexCredential = {
    id: "cred-codex",
    provider: "openai-codex",
    label: "ChatGPT Plus/Pro",
    hasKey: false,
    isDefault: false,
    modelId: "gpt-6-luna",
    authKind: "oauth",
  };
  let oauthReady = false;
  let oauthFinished = false;
  await page.route("**/rpc/models/credentials", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: unknown[] };
    if (oauthFinished) body.json.push(codexCredential);
    await route.fulfill({ response, body: JSON.stringify(body) });
  });
  await page.route("**/rpc/models/beginOAuth", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          loginId: "fake-login",
          provider: "openai-codex",
          mode: "device-code",
          verificationUri: "https://example.com/device",
          userCode: "TEST-CODE",
          expiresInSeconds: 900,
        },
      }),
    });
  });
  await page.route("**/rpc/models/completeOAuth", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { status: oauthReady ? "ready" : "pending" } }),
    });
  });
  await page.route("**/rpc/models/finishOAuth", async (route) => {
    oauthFinished = true;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: codexCredential }),
    });
  });
  await page.evaluate(() => {
    window.open = () => null;
  });
  let finishRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/rpc/models/finishOAuth")) finishRequests += 1;
  });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

  await providerSearch.fill("openai-codex");
  await page
    .getByRole("button", { name: /ChatGPT Plus\/Pro/ })
    .first()
    .click();
  await page.getByRole("button", { name: /Sign in with ChatGPT Plus\/Pro/ }).click();

  // The popup is blocked (window.open returned null): the card still carries the
  // code, a copy button, the expiry, and a way to abandon the attempt.
  await expect(page.getByText("TEST-CODE")).toBeVisible();
  await expect(page.getByRole("link", { name: "example.com/device" })).toBeVisible();
  await expect(page.getByText(/code expires in about 15 minutes/)).toBeVisible();
  await captureScreenshot(page, testInfo, "oauth-device-code-card");
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("TEST-CODE");

  const cancelledByButton = page.waitForRequest((request) =>
    request.url().includes("/rpc/models/cancelOAuth"),
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await cancelledByButton;
  await expect(page.getByText("TEST-CODE")).toBeHidden();

  // A canceled attempt leaves sign-in reusable.
  await page.getByRole("button", { name: /Sign in with ChatGPT Plus\/Pro/ }).click();
  await expect(page.getByText("TEST-CODE")).toBeVisible();

  const cancelled = page.waitForRequest((request) =>
    request.url().includes("/rpc/models/cancelOAuth"),
  );
  await providerSearch.fill(keyed.search);
  await keyedRow().click();
  await cancelled;
  expect(finishRequests).toBe(0);
  await page.getByLabel("Replace API key").fill(`fake-${keyed.provider}-key-three`);
  await expect(page.getByRole("button", { name: "Replace API key" })).toBeEnabled();
  await expect(page.getByText("TEST-CODE")).toBeHidden();

  // A finished sign-in relabels the action so re-clicking reads as a reconnect.
  oauthReady = true;
  await providerSearch.fill("openai-codex");
  await page
    .getByRole("button", { name: /ChatGPT Plus\/Pro/ })
    .first()
    .click();
  await page.getByRole("button", { name: /Sign in with ChatGPT Plus\/Pro/ }).click();
  await expect(page.getByText(/Connected and using/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in again", exact: true })).toBeVisible();

  // Disconnect removes the credential and its Connected marker.
  await providerSearch.fill(keyed.search);
  await keyedRow().click();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  const confirmDisconnect = page.getByRole("alertdialog");
  await expect(
    confirmDisconnect.getByRole("heading", { name: `Disconnect ${keyed.name}?` }),
  ).toBeVisible();
  await confirmDisconnect.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByText(`Disconnected ${keyed.name}`)).toBeVisible();
  const afterDisconnect = await rpc<Array<{ provider: string }>>(page, "models/credentials", {});
  expect(afterDisconnect.some((entry) => entry.provider === keyed.provider)).toBe(false);
  await expect(keyedRow()).not.toContainText("Connected");
});

test("a deployment default on server credentials says so and keeps an own key optional", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `server-credentials-${stamp}@rakazo.test`, "password12", `Server ${stamp}`);
  await completeOnboarding(page);
  // The E2E deployment runs on a scripted model, so present the active default as one that
  // authenticates from the host, the way an Amazon Bedrock deployment on an AWS role does.
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({
      response,
      json: {
        ...body,
        json: {
          ...body.json,
          defaultProvider: "amazon-bedrock",
          defaultModel: "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
          hostCredentialProvider: "amazon-bedrock",
          hostCredentialSource: "AWS IAM",
        },
      },
    });
  });
  await openUserSettings(page, "models");

  const serverNote = page.getByText(
    "Uses this server's own AWS IAM credentials to access Amazon Bedrock.",
  );
  const ownKeyDisclosure = page.getByText("Use your own key", { exact: true });
  await expect(serverNote).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect API key" })).toBeHidden();
  await captureScreenshot(page, testInfo, "model-settings-server-credentials");

  await ownKeyDisclosure.click();
  await expect(page.getByRole("button", { name: "Connect API key" })).toBeVisible();
  await expect(serverNote).toBeVisible();
  await ownKeyDisclosure.click();
  await expect(page.getByRole("button", { name: "Connect API key" })).toBeHidden();
  await expect(serverNote).toBeVisible();
});

test("a key connected in another space can replace server credentials for the same model", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `shared-model-${stamp}@rakazo.test`, "password12", "Model Owner");
  await completeOnboarding(page);
  const otherSpace = await rpc<{ id: string }>(page, "spaces/create", { name: "Other space" });
  const provider = "amazon-bedrock";
  const modelId = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
  const connected = await page.request.post("/rpc/models/connect", {
    headers: { "x-rakazo-space-id": otherSpace.id },
    data: { json: { provider, modelId, apiKey: "fake-bedrock-key" } },
  });
  expect(connected.ok()).toBe(true);
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    // The offline deployment uses Scripted; expose its untouched default as host Bedrock.
    if (body.json.defaultProvider !== provider) {
      Object.assign(body.json, {
        defaultProvider: provider,
        defaultModel: modelId,
        hostCredentialProvider: provider,
        hostCredentialSource: "AWS IAM",
      });
    }
    await route.fulfill({ response, json: body });
  });
  await openUserSettings(page, "models");
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveText(
    /Claude Haiku/,
  );
  await expect(
    page.getByText("Uses this server's own AWS IAM credentials to access Amazon Bedrock."),
  ).toBeVisible();
  const useModel = page.getByRole("button", { name: "Use this model", exact: true });
  await expect(useModel).toBeVisible();
  const personalBillingNote = page.getByText(
    "Uses your Amazon Bedrock API key. Rakazo does not pay for model usage.",
  );
  await expect(personalBillingNote).toBeHidden();
  await captureScreenshot(page, testInfo, "model-settings-server-credentials-connected-key");
  const saved = page.waitForRequest("**/rpc/models/setDefault");
  await useModel.click();
  const request = await saved;
  expect(request.postDataJSON().json).toMatchObject({ provider, modelId });
  expect(request.headers()["x-rakazo-space-id"]).not.toBe(otherSpace.id);
  await expect(page.getByText(/Now using/)).toBeVisible();
  await expect(useModel).toBeHidden();
  await expect(personalBillingNote).toBeVisible();
  await expect(
    page.getByText("Uses this server's own AWS IAM credentials to access Amazon Bedrock."),
  ).toBeHidden();
  expect(await rpc(page, "me", {})).toMatchObject({
    defaultProvider: provider,
    defaultModel: modelId,
    hostCredentialProvider: null,
  });
});

test("catalog models keep a space default thinking level per saved model", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `catalog-thinking-${stamp}@rakazo.test`, "password12", `Thinking ${stamp}`);
  await completeOnboarding(page);

  await openUserSettings(page, "models");
  const providerSearch = page.getByPlaceholder("Search providers");

  if ((await keyedTestProvider(page)).provider === "scripted") {
    await providerSearch.fill("scripted");
    await page.getByRole("button", { name: /Scripted/ }).click();
    await expect(page.getByRole("combobox", { name: "Thinking", exact: true })).toBeHidden();
  }

  await providerSearch.fill("anthropic");
  await page.getByRole("button", { name: /^Anthropic / }).click();
  await page.getByLabel("API key").fill("fake-anthropic-key");
  await page.getByRole("button", { name: "Connect API key" }).click();
  await expect(page.getByText(/Connected and using/)).toBeVisible();

  const thinking = page.getByRole("combobox", { name: "Thinking", exact: true });
  await expect(thinking).toBeVisible();
  await expect(thinking).toHaveValue("");
  await thinking.selectOption("high");
  await captureScreenshot(page, testInfo, "catalog-model-thinking");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/Now using/)).toBeVisible();
  // The Active model banner surfaces the effective effort while the model can think.
  await expect(page.getByText("Thinking: High", { exact: true })).toBeVisible();

  const credentials = await rpc<Array<{ provider: string; thinkingLevel?: string | null }>>(
    page,
    "models/credentials",
    {},
  );
  expect(credentials.find((entry) => entry.provider === "anthropic")?.thinkingLevel).toBe("high");

  // The level persists across reloads while the same model stays selected.
  await page.reload();
  await openUserSettings(page, "models");
  await providerSearch.fill("anthropic");
  await page.getByRole("button", { name: /^Anthropic / }).click();
  await expect(page.getByRole("combobox", { name: "Thinking", exact: true })).toHaveValue("high");

  // The stored level is bound to the saved model: staging another model resets the
  // staged level, and saving the new model clears the old level instead of leaking it.
  await page.getByRole("combobox", { name: "Model", exact: true }).click();
  await page.getByRole("option", { name: "Claude Opus 4.8", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Thinking", exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Use this model", exact: true }).click();
  await expect(page.getByText(/Now using/)).toBeVisible();
  const updated = await rpc<Array<{ provider: string; thinkingLevel?: string | null }>>(
    page,
    "models/credentials",
    {},
  );
  expect(updated.find((entry) => entry.provider === "anthropic")?.thinkingLevel).toBeUndefined();
});

test("saves and reloads an ordered backup model list for connected models", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `backup-models-${stamp}@rakazo.test`, "password12", `Backups ${stamp}`);
  await completeOnboarding(page);

  const catalog = await rpc<
    Array<{
      provider: string;
      id: string;
      label: string;
      providerName?: string;
      placeholder?: boolean;
    }>
  >(page, "models/list", {});
  const targets = ["anthropic", "openai"].map((provider) => {
    const model = catalog.find((entry) => entry.provider === provider && !entry.placeholder);
    expect(model, `expected a ${provider} catalog entry`).toBeDefined();
    return model!;
  });
  // Fake credentials exercise the connected-model picker without calling a provider.
  for (const model of targets) {
    await rpc(page, "models/connect", {
      provider: model.provider,
      apiKey: `fake-backup-${model.provider}-key`,
      modelId: model.id,
    });
  }

  const settings = await openUserSettings(page, "models");
  const panel = settings.getByTestId("model-backups");
  await panel.scrollIntoViewIfNeeded();
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Add connected models to use them as backups.")).toBeVisible();
  const picker = panel.getByRole("combobox", { name: "Add connected model" });
  const firstValue = JSON.stringify([targets[0]!.provider, targets[0]!.id]);
  const secondValue = JSON.stringify([targets[1]!.provider, targets[1]!.id]);
  await picker.selectOption(firstValue);
  await panel.getByRole("button", { name: "Add", exact: true }).click();
  await picker.selectOption(secondValue);
  await panel.getByRole("button", { name: "Add", exact: true }).click();

  const firstLabel = `${targets[0]!.providerName ?? targets[0]!.provider} · ${targets[0]!.label}`;
  const secondLabel = `${targets[1]!.providerName ?? targets[1]!.provider} · ${targets[1]!.label}`;
  await panel.getByRole("button", { name: `Move ${secondLabel} up` }).click();
  const rows = panel.locator('[data-testid^="model-backup-"]');
  await expect(rows.nth(0)).toContainText(secondLabel);
  await expect(rows.nth(1)).toContainText(firstLabel);
  await panel.scrollIntoViewIfNeeded();
  await expect(panel).toBeInViewport();

  const savedResponse = page.waitForResponse(
    (response) => response.url().includes("/rpc/models/setBackups") && response.ok(),
  );
  await panel.getByRole("button", { name: "Save backups", exact: true }).click();
  await savedResponse;
  await expect(panel.getByText("Backup models saved.")).toBeVisible();
  expect(await rpc(page, "models/backups", {})).toEqual([
    { provider: targets[1]!.provider, modelId: targets[1]!.id },
    { provider: targets[0]!.provider, modelId: targets[0]!.id },
  ]);

  await page.reload();
  const reloadedSettings = await openUserSettings(page, "models");
  const reloadedPanel = reloadedSettings.getByTestId("model-backups");
  await reloadedPanel.scrollIntoViewIfNeeded();
  const reloadedRows = reloadedPanel.locator('[data-testid^="model-backup-"]');
  await expect(reloadedRows.nth(0)).toContainText(secondLabel);
  await expect(reloadedRows.nth(1)).toContainText(firstLabel);
  await reloadedPanel.scrollIntoViewIfNeeded();
  await expect(reloadedPanel).toBeInViewport();
  await testInfo.attach("settings-backup-models-control", {
    body: await reloadedPanel.screenshot({ animations: "disabled" }),
    contentType: "image/png",
  });
  await captureScreenshot(page, testInfo, "settings-backup-models-order");
  await reloadedPanel.getByRole("button", { name: `Remove ${firstLabel}` }).click();
  const removalResponse = page.waitForResponse(
    (response) => response.url().includes("/rpc/models/setBackups") && response.ok(),
  );
  await reloadedPanel.getByRole("button", { name: "Save backups", exact: true }).click();
  await removalResponse;
  expect(await rpc(page, "models/backups", {})).toEqual([
    { provider: targets[1]!.provider, modelId: targets[1]!.id },
  ]);
});
