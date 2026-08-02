import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerModuleBoundary } from "../module.ts";
import { registerCaptureTools } from "./capture.ts";
import { registerIngestRawTurnTool } from "./ingest-raw-turn.ts";
import { registerLaneTools } from "./lanes.ts";
import { registerNamespaceGuardTool } from "./namespace-guard.ts";
import { registerSessionEventTool } from "./session-events.ts";
import { registerSessionLifecycleTools } from "./session-lifecycle.ts";
import { registerSessionSaveLoadTools } from "./session-save-load.ts";
import type { MemoryToolDependencies } from "./types.ts";

export const TOOLS_BOUNDARY: ServerModuleBoundary = {
  name: "tools",
  owns: ["MCP schemas", "tool handlers", "contract registration"],
  excludes: ["token parsing", "HTTP session lifecycle"],
};

export function registerMemoryTools(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  registerCaptureTools(server, dependencies);
  registerLaneTools(server, dependencies);
  registerSessionLifecycleTools(server, dependencies);
  registerSessionEventTool(server, dependencies);
  registerSessionSaveLoadTools(server, dependencies);
  registerIngestRawTurnTool(server, dependencies);
  registerNamespaceGuardTool(server, dependencies);
}

export type { MemoryToolDependencies } from "./types.ts";
