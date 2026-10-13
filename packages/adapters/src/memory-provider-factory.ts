import type {
  AdapterContext,
  DurableMemoryScope,
  MemoryBankDirectory,
  MemoryTransport,
  SecretStore,
  SemanticMemoryCapabilities,
  SemanticMemoryProvider,
} from "@rakazo/adapter-kit";
import type { MemoryConnectionFailureReason, MemorySelection } from "@rakazo/contracts";
import {
  MEMORY_FAILURE_MESSAGES,
  MemoryBankIdSchema,
  MemorySelectionSchema,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { checkMemoryDispatch, selectBotMemory } from "@rakazo/db";
import { credentialForms, HINDSIGHT_PROVIDER_ID } from "./hindsight-client.js";
import type { MemoryRequestGuard } from "./hindsight-memory-provider.js";
import {
  createHindsightBankDirectory,
  createHindsightProvider,
  HINDSIGHT_CAPABILITIES,
  MemoryDispatchDeniedError,
  prepareHindsightConnection,
} from "./hindsight-memory-provider.js";
import {
  classifySerenityConnectionSettings,
  createSerenityProvider,
  prepareSerenityConnection,
  SERENITY_CAPABILITIES,
  SERENITY_PROVIDER_ID,
  serenityRequiresDeploymentOwner,
} from "./serenity-memory-provider.js";

export {
  MemoryDispatchDeniedError,
  MemoryProviderConnectionError,
} from "./hindsight-memory-provider.js";
export { MemoryProviderDeploymentOwnerRequiredError } from "./serenity-memory-provider.js";

import {
  assertSupermemoryLocalBaseUrl,
  createSupermemoryProvider,
  decodeLegacySupermemoryCredentials,
  prepareSupermemoryConnection,
  SUPERMEMORY_CAPABILITIES,
  SUPERMEMORY_PROVIDER_ID,
  supermemoryRequiresDeploymentOwner,
} from "./supermemory-memory-provider.js";

export interface MemoryProviderConnectionInput {
  provider: string;
  settings: Record<string, string>;
  credentials: Record<string, string>;
  /** When false, Serenity must not probe endpoints that classify as private. */
  allowPrivateEndpoint?: boolean;
}

export interface MemoryProviderPrepareOptions {
  signal?: AbortSignal;
  beforeRequest?: () => Promise<void>;
  memoryTransport?: MemoryTransport;
}

export interface PreparedMemoryProviderConnection {
  provider: string;
  settings: Record<string, string>;
  credentials: Record<string, string>;
}

export interface MemoryProviderCreateOptions {
  bankId?: string;
  beforeRequest?: MemoryRequestGuard;
  memoryTransport?: MemoryTransport;
}

export type MemoryResolution =
  | { kind: "native" }
  | {
      kind: "configured";
      provider: SemanticMemoryProvider;
      capabilities: SemanticMemoryCapabilities;
      defaultScope: DurableMemoryScope;
      selection: Exclude<MemorySelection, { kind: "native" }>;
    }
  | {
      kind: "unavailable";
      capabilities: SemanticMemoryCapabilities;
      code: MemoryConnectionFailureReason;
      error: string;
    };

export interface MemoryResolveOptions {
  registerSecrets?: (values: string[]) => void;
  beforeRequest?: MemoryRequestGuard;
}

export interface MemoryProviderResolver {
  select(input: { spaceId: string; userId: string; botId: string }): Promise<MemorySelection>;
  resolve(
    input: { spaceId: string; userId: string; botId: string; selection: MemorySelection },
    options?: MemoryResolveOptions,
  ): Promise<MemoryResolution>;
}

export interface MemoryProviderFactoryDeps {
  prisma: Pick<
    PrismaClient,
    "spaceMemoryConfig" | "deploymentSettings" | "botMemoryBank" | "spaceMember" | "bot"
  >;
  secrets: SecretStore;
  memoryTransport?: MemoryTransport;
}

interface MemoryProviderAdapter {
  capabilities: SemanticMemoryCapabilities;
  requiresDeploymentOwner(settings: Record<string, string>): boolean;
  /** Async trust classification (e.g. DNS) without probing credentials. */
  classifySettings?(settings: Record<string, string>): Promise<Record<string, string>>;
  revalidateSettings?(settings: Record<string, string>): Promise<void>;
  prepare(
    settings: Record<string, string>,
    credentials: Record<string, string>,
    options: MemoryProviderPrepareOptions & { allowPrivateEndpoint?: boolean },
  ): Promise<{ settings: Record<string, string>; credentials: Record<string, string> }>;
  create(
    settings: Record<string, string>,
    credentials: Record<string, string>,
    options: MemoryProviderCreateOptions,
  ): SemanticMemoryProvider;
  createBankDirectory?(
    settings: Record<string, string>,
    credentials: Record<string, string>,
    options: {
      signal?: AbortSignal;
      beforeRequest?: MemoryRequestGuard;
      memoryTransport?: MemoryTransport;
    },
  ): MemoryBankDirectory;
  decodeLegacyCredentials?(plaintext: string): Record<string, string> | null;
}

const LEGACY_UNAVAILABLE_MESSAGE = "The memory provider is unavailable.";

const UNKNOWN_PROVIDER_CAPABILITIES: SemanticMemoryCapabilities = {
  recall: true,
  save: true,
  purgeHistory: false,
  sharedScope: false,
  forget: false,
};

function failureMessage(provider: string, code: MemoryConnectionFailureReason): string {
  return provider === HINDSIGHT_PROVIDER_ID
    ? MEMORY_FAILURE_MESSAGES[code]
    : LEGACY_UNAVAILABLE_MESSAGE;
}

function guardLegacyProvider(
  provider: SemanticMemoryProvider,
  providerId: string,
  guard: MemoryRequestGuard | undefined,
): SemanticMemoryProvider {
  if (!guard) return provider;
  const run = async <T>(
    context: AdapterContext,
    send: () => Promise<T>,
  ): Promise<T | { ok: false; error: string; code: MemoryConnectionFailureReason }> => {
    try {
      await guard(context);
    } catch (error) {
      if (!(error instanceof MemoryDispatchDeniedError)) throw error;
      return { ok: false, error: failureMessage(providerId, error.code), code: error.code };
    }
    return send();
  };
  const guarded: SemanticMemoryProvider = {
    describe: () => provider.describe(),
    recall: (request, context) => run(context, () => provider.recall(request, context)),
    save: (request, context) => run(context, () => provider.save(request, context)),
  };
  const { purgeHistory, forget, operationStatus } = provider;
  if (purgeHistory) {
    guarded.purgeHistory = (request, context) =>
      run(context, () => purgeHistory.call(provider, request, context));
  }
  if (forget) {
    guarded.forget = (request, context) =>
      run(context, () => forget.call(provider, request, context));
  }
  if (operationStatus) {
    guarded.operationStatus = (operationId, context) =>
      run(context, () => operationStatus.call(provider, operationId, context));
  }
  return guarded;
}

async function guardLegacyProbe<T>(
  options: MemoryProviderPrepareOptions,
  probe: (fetch: typeof globalThis.fetch) => Promise<T>,
): Promise<T> {
  let denial: { error: unknown } | undefined;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    try {
      await options.beforeRequest?.();
    } catch (error) {
      denial = { error };
      throw error;
    }
    const signals = [options.signal, init?.signal ?? undefined].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const transport = options.memoryTransport?.fetch ?? globalThis.fetch;
    return transport(input, {
      ...init,
      ...(signals.length > 0 ? { signal: AbortSignal.any(signals) } : {}),
    });
  };
  try {
    return await probe(fetch);
  } catch (error) {
    if (denial) throw denial.error;
    throw error;
  }
}

