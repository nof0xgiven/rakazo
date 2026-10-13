import type {
  AdapterContext,
  MemoryBankDirectory,
  MemoryBankPage,
  MemoryTransport,
  SemanticMemoryCapabilities,
  SemanticMemoryOperationStatus,
  SemanticMemoryProvider,
  SemanticMemoryRecallRequest,
  SemanticMemoryResponse,
  SemanticMemoryResult,
  SemanticMemorySaveReceipt,
  SemanticMemorySaveRequest,
} from "@rakazo/adapter-kit";
import type { MemoryBank, MemoryConnectionFailureReason } from "@rakazo/contracts";
import { MEMORY_FAILURE_MESSAGES } from "@rakazo/contracts";
import type { HindsightRecallFact, HindsightResult } from "./hindsight-client.js";
import {
  HINDSIGHT_CLOUD_ORIGIN,
  HINDSIGHT_LIST_PAGE_SIZE,
  HINDSIGHT_PROVIDER_ID,
  HindsightClient,
  normalizeHindsightApiKey,
  validateHindsightBankId,
} from "./hindsight-client.js";

export const HINDSIGHT_CAPABILITIES = {
  recall: true,
  save: true,
  purgeHistory: false,
  sharedScope: false,
  banks: true,
  automaticRecall: true,
  conversationRetention: true,
  forget: false,
} as const satisfies SemanticMemoryCapabilities;

export class MemoryProviderConnectionError extends Error {
  constructor(
    readonly reason: MemoryConnectionFailureReason,
    message: string = MEMORY_FAILURE_MESSAGES[reason],
  ) {
    super(message);
    this.name = "MemoryProviderConnectionError";
  }
}

export class MemoryDispatchDeniedError extends Error {
  constructor(readonly code: "binding_retired" | "forbidden") {
    super(MEMORY_FAILURE_MESSAGES[code]);
    this.name = "MemoryDispatchDeniedError";
  }
}

export type MemoryRequestGuard = (context: AdapterContext) => Promise<void>;

export interface HindsightPrepareOptions {
  signal?: AbortSignal;
  beforeRequest?: () => Promise<void>;
  memoryTransport?: MemoryTransport;
}

export interface HindsightProviderOptions {
  bankId?: string;
  beforeRequest?: MemoryRequestGuard;
  memoryTransport?: MemoryTransport;
}

export interface HindsightDirectoryOptions {
  signal?: AbortSignal;
  beforeRequest?: MemoryRequestGuard;
  memoryTransport?: MemoryTransport;
}

const CONVERSATION_CONTEXT = "Rakazo conversation";
const SAVED_MEMORY_CONTEXT = "Rakazo saved memory";

function parseConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
  allowVerificationBankId: boolean,
): { apiKey: string; verificationBankId?: string } {
  const settingsValid =
    settings.baseUrl === HINDSIGHT_CLOUD_ORIGIN &&
    Object.keys(settings).every(
      (key) => key === "baseUrl" || (allowVerificationBankId && key === "verificationBankId"),
    );
  const credentialKeys = Object.keys(credentials);
  const apiKey = normalizeHindsightApiKey(credentials.apiKey);
  if (!settingsValid || credentialKeys.length !== 1 || credentialKeys[0] !== "apiKey" || !apiKey) {
    throw new MemoryProviderConnectionError("invalid_request");
  }
  if (settings.verificationBankId === undefined) return { apiKey };
  const verificationBankId = validateHindsightBankId(settings.verificationBankId);
  if (verificationBankId === null) throw new MemoryProviderConnectionError("invalid_request");
  return { apiKey, verificationBankId };
}

function failureResponse<T>(
  code: MemoryConnectionFailureReason,
  retryAfterMs?: number,
): SemanticMemoryResponse<T> {
  const error = MEMORY_FAILURE_MESSAGES[code];
  return retryAfterMs === undefined
    ? { ok: false, error, code }
    : { ok: false, error, code, retryAfterMs };
}

function toResponse<T>(result: HindsightResult<T>): SemanticMemoryResponse<T> {
  return result.ok ? result : failureResponse(result.code, result.retryAfterMs);
}

async function guarded<T>(
  guard: MemoryRequestGuard | undefined,
  context: AdapterContext,
  send: () => Promise<HindsightResult<T>>,
): Promise<HindsightResult<T>> {
  try {
    await guard?.(context);
  } catch (error) {
    if (error instanceof MemoryDispatchDeniedError) return { ok: false, code: error.code };
    throw error;
  }
  return send();
}

export async function prepareHindsightConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
  options: HindsightPrepareOptions = {},
): Promise<{ settings: Record<string, string>; credentials: Record<string, string> }> {
  const { apiKey, verificationBankId } = parseConnection(settings, credentials, true);
  const client = new HindsightClient({
    apiKey,
    fetch: options.memoryTransport?.fetch,
    signal: options.signal,
  });
  await options.beforeRequest?.();
  const listed = await client.listBanks({ offset: 0, limit: 1 });
  if (!listed.ok) {
    if (listed.code !== "forbidden") throw new MemoryProviderConnectionError(listed.code);
    if (verificationBankId === undefined) {
      throw new MemoryProviderConnectionError("bank_id_required");
    }
    await options.beforeRequest?.();
    const profile = await client.getBankProfile(verificationBankId);
    if (!profile.ok) throw new MemoryProviderConnectionError(profile.code);
  }
  return { settings: { baseUrl: HINDSIGHT_CLOUD_ORIGIN }, credentials: { apiKey } };
}

function attribution(fact: HindsightRecallFact): string | undefined {
  if (fact.runId !== undefined) return `run:${fact.runId}`;
  if (fact.documentId !== undefined) return `document:${fact.documentId}`;
  return undefined;
}

