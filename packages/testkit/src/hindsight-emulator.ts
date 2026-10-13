import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const CLOUD_ORIGIN = "https://api.hindsight.vectorize.io";
const MAX_API_BODY = 2 * 1024 * 1024;
const MAX_CONTROL_BODY = 1024 * 1024;
const MAX_SEED_BANKS = 5000;
const RECALL_LIMIT = 10;
const DISPOSITION = { skepticism: 3, literalism: 3, empathy: 3 };
const WORD = /[\p{L}\p{N}]+/gu;

export const HINDSIGHT_FIXTURE_CONTROL_PATH = "/__e2e/hindsight/fixtures";
export const HINDSIGHT_FIXTURE_TOKEN_HEADER = "x-rakazo-fixture-token";
export const HINDSIGHT_EMULATOR_DETAIL = "hindsight-emulator-detail";

export const HINDSIGHT_OPERATION_STATUSES = [
  "pending",
  "processing",
  "completed",
  "failed",
  "cancelled",
  "not_found",
] as const;
export type HindsightOperationStatus = (typeof HINDSIGHT_OPERATION_STATUSES)[number];

export const HINDSIGHT_ROUTES = ["list", "profile", "create", "recall", "retain", "status"] as const;
export type HindsightRoute = (typeof HINDSIGHT_ROUTES)[number];

export interface HindsightKeyPermissions {
  list: boolean;
  create: boolean;
  banks: string[] | "*";
}

export interface HindsightKeyOptions {
  label?: string;
  list?: boolean;
  create?: boolean;
  banks?: string[] | "*";
}

export interface HindsightFixtureKey {
  label: string;
  apiKey: string;
  permissions: HindsightKeyPermissions;
}

export interface HindsightDocumentSeed {
  documentId?: string;
  content: string;
  context?: string | null;
  metadata?: Record<string, string>;
  timestamp?: string | null;
}

export interface HindsightBankSeed {
  bankId: string;
  name?: string | null;
  displayAlias?: string | null;
  documents?: HindsightDocumentSeed[];
}

export interface HindsightFailure {
  status: number;
  retryAfter?: string | number;
}

export interface HindsightFixtureOptions {
  keys?: HindsightKeyOptions[];
  banks?: HindsightBankSeed[];
  seedBanks?: number;
  operationStatuses?: HindsightOperationStatus[];
  operationSequences?: HindsightOperationStatus[][];
  failures?: Array<HindsightFailure & { route: HindsightRoute }>;
  dropAcknowledgements?: HindsightRoute[];
}

export interface HindsightRecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  keyLabel: string;
  route: HindsightRoute | null;
  bankId: string | null;
  status: number;
  acknowledged: boolean;
}

export interface HindsightDocumentSnapshot {
  documentId: string;
  factId: string;
  content: string;
  context: string | null;
  metadata: Record<string, string>;
  timestamp: string | null;
}

export interface HindsightFixtureSnapshot {
  id: string;
  keys: HindsightFixtureKey[];
  banks: Array<{
    bankId: string;
    name: string | null;
    displayAlias: string | null;
    documents: HindsightDocumentSnapshot[];
  }>;
  operations: Array<{
    operationId: string;
    bankId: string;
    status: HindsightOperationStatus;
    statuses: HindsightOperationStatus[];
    documentIds: string[];
  }>;
  requests: HindsightRecordedRequest[];
}

export interface HindsightFixture {
  readonly id: string;
  readonly apiKey: string;
  readonly keys: HindsightFixtureKey[];
  readonly requests: readonly HindsightRecordedRequest[];
  issueKey(options?: HindsightKeyOptions): HindsightFixtureKey;
  addBank(seed: HindsightBankSeed): void;
  removeBank(bankId: string): boolean;
  seedBanks(count: number, prefix?: string): string[];
  queueFailure(route: HindsightRoute, failure: HindsightFailure): void;
  dropAcknowledgement(route?: HindsightRoute): void;
  queueOperationStatuses(statuses: HindsightOperationStatus[]): void;
  setOperationStatuses(statuses: HindsightOperationStatus[]): void;
  snapshot(): HindsightFixtureSnapshot;
}

