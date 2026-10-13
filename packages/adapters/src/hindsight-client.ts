import type { MemoryBankPage, SemanticMemoryOperationStatus } from "@rakazo/adapter-kit";
import type { MemoryBank, MemoryFailureCode } from "@rakazo/contracts";
import {
  hasControlCharacter,
  MemoryBankIdSchema,
  MemoryBankNameSchema,
  MemoryBankQuerySchema,
} from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";
import { z } from "zod";
import { readBodyCapped, withAbort } from "./web-ssrf.js";

export const HINDSIGHT_CLOUD_ORIGIN = "https://api.hindsight.vectorize.io";
export const HINDSIGHT_PROVIDER_ID = "hindsight";
export const HINDSIGHT_LIST_PAGE_SIZE = 50;
export const HINDSIGHT_RECALL_LIMIT = 5;
export const HINDSIGHT_RECALL_QUERY_MAX_BYTES = 450;
export const HINDSIGHT_RECALL_TEXT_MAX_BYTES = 2048;
export const HINDSIGHT_METADATA_VALUE_MAX_BYTES = 256;
export const HINDSIGHT_REQUEST_TIMEOUT_MS = 20_000;
export const HINDSIGHT_MAX_RESPONSE_BYTES = 1024 * 1024;
export const HINDSIGHT_MAX_REQUEST_BYTES = 128 * 1024;
export const HINDSIGHT_RETAIN_CONTEXTS = ["Rakazo conversation", "Rakazo saved memory"] as const;
export const HINDSIGHT_METADATA_KEYS = [
  "space_id",
  "bot_id",
  "thread_id",
  "run_id",
  "source_kind",
  "source_key",
] as const;

const API_PREFIX = "/v1/default/banks";
const MAX_BANK_NAME_CHARS = 80;
const MAX_API_KEY_CHARS = 4096;
const RETRY_AFTER_MIN_MS = 1_000;
const RETRY_AFTER_MAX_MS = 300_000;
const HTTP_DATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

export type HindsightResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: MemoryFailureCode; retryAfterMs?: number };

export type HindsightRetainContext = (typeof HINDSIGHT_RETAIN_CONTEXTS)[number];
export type HindsightMetadataKey = (typeof HINDSIGHT_METADATA_KEYS)[number];

export interface HindsightClientOptions {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

export interface HindsightRecallFact {
  memory: string;
  id?: string;
  documentId?: string;
  runId?: string;
  updatedAt?: string;
  score?: number;
}

export interface HindsightRetainInput {
  content: string;
  documentId: string;
  timestamp: string;
  context: HindsightRetainContext;
  metadata: Partial<Record<HindsightMetadataKey, string>>;
  operationId: string;
}

export interface HindsightRetainReceipt {
  operationId: string;
}

interface RequestSpec {
  method: "GET" | "POST" | "PUT";
  path: string;
  query?: URLSearchParams;
  body?: unknown;
}

const encoder = new TextEncoder();

function utf8Length(text: string): number {
  return encoder.encode(text).byteLength;
}

function cropUtf8(text: string, maxBytes: number): string {
  const { read } = encoder.encodeInto(text, new Uint8Array(maxBytes));
  return text.slice(0, read);
}

export function validateHindsightBankId(value: unknown): string | null {
  const parsed = MemoryBankIdSchema.safeParse(value);
  if (!parsed.success) return null;
  try {
    encodeURIComponent(parsed.data);
  } catch {
    return null;
  }
  return parsed.data;
}

export function normalizeHindsightApiKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_API_KEY_CHARS) return null;
  return hasControlCharacter(trimmed) ? null : trimmed;
}

export function boundRecallQuery(text: string): string {
  return cropUtf8(text.trim(), HINDSIGHT_RECALL_QUERY_MAX_BYTES).trimEnd();
}

const ExactIdentifier = z.string().refine((value) => validateHindsightBankId(value) === value);
const MetadataValue = z
  .string()
  .refine((value) => utf8Length(value) <= HINDSIGHT_METADATA_VALUE_MAX_BYTES);
const RetainInputSchema = z.object({
  content: z.string().refine((value) => value.trim().length > 0),
  documentId: ExactIdentifier,
  timestamp: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  context: z.enum(HINDSIGHT_RETAIN_CONTEXTS),
  metadata: z.partialRecord(z.enum(HINDSIGHT_METADATA_KEYS), MetadataValue),
  operationId: z.uuid(),
});

