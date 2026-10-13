import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { execSync, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RECALLED_MEMORY_PREFIX } from "@rakazo/core";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { createApp } from "../../../../apps/api/src/app.ts";
import {
  HINDSIGHT_FIXTURE_CONTROL_PATH,
  HINDSIGHT_FIXTURE_TOKEN_HEADER,
  startHindsightEmulator,
} from "../hindsight-emulator.js";
import type { ModelEmulatorRequest } from "../model-emulator.js";
import { startModelEmulator } from "../model-emulator.js";
import { runProcess } from "./process.js";

loadRootEnv();

const integration = process.argv.includes("--integration");
const e2e = process.argv.includes("--e2e");
const sandboxArg = process.argv.find((arg) => arg.startsWith("--sandbox="));
const specArg = process.argv.find((arg) => arg.startsWith("--spec="));
const grepArg = process.argv.find((arg) => arg.startsWith("--grep="));
const runtimeArg = process.argv.find((arg) => arg.startsWith("--runtime="));
const sandboxProvider = sandboxArg?.slice("--sandbox=".length) ?? "fake";
const e2eSpec = specArg?.slice("--spec=".length);
const e2eGrep = grepArg?.slice("--grep=".length);
const agentRuntime = runtimeArg?.slice("--runtime=".length) ?? "scripted";
const serveMode = process.argv.includes("--serve");

if (Number(integration) + Number(e2e) !== 1) {
  throw new Error("Pass exactly one of --integration or --e2e");
}
if (!["fake", "e2b", "daytona", "box"].includes(sandboxProvider)) {
  throw new Error('Sandbox must be "fake", "e2b", "daytona", or "box"');
}
if (integration && sandboxProvider !== "fake") {
  throw new Error("Integration tests only support the fake sandbox");
}
if (agentRuntime !== "pi" && agentRuntime !== "scripted") {
  throw new Error('Runtime must be "pi" or "scripted"');
}
if (sandboxProvider === "e2b" && !process.env.E2B_API_KEY) {
  throw new Error("E2B_API_KEY is required when --sandbox=e2b");
}
if (sandboxProvider === "daytona" && !process.env.DAYTONA_API_KEY) {
  throw new Error("DAYTONA_API_KEY is required when --sandbox=daytona");
}
if (sandboxProvider === "box" && !process.env.BOX_API_KEY) {
  throw new Error("BOX_API_KEY is required when --sandbox=box");
}
if (serveMode && (!e2e || sandboxProvider !== "fake")) {
  throw new Error("--serve is only supported with --e2e --sandbox=fake");
}
if (serveMode && (e2eSpec || e2eGrep)) {
  throw new Error("--serve does not run Playwright; omit --spec and --grep");
}