export interface HindsightEmulator {
  origin: string;
  controlToken: string;
  createFixture(options?: HindsightFixtureOptions): HindsightFixture;
  getFixture(id: string): HindsightFixture | undefined;
  disposeFixture(id: string): boolean;
  fetch: typeof globalThis.fetch;
  close(): Promise<void>;
}

interface BankState {
  bankId: string;
  name: string | null;
  displayAlias: string | null;
  createdAt: string;
  updatedAt: string;
  documents: Map<string, HindsightDocumentSnapshot>;
}

interface PendingItem {
  documentId: string;
  content: string;
  context: string | null;
  metadata: Record<string, string>;
  timestamp: string | null;
  append: boolean;
}

interface OperationState {
  operationId: string;
  bankId: string;
  statuses: HindsightOperationStatus[];
  index: number;
  status: HindsightOperationStatus;
  items: PendingItem[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  settled: boolean;
}

interface FixtureState {
  id: string;
  keys: HindsightFixtureKey[];
  banks: Map<string, BankState>;
  operations: Map<string, OperationState>;
  requests: HindsightRecordedRequest[];
  failures: Array<HindsightFailure & { route: HindsightRoute }>;
  drops: HindsightRoute[];
  defaultStatuses: HindsightOperationStatus[];
  sequences: HindsightOperationStatus[][];
  counter: number;
  seeded: number;
}

interface KeyGrant {
  fixtureId: string;
  key: HindsightFixtureKey;
}

interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface MatchedRoute {
  name: HindsightRoute;
  bankId: string | null;
  operationId: string | null;
}

type ParsedJson = { ok: true; value: unknown } | { ok: false };

export async function startHindsightEmulator(
  options: { allowedOrigin?: string; now?: () => Date } = {},
): Promise<HindsightEmulator> {
  const now = options.now ?? (() => new Date());
  const controlToken = randomBytes(32).toString("base64url");
  const fixtures = new Map<string, FixtureState>();
  const grants = new Map<string, KeyGrant>();
  const timestamp = () => now().toISOString();

  function issueKey(state: FixtureState, input: HindsightKeyOptions): HindsightFixtureKey {
    const parsed = parseKeyOptions(input, "key");
    const label = parsed.label ?? (state.keys.length ? `key-${state.keys.length + 1}` : "default");
    if (state.keys.some((key) => key.label === label)) invalid(`duplicate key label ${label}`);
    const key: HindsightFixtureKey = {
      label,
      apiKey: `hsk_fixture_${randomBytes(16).toString("hex")}`,
      permissions: {
        list: parsed.list ?? true,
        create: parsed.create ?? true,
        banks: parsed.banks === undefined || parsed.banks === "*" ? "*" : [...parsed.banks],
      },
    };
    state.keys.push(key);
    grants.set(key.apiKey, { fixtureId: state.id, key });
    return copyKey(key);
  }

  function addBank(state: FixtureState, input: HindsightBankSeed) {
    const seed = parseBankSeed(input, "bank");
    if (state.banks.has(seed.bankId)) invalid(`duplicate bank ${seed.bankId}`);
    const at = timestamp();
    const bank: BankState = {
      bankId: seed.bankId,
      name: seed.name ?? null,
      displayAlias: seed.displayAlias ?? null,
      createdAt: at,
      updatedAt: at,
      documents: new Map(),
    };
    state.banks.set(bank.bankId, bank);
    applyItems(
      state,
      bank,
      (seed.documents ?? []).map((document) => ({
        documentId: document.documentId ?? `doc-${++state.counter}`,
        content: document.content,
        context: document.context ?? null,
        metadata: { ...document.metadata },
        timestamp: document.timestamp ?? null,
        append: false,
      })),
    );
  }

  function seedBanks(state: FixtureState, count: number, prefix = "fixture-bank") {
    const total = parseCount(count, "seedBanks");
    if (typeof prefix !== "string" || !prefix) invalid("seedBanks prefix");
    const ids: string[] = [];
    for (let index = 0; index < total; index++) {
      const ordinal = String(++state.seeded).padStart(3, "0");
      const bankId = `${prefix}-${ordinal}`;
      addBank(state, { bankId, name: `Fixture bank ${ordinal}` });
      ids.push(bankId);
    }
    return ids;
  }

  function applyItems(state: FixtureState, bank: BankState, items: PendingItem[]) {
    for (const item of items) {
      const prior = bank.documents.get(item.documentId);
      bank.documents.delete(item.documentId);
      bank.documents.set(item.documentId, {
        documentId: item.documentId,
        factId: `fact-${++state.counter}`,
        content: item.append && prior ? `${prior.content}\n${item.content}` : item.content,
        context: item.context,
        metadata: { ...item.metadata },
        timestamp: item.timestamp,
      });
    }
    if (items.length) bank.updatedAt = timestamp();
  }

  function createFixture(input: HindsightFixtureOptions = {}): HindsightFixture {
    const parsed = parseFixtureOptions(input);
    const state: FixtureState = {
      id: `fixture_${randomBytes(12).toString("hex")}`,
      keys: [],
      banks: new Map(),
      operations: new Map(),
      requests: [],
      failures: parsed.failures,
      drops: parsed.dropAcknowledgements,
      defaultStatuses: parsed.operationStatuses,
      sequences: parsed.operationSequences,
      counter: 0,
      seeded: 0,
    };
    try {
      for (const key of parsed.keys.length ? parsed.keys : [{}]) issueKey(state, key);
      for (const bank of parsed.banks) addBank(state, bank);
      seedBanks(state, parsed.seedBanks);
    } catch (error) {
      for (const key of state.keys) grants.delete(key.apiKey);
      throw error;
    }
    fixtures.set(state.id, state);
    return handle(state);
  }

  function handle(state: FixtureState): HindsightFixture {
    return {
      id: state.id,
      get apiKey() {
        return state.keys[0]?.apiKey ?? "";
      },
      get keys() {
        return state.keys.map(copyKey);
      },
      get requests() {
        return state.requests;
      },
      issueKey: (input = {}) => issueKey(state, input),
      addBank: (seed) => addBank(state, seed),
      removeBank: (bankId) => state.banks.delete(bankId),
      seedBanks: (count, prefix) => seedBanks(state, count, prefix),
      queueFailure: (route, failure) => {
        state.failures.push({ ...parseFailure(failure, "failure"), route: parseRoute(route, "route") });
      },
      dropAcknowledgement: (route = "retain") => {
        state.drops.push(parseRoute(route, "route"));
      },
      queueOperationStatuses: (statuses) => {
        state.sequences.push(parseStatuses(statuses, "statuses"));
      },
      setOperationStatuses: (statuses) => {
        state.defaultStatuses = parseStatuses(statuses, "statuses");
      },
      snapshot: () => snapshot(state),
    };
  }

  function disposeFixture(id: string) {
    const state = fixtures.get(id);
    if (!state) return false;
    for (const key of state.keys) grants.delete(key.apiKey);
    return fixtures.delete(id);
  }

  function dispatch(
    state: FixtureState,
    key: HindsightFixtureKey,
    route: MatchedRoute,
    json: ParsedJson,
    url: URL,
  ): Reply {
    const failureIndex = state.failures.findIndex((failure) => failure.route === route.name);
    if (failureIndex >= 0) {
      const [failure] = state.failures.splice(failureIndex, 1);
      return {
        ...providerError(failure?.status ?? 500, "programmed failure"),
        ...(failure?.retryAfter !== undefined
          ? { headers: { "retry-after": String(failure.retryAfter) } }
          : {}),
      };
    }
    const bankId = route.bankId ?? "";
    const { banks: scope } = key.permissions;
    const permitted =
      route.name === "list"
        ? key.permissions.list
        : (scope === "*" || scope.includes(bankId)) && (route.name !== "create" || key.permissions.create);
    if (!permitted) return providerError(403, "forbidden");
    if (route.name === "list") return listBanks(state, key, url);
    const body = json.ok && isRecord(json.value) ? json.value : null;
    if (route.name === "create") {
      if (!body || !isOptionalString(body.name)) return providerError(422, "invalid bank");
      return putBank(state, bankId, body.name ?? null);
    }
    const bank = state.banks.get(bankId);
    if (!bank) return providerError(404, "bank not found");
    if (route.name === "profile") return { status: 200, body: profile(bank) };
    if (route.name === "recall") {
      if (!body || typeof body.query !== "string") return providerError(422, "invalid recall");
      return { status: 200, body: { results: recall(bank, body.query) } };
    }
    if (route.name === "retain") return body ? retain(state, bank, body) : providerError(422, "invalid retain");
    return operationStatus(state, bank, route.operationId ?? "");
  }

  function listBanks(state: FixtureState, key: HindsightFixtureKey, url: URL): Reply {
    const limit = intParam(url, "limit", 100);
    const offset = intParam(url, "offset", 0);
    if (limit === null || limit < 1 || limit > 1000 || offset === null) {
      return providerError(422, "invalid paging");
    }
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const matches = [...state.banks.values()].filter(
      (bank) =>
        (key.permissions.banks === "*" || key.permissions.banks.includes(bank.bankId)) &&
        (!q || bank.bankId.toLowerCase().includes(q) || (bank.name ?? "").toLowerCase().includes(q)),
    );
    return {
      status: 200,
      body: {
        banks: matches.slice(offset, offset + limit).map((bank) => ({
          bank_id: bank.bankId,
          name: bank.name,
          disposition: DISPOSITION,
          mission: null,
          created_at: bank.createdAt,
          updated_at: bank.updatedAt,
          fact_count: bank.documents.size,
          last_document_at: null,
          last_write_at: null,
          display_alias: bank.displayAlias,
          matched_aliases: [],
        })),
        total: matches.length,
        limit,
        offset,
      },
    };
  }

  function putBank(state: FixtureState, bankId: string, name: string | null): Reply {
    const existing = state.banks.get(bankId);
    if (existing) {
      if (name !== null) {
        existing.name = name;
        existing.updatedAt = timestamp();
      }
      return { status: 200, body: profile(existing) };
    }
    const at = timestamp();
    const bank: BankState = {
      bankId,
      name,
      displayAlias: null,
      createdAt: at,
      updatedAt: at,
      documents: new Map(),
    };
    state.banks.set(bankId, bank);
    return { status: 200, body: profile(bank) };
  }

  function retain(state: FixtureState, bank: BankState, body: Record<string, unknown>): Reply {
    const { items, operation_id: operationId, async: isAsync } = body;
    if (!Array.isArray(items) || items.length === 0) return providerError(422, "invalid items");
    if (!isOptionalString(operationId) || (isAsync !== undefined && typeof isAsync !== "boolean")) {
      return providerError(422, "invalid retain");
    }
    const existing = operationId ? state.operations.get(operationId) : undefined;
    if (existing && existing.bankId !== bank.bankId) return providerError(409, "operation conflict");
    const pending: PendingItem[] = [];
    for (const item of items) {
      if (!isRecord(item) || typeof item.content !== "string") return providerError(422, "invalid item");
      const { document_id: documentId, context, timestamp: occurredAt, metadata, update_mode: mode } = item;
      if (!isOptionalString(documentId) || !isOptionalString(context) || !isOptionalString(occurredAt)) {
        return providerError(422, "invalid item");
      }
      if (metadata !== undefined && metadata !== null && !isStringRecord(metadata)) {
        return providerError(422, "invalid metadata");
      }
      if (mode !== undefined && mode !== null && mode !== "replace" && mode !== "append") {
        return providerError(422, "invalid update mode");
      }
      pending.push({
        documentId: documentId ?? `doc-${++state.counter}`,
        content: item.content,
        context: context ?? null,
        metadata: { ...(metadata ?? {}) },
        timestamp: occurredAt ?? null,
        append: mode === "append",
      });
    }
    if (isAsync !== true && !existing) {
      applyItems(state, bank, pending);
      return {
        status: 200,
        body: { success: true, bank_id: bank.bankId, items_count: pending.length, async: false, operation_id: null },
      };
    }
    const at = timestamp();
    const operation: OperationState = existing ?? {
      operationId: operationId ?? randomUUID(),
      bankId: bank.bankId,
      statuses: [...(state.sequences.shift() ?? state.defaultStatuses)],
      index: 0,
      status: "pending",
      items: pending,
      createdAt: at,
      updatedAt: at,
      completedAt: null,
      settled: false,
    };
    state.operations.set(operation.operationId, operation);
    return {
      status: 200,
      body: {
        success: true,
        bank_id: operation.bankId,
        items_count: operation.items.length,
        async: true,
        operation_id: operation.operationId,
      },
    };
  }

  function operationStatus(state: FixtureState, bank: BankState, operationId: string): Reply {
    const operation = state.operations.get(operationId);
    if (!operation || operation.bankId !== bank.bankId) return providerError(404, "operation not found");
    const next =
      operation.statuses[Math.min(operation.index, operation.statuses.length - 1)] ?? "completed";
    operation.index++;
    operation.status = next;
    operation.updatedAt = timestamp();
    if (!operation.settled && next === "completed") {
      operation.settled = true;
      operation.completedAt = operation.updatedAt;
      applyItems(state, bank, operation.items);
    } else if (!operation.settled && (next === "failed" || next === "cancelled")) {
      operation.settled = true;
    }
    return {
      status: 200,
      body: {
        operation_id: operation.operationId,
        status: next,
        operation_type: "retain",
        created_at: operation.createdAt,
        updated_at: operation.updatedAt,
        completed_at: operation.completedAt,
        error_message: next === "failed" ? `${HINDSIGHT_EMULATOR_DETAIL}: operation failed` : null,
        retry_count: 0,
        next_retry_at: null,
        progress: null,
        result_metadata: null,
        details: null,
        child_operations: null,
        task_payload: null,
      },
    };
  }

  async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL) {
    const raw = await readBody(request, MAX_API_BODY);
    const bearer = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "");
    const grant = grants.get(bearer?.[1] ?? "");
    const state = grant ? fixtures.get(grant.fixtureId) : undefined;
    if (!grant || !state) return send(response, providerError(401, "invalid api key"));
    if (raw === null) return send(response, providerError(413, "payload too large"));
    const json = parseJson(raw);
    const route = matchRoute(request.method ?? "", url.pathname);
    const entry: HindsightRecordedRequest = {
      method: request.method ?? "",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: json.ok ? json.value : null,
      keyLabel: grant.key.label,
      route: route?.name ?? null,
      bankId: route?.bankId ?? null,
      status: 0,
      acknowledged: false,
    };
    state.requests.push(entry);
    const reply = route ? dispatch(state, grant.key, route, json, url) : providerError(404, "not found");
    entry.status = reply.status;
    const dropIndex = route && reply.status < 300 ? state.drops.indexOf(route.name) : -1;
    if (dropIndex >= 0) {
      state.drops.splice(dropIndex, 1);
      response.destroy();
      return;
    }
    entry.acknowledged = true;
    send(response, reply);
  }

  async function handleControl(request: IncomingMessage, response: ServerResponse, url: URL) {
    const origin = request.headers.origin;
    const peer = request.socket.remoteAddress ?? "";
    if (peer !== "::1" && !/^(::ffff:)?127\./.test(peer)) return send(response, controlError(403, "forbidden"));
    if (origin !== undefined && origin !== options.allowedOrigin) {
      return send(response, controlError(403, "forbidden"));
    }
    const cors: Record<string, string> = origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {};
    const segments = url.pathname.slice(HINDSIGHT_FIXTURE_CONTROL_PATH.length).split("/").filter(Boolean);
    const fixtureId = segments[0];
    if (segments.length > 1 || (url.pathname.endsWith("/") && !fixtureId)) {
      return send(response, { ...controlError(404, "not found"), headers: cors });
    }
    const method = request.method ?? "";
    if (method === "OPTIONS") {
      return send(response, {
        status: 204,
        headers: {
          ...cors,
          "access-control-allow-methods": fixtureId ? "GET, DELETE" : "POST",
          "access-control-allow-headers": `content-type, ${HINDSIGHT_FIXTURE_TOKEN_HEADER}`,
        },
      });
    }
    if (!tokenMatches(request.headers[HINDSIGHT_FIXTURE_TOKEN_HEADER], controlToken)) {
      return send(response, { ...controlError(401, "unauthorized"), headers: cors });
    }
    const mediaType = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
    if ((method === "POST" || method === "DELETE") && mediaType !== "application/json") {
      return send(response, { ...controlError(415, "json required"), headers: cors });
    }
    const raw = await readBody(request, MAX_CONTROL_BODY);
    if (raw === null) return send(response, { ...controlError(413, "payload too large"), headers: cors });
    if (!fixtureId) {
      if (method !== "POST") return send(response, { ...controlError(405, "method not allowed"), headers: cors });
      const json = raw.length ? parseJson(raw) : { ok: true as const, value: {} };
      if (!json.ok) return send(response, { ...controlError(400, "invalid json"), headers: cors });
      let fixture: HindsightFixture;
      try {
        fixture = createFixture(json.value as HindsightFixtureOptions);
      } catch (error) {
        const message = error instanceof FixtureOptionsError ? error.message : "invalid fixture";
        return send(response, { ...controlError(400, message), headers: cors });
      }
      return send(response, {
        status: 201,
        body: { id: fixture.id, apiKey: fixture.apiKey, keys: fixture.keys },
        headers: cors,
      });
    }
    const state = fixtures.get(fixtureId);
    if (method === "GET") {
      return send(
        response,
        state ? { status: 200, body: snapshot(state), headers: cors } : { ...controlError(404, "not found"), headers: cors },
      );
    }
    if (method === "DELETE") {
      return send(
        response,
        disposeFixture(fixtureId)
          ? { status: 200, body: { ok: true }, headers: cors }
          : { ...controlError(404, "not found"), headers: cors },
      );
    }
    return send(response, { ...controlError(405, "method not allowed"), headers: cors });
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const control =
      url.pathname === HINDSIGHT_FIXTURE_CONTROL_PATH ||
      url.pathname.startsWith(`${HINDSIGHT_FIXTURE_CONTROL_PATH}/`);
    void (control ? handleControl(request, response, url) : handleApi(request, response, url)).catch(() => {
      if (response.headersSent) response.destroy();
      else send(response, providerError(500, "emulator failure"));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const upstream = globalThis.fetch;

  const fetchThroughEmulator: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.origin !== CLOUD_ORIGIN ||
      url.username ||
      url.password ||
      url.pathname === "/__e2e" ||
      url.pathname.startsWith("/__e2e/")
    ) {
      throw new TypeError("Hindsight emulator refused a destination outside Hindsight Cloud");
    }
    const body =
      request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    return upstream(`${origin}${url.pathname}${url.search}`, {
      method: request.method,
      headers: request.headers,
      body,
      redirect: request.redirect,
      signal: request.signal,
    });
  };

  return {
    origin,
    controlToken,
    createFixture,
    getFixture(id) {
      const state = fixtures.get(id);
      return state ? handle(state) : undefined;
    },
    disposeFixture,
    fetch: fetchThroughEmulator,
    async close() {
      for (const id of [...fixtures.keys()]) disposeFixture(id);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

class FixtureOptionsError extends Error {}

function invalid(path: string): never {
  throw new FixtureOptionsError(`Invalid Hindsight fixture option: ${path}`);
}

interface NormalizedFixtureOptions {
  keys: HindsightKeyOptions[];
  banks: HindsightBankSeed[];
  seedBanks: number;
  operationStatuses: HindsightOperationStatus[];
  operationSequences: HindsightOperationStatus[][];
  failures: Array<HindsightFailure & { route: HindsightRoute }>;
  dropAcknowledgements: HindsightRoute[];
}

function parseFixtureOptions(value: unknown): NormalizedFixtureOptions {
  const input = parseRecord(value, "options", [
    "keys",
    "banks",
    "seedBanks",
    "operationStatuses",
    "operationSequences",
    "failures",
    "dropAcknowledgements",
  ]);
  return {
    keys: parseArray(input.keys, "keys", parseKeyOptions),
    banks: parseArray(input.banks, "banks", parseBankSeed),
    seedBanks: input.seedBanks === undefined ? 0 : parseCount(input.seedBanks, "seedBanks"),
    operationStatuses:
      input.operationStatuses === undefined
        ? ["completed"]
        : parseStatuses(input.operationStatuses, "operationStatuses"),
    operationSequences: parseArray(input.operationSequences, "operationSequences", parseStatuses),
    failures: parseArray(input.failures, "failures", (entry, path) => ({
      ...parseFailure(entry, path, ["route", "status", "retryAfter"]),
      route: parseRoute((entry as Record<string, unknown>).route, `${path}.route`),
    })),
    dropAcknowledgements: parseArray(input.dropAcknowledgements, "dropAcknowledgements", parseRoute),
  };
}

function parseKeyOptions(value: unknown, path: string): HindsightKeyOptions {
  const input = parseRecord(value, path, ["label", "list", "create", "banks"]);
  const { label, list, create, banks } = input;
  if (label !== undefined && (typeof label !== "string" || !label || label.length > 64)) invalid(`${path}.label`);
  if (list !== undefined && typeof list !== "boolean") invalid(`${path}.list`);
  if (create !== undefined && typeof create !== "boolean") invalid(`${path}.create`);
  if (banks !== undefined && banks !== "*" && !(Array.isArray(banks) && banks.every(isBankId))) {
    invalid(`${path}.banks`);
  }
  return {
    ...(label !== undefined ? { label } : {}),
    ...(list !== undefined ? { list } : {}),
    ...(create !== undefined ? { create } : {}),
    ...(banks !== undefined ? { banks: banks === "*" ? "*" : [...(banks as string[])] } : {}),
  };
}

function parseBankSeed(value: unknown, path: string): HindsightBankSeed {
  const input = parseRecord(value, path, ["bankId", "name", "displayAlias", "documents"]);
  const { bankId, name, displayAlias } = input;
  if (!isBankId(bankId)) invalid(`${path}.bankId`);
  if (!isOptionalString(name)) invalid(`${path}.name`);
  if (!isOptionalString(displayAlias)) invalid(`${path}.displayAlias`);
  return {
    bankId,
    name: name ?? null,
    displayAlias: displayAlias ?? null,
    documents: parseArray(input.documents, `${path}.documents`, (entry, entryPath) => {
      const document = parseRecord(entry, entryPath, ["documentId", "content", "context", "metadata", "timestamp"]);
      const { documentId, content, context, metadata, timestamp } = document;
      if (documentId !== undefined && !isBankId(documentId)) invalid(`${entryPath}.documentId`);
      if (typeof content !== "string") invalid(`${entryPath}.content`);
      if (!isOptionalString(context)) invalid(`${entryPath}.context`);
      if (!isOptionalString(timestamp)) invalid(`${entryPath}.timestamp`);
      if (metadata !== undefined && !isStringRecord(metadata)) invalid(`${entryPath}.metadata`);
      return {
        ...(documentId !== undefined ? { documentId } : {}),
        content,
        context: context ?? null,
        metadata: { ...(metadata ?? {}) },
        timestamp: timestamp ?? null,
      };
    }),
  };
}

function parseFailure(value: unknown, path: string, keys = ["status", "retryAfter"]): HindsightFailure {
  const { status, retryAfter } = parseRecord(value, path, keys);
  if (typeof status !== "number" || !Number.isInteger(status) || status < 400 || status > 599) {
    invalid(`${path}.status`);
  }
  if (retryAfter === undefined) return { status };
  if (
    typeof retryAfter === "string" ||
    (typeof retryAfter === "number" && Number.isInteger(retryAfter) && retryAfter >= 0)
  ) {
    return { status, retryAfter };
  }
  invalid(`${path}.retryAfter`);
}

function parseRoute(value: unknown, path: string): HindsightRoute {
  if (!HINDSIGHT_ROUTES.includes(value as HindsightRoute)) invalid(path);
  return value as HindsightRoute;
}

function parseStatuses(value: unknown, path: string): HindsightOperationStatus[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((status) => HINDSIGHT_OPERATION_STATUSES.includes(status as HindsightOperationStatus))
  ) {
    invalid(path);
  }
  return [...(value as HindsightOperationStatus[])];
}

function parseCount(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_SEED_BANKS) invalid(path);
  return value;
}

function parseArray<T>(value: unknown, path: string, parse: (entry: unknown, path: string) => T): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid(path);
  return value.map((entry, index) => parse(entry, `${path}[${index}]`));
}

