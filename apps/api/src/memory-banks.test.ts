import type { AdapterContext, MemoryBankDirectory, SecretStore } from "@rakazo/adapter-kit";
import type { createMemoryBankDirectory } from "@rakazo/adapters";
import { MemoryDispatchDeniedError } from "@rakazo/adapters";
import type { Actor, MemoryConnectionFailureReason } from "@rakazo/contracts";
import { MEMORY_FAILURE_MESSAGES } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { commitBotUpdate } from "./bot-update.js";
import type { MemoryBankDeps } from "./memory-banks.js";
import {
  createMemoryBank,
  listMemoryBanks,
  memoryBankCreationId,
  readMemoryBank,
} from "./memory-banks.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "owner@example.test",
  isDeploymentOwner: false,
};

type BotRow = {
  id: string;
  userId: string;
  spaceId: string;
  archivedAt: Date | null;
  name: string;
  title: string;
  description: string;
  instructions: string;
};
type BindingRow = {
  id: string;
  botId: string;
  spaceMemoryConfigId: string;
  bankId: string;
  name: string;
};
type State = {
  members: string[];
  bots: BotRow[];
  config: { id: string; spaceId: string; provider: string } | null;
  bindings: BindingRow[];
};
type CreateDirectory = typeof createMemoryBankDirectory;

function bot(id: string, overrides: Partial<BotRow> = {}): BotRow {
  return {
    id,
    userId: "user-1",
    spaceId: "space-1",
    archivedAt: null,
    name: id,
    title: "",
    description: "",
    instructions: "",
    ...overrides,
  };
}

function setup(overrides: { provider?: string; bindings?: BindingRow[] } = {}) {
  const state: State = {
    members: ["space-1:user-1", "space-2:user-1", "space-1:user-2"],
    bots: [bot("bot-1"), bot("bot-2"), bot("bot-foreign", { userId: "user-2" })],
    config: { id: "cfg-1", spaceId: "space-1", provider: overrides.provider ?? "hindsight" },
    bindings: overrides.bindings ?? [],
  };
  let nextBinding = 0;
  let failBotUpdate = false;
  const matches = (row: BotRow, where: Partial<BotRow>) =>
    Object.entries(where).every(([key, value]) => row[key as keyof BotRow] === value);
  const client = {
    $executeRaw: vi.fn(async () => 1),
    spaceMember: {
      findUnique: async ({
        where,
      }: {
        where: { spaceId_userId: { spaceId: string; userId: string } };
      }) => {
        const key = `${where.spaceId_userId.spaceId}:${where.spaceId_userId.userId}`;
        return state.members.includes(key) ? { id: key } : null;
      },
    },
    bot: {
      findFirst: async ({ where }: { where: Partial<BotRow> }) => {
        const row = state.bots.find((candidate) => matches(candidate, where));
        return row ? { id: row.id } : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<BotRow> }) => {
        if (failBotUpdate) throw new Error("bot write failed");
        const row = state.bots.find((candidate) => candidate.id === where.id)!;
        for (const [key, value] of Object.entries(data)) {
          if (value !== undefined) Object.assign(row, { [key]: value });
        }
        return { id: row.id, name: row.name, title: row.title, description: row.description };
      },
    },
    spaceMemoryConfig: {
      findUnique: async ({ where }: { where: { spaceId: string } }) =>
        state.config?.spaceId === where.spaceId ? { ...state.config } : null,
    },
    botMemoryBank: {
      findUnique: async ({ where }: { where: { botId: string } }) =>
        state.bindings.find((row) => row.botId === where.botId) ?? null,
      create: async ({ data }: { data: Omit<BindingRow, "id"> }) => {
        nextBinding += 1;
        const row = { ...data, id: `binding-new-${nextBinding}` };
        state.bindings.push(row);
        return row;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const row = state.bindings.find((candidate) => candidate.id === where.id)!;
        state.bindings = state.bindings.filter((candidate) => candidate.id !== where.id);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: { name: string } }) => {
        const row = state.bindings.find((candidate) => candidate.id === where.id)!;
        row.name = data.name;
        return row;
      },
    },
  };
  const transaction = vi.fn(
    async (callback: (tx: typeof client) => Promise<unknown>, _options?: unknown) => {
      const snapshot = structuredClone(state);
      try {
        return await callback(client);
      } catch (error) {
        Object.assign(state, snapshot);
        throw error;
      }
    },
  );
  const prisma = { ...client, $transaction: transaction } as unknown as PrismaClient;

  const cloud = new Map<string, string>([
    ["bank-a", "Alpha"],
    ["bank-b", "Beta"],
  ]);
  const requests: string[] = [];
  const failures: Partial<Record<"list" | "read" | "create", MemoryConnectionFailureReason>> = {};
  const hooks: { afterAuthorization?: () => void } = {};
  const createDirectory = vi.fn<CreateDirectory>(async (_deps, _input, options) => {
    hooks.afterAuthorization?.();
    const send = async <T>(
      operation: "list" | "read" | "create",
      context: AdapterContext,
      label: string,
      run: () => T,
    ) => {
      try {
        await options?.beforeRequest?.(context);
      } catch (error) {
        if (error instanceof MemoryDispatchDeniedError) {
          return { ok: false as const, code: error.code, error: error.message };
        }
        throw error;
      }
      requests.push(label);
      const failure = failures[operation];
      if (failure) return { ok: false as const, code: failure, error: "upstream" };
      return { ok: true as const, value: run() };
    };
    const directory: MemoryBankDirectory = {
      list: (request, context) =>
        send("list", context, `list:${request.q ?? ""}:${request.offset}:${request.limit}`, () => ({
          banks: [...cloud].map(([bankId, name]) => ({ bankId, name })),
          nextOffset: null,
        })),
      read: async (bankId, context) => {
        const result = await send("read", context, `read:${bankId}`, () => cloud.get(bankId));
        if (!result.ok) return result;
        return result.value === undefined
          ? { ok: false, code: "not_found", error: "missing" }
          : { ok: true, value: { bankId, name: result.value } };
      },
      create: (request, context) =>
        send("create", context, `create:${request.bankId}`, () => {
          if (!cloud.has(request.bankId)) cloud.set(request.bankId, request.name);
          return { bankId: request.bankId, name: cloud.get(request.bankId)! };
        }),
    };
    return { directory };
  });
  const deps = {
    prisma,
    secrets: {} as SecretStore,
    createDirectory,
  };
  return {
    state,
    deps,
    cloud,
    requests,
    failures,
    hooks,
    createDirectory,
    transaction,
    failBotUpdate: () => {
      failBotUpdate = true;
    },
  };
}