const MEMORY_PROVIDER_ADAPTERS: ReadonlyMap<string, MemoryProviderAdapter> = new Map<
  string,
  MemoryProviderAdapter
>([
  [
    SUPERMEMORY_PROVIDER_ID,
    {
      capabilities: SUPERMEMORY_CAPABILITIES,
      requiresDeploymentOwner: supermemoryRequiresDeploymentOwner,
      revalidateSettings: async (settings) => {
        if (settings.mode === "local" && settings.baseUrl) {
          await assertSupermemoryLocalBaseUrl(settings.baseUrl, { allowPrivateEndpoint: true });
        }
      },
      prepare: (settings, credentials, options) =>
        guardLegacyProbe(options, (fetch) =>
          prepareSupermemoryConnection(settings, credentials, {
            allowPrivateEndpoint: options.allowPrivateEndpoint,
            fetch,
          }),
        ),
      create: (settings, credentials, options) =>
        guardLegacyProvider(
          createSupermemoryProvider(settings, credentials),
          SUPERMEMORY_PROVIDER_ID,
          options.beforeRequest,
        ),
      decodeLegacyCredentials: decodeLegacySupermemoryCredentials,
    },
  ],
  [
    SERENITY_PROVIDER_ID,
    {
      capabilities: SERENITY_CAPABILITIES,
      requiresDeploymentOwner: serenityRequiresDeploymentOwner,
      classifySettings: classifySerenityConnectionSettings,
      prepare: (settings, credentials, options) =>
        guardLegacyProbe(options, (fetch) =>
          prepareSerenityConnection(
            settings,
            credentials,
            { fetch },
            { allowPrivateEndpoint: options.allowPrivateEndpoint },
          ),
        ),
      create: (settings, credentials, options) =>
        guardLegacyProvider(
          createSerenityProvider(settings, credentials),
          SERENITY_PROVIDER_ID,
          options.beforeRequest,
        ),
    },
  ],
  [
    HINDSIGHT_PROVIDER_ID,
    {
      capabilities: HINDSIGHT_CAPABILITIES,
      requiresDeploymentOwner: () => false,
      prepare: prepareHindsightConnection,
      create: createHindsightProvider,
      createBankDirectory: createHindsightBankDirectory,
    },
  ],
]);

