import { ORPCError } from "@orpc/server";
import type { MemoryBank } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  IsolationError,
  Prisma,
  withModelConfigurationOwnerLock,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

type AppendEvent = typeof appendEventInTransaction;

const botUpdateSelect = { id: true, name: true, title: true, description: true } as const;

export interface BotMemoryBankChange {
  userId: string;
  configId: string;
  expectedBindingId: string | null;
  bankId: string | null;
  readBank(bankId: string): Promise<MemoryBank>;
}

type CommittedBot = { id: string; name: string; title: string; description: string };

async function applyMemoryBankChange(
  tx: Prisma.TransactionClient,
  options: { spaceId: string; botId: string },
  change: BotMemoryBankChange,
  bank: MemoryBank | null,
): Promise<void> {
  await tx.$executeRaw`SELECT id FROM bots WHERE id = ${options.botId} FOR UPDATE`;
  const [bot, member, config, binding] = await Promise.all([
    tx.bot.findFirst({
      where: { id: options.botId, userId: change.userId, spaceId: options.spaceId },
      select: { id: true },
    }),
    tx.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: options.spaceId, userId: change.userId } },
      select: { id: true },
    }),
    tx.spaceMemoryConfig.findUnique({ where: { spaceId: options.spaceId }, select: { id: true } }),
    tx.botMemoryBank.findUnique({ where: { botId: options.botId } }),
  ]);
  if (!member) throw new ORPCError("FORBIDDEN");
  if (!bot) throw new IsolationError();
  if (!config || config.id !== change.configId) throw new ORPCError("CONFLICT");
  if ((binding?.id ?? null) !== change.expectedBindingId) throw new ORPCError("CONFLICT");
  if (
    bank &&
    binding &&
    binding.spaceMemoryConfigId === config.id &&
    binding.bankId === bank.bankId
  ) {
    if (binding.name !== bank.name) {
      await tx.botMemoryBank.update({ where: { id: binding.id }, data: { name: bank.name } });
    }
    return;
  }
  if (binding) await tx.botMemoryBank.delete({ where: { id: binding.id } });
  if (bank) {
    await tx.botMemoryBank.create({
      data: {
        botId: options.botId,
        spaceMemoryConfigId: config.id,
        bankId: bank.bankId,
        name: bank.name,
      },
    });
  }
}

/**
 * Persist a bot row. When profile labels change, write `bot.updated` in the same
 * transaction so clients never observe a successful rename without a durable event.
 * A model or effort change runs under the model-configuration owner lock and is
 * validated inside it, so it cannot reference a model that was just disabled.
 * Realtime notify stays best-effort after commit.
 */
export async function commitBotUpdate(
  options: {
    prisma: PrismaClient;
    notify: (threadId: string, seq: number) => Promise<void>;
    spaceId: string;
    threadId: string;
    botId: string;
    data: Prisma.BotUncheckedUpdateInput;
    emitBotUpdated: boolean;
    validateModelChoice?: (tx: Prisma.TransactionClient) => Promise<void>;
    modelOwnerUserId?: string;
    memoryBank?: BotMemoryBankChange;
  },
  appendEvent: AppendEvent = appendEventInTransaction,
): Promise<CommittedBot> {
  const validateModelChoice = options.validateModelChoice;
  const change = options.memoryBank;
  if (!options.emitBotUpdated && !validateModelChoice && !change) {
    return options.prisma.bot.update({
      where: { id: options.botId },
      data: options.data,
      select: botUpdateSelect,
    });
  }
  const bank = change?.bankId != null ? await change.readBank(change.bankId) : null;
  const write = async (tx: Prisma.TransactionClient) => {
    await validateModelChoice?.(tx);
    if (change) await applyMemoryBankChange(tx, options, change, bank);
    const updated = await tx.bot.update({
      where: { id: options.botId },
      data: options.data,
      select: botUpdateSelect,
    });
    if (!options.emitBotUpdated) return { updated, seq: null };
    const event = await appendEvent(tx, {
      spaceId: options.spaceId,
      threadId: options.threadId,
      botId: options.botId,
      type: "bot.updated",
      payload: {
        botId: updated.id,
        name: updated.name,
        title: updated.title,
        description: updated.description,
      },
    });
    return { updated, seq: event.seq };
  };
  const ownerUserId = options.modelOwnerUserId;
  if (validateModelChoice && !ownerUserId) {
    throw new Error("A model change needs its configuration owner");
  }
  const committed =
    validateModelChoice && ownerUserId
      ? await withModelConfigurationOwnerLock(options.prisma, ownerUserId, write)
      : change
        ? await withTransactionRetry(() =>
            options.prisma.$transaction(write, {
              isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            }),
          )
        : await options.prisma.$transaction(write);

  if (committed.seq !== null) {
    await options.notify(options.threadId, committed.seq).catch((error) => {
      getLogger().error("bot.updated realtime notification", error);
    });
  }
  return committed.updated;
}

export function botProfileLabelsChanged(input: {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  color?: unknown;
}): boolean {
  return (
    input.name !== undefined ||
    input.title !== undefined ||
    input.description !== undefined ||
    input.color !== undefined
  );
}
