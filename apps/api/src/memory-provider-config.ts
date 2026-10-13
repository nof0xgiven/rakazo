import { ORPCError } from "@orpc/server";
import type { MemoryTransport, SecretStore } from "@rakazo/adapter-kit";
import type { PreparedMemoryProviderConnection } from "@rakazo/adapters";
import {
  classifyMemoryProviderSettings,
  MemoryProviderConnectionError,
  MemoryProviderDeploymentOwnerRequiredError,
  memoryProviderCapabilities,
  memoryProviderRequiresDeploymentOwner,
  persistPreparedSecret,
  prepareMemoryProviderConnection,
  toStringRecord,
} from "@rakazo/adapters";
import type { Actor, MemoryScopeValue, SpaceMemoryConfig } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { findSpaceMemoryConfig, Prisma } from "@rakazo/db";
import { memoryProviderFailure } from "./memory-banks.js";
import { withSerializableRetry } from "./serializable-retry.js";

export interface MemoryProviderConfigDeps {
  prisma: PrismaClient;
  secrets: SecretStore;
  memoryTransport?: MemoryTransport;
  classifySettings?: (
    provider: string,
    settings: Record<string, string>,
  ) => Promise<Record<string, string>>;
  prepareConnection?: typeof prepareMemoryProviderConnection;
}

type SpaceMemberReader = Pick<PrismaClient, "spaceMember"> | Prisma.TransactionClient;

async function requireSpaceOwner(prisma: SpaceMemberReader, actor: Actor): Promise<void> {
  const member = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
    select: { role: true },
  });
  const roles = member?.role.split(",").map((role) => role.trim());
  if (!roles?.includes("owner")) throw new ORPCError("FORBIDDEN");
}

