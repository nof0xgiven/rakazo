import { afterEach, describe, expect, it, vi } from "vitest";
import type { HindsightRetainInput } from "./hindsight-client.js";
import {
  boundRecallQuery,
  HINDSIGHT_CLOUD_ORIGIN,
  HindsightClient,
  normalizeHindsightApiKey,
  validateHindsightBankId,
} from "./hindsight-client.js";

const KEY = "hsk_test_fixture+/= secret";
const KEY_FORMS = [
  KEY,
  Buffer.from(KEY).toString("base64"),
  Buffer.from(KEY).toString("base64url"),
  encodeURIComponent(KEY),
];
const OPERATION_ID = "6f1c2a4e-8b3d-4f5a-9c7e-1d2b3c4d5e6f";

interface Call {
  url: URL;
  init: RequestInit;
  body: unknown;
}

function harness(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const call = {
      url: new URL(String(input)),
      init,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return respond(call);
  };
  return { client: new HindsightClient({ apiKey: KEY, fetch }), calls };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

const RETAIN_INPUT = {
  content: "User 2026-10-13T00:00:00.000Z:\nI like marigolds.",
  documentId: "rakazo-doc-1",
  timestamp: "2026-10-13T00:00:00.000Z",
  context: "Rakazo conversation",
  metadata: { space_id: "space-1", bot_id: "bot-1", run_id: "run-1", source_key: "conversation" },
  operationId: OPERATION_ID,
};

function retainInput(overrides: Record<string, unknown> = {}): HindsightRetainInput {
  return JSON.parse(JSON.stringify({ ...RETAIN_INPUT, ...overrides }));
}

const acceptedRetain = {
  success: true,
  bank_id: "bank-1",
  items_count: 1,
  async: true,
  operation_id: OPERATION_ID,
};

function expectNoKey(value: unknown) {
  const text = JSON.stringify(value);
  for (const form of KEY_FORMS) expect(text).not.toContain(form);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("HindsightClient transport", () => {
  it("targets the fixed Cloud origin with Bearer auth and refuses redirects", async () => {
    const { client, calls } = harness(() => json({ bank_id: "bank-1", name: "Notes" }));

    await expect(client.getBankProfile("bank-1")).resolves.toEqual({
      ok: true,
      value: { bankId: "bank-1", name: "Notes" },
    });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url.origin).toBe(HINDSIGHT_CLOUD_ORIGIN);
    expect(call?.url.pathname).toBe("/v1/default/banks/bank-1/profile");
    expect(call?.init.method).toBe("GET");
    expect(call?.init.redirect).toBe("error");
    expect(new Headers(call?.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("encodes bank and operation IDs as single path segments", async () => {
    const { client, calls } = harness((call) =>
      call.url.pathname.includes("/operations/")
        ? json({ operation_id: "op/1?x", status: "pending" })
        : json({ bank_id: "team/a b?#", name: "Team" }),
    );

    await client.getBankProfile("  team/a b?#  ");
    await client.operationStatus("team/a b?#", "op/1?x");

    expect(calls.map((call) => call.url.href)).toEqual([
      `${HINDSIGHT_CLOUD_ORIGIN}/v1/default/banks/team%2Fa%20b%3F%23/profile`,
      `${HINDSIGHT_CLOUD_ORIGIN}/v1/default/banks/team%2Fa%20b%3F%23/operations/op%2F1%3Fx`,
    ]);
  });

  it.each([
    "",
    "   ",
    ".",
    "..",
    "bank\u0000id",
    "bank\u007fid",
    "x".repeat(256),
    "\ud800",
  ])("rejects invalid bank ID %j without a request", async (bankId) => {
    const { client, calls } = harness(() => json({}));

    expect(validateHindsightBankId(bankId)).toBeNull();
    await expect(client.getBankProfile(bankId)).resolves.toEqual({
      ok: false,
      code: "invalid_request",
    });
    await expect(client.recall(bankId, { query: "hi" })).resolves.toEqual({
      ok: false,
      code: "invalid_request",
    });
    expect(calls).toHaveLength(0);
  });

  it("normalizes API keys and treats an unusable key as unauthorized without a request", async () => {
    expect(normalizeHindsightApiKey("  hsk_test_fixture  ")).toBe("hsk_test_fixture");
    expect(normalizeHindsightApiKey("")).toBeNull();
    expect(normalizeHindsightApiKey("hsk\ntest")).toBeNull();
    expect(normalizeHindsightApiKey("k".repeat(4097))).toBeNull();

    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new HindsightClient({ apiKey: "  ", fetch });
    await expect(client.getBankProfile("bank-1")).resolves.toEqual({
      ok: false,
      code: "unauthorized",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("times out a request whose fetch never settles", async () => {
    vi.useFakeTimers();
    const { client } = harness(() => new Promise<Response>(() => undefined));

    const pending = client.getBankProfile("bank-1");
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(pending).resolves.toEqual({ ok: false, code: "timeout" });
  });

  it("applies the deadline to response body reading", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const { client } = harness(
      () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        ),
    );

    const pending = client.getBankProfile("bank-1");
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(pending).resolves.toEqual({ ok: false, code: "timeout" });
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it("reports caller cancellation as unavailable rather than a deadline timeout", async () => {
    const controller = new AbortController();
    const { client } = harness(() => new Promise<Response>(() => undefined));

    const pending = client.getBankProfile("bank-1", controller.signal);
    controller.abort();

    await expect(pending).resolves.toEqual({ ok: false, code: "unavailable" });
  });

  it("cancels response streams that exceed 1 MiB", async () => {
    let cancelled = false;
    const { client } = harness(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(256 * 1024).fill(32));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        ),
    );

    await expect(client.getBankProfile("bank-1")).resolves.toEqual({
      ok: false,
      code: "invalid_response",
    });
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it("rejects and cancels a declared oversized response", async () => {
    let cancelled = false;
    const { client } = harness(
      () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200, headers: { "content-length": String(2 * 1024 * 1024) } },
        ),
    );

    await expect(client.getBankProfile("bank-1")).resolves.toEqual({
      ok: false,
      code: "invalid_response",
    });
    expect(cancelled).toBe(true);
  });

  it("rejects request bodies over 128 KiB without a request", async () => {
    const { client, calls } = harness(() => json(acceptedRetain));

    await expect(
      client.retain("bank-1", retainInput({ content: "x".repeat(129 * 1024) })),
    ).resolves.toEqual({ ok: false, code: "invalid_request" });
    expect(calls).toHaveLength(0);
  });

  it("maps network failures to unavailable", async () => {
    const { client } = harness(() => {
      throw new TypeError(`connect failed for ${KEY}`);
    });

    const result = await client.getBankProfile("bank-1");

    expect(result).toEqual({ ok: false, code: "unavailable" });
    expectNoKey(result);
  });
});

describe("HindsightClient HTTP failures", () => {
  it.each([
    [400, "invalid_request"],
    [422, "invalid_request"],
    [401, "unauthorized"],
    [402, "quota"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "conflict"],
    [429, "rate_limited"],
    [500, "unavailable"],
    [503, "unavailable"],
  ] as const)("maps HTTP %i to %s without provider text", async (status, code) => {
    const { client } = harness(() =>
      json({ detail: `bad key ${KEY}`, error_message: "upstream secret detail" }, { status }),
    );

    const result = await client.getBankProfile("bank-1");

    expect(result).toEqual({ ok: false, code });
    expect(JSON.stringify(result)).not.toContain("upstream secret detail");
    expectNoKey(result);
  });

  it.each([
    ["120", 120_000],
    ["0", 1_000],
    ["99999999999999999999", 300_000],
    [" 7 ", 7_000],
  ])("clamps Retry-After seconds %j", async (header, retryAfterMs) => {
    const { client } = harness(() => json({}, { status: 429, headers: { "retry-after": header } }));

    await expect(client.getBankProfile("bank-1")).resolves.toEqual({
      ok: false,
      code: "rate_limited",
      retryAfterMs,
    });
  });

  it("accepts HTTP-date Retry-After values and clamps them", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date("2026-10-13T00:00:00.000Z");
    vi.setSystemTime(now);
    const headers = [
      new Date(now.getTime() + 30_000).toUTCString(),
      new Date(now.getTime() + 3_600_000).toUTCString(),
      new Date(now.getTime() - 60_000).toUTCString(),
    ];
    const { client } = harness(() =>
      json({}, { status: 503, headers: { "retry-after": headers.shift() ?? "" } }),
    );

    await expect(client.getBankProfile("bank-1")).resolves.toEqual({
      ok: false,
      code: "unavailable",
      retryAfterMs: 30_000,
    });
    await expect(client.getBankProfile("bank-1")).resolves.toEqual({
      ok: false,
      code: "unavailable",
      retryAfterMs: 300_000,
    });
    await expect(client.getBankProfile("bank-1")).resolves.toEqual({
      ok: false,
      code: "unavailable",
      retryAfterMs: 1_000,
    });
  });

  it.each(["soon", "-5", "1.5", "2026-10-13T00:00:30Z"])(
    "ignores invalid Retry-After %j",
    async (header) => {
      const { client } = harness(() =>
        json({}, { status: 429, headers: { "retry-after": header } }),
      );

      await expect(client.getBankProfile("bank-1")).resolves.toEqual({
        ok: false,
        code: "rate_limited",
      });
    },
  );
});

describe("HindsightClient bank listing", () => {
  it("sends trimmed search, limit and offset as query parameters", async () => {
    const { client, calls } = harness(() => json({ banks: [], total: 0, limit: 50, offset: 0 }));

    await client.listBanks({ q: "  alice  ", offset: 0, limit: 50 });

    expect(calls[0]?.url.pathname).toBe("/v1/default/banks");
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({
      q: "alice",
      limit: "50",
      offset: "0",
    });
  });

  it("accepts a valid empty page", async () => {
    const { client } = harness(() => json({ banks: [], total: 0, limit: 1, offset: 0 }));

    await expect(client.listBanks({ offset: 0, limit: 1 })).resolves.toEqual({
      ok: true,
      value: { banks: [], nextOffset: null },
    });
  });

  it.each([
    ["non-JSON", () => new Response("<html>", { status: 200 })],
    ["empty body", () => new Response("", { status: 200 })],
    ["missing banks", () => json({ total: 0 })],
    ["missing total", () => json({ banks: [] })],
    ["banks not an array", () => json({ banks: {}, total: 0 })],
    ["bank without ID", () => json({ banks: [{ name: "x" }], total: 1 })],
    ["bank with invalid ID", () => json({ banks: [{ bank_id: ".." }], total: 1 })],
    ["non-string name", () => json({ banks: [{ bank_id: "a", name: 7 }], total: 1 })],
    ["negative total", () => json({ banks: [], total: -1 })],
  ])("rejects a malformed page (%s) instead of returning an empty list", async (_label, respond) => {
    const { client } = harness(respond);

    await expect(client.listBanks({ offset: 0, limit: 50 })).resolves.toEqual({
      ok: false,
      code: "invalid_response",
    });
  });

  it("derives names from name, then display alias, then bank ID", async () => {
    const { client } = harness(() =>
      json({
        banks: [
          { bank_id: "a", name: " Alpha ", display_alias: "alias-a" },
          { bank_id: "b", name: null, display_alias: "Beta alias" },
          { bank_id: "c", name: "  ", display_alias: null },
          { bank_id: "d" },
        ],
        total: 4,
      }),
    );

    await expect(client.listBanks({ offset: 0, limit: 50 })).resolves.toEqual({
      ok: true,
      value: {
        banks: [
          { bankId: "a", name: "Alpha" },
          { bankId: "b", name: "Beta alias" },
          { bankId: "c", name: "c" },
          { bankId: "d", name: "d" },
        ],
        nextOffset: null,
      },
    });
  });

  it.each([
    [50, 50, 120, 100],
    [50, 50, 100, null],
    [0, 3, 10, 3],
    [10, 0, 50, null],
  ])(
    "offset %i with %i banks of total %i yields nextOffset %s",
    async (offset, count, total, nextOffset) => {
      const banks = Array.from({ length: count }, (_, index) => ({ bank_id: `bank-${index}` }));
      const { client } = harness(() => json({ banks, total }));

      const result = await client.listBanks({ offset, limit: 50 });

      expect(result.ok && result.value.nextOffset).toBe(nextOffset);
    },
  );

  it.each([
    { q: "x".repeat(201), offset: 0, limit: 50 },
    { offset: -1, limit: 50 },
    { offset: 1.5, limit: 50 },
    { offset: Number.MAX_SAFE_INTEGER + 1, limit: 50 },
    { offset: 0, limit: 51 },
    { offset: 0, limit: 0 },
  ])("rejects invalid list input %j without a request", async (request) => {
    const { client, calls } = harness(() => json({ banks: [], total: 0 }));

    await expect(client.listBanks(request)).resolves.toEqual({
      ok: false,
      code: "invalid_request",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("HindsightClient bank profile and creation", () => {
  it("rejects a profile that does not echo the requested bank", async () => {
    const { client } = harness(() => json({ bank_id: "other", name: "Other" }));

    await expect(client.getBankProfile("bank-1")).resolves.toEqual({
      ok: false,
      code: "invalid_response",
    });
  });

  it("creates with a PUT carrying only the trimmed name", async () => {
    const { client, calls } = harness(() => json({ bank_id: "rakazo-abc", name: "Team notes" }));

    await expect(client.putBank("rakazo-abc", { name: "  Team notes " })).resolves.toEqual({
      ok: true,
      value: { bankId: "rakazo-abc", name: "Team notes" },
    });
    expect(calls[0]?.init.method).toBe("PUT");
    expect(calls[0]?.url.pathname).toBe("/v1/default/banks/rakazo-abc");
    expect(calls[0]?.body).toEqual({ name: "Team notes" });
  });

  it.each(["", "   ", "n".repeat(81)])("rejects bank name %j without a request", async (name) => {
    const { client, calls } = harness(() => json({}));

    await expect(client.putBank("bank-1", { name })).resolves.toEqual({
      ok: false,
      code: "invalid_request",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("HindsightClient recall", () => {
  it("sends a bounded low-budget recall request", async () => {
    const { client, calls } = harness(() => json({ results: [] }));

    await expect(client.recall("bank-1", { query: "  marigolds?  " })).resolves.toEqual({
      ok: true,
      value: [],
    });
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/v1/default/banks/bank-1/memories/recall");
    expect(calls[0]?.body).toEqual({ query: "marigolds?", budget: "low", max_tokens: 1024 });
  });

  it("crops long queries to 450 UTF-8 bytes on a code point boundary", async () => {
    const { client, calls } = harness(() => json({ results: [] }));
    const query = `a${"😀".repeat(200)}`;
    const bounded = `a${"😀".repeat(112)}`;

    await client.recall("bank-1", { query });

    expect(boundRecallQuery(query)).toBe(bounded);
    expect(Buffer.byteLength(bounded)).toBe(449);
    expect(calls[0]?.body).toEqual({ query: bounded, budget: "low", max_tokens: 1024 });
    expect(boundRecallQuery("é".repeat(300))).toBe("é".repeat(225));
  });

  it("makes no request for an empty query", async () => {
    const { client, calls } = harness(() => json({ results: [] }));

    await expect(client.recall("bank-1", { query: "   " })).resolves.toEqual({
      ok: true,
      value: [],
    });
    expect(calls).toHaveLength(0);
  });

  it("keeps the first five ranked facts with bounded text and attribution", async () => {
    const results = [
      {
        id: "fact-0",
        text: `${"x".repeat(2047)}😀tail`,
        document_id: "rakazo-doc-1",
        metadata: { run_id: "run-1", other: "ignored" },
        mentioned_at: "2026-10-12T10:00:00Z",
        scores: { final: 0.9 },
      },
      {
        id: "fact-1",
        text: "Second",
        document_id: null,
        metadata: { run_id: "r".repeat(257) },
      },
      { id: "fact-2", text: "Third", metadata: { run_id: 42 }, scores: null },
      { id: "fact-3", text: "Fourth" },
      { id: "fact-4", text: "Fifth" },
      { id: "fact-5", text: "Sixth" },
      { id: "fact-6", text: "Seventh" },
    ];
    const { client } = harness(() => json({ results }));

    await expect(client.recall("bank-1", { query: "flowers" })).resolves.toStrictEqual({
      ok: true,
      value: [
        {
          memory: "x".repeat(2047),
          id: "fact-0",
          documentId: "rakazo-doc-1",
          runId: "run-1",
          updatedAt: "2026-10-12T10:00:00.000Z",
          score: 0.9,
        },
        { memory: "Second", id: "fact-1" },
        { memory: "Third", id: "fact-2" },
        { memory: "Fourth", id: "fact-3" },
        { memory: "Fifth", id: "fact-4" },
      ],
    });
  });

  it.each([
    ["missing results", { facts: [] }],
    ["result without text", { results: [{ id: "a" }] }],
    ["result without id", { results: [{ text: "a" }] }],
    ["results not an array", { results: "a" }],
  ])("rejects a malformed recall response (%s)", async (_label, body) => {
    const { client } = harness(() => json(body));

    await expect(client.recall("bank-1", { query: "q" })).resolves.toEqual({
      ok: false,
      code: "invalid_response",
    });
  });
});

describe("HindsightClient retain", () => {
  it("submits one async replace item with the persisted operation ID", async () => {
    const { client, calls } = harness(() => json(acceptedRetain));

    await expect(client.retain("bank-1", retainInput())).resolves.toEqual({
      ok: true,
      value: { operationId: OPERATION_ID },
    });
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/v1/default/banks/bank-1/memories");
    expect(calls[0]?.body).toEqual({
      items: [
        {
          content: "User 2026-10-13T00:00:00.000Z:\nI like marigolds.",
          document_id: "rakazo-doc-1",
          timestamp: "2026-10-13T00:00:00.000Z",
          context: "Rakazo conversation",
          metadata: {
            space_id: "space-1",
            bot_id: "bot-1",
            run_id: "run-1",
            source_key: "conversation",
          },
          update_mode: "replace",
        },
      ],
      async: true,
      operation_id: OPERATION_ID,
    });
  });

  it.each([
    ["success false", { success: false }],
    ["different bank", { bank_id: "bank-2" }],
    ["different operation", { operation_id: "00000000-0000-4000-8000-000000000000" }],
    ["missing operation", { operation_id: null }],
    ["two items", { items_count: 2 }],
    ["synchronous", { async: false }],
  ])("rejects an acceptance with %s", async (_label, override) => {
    const { client } = harness(() => json({ ...acceptedRetain, ...override }));

    await expect(client.retain("bank-1", retainInput())).resolves.toEqual({
      ok: false,
      code: "invalid_response",
    });
  });

  it.each([
    ["unknown context", { context: "Other" }],
    ["non-UUID operation", { operationId: "op-1" }],
    ["oversized metadata", { metadata: { run_id: "r".repeat(257) } }],
    ["unknown metadata key", { metadata: { user_name: "Ada" } }],
    ["non-string metadata", { metadata: { run_id: 7 } }],
    ["empty content", { content: "  " }],
    ["invalid timestamp", { timestamp: "yesterday" }],
  ])("rejects %s without a request", async (_label, override) => {
    const { client, calls } = harness(() => json(acceptedRetain));

    await expect(client.retain("bank-1", retainInput(override))).resolves.toEqual({
      ok: false,
      code: "invalid_request",
    });
    expect(calls).toHaveLength(0);
  });

  it("accepts the saved-memory context", async () => {
    const { client } = harness(() => json(acceptedRetain));

    await expect(
      client.retain("bank-1", retainInput({ context: "Rakazo saved memory" })),
    ).resolves.toMatchObject({ ok: true });
  });
});

describe("HindsightClient operation status", () => {
  it.each(["pending", "processing", "completed", "failed", "cancelled", "not_found"] as const)(
    "normalizes %s and discards provider error text",
    async (status) => {
      const { client, calls } = harness(() =>
        json({ operation_id: OPERATION_ID, status, error_message: "provider failure detail" }),
      );

      const result = await client.operationStatus("bank-1", OPERATION_ID);

      expect(result).toEqual({ ok: true, value: status });
      expect(calls[0]?.url.pathname).toBe(`/v1/default/banks/bank-1/operations/${OPERATION_ID}`);
    },
  );

  it("reports a missing operation as a not_found status value", async () => {
    const { client } = harness(() => json({ detail: "missing" }, { status: 404 }));

    await expect(client.operationStatus("bank-1", OPERATION_ID)).resolves.toEqual({
      ok: true,
      value: "not_found",
    });
  });

  it.each([
    ["different operation", { operation_id: "other", status: "completed" }],
    ["unknown status", { operation_id: OPERATION_ID, status: "running" }],
    ["missing status", { operation_id: OPERATION_ID }],
  ])("rejects %s", async (_label, body) => {
    const { client } = harness(() => json(body));

    await expect(client.operationStatus("bank-1", OPERATION_ID)).resolves.toEqual({
      ok: false,
      code: "invalid_response",
    });
  });
});

describe("HindsightClient key handling", () => {
  it("strips the client's own key and encoded forms from outgoing payloads", async () => {
    const { client, calls } = harness((call) =>
      call.url.pathname.endsWith("/recall") ? json({ results: [] }) : json(acceptedRetain),
    );
    const leaked = KEY_FORMS.join(" | ");

    await client.recall("bank-1", { query: `remember ${leaked}` });
    await client.retain(
      "bank-1",
      retainInput({ content: `note ${leaked}`, metadata: { source_key: KEY } }),
    );
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expectNoKey(call.body);
      expect(String(call.init.body)).toContain("[redacted]");
    }
  });

  it("keeps the key out of returned facts, bank names and errors", async () => {
    const responses = [
      json({
        results: [
          { id: KEY, text: `secret is ${KEY}`, document_id: encodeURIComponent(KEY) },
          { id: "fact", text: "plain", metadata: { run_id: Buffer.from(KEY).toString("base64") } },
        ],
      }),
      json({ banks: [{ bank_id: "a", name: `Bank ${KEY}` }], total: 1 }),
      json({ bank_id: "a", name: KEY }),
      json({ message: KEY }, { status: 401, headers: { "retry-after": KEY } }),
      new Response(KEY, { status: 200 }),
    ];
    const { client } = harness(() => responses.shift() ?? json({}));

    const results = [
      await client.recall("bank-1", { query: "q" }),
      await client.listBanks({ offset: 0, limit: 50 }),
      await client.getBankProfile("a"),
      await client.getBankProfile("a"),
      await client.getBankProfile("a"),
    ];

    expect(results[0]).toEqual({
      ok: true,
      value: [{ memory: "secret is [redacted]" }, { memory: "plain", id: "fact" }],
    });
    for (const result of results) expectNoKey(result);
  });
});