function update(
  env: { deps: MemoryBankDeps },
  input: {
    botId?: string;
    expectedBindingId: string | null;
    bankId: string | null;
    title?: string;
  },
) {
  const botId = input.botId ?? "bot-1";
  return commitBotUpdate({
    prisma: env.deps.prisma,
    notify: async () => {},
    spaceId: actor.spaceId,
    threadId: "thread-1",
    botId,
    emitBotUpdated: false,
    data: { title: input.title },
    memoryBank: {
      userId: actor.userId,
      configId: "cfg-1",
      expectedBindingId: input.expectedBindingId,
      bankId: input.bankId,
      readBank: (bankId) => readMemoryBank(env.deps, actor, { botId, configId: "cfg-1", bankId }),
    },
  });
}

describe("memory bank metadata", () => {
  it("lists banks for the actor's bot through the current connection", async () => {
    const env = setup();
    await expect(
      listMemoryBanks(env.deps, actor, { botId: "bot-1", configId: "cfg-1", q: "al", offset: 50 }),
    ).resolves.toEqual({
      banks: [
        { bankId: "bank-a", name: "Alpha" },
        { bankId: "bank-b", name: "Beta" },
      ],
      nextOffset: null,
    });
    expect(env.createDirectory).toHaveBeenCalledWith(
      expect.anything(),
      { configId: "cfg-1", spaceId: "space-1" },
      expect.anything(),
    );
    expect(env.requests).toEqual(["list:al:50:50"]);
  });

  it.each([
    ["another owner's bot", { userId: "user-1", spaceId: "space-1" }, "bot-foreign"],
    ["a bot from another Space", { userId: "user-1", spaceId: "space-2" }, "bot-1"],
    ["a revoked member", { userId: "user-3", spaceId: "space-1" }, "bot-1"],
  ])("denies %s before any credential or HTTP use", async (_label, scope, botId) => {
    const env = setup();
    const caller = { ...actor, ...scope };
    const attempts = [
      () => listMemoryBanks(env.deps, caller, { botId, configId: "cfg-1" }),
      () => readMemoryBank(env.deps, caller, { botId, configId: "cfg-1", bankId: "bank-a" }),
      () =>
        createMemoryBank(env.deps, caller, {
          botId,
          configId: "cfg-1",
          requestId: "00000000-0000-4000-8000-000000000001",
          name: "Notes",
        }),
    ];
    for (const attempt of attempts) {
      const error = await attempt().catch((caught: unknown) => caught);
      if (caller.userId === "user-3") expect(error).toMatchObject({ code: "FORBIDDEN" });
      else expect(error).toBeInstanceOf(IsolationError);
    }
    expect(env.createDirectory).not.toHaveBeenCalled();
    expect(env.requests).toEqual([]);
  });

  it("returns CONFLICT for a stale connection and BAD_REQUEST for a legacy one, without HTTP", async () => {
    const stale = setup();
    await expect(
      readMemoryBank(stale.deps, actor, { botId: "bot-1", configId: "cfg-old", bankId: "bank-a" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const legacy = setup({ provider: "supermemory" });
    await expect(
      listMemoryBanks(legacy.deps, actor, { botId: "bot-1", configId: "cfg-1" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(stale.createDirectory).not.toHaveBeenCalled();
    expect(legacy.createDirectory).not.toHaveBeenCalled();
  });

  it("stops a request when membership is revoked after authorization", async () => {
    const env = setup();
    env.hooks.afterAuthorization = () => {
      env.state.members = env.state.members.filter((member) => member !== "space-1:user-1");
    };
    await expect(
      readMemoryBank(env.deps, actor, { botId: "bot-1", configId: "cfg-1", bankId: "bank-a" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(env.createDirectory).toHaveBeenCalledOnce();
    expect(env.requests).toEqual([]);
  });

  it("stops a request when the connection is replaced after authorization", async () => {
    const env = setup();
    env.hooks.afterAuthorization = () => {
      env.state.config = { id: "cfg-2", spaceId: "space-1", provider: "hindsight" };
    };
    await expect(
      listMemoryBanks(env.deps, actor, { botId: "bot-1", configId: "cfg-1" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(env.createDirectory).toHaveBeenCalledOnce();
    expect(env.requests).toEqual([]);
  });

  it("maps provider failures to a safe reason", async () => {
    const env = setup();
    env.failures.list = "bank_list_forbidden";
    const error = await listMemoryBanks(env.deps, actor, {
      botId: "bot-1",
      configId: "cfg-1",
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "BAD_REQUEST",
      message: MEMORY_FAILURE_MESSAGES.bank_list_forbidden,
      data: { reason: "bank_list_forbidden" },
    });
  });

  it("derives a deterministic creation ID from the connection, bot, intent and trimmed name", () => {
    const id = memoryBankCreationId("cfg-1", "bot-1", "request-1", "Notes");
    expect(id).toMatch(/^rakazo-[0-9a-f]{32}$/);
    expect(memoryBankCreationId("cfg-1", "bot-1", "request-1", "  Notes ")).toBe(id);
    for (const other of [
      memoryBankCreationId("cfg-2", "bot-1", "request-1", "Notes"),
      memoryBankCreationId("cfg-1", "bot-2", "request-1", "Notes"),
      memoryBankCreationId("cfg-1", "bot-1", "request-2", "Notes"),
      memoryBankCreationId("cfg-1", "bot-1", "request-1", "Notes 2"),
    ]) {
      expect(other).not.toBe(id);
    }
  });

  it("reuses the bank created by an uncertain earlier attempt with the same intent", async () => {
    const env = setup();
    const input = {
      botId: "bot-1",
      configId: "cfg-1",
      requestId: "00000000-0000-4000-8000-000000000001",
      name: "Notes",
    };
    const first = await createMemoryBank(env.deps, actor, input);
    env.cloud.set(first.bankId, "Renamed in Cloud");
    const second = await createMemoryBank(env.deps, actor, input);
    expect(first.bankId).toBe(memoryBankCreationId("cfg-1", "bot-1", input.requestId, "Notes"));
    expect(second).toEqual({ bankId: first.bankId, name: "Renamed in Cloud" });
    expect(env.requests).toEqual([`create:${first.bankId}`, `create:${first.bankId}`]);
    expect([...env.cloud.keys()]).toEqual(["bank-a", "bank-b", first.bankId]);
  });
});

describe("bot memory bank binding", () => {
  it("binds a verified bank together with the bot fields", async () => {
    const env = setup();
    await update(env, { expectedBindingId: null, bankId: "bank-a", title: "Researcher" });
    expect(env.requests).toEqual(["read:bank-a"]);
    expect(env.state.bindings).toEqual([
      {
        id: "binding-new-1",
        botId: "bot-1",
        spaceMemoryConfigId: "cfg-1",
        bankId: "bank-a",
        name: "Alpha",
      },
    ]);
    expect(env.state.bots[0]!.title).toBe("Researcher");
    expect(env.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
  });

  it("lets two bots explicitly share one bank", async () => {
    const env = setup();
    await update(env, { botId: "bot-1", expectedBindingId: null, bankId: "bank-a" });
    await update(env, { botId: "bot-2", expectedBindingId: null, bankId: "bank-a" });
    expect(env.state.bindings.map((row) => [row.botId, row.bankId])).toEqual([
      ["bot-1", "bank-a"],
      ["bot-2", "bank-a"],
    ]);
  });

  it("keeps the binding identity when the same bank is saved again", async () => {
    const binding = {
      id: "binding-1",
      botId: "bot-1",
      spaceMemoryConfigId: "cfg-1",
      bankId: "bank-a",
      name: "Alpha",
    };
    const env = setup({ bindings: [binding] });
    await update(env, { expectedBindingId: "binding-1", bankId: "bank-a" });
    await update(env, { expectedBindingId: "binding-1", bankId: "bank-a" });
    expect(env.state.bindings).toEqual([binding]);
  });

  it("replaces the binding identity when a different bank is chosen", async () => {
    const env = setup({
      bindings: [
        {
          id: "binding-1",
          botId: "bot-1",
          spaceMemoryConfigId: "cfg-1",
          bankId: "bank-a",
          name: "Alpha",
        },
      ],
    });
    await update(env, { expectedBindingId: "binding-1", bankId: "bank-b" });
    expect(env.state.bindings).toEqual([
      expect.objectContaining({ id: "binding-new-1", bankId: "bank-b", name: "Beta" }),
    ]);
  });

  it("unbinds without any Cloud request", async () => {
    const env = setup({
      bindings: [
        {
          id: "binding-1",
          botId: "bot-1",
          spaceMemoryConfigId: "cfg-1",
          bankId: "bank-a",
          name: "Alpha",
        },
      ],
    });
    await update(env, { expectedBindingId: "binding-1", bankId: null });
    expect(env.state.bindings).toEqual([]);
    expect(env.createDirectory).not.toHaveBeenCalled();
    expect(env.requests).toEqual([]);
  });

  it.each([
    ["a stale expected binding", { expectedBindingId: null, bankId: "bank-b" }],
    ["a stale unbind", { expectedBindingId: "binding-other", bankId: null }],
  ])("rejects %s without changing any field", async (_label, input) => {
    const env = setup({
      bindings: [
        {
          id: "binding-1",
          botId: "bot-1",
          spaceMemoryConfigId: "cfg-1",
          bankId: "bank-a",
          name: "Alpha",
        },
      ],
    });
    const before = structuredClone(env.state);
    await expect(update(env, { ...input, title: "Changed" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(env.state).toEqual(before);
  });

  it("does not resubmit over a binding committed by a lost first response", async () => {
    const env = setup();
    await update(env, { expectedBindingId: null, bankId: "bank-a" });
    const committed = structuredClone(env.state.bindings);
    await expect(update(env, { expectedBindingId: null, bankId: "bank-a" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(env.state.bindings).toEqual(committed);
  });

  it("rejects a selection whose connection was replaced after the profile check", async () => {
    const env = setup();
    const before = structuredClone(env.state);
    await expect(
      commitBotUpdate({
        prisma: env.deps.prisma,
        notify: async () => {},
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        emitBotUpdated: false,
        data: { title: "Changed" },
        memoryBank: {
          userId: "user-1",
          configId: "cfg-1",
          expectedBindingId: null,
          bankId: "bank-a",
          readBank: async (bankId) => {
            const bank = await readMemoryBank(env.deps, actor, {
              botId: "bot-1",
              configId: "cfg-1",
              bankId,
            });
            env.state.config = { id: "cfg-2", spaceId: "space-1", provider: "hindsight" };
            return bank;
          },
        },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect({ ...env.state, config: before.config }).toEqual(before);
  });

  it("rolls back the binding when the bot write fails", async () => {
    const env = setup();
    env.failBotUpdate();
    await expect(update(env, { expectedBindingId: null, bankId: "bank-a" })).rejects.toThrow(
      "bot write failed",
    );
    expect(env.state.bindings).toEqual([]);
  });

  it("changes nothing when the bank profile cannot be verified", async () => {
    const env = setup();
    await expect(
      update(env, { expectedBindingId: null, bankId: "bank-missing", title: "Changed" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", data: { reason: "not_found" } });
    expect(env.transaction).not.toHaveBeenCalled();
    expect(env.state.bindings).toEqual([]);
    expect(env.state.bots[0]!.title).toBe("");
  });

  it("rejects an unbind by a member who no longer belongs to the Space", async () => {
    const env = setup({
      bindings: [
        {
          id: "binding-1",
          botId: "bot-1",
          spaceMemoryConfigId: "cfg-1",
          bankId: "bank-a",
          name: "Alpha",
        },
      ],
    });
    env.state.members = [];
    const before = structuredClone(env.state);
    await expect(
      update(env, { expectedBindingId: "binding-1", bankId: null, title: "Changed" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(env.state).toEqual(before);
  });
});