async function main() {
  const mode = integration ? "integration" : "e2e";
  const reportDir = path.resolve("test-report", mode);
  await mkdir(reportDir, { recursive: true });
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  try {
    const databaseUrl = container.getConnectionUri();
    const apiPort = Number(process.env.API_PORT ?? 3110);
    const webPort = Number(process.env.WEB_PORT ?? 5180);
    const webOrigin = `http://127.0.0.1:${webPort}`;

    if (serveMode) {
      for (const name of Object.keys(process.env)) {
        if (name.endsWith("_API_KEY") || name.startsWith("PI_DEFAULT_")) delete process.env[name];
      }
    }

    process.env.DATABASE_URL = databaseUrl;
    process.env.REALTIME_DATABASE_URL = databaseUrl;
    process.env.VERIFY_DATABASE = "1";
    process.env.WAKEUP_DRIVER = "memory";
    process.env.SANDBOX_PROVIDER = sandboxProvider;
    process.env.AGENT_RUNTIME = agentRuntime;
    if (!integration) process.env.TICKET_BOARD_ENABLED = "true";
    // Playwright/E2E force the offline cloud-agent emulator; clear Cursor keys so cards never hit a live VM.
    process.env.CLOUD_AGENT_PROVIDER = "emulator";
    delete process.env.CURSOR_API_KEY;
    process.env.COMPOSIO_API_KEY = "";
    process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-32chars!";
    process.env.ENCRYPTION_KEY = "test-encryption-key-test-encryption-key";
    process.env.SANDBOX_SUPERVISOR_TOKEN = "test-supervisor-token-test-32chars";
    process.env.SCREEN_PROXY_SECRET = "test-screen-proxy-secret-test-32chars";
    process.env.BETTER_AUTH_URL = webOrigin;
    process.env.WEB_ORIGIN = webOrigin;
    process.env.API_PORT = String(apiPort);
    process.env.API_URL = `http://127.0.0.1:${apiPort}`;
    process.env.API_PROXY_TARGET = `http://127.0.0.1:${apiPort}`;
    process.env.WEB_PORT = String(webPort);
    process.env.PLAYWRIGHT_BASE_URL = webOrigin;
    process.env.DATA_DIR = path.join(reportDir, "data");
    process.env.SIGNUPS_ENABLED = "true";
    process.env.SIGNUP_ALLOWLIST = "";
    process.env.CI = "1";

    execSync("pnpm --filter @rakazo/db generate", { stdio: "inherit", env: process.env });
    execSync("pnpm --filter @rakazo/db exec prisma migrate deploy", {
      stdio: "inherit",
      env: process.env,
      cwd: path.resolve("packages/db"),
    });

    if (integration) {
      const suites = [
        "packages/testkit/src/pi-offline.postgres.test.ts",
        "packages/testkit/src/usage-accounting.postgres.test.ts",
        "packages/db/src/history-retrieval.postgres.test.ts",
        "packages/testkit/src/history-retrieval.postgres.test.ts",
        "packages/testkit/src/history-short-product.postgres.test.ts",
        "packages/testkit/src/history-followup-product.postgres.test.ts",
        "packages/testkit/src/history-search-continuation.postgres.test.ts",
        "packages/testkit/src/history-product-loop.postgres.test.ts",
        "packages/testkit/src/history-clarification.postgres.test.ts",
        "packages/testkit/src/computer-approval.postgres.test.ts",
        "packages/testkit/src/eval-history.postgres.test.ts",
        "packages/testkit/src/eval-customer-support.postgres.test.ts",
        "packages/testkit/src/journeys.test.ts",
        "packages/testkit/src/authorization.test.ts",
        "packages/testkit/src/attachments.test.ts",
        "packages/testkit/src/voice.test.ts",
        "packages/testkit/src/search.test.ts",
        "packages/testkit/src/executor-lifecycle.test.ts",
        "packages/testkit/src/connections.test.ts",
        "packages/testkit/src/bot-secrets.test.ts",
        "packages/db/src/space-membership.postgres.test.ts",
        "packages/db/src/messaging.postgres.test.ts",
        "packages/db/src/billing.postgres.test.ts",
        "apps/api/src/billing.postgres.test.ts",
        "packages/memory/src/commit.postgres.test.ts",
        "packages/adapters/src/wakeup.postgres.test.ts",
        "packages/adapters/src/realtime.postgres.test.ts",
        "packages/adapters/src/job-reconciler.postgres.test.ts",
        "packages/adapters/src/cloud-agent.postgres.test.ts",
        "packages/testkit/src/memory-retention.postgres.test.ts",
        "packages/testkit/src/hindsight-memory.postgres.test.ts",
      ];
      // Each app reconciles all durable work in its database, including intentionally
      // unfinished fixture runs. Clone the pristine migrated schema so one suite
      // cannot execute another suite's backlog or wait for it during shutdown.
      const template = container.getDatabase().replaceAll('"', '""');
      const databaseCommand = async (statement: string) => {
        const result = await container.exec([
          "psql",
          "-U",
          container.getUsername(),
          "-d",
          "postgres",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          statement,
        ]);
        if (result.exitCode !== 0)
          throw new Error("Isolated integration database operation failed");
      };
      for (const [index, suite] of suites.entries()) {
        const database = `integration_${index}`;
        await databaseCommand(`CREATE DATABASE "${database}" TEMPLATE "${template}"`);
        const suiteUrl = new URL(databaseUrl);
        suiteUrl.pathname = `/${database}`;
        try {
          await runProcess("pnpm", ["exec", "vitest", "run", suite], {
            ...process.env,
            DATABASE_URL: suiteUrl.toString(),
            REALTIME_DATABASE_URL: suiteUrl.toString(),
            OPENROUTER_API_KEY: "",
            MODEL_API_KEY: "",
          });
        } finally {
          await databaseCommand(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
        }
      }
      await writeSummary(reportDir, {
        ok: true,
        mode,
        sandbox: process.env.SANDBOX_PROVIDER,
        runtime: process.env.AGENT_RUNTIME,
      });
      return;
    }

    const [
      { ComposioEmulator, EmailEmulator, PipedreamConnector, ThirdPartyConnectorEmulator },
      { createApp },
    ] = await Promise.all([import("@rakazo/adapters"), import("../../../../apps/api/src/app.ts")]);
    const { serve } = await import("@hono/node-server");
    const thirdParties = new ThirdPartyConnectorEmulator();
    const pipedream = new PipedreamConnector(
      {
        clientId: "fake-client-id",
        clientSecret: "fake-client-secret",
        projectId: "fake-project-id",
        environment: "development",
        identitySecret: process.env.ENCRYPTION_KEY,
      },
      { fetch: thirdParties.fetch, resolveHostname: thirdParties.resolveHostname },
    );
    const email = new EmailEmulator();
    const hindsight = await startHindsightEmulator({ allowedOrigin: webOrigin });
    const handles = await createApp({
      databaseUrl,
      prisma: undefined,
      composio: new ComposioEmulator(),
      pipedream,
      email,
      remoteConnectors: {
        fetch: thirdParties.fetch,
        resolveHostname: thirdParties.resolveHostname,
      },
      integrationsCatalogUrl: "https://catalog.example.test/",
      memoryTransport: { fetch: hindsight.fetch },
    }).catch(async (error: unknown) => {
      await hindsight.close();
      throw error;
    });
    let activeRequests = 0;
    const requestWaiters = new Set<() => void>();
    const server = serve({
      fetch: async (request) => {
        if (new URL(request.url).pathname === "/__e2e/emails") {
          return Response.json(email.sent, { headers: { "cache-control": "no-store" } });
        }
        activeRequests += 1;
        try {
          return await handles.app.fetch(request);
        } finally {
          activeRequests -= 1;
          if (activeRequests === 0) {
            for (const resolve of requestWaiters) resolve();
            requestWaiters.clear();
          }
        }
      },
      port: apiPort,
      hostname: "127.0.0.1",
    });
    await waitForHealth(`http://127.0.0.1:${apiPort}/health`, 15_000);

    let web: ChildProcess | undefined;
    let model: ServeModelFixture | undefined;
    try {
      if (serveMode) {
        if (agentRuntime === "pi") model = await startServeModelFixture(reportDir);
        web = spawn("pnpm", ["--filter", "@rakazo/web", "dev"], {
          stdio: ["ignore", "inherit", "inherit"],
          env: { ...process.env, VITE_DEFAULT_UI_LOCALE: "en", RAKAZO_DEV_HOST: "127.0.0.1" },
          detached: true,
        });
        const stopped = waitForStopSignal(web);
        const ready = await Promise.race([
          waitForHealth(webOrigin, 120_000).then(() => true),
          stopped.then(() => false),
        ]);
        if (ready) {
          const fixture = hindsight.createFixture({ seedBanks: 3 });
          printServeInstructions({
            webOrigin,
            apiOrigin: `http://127.0.0.1:${apiPort}`,
            databaseUrl,
            hindsightOrigin: hindsight.origin,
            controlToken: hindsight.controlToken,
            fixtureId: fixture.id,
            fixtureKey: fixture.apiKey,
            model,
          });
          await stopped;
        }
      } else {
        try {
          await runProcess(
            "pnpm",
            [
              "--filter",
              "@rakazo/web",
              "exec",
              "playwright",
              "test",
              ...(e2eSpec ? [e2eSpec] : []),
              ...(e2eGrep ? ["--grep", e2eGrep] : []),
            ],
            {
              ...process.env,
              CI: "1",
              // Pin English so e2e selectors match source messages regardless of runner locale.
              VITE_DEFAULT_UI_LOCALE: "en",
              E2E_HINDSIGHT_FIXTURE_ORIGIN: hindsight.origin,
              E2E_HINDSIGHT_FIXTURE_TOKEN: hindsight.controlToken,
            },
          );
        } catch (error) {
          const failedRuns = await handles.prisma.run.findMany({
            where: { status: "failed" },
            select: { id: true, error: true },
          });
          if (failedRuns.length) console.error("Failed agent runs:", failedRuns);
          throw error;
        }
        await writeSummary(reportDir, {
          ok: true,
          mode,
          sandbox: process.env.SANDBOX_PROVIDER,
          runtime: process.env.AGENT_RUNTIME,
          apiPort,
          webPort,
        });
      }
    } finally {
      if (web) await stopProcessGroup(web);
      const cleanupErrors: unknown[] = [];
      const computers = await managedComputers(handles).catch((error) => {
        cleanupErrors.push(error);
        return [];
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (activeRequests > 0) {
        await new Promise<void>((resolve) => requestWaiters.add(resolve));
      }
      await handles.stop().catch(() => undefined);
      const fixtureCloses = [hindsight.close(), ...(model ? [model.close()] : [])];
      for (const result of await Promise.allSettled(fixtureCloses)) {
        if (result.status === "rejected") {
          console.error("Could not close an e2e fixture server:", result.reason);
          process.exitCode = 1;
        }
      }
      if (model) {
        try {
          model.assertComplete();
        } catch (error) {
          console.error("Serve model fixture was not completed as scripted:", error);
          process.exitCode = 1;
        }
      }
      for (let index = 0; index < computers.length; index += 4) {
        const results = await Promise.allSettled(
          computers.slice(index, index + 4).map((computer) =>
            handles.sandbox.destroy(
              {
                id: computer.providerRef!,
                botId: computer.homeKey,
                kind: computer.kind as "e2b" | "daytona" | "box",
                providerRef: computer.providerRef!,
              },
              {
                operationId: "e2e-cleanup",
                traceId: "e2e-cleanup",
                spaceId: computer.spaceId,
                userId: computer.userId,
                signal: new AbortController().signal,
              },
            ),
          ),
        );
        for (const result of results) {
          if (result.status === "rejected") cleanupErrors.push(result.reason);
        }
      }
      if (cleanupErrors.length) {
        console.error(
          new AggregateError(cleanupErrors, "Could not destroy every managed test sandbox"),
        );
        process.exitCode = 1;
      }
    }
  } finally {
    await container.stop().catch(() => undefined);
  }
}

type AppHandles = Awaited<ReturnType<typeof createApp>>;

async function managedComputers(handles: AppHandles) {
  if (!["e2b", "daytona", "box"].includes(sandboxProvider)) return [];
  return handles.prisma.computer.findMany({
    where: { providerRef: { not: null } },
    select: { homeKey: true, kind: true, providerRef: true, userId: true, spaceId: true },
  });
}

async function writeSummary(reportDir: string, summary: Record<string, unknown>) {
  await writeFile(
    path.join(reportDir, "summary.json"),
    JSON.stringify({ ...summary, at: new Date().toISOString() }, null, 2),
  );
}

async function waitForHealth(url: string, ms: number) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < ms) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = `${res.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`API health check failed for ${url}: ${last}`);
}

interface ServeModelFixture {
  baseUrl: string;
  modelId: string;
  apiKey: string;
  requestLogPath: string;
  assertComplete(): void;
  close(): Promise<void>;
}

const SERVE_MODEL_ID = "offline-fixture";
const SERVE_MODEL_API_KEY = "rk-fixture-model-key";
const SERVE_CREATED_REPLY = "Ready. Tell me what to remember or work on first.";
const SERVE_FIRST_REPLY = "Noted: the project codename is MARIGOLD-773.";
const SERVE_RECALL_REPLY = "From memory: the project codename is MARIGOLD-773.";

async function startServeModelFixture(reportDir: string): Promise<ServeModelFixture> {
  const requestLogPath = path.join(reportDir, "serve-model-requests.json");
  const requests: ModelEmulatorRequest[] = [];
  const record = async (request: ModelEmulatorRequest) => {
    requests.push(request);
    await writeFile(requestLogPath, JSON.stringify(requests, null, 2));
  };
  await writeFile(requestLogPath, "[]");
  const emulator = await startModelEmulator({
    modelId: SERVE_MODEL_ID,
    apiKey: SERVE_MODEL_API_KEY,
    steps: [
      { expect: record, response: { type: "text", text: SERVE_CREATED_REPLY } },
      { expect: record, response: { type: "text", text: SERVE_FIRST_REPLY } },
      {
        expect: async (request) => {
          await record(request);
          assert.ok(
            JSON.stringify(request.messages).includes(RECALLED_MEMORY_PREFIX),
            "The follow-up model request did not include recalled memory",
          );
        },
        response: { type: "text", text: SERVE_RECALL_REPLY },
      },
    ],
  });
  return {
    baseUrl: emulator.baseUrl,
    modelId: SERVE_MODEL_ID,
    apiKey: SERVE_MODEL_API_KEY,
    requestLogPath,
    assertComplete: () => emulator.assertComplete(),
    close: () => emulator.close(),
  };
}

function printServeInstructions(input: {
  webOrigin: string;
  apiOrigin: string;
  databaseUrl: string;
  hindsightOrigin: string;
  controlToken: string;
  fixtureId: string;
  fixtureKey: string;
  model: ServeModelFixture | undefined;
}) {
  const control = `${input.hindsightOrigin}${HINDSIGHT_FIXTURE_CONTROL_PATH}`;
  const token = `-H '${HINDSIGHT_FIXTURE_TOKEN_HEADER}: ${input.controlToken}'`;
  const lines = [
    "",
    "Rakazo e2e harness is serving (fake sandbox, test-only fixtures).",
    `  Web:      ${input.webOrigin}  (sign up at ${input.webOrigin}/sign-up)`,
    `  API:      ${input.apiOrigin}`,
    `  Database: ${input.databaseUrl}`,
    `  Hindsight Cloud fixture API key: ${input.fixtureKey}  (fixture ${input.fixtureId}, 3 banks)`,
    "  Create another isolated Hindsight fixture:",
    `    curl -sS -X POST ${control} -H 'content-type: application/json' ${token} -d '{"seedBanks":60}'`,
    "  Inspect a fixture (banks, documents, operations, requests):",
    `    curl -sS ${control}/<fixture-id> ${token}`,
  ];
  if (input.model) {
    lines.push(
      "  Model fixture: onboarding Connect a model (or Settings → Models) → OpenAI-compatible",
      `    Server URL ${input.model.baseUrl}, Model id ${input.model.modelId} (type it), API key ${input.model.apiKey}`,
      `    Scripted turns: 1) the new bot's first reply → "${SERVE_CREATED_REPLY}"`,
      `                    2) your first message → "${SERVE_FIRST_REPLY}"`,
      `                    3) a follow-up whose request must carry recalled memory → "${SERVE_RECALL_REPLY}"`,
      `    Model requests are written to ${input.model.requestLogPath}`,
    );
  }
  lines.push("Press Ctrl-C to stop.", "");
  console.log(lines.join("\n"));
}

function waitForStopSignal(child: ChildProcess) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      child.off("exit", exited);
    };
    const stop = () => {
      cleanup();
      resolve();
    };
    const exited = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Web dev server exited (${signal ?? code})`));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    child.once("exit", exited);
    if (child.exitCode !== null || child.signalCode !== null) exited(child.exitCode, child.signalCode);
  });
}

async function stopProcessGroup(child: ChildProcess) {
  const pid = child.pid;
  if (pid === undefined) return;
  const signalGroup = (signal: NodeJS.Signals | 0) => {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      return false;
    }
  };
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    signalGroup("SIGTERM");
    const timer = setTimeout(() => signalGroup("SIGKILL"), 10_000);
    await exited;
    clearTimeout(timer);
  }
  const deadline = Date.now() + 5_000;
  while (signalGroup(0) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  signalGroup("SIGKILL");
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