function memoryProviderAdapter(provider: string): MemoryProviderAdapter {
  const adapter = MEMORY_PROVIDER_ADAPTERS.get(provider);
  if (!adapter) throw new Error(`Unknown memory provider "${provider}".`);
  return adapter;
}

export function memoryProviderCapabilities(provider: string): SemanticMemoryCapabilities {
  return MEMORY_PROVIDER_ADAPTERS.get(provider)?.capabilities ?? UNKNOWN_PROVIDER_CAPABILITIES;
}

/** Adapters classify their settings; callers enforce the deployment trust boundary. */
export function memoryProviderRequiresDeploymentOwner(
  provider: string,
  settings: Record<string, string>,
): boolean {
  return memoryProviderAdapter(provider).requiresDeploymentOwner(settings);
}

/**
 * Run provider-specific trust classification (DNS, etc.) without credentialed probes.
 * Callers must authorize deployment-owner endpoints before prepare/probe.
 */
export async function classifyMemoryProviderSettings(
  provider: string,
  settings: Record<string, string>,
): Promise<Record<string, string>> {
  const adapter = memoryProviderAdapter(provider);
  return adapter.classifySettings ? adapter.classifySettings(settings) : settings;
}

export async function prepareMemoryProviderConnection(
  input: MemoryProviderConnectionInput,
  options: MemoryProviderPrepareOptions = {},
): Promise<PreparedMemoryProviderConnection> {
  const prepared = await memoryProviderAdapter(input.provider).prepare(
    input.settings,
    input.credentials,
    { ...options, allowPrivateEndpoint: input.allowPrivateEndpoint },
  );
  return { provider: input.provider, ...prepared };
}

export function createMemoryProvider(
  provider: string,
  settings: Record<string, string>,
  credentials: Record<string, string>,
  options: MemoryProviderCreateOptions = {},
): SemanticMemoryProvider {
  return memoryProviderAdapter(provider).create(settings, credentials, options);
}

export function toStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function decodeCredentials(provider: string, plaintext: string): Record<string, string> {
  try {
    const credentials = toStringRecord(JSON.parse(plaintext));
    if (Object.keys(credentials).length > 0) return credentials;
  } catch {
    // Configurations created before the generic provider boundary stored the API key directly.
  }
  const legacyCredentials = memoryProviderAdapter(provider).decodeLegacyCredentials?.(plaintext);
  if (legacyCredentials) return legacyCredentials;
  throw new Error(`Stored credentials for memory provider "${provider}" are invalid.`);
}

async function loadCredentials(
  secrets: SecretStore,
  provider: string,
  secret: { ciphertext: string; id: string },
): Promise<Record<string, string> | null> {
  try {
    return decodeCredentials(provider, await secrets.load(secret.ciphertext, secret.id));
  } catch {
    return null;
  }
}

function unavailable(
  provider: string,
  capabilities: SemanticMemoryCapabilities,
  code: MemoryConnectionFailureReason,
): MemoryResolution {
  return { kind: "unavailable", capabilities, code, error: failureMessage(provider, code) };
}

export async function createMemoryBankDirectory(
  deps: MemoryProviderFactoryDeps,
  input: { configId: string; spaceId: string },
  options: { signal?: AbortSignal; beforeRequest?: MemoryRequestGuard } = {},
): Promise<{ directory: MemoryBankDirectory } | { error: MemoryConnectionFailureReason }> {
  const config = await deps.prisma.spaceMemoryConfig.findUnique({
    where: { id: input.configId },
    include: { secret: true },
  });
  if (!config || config.spaceId !== input.spaceId) return { error: "binding_retired" };
  const adapter = MEMORY_PROVIDER_ADAPTERS.get(config.provider);
  if (!adapter?.createBankDirectory) return { error: "invalid_request" };
  const credentials = await loadCredentials(deps.secrets, config.provider, config.secret);
  if (!credentials) return { error: "unavailable" };
  try {
    return {
      directory: adapter.createBankDirectory(toStringRecord(config.settings), credentials, {
        signal: options.signal,
        beforeRequest: options.beforeRequest,
        memoryTransport: deps.memoryTransport,
      }),
    };
  } catch {
    return { error: "invalid_request" };
  }
}