const DisplayText = z.string().nullish();
const BankListResponse = z.object({
  banks: z.array(
    z.object({ bank_id: ExactIdentifier, name: DisplayText, display_alias: DisplayText }),
  ),
  total: z.number().int().nonnegative(),
});
const BankProfileResponse = z.object({
  bank_id: z.string(),
  name: DisplayText,
  display_alias: DisplayText,
});
const RecallResponse = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      document_id: z.string().nullish().catch(null),
      metadata: z
        .object({ run_id: z.string().optional().catch(undefined) })
        .nullish()
        .catch(null),
      mentioned_at: z.string().nullish().catch(null),
      scores: z
        .object({ final: z.number().optional().catch(undefined) })
        .nullish()
        .catch(null),
    }),
  ),
});
const RetainResponse = z.object({
  success: z.literal(true),
  bank_id: z.string(),
  items_count: z.literal(1),
  async: z.literal(true),
  operation_id: z.string(),
});
const OperationStatusResponse = z.object({
  operation_id: z.string(),
  status: z.enum(["pending", "processing", "completed", "failed", "cancelled", "not_found"]),
});

function displayName(bankId: string, ...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return Array.from(trimmed).slice(0, MAX_BANK_NAME_CHARS).join("");
  }
  return bankId;
}

function bankPath(bankId: string, ...rest: string[]): string {
  return [API_PREFIX, ...[bankId, ...rest].map((segment) => encodeURIComponent(segment))].join("/");
}

function failure<T>(code: MemoryFailureCode, retryAfterMs?: number): HindsightResult<T> {
  return retryAfterMs === undefined ? { ok: false, code } : { ok: false, code, retryAfterMs };
}

function codeForStatus(status: number): MemoryFailureCode {
  if (status === 400 || status === 422) return "invalid_request";
  if (status === 401) return "unauthorized";
  if (status === 402) return "quota";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  if (status >= 400) return "invalid_request";
  return "invalid_response";
}

function retryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  let delayMs: number;
  if (/^\d+$/.test(value)) {
    delayMs = Number(value) * 1000;
  } else if (HTTP_DATE.test(value)) {
    const at = Date.parse(value);
    if (!Number.isFinite(at)) return undefined;
    delayMs = at - Date.now();
  } else {
    return undefined;
  }
  return Math.min(Math.max(delayMs, RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS);
}

export function credentialForms(apiKey: string): string[] {
  const base64 = Buffer.from(apiKey).toString("base64");
  const forms = [
    apiKey,
    base64,
    base64.replace(/=+$/, ""),
    Buffer.from(apiKey).toString("base64url"),
    encodeURIComponent(apiKey),
  ];
  return [...new Set(forms)].sort((a, b) => b.length - a.length);
}

const FREE_TEXT_FIELDS: Record<string, true> = { content: true, query: true, q: true };

function structuralValues(value: unknown, key = ""): string[] {
  if (FREE_TEXT_FIELDS[key]) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  if (Array.isArray(value)) return value.flatMap((item) => structuralValues(item));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([nested, item]) => structuralValues(item, nested));
  }
  return [];
}

export class HindsightClient {
  private readonly apiKey: string | null;
  private readonly forms: string[];
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly signal?: AbortSignal;

  constructor(options: HindsightClientOptions) {
    this.apiKey = normalizeHindsightApiKey(options.apiKey);
    this.forms = this.apiKey === null ? [] : credentialForms(this.apiKey);
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.signal = options.signal;
  }

  async listBanks(
    request: { q?: string; offset: number; limit: number },
    signal?: AbortSignal,
  ): Promise<HindsightResult<MemoryBankPage>> {
    const { offset, limit } = request;
    const q = MemoryBankQuerySchema.optional().safeParse(request.q);
    if (
      !q.success ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > HINDSIGHT_LIST_PAGE_SIZE
    ) {
      return failure("invalid_request");
    }
    const query = new URLSearchParams();
    const search = this.strip(q.data ?? "");
    if (search) query.set("q", search);
    query.set("limit", String(limit));
    query.set("offset", String(offset));
    return this.send({ method: "GET", path: API_PREFIX, query }, signal, (json) => {
      const parsed = BankListResponse.safeParse(json);
      if (!parsed.success) return undefined;
      const { banks, total } = parsed.data;
      const next = offset + banks.length;
      return {
        banks: banks.map((bank) => ({
          bankId: bank.bank_id,
          name: displayName(
            bank.bank_id,
            this.cleanText(bank.name),
            this.cleanText(bank.display_alias),
          ),
        })),
        nextOffset: banks.length > 0 && next < total ? next : null,
      };
    });
  }