function parseRecord(value: unknown, path: string, allowed: string[]): Record<string, unknown> {
  if (!isRecord(value)) invalid(path);
  const unknownKey = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknownKey !== undefined) invalid(`${path}.${unknownKey}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isOptionalString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function isBankId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 255;
}

function copyKey(key: HindsightFixtureKey): HindsightFixtureKey {
  const { banks } = key.permissions;
  return { ...key, permissions: { ...key.permissions, banks: banks === "*" ? "*" : [...banks] } };
}

function snapshot(state: FixtureState): HindsightFixtureSnapshot {
  return {
    id: state.id,
    keys: state.keys.map(copyKey),
    banks: [...state.banks.values()].map((bank) => ({
      bankId: bank.bankId,
      name: bank.name,
      displayAlias: bank.displayAlias,
      documents: [...bank.documents.values()].map((document) => ({
        ...document,
        metadata: { ...document.metadata },
      })),
    })),
    operations: [...state.operations.values()].map((operation) => ({
      operationId: operation.operationId,
      bankId: operation.bankId,
      status: operation.status,
      statuses: [...operation.statuses],
      documentIds: operation.items.map((item) => item.documentId),
    })),
    requests: structuredClone(state.requests),
  };
}

function profile(bank: BankState) {
  return {
    bank_id: bank.bankId,
    name: bank.name ?? "",
    disposition: DISPOSITION,
    mission: "",
    background: null,
  };
}

function recall(bank: BankState, query: string) {
  const terms = new Set(query.toLowerCase().match(WORD));
  if (!terms.size) return [];
  return [...bank.documents.values()]
    .map((document, order) => {
      const words = new Set(document.content.toLowerCase().match(WORD));
      let score = 0;
      for (const term of terms) if (words.has(term)) score++;
      return { document, order, score };
    })
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .slice(0, RECALL_LIMIT)
    .map(({ document }) => ({
      id: document.factId,
      text: document.content,
      type: "world",
      context: document.context,
      mentioned_at: document.timestamp,
      document_id: document.documentId,
      metadata: { ...document.metadata },
      tags: null,
      entities: null,
      scores: null,
    }));
}

function matchRoute(method: string, pathname: string): MatchedRoute | null {
  let segments: string[];
  try {
    segments = pathname.split("/").slice(1).map(decodeURIComponent);
  } catch {
    return null;
  }
  const [v1, scope, banks, bankId, resource, leaf] = segments;
  if (v1 !== "v1" || scope !== "default" || banks !== "banks") return null;
  if (segments.length === 3) return method === "GET" ? { name: "list", bankId: null, operationId: null } : null;
  if (!bankId) return null;
  const at = (name: HindsightRoute, expected: string, operationId: string | null = null): MatchedRoute | null =>
    method === expected ? { name, bankId, operationId } : null;
  if (segments.length === 4) return at("create", "PUT");
  if (segments.length === 5 && resource === "profile") return at("profile", "GET");
  if (segments.length === 5 && resource === "memories") return at("retain", "POST");
  if (segments.length === 6 && resource === "memories" && leaf === "recall") return at("recall", "POST");
  if (segments.length === 6 && resource === "operations" && leaf) return at("status", "GET", leaf);
  return null;
}

function intParam(url: URL, name: string, fallback: number) {
  const value = url.searchParams.get(name);
  if (value === null) return fallback;
  const parsed = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(parsed) ? parsed : null;
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size <= limit) chunks.push(buffer);
  }
  return size > limit ? null : Buffer.concat(chunks);
}

function parseJson(raw: Buffer): ParsedJson {
  if (!raw.length) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(raw.toString("utf8")) as unknown };
  } catch {
    return { ok: false };
  }
}

function tokenMatches(value: string | string[] | undefined, expected: string) {
  if (typeof value !== "string") return false;
  const given = Buffer.from(value);
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

function providerError(status: number, reason: string): Reply {
  return { status, body: { detail: `${HINDSIGHT_EMULATOR_DETAIL}: ${reason}` } };
}

function controlError(status: number, error: string): Reply {
  return { status, body: { error } };
}

function send(response: ServerResponse, reply: Reply) {
  response.writeHead(reply.status, {
    ...(reply.body === undefined ? {} : { "content-type": "application/json" }),
    ...reply.headers,
  });
  response.end(reply.body === undefined ? undefined : JSON.stringify(reply.body));
}
