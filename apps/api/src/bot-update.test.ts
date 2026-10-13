import type * as Db from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  appendEventInTransaction: vi.fn(),
}));

import { botProfileLabelsChanged, commitBotUpdate } from "./bot-update.js";

describe("botProfileLabelsChanged", () => {
  it("is true when name, title, description, or color is present", () => {
    expect(botProfileLabelsChanged({})).toBe(false);
    expect(botProfileLabelsChanged({ name: "SEO" })).toBe(true);
    expect(botProfileLabelsChanged({ title: "Strategist" })).toBe(true);
    expect(botProfileLabelsChanged({ description: "Helps with SEO" })).toBe(true);
    expect(botProfileLabelsChanged({ color: "#8B5CF6::shape_1" })).toBe(true);
  });
});

describe("commitBotUpdate", () => {
  it("writes the bot row and bot.updated in one transaction when labels change", async () => {
    const updated = {
      id: "bot-1",
      name: "SEO Strategist",
      title: "SEO Strategist",
      description: "Helps with keyword research",
    };
    const botUpdate = vi.fn().mockResolvedValue(updated);
    const tx = { bot: { update: botUpdate } };
    const transaction = vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx));
    const notify = vi.fn().mockResolvedValue(undefined);
    const appendEvent = vi.fn().mockResolvedValue({ seq: 9 });
    const prisma = {
      $transaction: transaction,
      bot: { update: vi.fn() },
    };

    await expect(
      commitBotUpdate(
        {
          prisma: prisma as never,
          notify,
          spaceId: "space-1",
          threadId: "thread-1",
          botId: "bot-1",
          data: { name: "SEO Strategist", title: "SEO Strategist" },
          emitBotUpdated: true,
        },
        appendEvent,
      ),
    ).resolves.toEqual(updated);

    expect(transaction).toHaveBeenCalledOnce();
    expect(botUpdate).toHaveBeenCalledOnce();
    expect(appendEvent).toHaveBeenCalledWith(tx, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      type: "bot.updated",
      payload: {
        botId: "bot-1",
        name: "SEO Strategist",
        title: "SEO Strategist",
        description: "Helps with keyword research",
      },
    });
    expect(notify).toHaveBeenCalledWith("thread-1", 9);
    expect(prisma.bot.update).not.toHaveBeenCalled();
  });

  it("fails the whole update when the durable event write fails", async () => {
    const appendEvent = vi.fn().mockRejectedValue(new Error("event store unavailable"));
    const transaction = vi.fn(async (run: (client: unknown) => Promise<unknown>) =>
      run({
        bot: {
          update: vi.fn().mockResolvedValue({
            id: "bot-1",
            name: "SEO",
            title: "SEO",
            description: "",
          }),
        },
      }),
    );
    const notify = vi.fn();
    const prisma = {
      $transaction: transaction,
      bot: { update: vi.fn() },
    };

    await expect(
      commitBotUpdate(
        {
          prisma: prisma as never,
          notify,
          spaceId: "space-1",
          threadId: "thread-1",
          botId: "bot-1",
          data: { name: "SEO" },
          emitBotUpdated: true,
        },
        appendEvent,
      ),
    ).rejects.toThrow("event store unavailable");
    expect(notify).not.toHaveBeenCalled();
    expect(prisma.bot.update).not.toHaveBeenCalled();
  });

  it("updates without an event when profile labels are unchanged", async () => {
    const update = vi.fn().mockResolvedValue({
      id: "bot-1",
      name: "Chief",
      title: "Chief",
      description: "",
    });
    const prisma = {
      $transaction: vi.fn(),
      bot: { update },
    };
    const notify = vi.fn();
    const appendEvent = vi.fn();

    await expect(
      commitBotUpdate(
        {
          prisma: prisma as never,
          notify,
          spaceId: "space-1",
          threadId: "thread-1",
          botId: "bot-1",
          data: { pinned: true },
          emitBotUpdated: false,
        },
        appendEvent,
      ),
    ).resolves.toMatchObject({ id: "bot-1" });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(appendEvent).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledOnce();
  });

  it("writes a model-only save in the owner-locked transaction after validating it", async () => {
    const order: string[] = [];
    const updated = { id: "bot-1", name: "Chief", title: "", description: "" };
    const tx = {
      $queryRaw: vi.fn(async (_query: TemplateStringsArray, ..._values: unknown[]) => {
        order.push("owner");
        return [{ id: "user-1" }];
      }),
      bot: {
        update: vi.fn(async () => {
          order.push("update");
          return updated;
        }),
      },
    };
    const transaction = vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx));
    const prisma = { $transaction: transaction, bot: { update: vi.fn() } };
    const appendEvent = vi.fn();
    const notify = vi.fn();
    const validateModelChoice = vi.fn(async (client: unknown) => {
      expect(client).toBe(tx);
      order.push("validate");
    });

    await expect(
      commitBotUpdate(
        {
          prisma: prisma as never,
          notify,
          spaceId: "space-1",
          threadId: "thread-1",
          botId: "bot-1",
          data: { modelProvider: "openai-compatible", modelId: "model-b", thinkingLevel: null },
          emitBotUpdated: false,
          validateModelChoice,
          modelOwnerUserId: "user-1",
        },
        appendEvent,
      ),
    ).resolves.toEqual(updated);

    expect(order).toEqual(["owner", "validate", "update"]);
    expect(tx.$queryRaw.mock.calls[0]?.slice(1)).toEqual(["user-1"]);
    expect(transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: "ReadCommitted" }),
    );
    expect(prisma.bot.update).not.toHaveBeenCalled();
    expect(appendEvent).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("writes nothing when the model choice fails validation inside the lock", async () => {
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: "user-1" }]),
      bot: { update: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
      bot: { update: vi.fn() },
    };
    const appendEvent = vi.fn();
    const disabled = new Error("This model is not enabled for the connection.");

    await expect(
      commitBotUpdate(
        {
          prisma: prisma as never,
          notify: vi.fn(),
          spaceId: "space-1",
          threadId: "thread-1",
          botId: "bot-1",
          data: { name: "Renamed", thinkingLevel: "high" },
          emitBotUpdated: true,
          validateModelChoice: async () => {
            throw disabled;
          },
          modelOwnerUserId: "user-1",
        },
        appendEvent,
      ),
    ).rejects.toBe(disabled);
    expect(tx.bot.update).not.toHaveBeenCalled();
    expect(appendEvent).not.toHaveBeenCalled();
  });
});