export async function persistMemoryProviderConfig(
  deps: MemoryProviderConfigDeps,
  actor: Actor,
  input: {
    provider: string;
    settings: Record<string, string>;
    credentials: Record<string, string>;
    defaultMemoryScope: MemoryScopeValue;
    expectedConfigId: string | null;
  },
  signal: AbortSignal = new AbortController().signal,
): Promise<SpaceMemoryConfig> {
  await requireSpaceOwner(deps.prisma, actor);
  const current = await findSpaceMemoryConfig(deps.prisma, actor.spaceId);
  if ((current?.id ?? null) !== input.expectedConfigId) throw new ORPCError("CONFLICT");
  let denied: ORPCError<string, unknown> | undefined;
  let prepared: PreparedMemoryProviderConnection;
  try {
    if (
      memoryProviderRequiresDeploymentOwner(input.provider, input.settings) &&
      !actor.isDeploymentOwner
    ) {
      throw new ORPCError("FORBIDDEN");
    }
    const classify = deps.classifySettings ?? classifyMemoryProviderSettings;
    const prepare = deps.prepareConnection ?? prepareMemoryProviderConnection;
    const classifiedSettings = await classify(input.provider, input.settings);
    if (
      memoryProviderRequiresDeploymentOwner(input.provider, classifiedSettings) &&
      !actor.isDeploymentOwner
    ) {
      throw new ORPCError("FORBIDDEN");
    }
    prepared = await prepare(
      {
        provider: input.provider,
        settings: classifiedSettings,
        credentials: input.credentials,
        allowPrivateEndpoint: actor.isDeploymentOwner,
      },
      {
        signal,
        memoryTransport: deps.memoryTransport,
        beforeRequest: async () => {
          try {
            await requireSpaceOwner(deps.prisma, actor);
          } catch (error) {
            denied = error instanceof ORPCError ? error : new ORPCError("FORBIDDEN");
            throw denied;
          }
        },
      },
    );
    if (
      memoryProviderRequiresDeploymentOwner(prepared.provider, prepared.settings) &&
      !actor.isDeploymentOwner
    ) {
      throw new ORPCError("FORBIDDEN");
    }
  } catch (error) {
    if (denied) throw denied;
    if (error instanceof ORPCError) throw error;
    if (error instanceof MemoryProviderDeploymentOwnerRequiredError) {
      throw new ORPCError("FORBIDDEN");
    }
    if (error instanceof MemoryProviderConnectionError) throw memoryProviderFailure(error.reason);
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "Memory provider connection failed",
    });
  }
  const capabilities = memoryProviderCapabilities(prepared.provider);
  const stored = await deps.secrets.put(JSON.stringify(prepared.credentials), {
    operationId: "memory-provider-config",
    traceId: "memory-provider-config",
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal,
  });
  const config = await persistPreparedSecret(deps.prisma, deps.secrets, stored, () =>
    withSerializableRetry(() =>
      deps.prisma.$transaction(
        async (tx) => {
          await requireSpaceOwner(tx, actor);
          const existing = await findSpaceMemoryConfig(tx, actor.spaceId);
          if ((existing?.id ?? null) !== input.expectedConfigId) {
            throw new ORPCError("CONFLICT");
          }
          if (existing) {
            await tx.spaceMemoryConfig.delete({ where: { id: existing.id } });
            await tx.secret.deleteMany({ where: { id: existing.secretId } });
          }
          await tx.secret.create({
            data: {
              id: stored.id,
              userId: actor.userId,
              spaceId: actor.spaceId,
              kind: "memory-provider",
              ciphertext: stored.ciphertext,
            },
          });
          return tx.spaceMemoryConfig.create({
            data: {
              spaceId: actor.spaceId,
              userId: actor.userId,
              provider: prepared.provider,
              settings: prepared.settings,
              secretId: stored.id,
              defaultMemoryScope: capabilities.sharedScope ? input.defaultMemoryScope : "isolated",
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    ),
  );
  return serializeSpaceMemoryConfig(config);
}

export async function updateMemoryProviderDefaultScope(
  deps: MemoryProviderConfigDeps,
  actor: Actor,
  input: { configId: string; defaultMemoryScope: MemoryScopeValue },
): Promise<SpaceMemoryConfig> {
  await requireSpaceOwner(deps.prisma, actor);
  const existing = await findSpaceMemoryConfig(deps.prisma, actor.spaceId);
  if (!existing || existing.id !== input.configId) throw new ORPCError("CONFLICT");
  if (!memoryProviderCapabilities(existing.provider).sharedScope) {
    throw new ORPCError("BAD_REQUEST", {
      message: "This memory connection does not support a default scope.",
    });
  }
  const { count } = await deps.prisma.spaceMemoryConfig.updateMany({
    where: { id: existing.id, spaceId: actor.spaceId },
    data: { defaultMemoryScope: input.defaultMemoryScope },
  });
  const updated = count
    ? await deps.prisma.spaceMemoryConfig.findUnique({ where: { id: existing.id } })
    : null;
  if (!updated) throw new ORPCError("CONFLICT");
  return serializeSpaceMemoryConfig(updated);
}

export function serializeSpaceMemoryConfig(config: {
  id: string;
  provider: string;
  settings: unknown;
  defaultMemoryScope: string;
  updatedAt: Date;
}): SpaceMemoryConfig {
  const capabilities = memoryProviderCapabilities(config.provider);
  return {
    id: config.id,
    provider: config.provider,
    settings: toStringRecord(config.settings),
    defaultMemoryScope: config.defaultMemoryScope === "shared" ? "shared" : "isolated",
    capabilities: {
      banks: capabilities.banks === true,
      sharedScope: capabilities.sharedScope,
    },
    updatedAt: config.updatedAt.toISOString(),
  };
}

export async function disconnectMemoryProvider(
  deps: MemoryProviderConfigDeps,
  actor: Actor,
  input: { configId: string },
): Promise<{ ok: true }> {
  await requireSpaceOwner(deps.prisma, actor);
  await withSerializableRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        const existing = await findSpaceMemoryConfig(tx, actor.spaceId);
        if (!existing) return;
        if (existing.id !== input.configId) throw new ORPCError("CONFLICT");
        await tx.spaceMemoryConfig.delete({ where: { id: existing.id } });
        await tx.secret.deleteMany({ where: { id: existing.secretId } });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  return { ok: true as const };
}
