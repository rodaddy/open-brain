import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validateToolInputWithSummary } from "./validation-errors.ts";

type ToolInputValidator = (
  tool: unknown,
  args: unknown,
  toolName: string,
) => Promise<unknown>;

function installValidationSummaryFormatter(server: McpServer): void {
  const candidate = server as unknown as {
    validateToolInput?: ToolInputValidator;
  };

  if (typeof candidate.validateToolInput !== "function") {
    throw new Error(
      "MCP SDK contract changed: McpServer.validateToolInput is unavailable",
    );
  }

  // SDK-private hook: @modelcontextprotocol/sdk/server/mcp.js currently calls
  // validateToolInput(tool, args, toolName) before dispatch. Keep validation
  // semantics intact while replacing only the failure message formatting.
  candidate.validateToolInput =
    validateToolInputWithSummary as ToolInputValidator;
}

export function createBrainServer(): McpServer {
  const server = new McpServer({
    name: "open-brain",
    version: "1.0.0",
  });

  installValidationSummaryFormatter(server);

  return server;
}