  async getBankProfile(bankId: string, signal?: AbortSignal): Promise<HindsightResult<MemoryBank>> {
    const id = validateHindsightBankId(bankId);
    if (id === null) return failure("invalid_request");
    return this.send({ method: "GET", path: bankPath(id, "profile") }, signal, (json) =>
      this.parseProfile(json, id),
    );
  }

  async putBank(
    bankId: string,
    request: { name: string },
    signal?: AbortSignal,
  ): Promise<HindsightResult<MemoryBank>> {
    const id = validateHindsightBankId(bankId);
    const name = MemoryBankNameSchema.safeParse(request.name);
    if (id === null || !name.success) return failure("invalid_request");
    return this.send(
      { method: "PUT", path: bankPath(id), body: { name: name.data } },
      signal,
      (json) => this.parseProfile(json, id),
    );
  }

  async recall(
    bankId: string,
    request: { query: string },
    signal?: AbortSignal,
  ): Promise<HindsightResult<HindsightRecallFact[]>> {
    const id = validateHindsightBankId(bankId);
    if (id === null || typeof request.query !== "string") return failure("invalid_request");
    const query = boundRecallQuery(this.strip(request.query));
    if (!query) return { ok: true, value: [] };
    return this.send(
      {
        method: "POST",
        path: bankPath(id, "memories", "recall"),
        body: { query, budget: "low", max_tokens: 1024 },
      },
      signal,
      (json) => {
        const parsed = RecallResponse.safeParse(json);
        if (!parsed.success) return undefined;
        return parsed.data.results.slice(0, HINDSIGHT_RECALL_LIMIT).map((result) => {
          const fact: HindsightRecallFact = {
            memory: cropUtf8(this.strip(result.text), HINDSIGHT_RECALL_TEXT_MAX_BYTES),
          };
          const resultId = this.attribution(result.id);
          if (resultId !== undefined) fact.id = resultId;
          const documentId = this.attribution(result.document_id);
          if (documentId !== undefined) fact.documentId = documentId;
          const runId = this.attribution(result.metadata?.run_id);
          if (runId !== undefined) fact.runId = runId;
          const mentioned = Date.parse(result.mentioned_at ?? "");
          if (Number.isFinite(mentioned)) fact.updatedAt = new Date(mentioned).toISOString();
          const score = result.scores?.final;
          if (score !== undefined) fact.score = score;
          return fact;
        });
      },
    );
  }

  async retain(
    bankId: string,
    input: HindsightRetainInput,
    signal?: AbortSignal,
  ): Promise<HindsightResult<HindsightRetainReceipt>> {
    const id = validateHindsightBankId(bankId);
    const parsed = RetainInputSchema.safeParse(input);
    if (id === null || !parsed.success) return failure("invalid_request");
    const item = parsed.data;
    const body = {
      items: [
        {
          content: this.strip(item.content),
          document_id: item.documentId,
          timestamp: item.timestamp,
          context: item.context,
          metadata: item.metadata,
          update_mode: "replace",
        },
      ],
      async: true,
      operation_id: item.operationId,
    };
    return this.send({ method: "POST", path: bankPath(id, "memories"), body }, signal, (json) => {
      const response = RetainResponse.safeParse(json);
      return response.success &&
        response.data.bank_id === id &&
        response.data.operation_id === item.operationId
        ? { operationId: item.operationId }
        : undefined;
    });
  }

