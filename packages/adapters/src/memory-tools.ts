import type { ConnectorTool, SemanticMemoryCapabilities } from "@rakazo/adapter-kit";

const SEMANTIC_MEMORY_TOOL_NAMES: Record<string, true> = {
  recall_memory: true,
  save_memory: true,
  forget_memory: true,
};

export const QUEUED_SAVE_MEMORY_DESCRIPTION =
  "Queues memory for storage; processing may continue after this reply.";

export function selectMemoryTools(
  tools: ConnectorTool[],
  capabilities: SemanticMemoryCapabilities | null,
): ConnectorTool[] {
  if (!capabilities) return tools.filter((tool) => !SEMANTIC_MEMORY_TOOL_NAMES[tool.name]);
  return tools.flatMap((tool) => {
    if (tool.name === "remember") return [];
    if (tool.name === "forget_memory" && capabilities.forget === false) return [];
    if (tool.name === "save_memory" && capabilities.banks === true) {
      return [{ ...tool, description: QUEUED_SAVE_MEMORY_DESCRIPTION }];
    }
    return [tool];
  });
}