function recallResult(fact: HindsightRecallFact): SemanticMemoryResult {
  const result: SemanticMemoryResult = { memory: fact.memory };
  if (fact.score !== undefined) result.score = fact.score;
  if (fact.updatedAt !== undefined) result.updatedAt = fact.updatedAt;
  if (fact.id !== undefined) result.id = fact.id;
  const provenance = attribution(fact);
  if (provenance !== undefined) result.provenance = provenance;
  return result;
}

export class HindsightMemoryProvider implements SemanticMemoryProvider {
  constructor(
    private readonly client: HindsightClient,
    private readonly bankId: string,
    private readonly beforeRequest?: MemoryRequestGuard,
  ) {}

  describe() {
    return {
      id: HINDSIGHT_PROVIDER_ID,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: HINDSIGHT_CAPABILITIES,
    };
  }

  async recall(
    request: SemanticMemoryRecallRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<SemanticMemoryResult[]>> {
    if (!request.query.trim()) return { ok: true, value: [] };
    const result = await guarded(this.beforeRequest, context, () =>
      this.client.recall(this.bankId, { query: request.query }, context.signal),
    );
    if (!result.ok) return failureResponse(result.code, result.retryAfterMs);
    return {
      ok: true,
      value: result.value.slice(0, Math.max(0, request.limit)).map(recallResult),
    };
  }

  async save(
    request: SemanticMemorySaveRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<SemanticMemorySaveReceipt>> {
    const { delivery, source } = request;
    const runId = context.runId;
    if (source.kind === "history" || !delivery || !runId) {
      return failureResponse("invalid_request");
    }
    const profile = await guarded(this.beforeRequest, context, () =>
      this.client.getBankProfile(this.bankId, context.signal),
    );
    if (!profile.ok) return failureResponse(profile.code, profile.retryAfterMs);
    const retained = await guarded(this.beforeRequest, context, () =>
      this.client.retain(
        this.bankId,
        {
          content: request.content,
          documentId: delivery.documentId,
          timestamp: delivery.timestamp,
          context: source.kind === "conversation" ? CONVERSATION_CONTEXT : SAVED_MEMORY_CONTEXT,
          metadata: {
            space_id: context.spaceId,
            bot_id: request.botId,
            thread_id: delivery.threadId,
            run_id: runId,
            source_kind: source.kind,
            source_key: delivery.sourceKey,
          },
          operationId: delivery.operationId,
        },
        context.signal,
      ),
    );
    if (!retained.ok) return failureResponse(retained.code, retained.retryAfterMs);
    return { ok: true, value: { status: "pending", operationId: retained.value.operationId } };
  }

  async operationStatus(
    operationId: string,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<SemanticMemoryOperationStatus>> {
    return toResponse(
      await guarded(this.beforeRequest, context, () =>
        this.client.operationStatus(this.bankId, operationId, context.signal),
      ),
    );
  }
}

export function createHindsightProvider(
  settings: Record<string, string>,
  credentials: Record<string, string>,
  options: HindsightProviderOptions = {},
): SemanticMemoryProvider {
  const { apiKey } = parseConnection(settings, credentials, false);
  const bankId = validateHindsightBankId(options.bankId);
  if (bankId === null || bankId !== options.bankId) {
    throw new MemoryProviderConnectionError("invalid_request");
  }
  const client = new HindsightClient({ apiKey, fetch: options.memoryTransport?.fetch });
  return new HindsightMemoryProvider(client, bankId, options.beforeRequest);
}

export class HindsightBankDirectory implements MemoryBankDirectory {
  constructor(
    private readonly client: HindsightClient,
    private readonly beforeRequest?: MemoryRequestGuard,
  ) {}

  async list(
    request: { q?: string; offset: number; limit: number },
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<MemoryBankPage>> {
    const result = await guarded(this.beforeRequest, context, () =>
      this.client.listBanks(
        {
          q: request.q,
          offset: request.offset,
          limit: Math.min(request.limit, HINDSIGHT_LIST_PAGE_SIZE),
        },
        context.signal,
      ),
    );
    if (!result.ok && result.code === "forbidden") return failureResponse("bank_list_forbidden");
    return toResponse(result);
  }

  async read(bankId: string, context: AdapterContext): Promise<SemanticMemoryResponse<MemoryBank>> {
    return toResponse(
      await guarded(this.beforeRequest, context, () =>
        this.client.getBankProfile(bankId, context.signal),
      ),
    );
  }

  async create(
    request: { bankId: string; name: string },
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<MemoryBank>> {
    const existing = await guarded(this.beforeRequest, context, () =>
      this.client.getBankProfile(request.bankId, context.signal),
    );
    if (existing.ok || existing.code !== "not_found") return toResponse(existing);
    const created = await guarded(this.beforeRequest, context, () =>
      this.client.putBank(request.bankId, { name: request.name }, context.signal),
    );
    if (!created.ok) {
      return created.code === "forbidden"
        ? failureResponse("bank_create_forbidden")
        : failureResponse(created.code, created.retryAfterMs);
    }
    return this.read(request.bankId, context);
  }
}

export function createHindsightBankDirectory(
  settings: Record<string, string>,
  credentials: Record<string, string>,
  options: HindsightDirectoryOptions = {},
): MemoryBankDirectory {
  const { apiKey } = parseConnection(settings, credentials, false);
  const client = new HindsightClient({
    apiKey,
    fetch: options.memoryTransport?.fetch,
    signal: options.signal,
  });
  return new HindsightBankDirectory(client, options.beforeRequest);
}
