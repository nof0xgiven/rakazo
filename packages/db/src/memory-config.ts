import type { MemorySelection } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";

export function findSpaceMemoryConfig(
  prisma: Pick<PrismaClient, "spaceMemoryConfig">,
  spaceId: string,
) {
  return prisma.spaceMemoryConfig.findUnique({ where: { spaceId } });
}

export function effectiveMemoryScope(
  botScope: string | null,
  defaultScope: string,
): "isolated" | "shared" {
  const scope = botScope ?? defaultScope;
  return scope === "shared" ? "shared" : "isolated";
}

export async function selectBotMemory(
  prisma: Pick<PrismaClient, "spaceMemoryConfig" | "bot">,
  input: { spaceId: string; userId: string; botId: string },
  options: { bankCapable: (provider: string) => boolean },
): Promise<MemorySelection> {
  const [config, bot] = await Promise.all([
    prisma.spaceMemoryConfig.findUnique({
      where: { spaceId: input.spaceId },
      select: { id: true, provider: true, defaultMemoryScope: true },
    }),
    prisma.bot.findFirst({
      where: { id: input.botId, spaceId: input.spaceId },
      select: {
        memoryScope: true,
        memoryBank: { select: { id: true, spaceMemoryConfigId: true, bankId: true } },
      },
    }),
  ]);
  if (!config || !bot) return { kind: "native" };
  if (!options.bankCapable(config.provider)) {
    return {
      kind: "legacy",
      configId: config.id,
      provider: config.provider,
      scope: effectiveMemoryScope(bot.memoryScope, config.defaultMemoryScope),
    };
  }
  const binding = bot.memoryBank;
  if (!binding || binding.spaceMemoryConfigId !== config.id) return { kind: "native" };
  return {
    kind: "bank",
    configId: config.id,
    provider: config.provider,
    bindingId: binding.id,
    bankId: binding.bankId,
  };
}

export async function checkMemoryDispatch(
  prisma: Pick<PrismaClient, "spaceMemoryConfig" | "botMemoryBank" | "spaceMember" | "bot">,
  input: {
    configId: string;
    bindingId: string | null;
    bankId: string | null;
    spaceId: string;
    userId: string;
    botId: string;
  },
): Promise<"ok" | "binding_retired" | "forbidden"> {
  if ((input.bindingId === null) !== (input.bankId === null)) return "binding_retired";
  const [config, binding, member, bot] = await Promise.all([
    prisma.spaceMemoryConfig.findUnique({
      where: { id: input.configId },
      select: { spaceId: true },
    }),
    input.bindingId === null
      ? null
      : prisma.botMemoryBank.findUnique({
          where: { id: input.bindingId },
          select: { spaceMemoryConfigId: true, bankId: true, botId: true },
        }),
    prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: input.spaceId, userId: input.userId } },
      select: { id: true },
    }),
    prisma.bot.findUnique({
      where: { id: input.botId },
      select: { spaceId: true, userId: true },
    }),
  ]);
  if (!config || config.spaceId !== input.spaceId) return "binding_retired";
  if (
    input.bindingId !== null &&
    (!binding ||
      binding.spaceMemoryConfigId !== input.configId ||
      binding.bankId !== input.bankId ||
      binding.botId !== input.botId)
  ) {
    return "binding_retired";
  }
  if (!member || !bot || bot.spaceId !== input.spaceId) return "forbidden";
  if (input.bindingId !== null && bot.userId !== input.userId) return "forbidden";
  return "ok";
}
