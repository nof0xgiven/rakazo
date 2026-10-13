import {
  appendEventInTransaction,
  type Prisma,
  type PrismaClient,
  withModelConfigurationOwnerLock,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

type AppendEvent = typeof appendEventInTransaction;

const botUpdateSelect = { id: true, name: true, title: true, description: true } as const;

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
  },
  appendEvent: AppendEvent = appendEventInTransaction,
): Promise<{ id: string; name: string; title: string; description: string }> {
  const validateModelChoice = options.validateModelChoice;
  if (!options.emitBotUpdated && !validateModelChoice) {
    return options.prisma.bot.update({
      where: { id: options.botId },
      data: options.data,
      select: botUpdateSelect,
    });
  }

  const write = async (tx: Prisma.TransactionClient) => {
    await validateModelChoice?.(tx);
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
