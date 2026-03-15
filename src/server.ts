import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function createBrainServer(): McpServer {
  return new McpServer({
    name: "open-brain",
    version: "1.0.0",
  });
}
