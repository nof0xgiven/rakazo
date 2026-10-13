import { expect, test } from "@playwright/test";
import { captureScreenshot, signup } from "./helpers";

test("onboarding uses compact model selects without misleading latest labels", async ({
  page,
}, testInfo) => {
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({
      response,
      json: {
        json: {
          ...body.json,
          needsModel: true,
          defaultProvider: "openrouter",
          defaultModel: "openai/gpt-5.6-luna",
        },
      },
    });
  });

  const stamp = Date.now();
  await signup(page, `model-labels-${stamp}@rakazo.test`, "password12", `Model labels ${stamp}`);
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible({
    timeout: 20_000,
  });

  const provider = page.getByRole("combobox", { name: "Provider" });
  await expect(provider).toContainText("OpenRouter");
  await page.getByLabel("API key").fill("openrouter-only-key");
  await provider.click();
  await expect(page.getByRole("option", { name: "ChatGPT" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Vercel AI Gateway" })).toBeVisible();
  await page.getByRole("option", { name: "Anthropic" }).click();
  await expect(provider).toContainText("Anthropic");
  await expect(page.getByLabel(/API key/)).toHaveValue("");

  const models = page.getByRole("combobox", { name: "Model", exact: true });
  await models.click();
  const labels = await page.getByRole("option").allTextContents();
  // "latest" is an upstream alias marker, so it lands on families like Claude Opus 4.5 while
  // newer models carry no marker. Rendered as-is it tells the user the opposite of the truth.
  expect(labels.filter((label) => /\blatest\b/i.test(label))).toEqual([]);

  // Select a non-default model and keep its user-facing alias visible in the compact trigger.
  const alias = labels.find((label) => label.includes("(auto-updates)"));
  expect(alias).toBeTruthy();
  await page.getByRole("option", { name: alias! }).click();
  await expect(models).toContainText(alias!);

  await page.route("**/rpc/models/probeOpenAiCompatible", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { models: [{ modelId: "probed-model", capabilities: null }] } }),
    });
  });
  await page.route("**/rpc/models/describeOpenAiCompatible", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { models: [] } }),
    });
  });
  await provider.click();
  await page.getByRole("option", { name: "OpenAI-compatible" }).click();
  const serverUrl = page.getByLabel("OpenAI-compatible server URL");
  await serverUrl.fill("http://127.0.0.1:8090/v1");
  await page.getByRole("button", { name: "Other model…" }).click();
  await page.getByLabel("Model id").fill("manual-model");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const manual = page.getByRole("checkbox", { name: "manual-model" });
  await expect(manual).toBeChecked();
  const setup = page.getByRole("group", { name: "Advanced: manual-model" });
  await expect(setup).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  await setup.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByLabel("Default model")).toHaveValue("manual-model");
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();

  const probeResponse = page.waitForResponse("**/rpc/models/probeOpenAiCompatible");
  await page.getByRole("button", { name: "Find models" }).click();
  await probeResponse;
  await expect(page.getByRole("checkbox", { name: "probed-model" })).not.toBeChecked();
  await expect(manual).toBeChecked();
  await page.getByLabel("Search models").fill("probed");
  await expect(manual).toHaveCount(0);
  await page.getByLabel("Search models").fill("");
  await expect(manual).toBeChecked();

  await serverUrl.fill("http://127.0.0.1:8091/v1");
  await expect(manual).toHaveCount(0);

  await captureScreenshot(page, testInfo, "onboarding-model-labels");
});
