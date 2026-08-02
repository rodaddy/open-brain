import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerModuleBoundary } from "../module.ts";
import { registerAdjacentContextTool } from "./adjacent-context.ts";
import {
  registerAgentContextPackTool,
  registerAgentReflexPointersTool,
} from "./agent-context-pack.ts";
import { registerBrainAnswerTool } from "./brain-answer.ts";
import { registerCaptureTools } from "./capture.ts";
import { registerIngestRawTurnTool } from "./ingest-raw-turn.ts";
import { registerLaneTools } from "./lanes.ts";
import { registerListRecentTool } from "./list-recent.ts";
import { registerSearchAllTool } from "./search-all.ts";
import { registerSearchBrainTool } from "./search-brain.ts";
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
  // The search/recall family. `search_brain` was previously a namespace-denial
  // stub registered by this wave's predecessor so the isolation boundary stayed
  // observable while the body was unowned; the real handler replaces it here.
  registerSearchBrainTool(server, dependencies);
  registerSearchAllTool(server, dependencies);
  registerBrainAnswerTool(server, dependencies);
  registerListRecentTool(server, dependencies);
  registerAdjacentContextTool(server, dependencies);
  // The realtime context-pack surface. Both tools share ONE recall stack and one
  // pointer builder: `agent_reflex_pointers` is a projection over
  // `agent_context_pack`, not a second implementation of it.
  registerAgentContextPackTool(server, dependencies);
  registerAgentReflexPointersTool(server, dependencies);
}

export type { MemoryToolDependencies } from "./types.ts";
