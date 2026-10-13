import { describe, expect, it } from "vitest";
import { checkMemoryDispatch, effectiveMemoryScope, selectBotMemory } from "./memory-config.js";

describe("effectiveMemoryScope", () => {
  it("uses the bot's own scope when set", () => {
    expect(effectiveMemoryScope("shared", "isolated")).toBe("shared");
  });

  it("falls back to the workspace default when the bot has none", () => {
    expect(effectiveMemoryScope(null, "shared")).toBe("shared");
  });
});

interface Binding {
  id: string;
  botId: string;
  spaceMemoryConfigId: string;
  bankId: string;
}

interface MemoryWorld {
  config: { id: string; spaceId: string; provider: string; defaultMemoryScope: string } | null;
  binding: Binding | null;
  bot: { id: string; spaceId: string; userId: string; memoryScope: string | null } | null;
  members: string[];
}

function world(provider = "hindsight"): MemoryWorld {
  return {
    config: { id: "config-1", spaceId: "space-1", provider, defaultMemoryScope: "shared" },
    binding: { id: "binding-1", botId: "bot-1", spaceMemoryConfigId: "config-1", bankId: "bank-a" },
    bot: { id: "bot-1", spaceId: "space-1", userId: "user-1", memoryScope: null },
    members: ["user-1"],
  };
}

function prismaFor(state: MemoryWorld) {
  return {
    spaceMemoryConfig: {
      findUnique: async ({ where }: { where: { id?: string; spaceId?: string } }) =>
        state.config &&
        (where.id === undefined || where.id === state.config.id) &&
        (where.spaceId === undefined || where.spaceId === state.config.spaceId)
          ? state.config
          : null,
    },
    bot: {
      findFirst: async ({ where }: { where: { id: string; spaceId: string } }) =>
        state.bot?.id === where.id && state.bot.spaceId === where.spaceId
          ? { ...state.bot, memoryBank: state.binding }
          : null,
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.bot?.id === where.id ? state.bot : null,
    },
    botMemoryBank: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.binding?.id === where.id ? state.binding : null,
    },
    spaceMember: {
      findUnique: async ({
        where,
      }: {
        where: { spaceId_userId: { spaceId: string; userId: string } };
      }) =>
        where.spaceId_userId.spaceId === "space-1" &&
        state.members.includes(where.spaceId_userId.userId)
          ? { id: "member-1" }
          : null,
    },
  } as never;
}

const INPUT = { spaceId: "space-1", userId: "user-1", botId: "bot-1" };
const bankCapable = (provider: string) => provider === "hindsight";

describe("selectBotMemory", () => {
  it("selects the bound bank for a bank-capable connection", async () => {
    await expect(selectBotMemory(prismaFor(world()), INPUT, { bankCapable })).resolves.toEqual({
      kind: "bank",
      configId: "config-1",
      provider: "hindsight",
      bindingId: "binding-1",
      bankId: "bank-a",
    });
  });

  it("keeps unbound bots and Spaces without a connection native", async () => {
    const unbound = world();
    unbound.binding = null;
    const disconnected = world();
    disconnected.config = null;

    for (const state of [unbound, disconnected]) {
      await expect(selectBotMemory(prismaFor(state), INPUT, { bankCapable })).resolves.toEqual({
        kind: "native",
      });
    }
  });

  it("selects legacy memory with the bot scope falling back to the Space default", async () => {
    const state = world("supermemory");
    state.binding = null;
    await expect(selectBotMemory(prismaFor(state), INPUT, { bankCapable })).resolves.toEqual({
      kind: "legacy",
      configId: "config-1",
      provider: "supermemory",
      scope: "shared",
    });
    state.bot!.memoryScope = "isolated";
    await expect(selectBotMemory(prismaFor(state), INPUT, { bankCapable })).resolves.toMatchObject({
      scope: "isolated",
    });
  });
});

describe("checkMemoryDispatch", () => {
  const BANK = { ...INPUT, configId: "config-1", bindingId: "binding-1", bankId: "bank-a" };
  const LEGACY = { ...INPUT, configId: "config-1", bindingId: null, bankId: null };

  it("allows the exact captured binding for the bot owner", async () => {
    await expect(checkMemoryDispatch(prismaFor(world()), BANK)).resolves.toBe("ok");
  });

  it("retires a dispatch whose connection or binding changed", async () => {
    const rebound = world();
    rebound.binding = { ...rebound.binding!, bankId: "bank-b" };
    const replaced = world();
    replaced.config = { ...replaced.config!, id: "config-2" };
    const removed = world();
    removed.binding = null;

    for (const state of [rebound, replaced, removed]) {
      await expect(checkMemoryDispatch(prismaFor(state), BANK)).resolves.toBe("binding_retired");
    }
    await expect(
      checkMemoryDispatch(prismaFor(world()), { ...BANK, spaceId: "space-2" }),
    ).resolves.toBe("binding_retired");
  });

  it("forbids a revoked member or another user's bot", async () => {
    const revoked = world();
    revoked.members = [];
    const foreign = world();
    foreign.bot!.userId = "user-2";

    await expect(checkMemoryDispatch(prismaFor(revoked), BANK)).resolves.toBe("forbidden");
    await expect(checkMemoryDispatch(prismaFor(foreign), BANK)).resolves.toBe("forbidden");
    await expect(checkMemoryDispatch(prismaFor(foreign), LEGACY)).resolves.toBe("ok");
    await expect(checkMemoryDispatch(prismaFor(revoked), LEGACY)).resolves.toBe("forbidden");
  });
});