  async operationStatus(
    bankId: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<HindsightResult<SemanticMemoryOperationStatus>> {
    const id = validateHindsightBankId(bankId);
    if (id === null || !ExactIdentifier.safeParse(operationId).success) {
      return failure("invalid_request");
    }
    return this.send(
      { method: "GET", path: bankPath(id, "operations", operationId) },
      signal,
      (json) => {
        const parsed = OperationStatusResponse.safeParse(json);
        return parsed.success && parsed.data.operation_id === operationId
          ? parsed.data.status
          : undefined;
      },
      "not_found",
    );
  }

  private strip(value: string): string {
    return redactSecrets(value, this.forms);
  }

  private hasCredential(values: Array<string | undefined>): boolean {
    return values.some(
      (value) => value !== undefined && this.forms.some((form) => value.includes(form)),
    );
  }

  private cleanText(value: string | null | undefined): string | undefined {
    return typeof value === "string" ? this.strip(value) : undefined;
  }

  private parseProfile(json: unknown, bankId: string): MemoryBank | undefined {
    const parsed = BankProfileResponse.safeParse(json);
    if (!parsed.success || parsed.data.bank_id !== bankId) return undefined;
    return {
      bankId,
      name: displayName(
        bankId,
        this.cleanText(parsed.data.name),
        this.cleanText(parsed.data.display_alias),
      ),
    };
  }

  private attribution(value: string | null | undefined): string | undefined {
    if (!value || utf8Length(value) > HINDSIGHT_METADATA_VALUE_MAX_BYTES) return undefined;
    if (hasControlCharacter(value) || this.hasCredential([value])) return undefined;
    return value;
  }

  private async send<T>(
    spec: RequestSpec,
    signal: AbortSignal | undefined,
    parse: (json: unknown) => T | undefined,
    notFound?: T,
  ): Promise<HindsightResult<T>> {
    if (this.apiKey === null) return failure("unauthorized");
    if (
      this.hasCredential([
        ...spec.path.split("/").map((segment) => decodeURIComponent(segment)),
        ...[...(spec.query ?? [])].flatMap(([name, value]) => structuralValues(value, name)),
        ...structuralValues(spec.body),
      ])
    ) {
      return failure("invalid_request");
    }
    let body: string | undefined;
    if (spec.body !== undefined) {
      body = JSON.stringify(spec.body);
      if (utf8Length(body) > HINDSIGHT_MAX_REQUEST_BYTES) return failure("invalid_request");
    }
    const url = new URL(spec.path, HINDSIGHT_CLOUD_ORIGIN);
    if (spec.query) url.search = spec.query.toString();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const callers = [this.signal, signal].filter((item): item is AbortSignal => Boolean(item));
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), HINDSIGHT_REQUEST_TIMEOUT_MS);
    const combined = AbortSignal.any([...callers, deadline.signal]);
    const abortedCode = (): MemoryFailureCode =>
      callers.some((item) => item.aborted) ? "unavailable" : "timeout";

    try {
      if (combined.aborted) return failure(abortedCode());
      let response: Response;
      try {
        response = await withAbort(
          this.fetchImpl(url.href, {
            method: spec.method,
            headers,
            body,
            redirect: "error",
            signal: combined,
          }),
          combined,
        );
      } catch {
        return failure(combined.aborted ? abortedCode() : "unavailable");
      }

      if (!response.ok) {
        await this.release(response, combined);
        if (response.status === 404 && notFound !== undefined) return { ok: true, value: notFound };
        const code = codeForStatus(response.status);
        const retryable = code === "rate_limited" || code === "unavailable";
        return failure(
          code,
          retryable ? retryAfterMs(response.headers.get("retry-after")) : undefined,
        );
      }

      const declared = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(declared) && declared > HINDSIGHT_MAX_RESPONSE_BYTES) {
        await this.release(response, combined);
        return failure("invalid_response");
      }
      let bytes: Uint8Array;
      try {
        bytes = await readBodyCapped(response, HINDSIGHT_MAX_RESPONSE_BYTES, combined);
      } catch (error) {
        if (combined.aborted) return failure(abortedCode());
        return failure(
          error instanceof Error && error.message === "Response is too large"
            ? "invalid_response"
            : "unavailable",
        );
      }
      let json: unknown;
      try {
        json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        return failure("invalid_response");
      }
      const value = parse(json);
      return value === undefined ? failure("invalid_response") : { ok: true, value };
    } finally {
      clearTimeout(timer);
    }
  }

  private async release(response: Response, signal: AbortSignal): Promise<void> {
    const cancel = response.body?.cancel().catch(() => undefined) ?? Promise.resolve();
    await withAbort(cancel, signal).catch(() => undefined);
  }
}