export class SpaceMemoryProviderResolver implements MemoryProviderResolver {
  constructor(private readonly deps: MemoryProviderFactoryDeps) {}

  async select(input: {
    spaceId: string;
    userId: string;
    botId: string;
  }): Promise<MemorySelection> {
    const selection = await selectBotMemory(this.deps.prisma, input, {
      bankCapable: (provider) => memoryProviderCapabilities(provider).banks === true,
    });
    if (selection.kind !== "legacy") return selection;
    const config = await this.deps.prisma.spaceMemoryConfig.findUnique({
      where: { id: selection.configId },
      select: { userId: true, provider: true, settings: true },
    });
    if (!config || !MEMORY_PROVIDER_ADAPTERS.has(config.provider)) return selection;
    return (await this.deploymentOwnerAllows(config)) ? selection : { kind: "native" };
  }

  async resolve(
    input: { spaceId: string; userId: string; botId: string; selection: MemorySelection },
    options: MemoryResolveOptions = {},
  ): Promise<MemoryResolution> {
    const parsed = MemorySelectionSchema.safeParse(input.selection);
    if (!parsed.success) {
      return unavailable("", UNKNOWN_PROVIDER_CAPABILITIES, "invalid_request");
    }
    const selection = parsed.data;
    if (selection.kind === "native") return { kind: "native" };
    const adapter = MEMORY_PROVIDER_ADAPTERS.get(selection.provider);
    if (!adapter) {
      return unavailable(selection.provider, UNKNOWN_PROVIDER_CAPABILITIES, "invalid_request");
    }
    const { capabilities } = adapter;
    const isBank = selection.kind === "bank";
    if (
      isBank !== (capabilities.banks === true) ||
      (isBank && MemoryBankIdSchema.safeParse(selection.bankId).data !== selection.bankId)
    ) {
      return unavailable(selection.provider, capabilities, "invalid_request");
    }
    const dispatch = {
      configId: selection.configId,
      bindingId: isBank ? selection.bindingId : null,
      bankId: isBank ? selection.bankId : null,
      spaceId: input.spaceId,
      userId: input.userId,
      botId: input.botId,
    };
    const check = await checkMemoryDispatch(this.deps.prisma, dispatch);
    if (check !== "ok") return unavailable(selection.provider, capabilities, check);
    const config = await this.deps.prisma.spaceMemoryConfig.findUnique({
      where: { id: selection.configId },
      include: { secret: true },
    });
    if (!config || config.provider !== selection.provider || config.spaceId !== input.spaceId) {
      return unavailable(selection.provider, capabilities, "binding_retired");
    }
    const settings = toStringRecord(config.settings);
    if (!(await this.deploymentOwnerAllows({ ...config, settings }))) {
      return unavailable(selection.provider, capabilities, "forbidden");
    }
    try {
      await adapter.revalidateSettings?.(settings);
    } catch {
      return unavailable(selection.provider, capabilities, "invalid_request");
    }
    const credentials = await loadCredentials(this.deps.secrets, config.provider, config.secret);
    if (!credentials) return unavailable(selection.provider, capabilities, "unavailable");
    options.registerSecrets?.(Object.values(credentials).flatMap(credentialForms));
    const prisma = this.deps.prisma;
    const beforeRequest: MemoryRequestGuard = async (context) => {
      const current = await checkMemoryDispatch(prisma, dispatch);
      if (current !== "ok") throw new MemoryDispatchDeniedError(current);
      await options.beforeRequest?.(context);
    };
    let provider: SemanticMemoryProvider;
    try {
      provider = adapter.create(settings, credentials, {
        ...(isBank ? { bankId: selection.bankId } : {}),
        beforeRequest,
        memoryTransport: this.deps.memoryTransport,
      });
    } catch {
      return unavailable(selection.provider, capabilities, "invalid_request");
    }
    return {
      kind: "configured",
      provider,
      capabilities,
      defaultScope: selection.kind === "legacy" ? selection.scope : "isolated",
      selection,
    };
  }

  private async deploymentOwnerAllows(config: {
    userId: string;
    provider: string;
    settings: unknown;
  }): Promise<boolean> {
    if (!memoryProviderRequiresDeploymentOwner(config.provider, toStringRecord(config.settings))) {
      return true;
    }
    const deployment = await this.deps.prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { ownerUserId: true },
    });
    // Also disable pre-existing local configurations authored outside the deployment boundary.
    return Boolean(deployment?.ownerUserId) && deployment?.ownerUserId === config.userId;
  }
}
