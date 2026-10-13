import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type {
  AdapterContext,
  MemoryBankDirectory,
  MemoryBankPage,
  MemoryTransport,
  SecretStore,
  SemanticMemoryResponse,
} from "@rakazo/adapter-kit";
import {
  createMemoryBankDirectory,
  MemoryDispatchDeniedError,
  memoryProviderCapabilities,
} from "@rakazo/adapters";
import type { Actor, MemoryBank, MemoryConnectionFailureReason } from "@rakazo/contracts";
import { MEMORY_FAILURE_MESSAGES } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { findSpaceMemoryConfig, IsolationError } from "@rakazo/db";

export const MEMORY_BANK_PAGE_SIZE = 50;

export interface MemoryBankDeps {
  prisma: PrismaClient;
  secrets: SecretStore;
  memoryTransport?: MemoryTransport;
  createDirectory?: typeof createMemoryBankDirectory;
}

export interface MemoryBankTarget {
  botId: string;
  configId: string;
}

export function memoryBankCreationId(
  configId: string,
  botId: string,
  requestId: string,
  name: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([configId, botId, requestId, name.trim()]))
    .digest("hex");
  return `rakazo-${digest.slice(0, 32)}`;
}

export function memoryProviderFailure(
  reason: MemoryConnectionFailureReason,
): ORPCError<string, unknown> {
  if (reason === "binding_retired") return new ORPCError("CONFLICT");
  return new ORPCError("BAD_REQUEST", {
    message: MEMORY_FAILURE_MESSAGES[reason],
    data: { reason },
  });
}

async function authorizeMemoryBankAccess(
  prisma: PrismaClient,
  actor: Actor,
  target: MemoryBankTarget,
): Promise<void> {
  const [member, bot, config] = await Promise.all([
    prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
      select: { id: true },
    }),
    prisma.bot.findFirst({
      where: {
        id: target.botId,
        userId: actor.userId,
        spaceId: actor.spaceId,
        archivedAt: null,
      },
      select: { id: true },
    }),
    findSpaceMemoryConfig(prisma, actor.spaceId),
  ]);
  if (!member) throw new ORPCError("FORBIDDEN");
  if (!bot) throw new IsolationError();
  if (!config || config.id !== target.configId) throw new ORPCError("CONFLICT");
  if (!memoryProviderCapabilities(config.provider).banks) {
    throw new ORPCError("BAD_REQUEST", { message: "This memory connection does not use banks." });
  }
}

async function withMemoryBankDirectory<T>(
  deps: MemoryBankDeps,
  actor: Actor,
  target: MemoryBankTarget,
  signal: AbortSignal,
  operation: (
    directory: MemoryBankDirectory,
    context: AdapterContext,
  ) => Promise<SemanticMemoryResponse<T>>,
): Promise<T> {
  await authorizeMemoryBankAccess(deps.prisma, actor, target);
  let denied: unknown;
  const beforeRequest = async () => {
    try {
      await authorizeMemoryBankAccess(deps.prisma, actor, target);
    } catch (error) {
      denied = error;
      throw new MemoryDispatchDeniedError(
        error instanceof ORPCError && error.code === "CONFLICT" ? "binding_retired" : "forbidden",
      );
    }
  };
  const created = await (deps.createDirectory ?? createMemoryBankDirectory)(
    { prisma: deps.prisma, secrets: deps.secrets, memoryTransport: deps.memoryTransport },
    { configId: target.configId, spaceId: actor.spaceId },
    { signal, beforeRequest },
  );
  if ("error" in created) throw memoryProviderFailure(created.error);
  const context: AdapterContext = {
    operationId: `memory-bank:${target.botId}`,
    traceId: `memory-bank:${target.botId}`,
    spaceId: actor.spaceId,
    userId: actor.userId,
    botId: target.botId,
    signal,
  };
  let result: SemanticMemoryResponse<T>;
  try {
    result = await operation(created.directory, context);
  } catch (error) {
    if (denied) throw denied;
    throw error;
  }
  if (denied) throw denied;
  if (!result.ok) throw memoryProviderFailure(result.code ?? "unavailable");
  return result.value;
}

export function listMemoryBanks(
  deps: MemoryBankDeps,
  actor: Actor,
  input: MemoryBankTarget & { q?: string; offset?: number },
  signal: AbortSignal = new AbortController().signal,
): Promise<MemoryBankPage> {
  return withMemoryBankDirectory(deps, actor, input, signal, (directory, context) =>
    directory.list(
      {
        ...(input.q ? { q: input.q } : {}),
        offset: input.offset ?? 0,
        limit: MEMORY_BANK_PAGE_SIZE,
      },
      context,
    ),
  );
}

export function readMemoryBank(
  deps: MemoryBankDeps,
  actor: Actor,
  input: MemoryBankTarget & { bankId: string },
  signal: AbortSignal = new AbortController().signal,
): Promise<MemoryBank> {
  return withMemoryBankDirectory(deps, actor, input, signal, (directory, context) =>
    directory.read(input.bankId, context),
  );
}

export function createMemoryBank(
  deps: MemoryBankDeps,
  actor: Actor,
  input: MemoryBankTarget & { requestId: string; name: string },
  signal: AbortSignal = new AbortController().signal,
): Promise<MemoryBank> {
  const name = input.name.trim();
  const bankId = memoryBankCreationId(input.configId, input.botId, input.requestId, name);
  return withMemoryBankDirectory(deps, actor, input, signal, (directory, context) =>
    directory.create({ bankId, name }, context),
  );
}
