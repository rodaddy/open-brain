import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerModuleBoundary } from "../module.ts";
import { registerAdjacentContextTool } from "./adjacent-context.ts";
import {
  registerAgentContextPackTool,
  registerAgentReflexPointersTool,
} from "./agent-context-pack.ts";
import { registerBrainAnswerTool } from "./brain-answer.ts";
import { registerCaptureTools } from "./capture.ts";
import { registerCurationTools } from "./curation.ts";
import { registerDecomposeEntryTool } from "./decompose-entry.ts";
import { registerEntityTools } from "./entities.ts";
import { registerGetContractTool } from "./get-contract.ts";
import { registerGetEntryTool } from "./get-entry.ts";
import { registerIngestRawTurnTool } from "./ingest-raw-turn.ts";
import { registerLaneTools } from "./lanes.ts";
import { registerListRecentTool } from "./list-recent.ts";
import { registerOperatorDoctorTool } from "./operator-doctor.ts";
import { registerPeopleTools } from "./people.ts";
import { registerPromotionTools } from "./promotion.ts";
import { registerReportingTools } from "./reporting.ts";
import { registerRepoFactTools } from "./repo-facts.ts";
import { registerResolveEntryTool } from "./resolve-entry.ts";
import { registerSearchAllTool } from "./search-all.ts";
import { registerSearchBrainTool } from "./search-brain.ts";
import { registerUpdateEntryTool } from "./update-entry.ts";
import { registerSessionEventTool } from "./session-events.ts";
import { registerSourceRegistryTools } from "./source-registry.ts";
import { registerSessionLifecycleTools } from "./session-lifecycle.ts";
import { registerSessionSaveLoadTools } from "./session-save-load.ts";
import { registerTieringTools } from "./tiering.ts";
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
  registerCurationTools(server, dependencies);
  registerDecomposeEntryTool(server, dependencies);
  registerUpdateEntryTool(server, dependencies);
  // `resolve_entry` hands back a `get_entry` fetch path, so the two register
  // together: a resolve result that names a tool this server does not answer is
  // a dangling pointer the caller only discovers on the follow-up call.
  registerResolveEntryTool(server, dependencies);
  registerGetEntryTool(server, dependencies);
  registerTieringTools(server, dependencies);
  registerReportingTools(server, dependencies);
  registerEntityTools(server, dependencies);
  registerPeopleTools(server, dependencies);
  registerSourceRegistryTools(server, dependencies);
  registerRepoFactTools(server, dependencies);
  registerPromotionTools(server, dependencies);
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
  // Service-metadata surfaces. Neither is namespaced memory: `get_contract`
  // reports what this server promises downstream clients, `operator_doctor`
  // reports how the deployment is doing, and both reuse the single existing
  // builder so the rewrite cannot answer either question differently from the
  // contract and payload locks that already police it.
  registerGetContractTool(server, dependencies);
  registerOperatorDoctorTool(server, dependencies);
}

export type { MemoryToolDependencies } from "./types.ts";
