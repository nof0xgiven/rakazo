import type { ConnectorTool, SemanticMemoryCapabilities } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { QUEUED_SAVE_MEMORY_DESCRIPTION, selectMemoryTools } from "./memory-tools.js";

function tool(name: string): ConnectorTool {
  return { name, description: name, inputSchema: { type: "object", properties: {} } };
}

const allMemoryTools = [
  tool("remember"),
  tool("recall_memory"),
  tool("save_memory"),
  tool("forget_memory"),
  tool("save_shared_memory"),
  tool("shell"),
];

const legacy: SemanticMemoryCapabilities = {
  recall: true,
  save: true,
  purgeHistory: true,
  sharedScope: true,
};

const bank: SemanticMemoryCapabilities = {
  recall: true,
  save: true,
  purgeHistory: false,
  sharedScope: false,
  banks: true,
  automaticRecall: true,
  conversationRetention: true,
  forget: false,
};

describe("selectMemoryTools", () => {
  it("keeps native remember and drops semantic memory tools without an external provider", () => {
    const names = selectMemoryTools(allMemoryTools, null).map((t) => t.name);
    expect(names).toEqual(["remember", "save_shared_memory", "shell"]);
  });

  it("keeps every semantic tool for a legacy provider whose forget support is undeclared", () => {
    const selected = selectMemoryTools(allMemoryTools, legacy);
    expect(selected.map((t) => t.name)).toEqual([
      "recall_memory",
      "save_memory",
      "forget_memory",
      "save_shared_memory",
      "shell",
    ]);
    expect(selected.find((t) => t.name === "save_memory")?.description).toBe("save_memory");
  });

  it("offers bank providers recall and queued save, never forget or native remember", () => {
    const selected = selectMemoryTools(allMemoryTools, bank);
    expect(selected.map((t) => t.name)).toEqual([
      "recall_memory",
      "save_memory",
      "save_shared_memory",
      "shell",
    ]);
    expect(selected.find((t) => t.name === "save_memory")?.description).toBe(
      QUEUED_SAVE_MEMORY_DESCRIPTION,
    );
  });

  it("is a no-op for tool lists with no memory tools at all", () => {
    const shellOnly = [tool("shell")];
    expect(selectMemoryTools(shellOnly, null)).toEqual(shellOnly);
    expect(selectMemoryTools(shellOnly, bank)).toEqual(shellOnly);
  });
});
