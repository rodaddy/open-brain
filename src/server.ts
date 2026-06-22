import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validateToolInputWithSummary } from "./validation-errors.ts";

export function createBrainServer(): McpServer {
  const server = new McpServer({
    name: "open-brain",
    version: "1.0.0",
  });

  // The SDK's default tool-input validation message can expose a raw validator
  // dump that clients truncate. Keep the same validation semantics, but format
  // failures as bounded JSON with field-level detail.
  (server as unknown as {
    validateToolInput: (
      tool: unknown,
      args: unknown,
      toolName: string,
    ) => Promise<unknown>;
  }).validateToolInput = validateToolInputWithSummary as (
    tool: unknown,
    args: unknown,
    toolName: string,
  ) => Promise<unknown>;

  return server;
}
