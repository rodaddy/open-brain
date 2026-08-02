import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerModuleBoundary } from "../module.ts";
import { registerAdjacentContextTool } from "./adjacent-context.ts";
import {
  registerAgentContextPackTool,
  registerAgentReflexPointersTool,
} from "./agent-context-pack.ts";
import { registerBrainAnswerTool } from "./brain-answer.ts";
import { registerCaptureTools } from "./capture.ts";
import { registerCitationRecallTool } from "./citation-recall.ts";
import { registerCurationTools } from "./curation.ts";
import { registerDecomposeEntryTool } from "./decompose-entry.ts";
import { registerEntityTools } from "./entities.ts";
import { registerFindDuplicatesTool } from "./find-duplicates.ts";
import { registerIngestConversationFactsTool } from "./ingest-conversation-facts.ts";
import { registerGetContractTool } from "./get-contract.ts";
import { registerGetEntryTool } from "./get-entry.ts";
import { registerIngestRawTurnTool } from "./ingest-raw-turn.ts";
import { registerLaneTools } from "./lanes.ts";
import { registerListRecentTool } from "./list-recent.ts";
import { registerOperatorDoctorTool } from "./operator-doctor.ts";
import { registerPeopleTools } from "./people.ts";
import { registerPromoteEntryTool } from "./promote-entry.ts";
import { registerPromotionTools } from "./promotion.ts";
import { registerRealtimeAppendTools } from "./realtime-append.ts";
import { registerReportingTools } from "./reporting.ts";
import { registerRepoFactTools } from "./repo-facts.ts";
import { registerResolveEntryTool } from "./resolve-entry.ts";
import { registerScanNamespaceTool } from "./scan-namespace.ts";
import { registerSearchAllTool } from "./search-all.ts";
import { registerSearchBrainTool } from "./search-brain.ts";
import { registerUpdateEntryTool } from "./update-entry.ts";
import { registerSessionEventTool } from "./session-events.ts";
import { registerSkillUsageTools } from "./skill-usage.ts";
import { registerSourceRegistryTools } from "./source-registry.ts";
import { registerSessionLifecycleTools } from "./session-lifecycle.ts";
import { registerSessionSaveLoadTools } from "./session-save-load.ts";
import { registerTierLaneTool } from "./tier-lane.ts";
import { registerTierMutationTools } from "./tier-mutations.ts";
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
  // The distilled-facts twin of `ingest_raw_turn`. Both land in
  // `ob_session_events` against an existing scoped lane, so they register
  // together: they share the journal, the dedup rule, and the embedding
  // conventions, and only differ in what they will accept as input.
  registerIngestConversationFactsTool(server, dependencies);
  // Citation evidence for one session event. It reads back what the two ingest
  // paths above wrote, so registering the writes without it would accept
  // provenance nothing could ever cite.
  registerCitationRecallTool(server, dependencies);
  registerCurationTools(server, dependencies);
  // `find_duplicates` is curation's read-only discovery arm: it reports pairs
  // and archives nothing, and acting on a pair is a separate `bulk_archive`
  // call. It carries the #485 fix -- the pairwise self-join is always bounded
  // to a namespace, where current-src leaves it unscoped for a global role.
  registerFindDuplicatesTool(server, dependencies);
  registerDecomposeEntryTool(server, dependencies);
  registerUpdateEntryTool(server, dependencies);
  // `resolve_entry` hands back a `get_entry` fetch path, so the two register
  // together: a resolve result that names a tool this server does not answer is
  // a dangling pointer the caller only discovers on the follow-up call.
  registerResolveEntryTool(server, dependencies);
  registerGetEntryTool(server, dependencies);
  registerTieringTools(server, dependencies);
  // The WRITE half of the tiering surface `registerTieringTools` reads. The two
  // register adjacently and stay in separate files on purpose: `tiering.ts`
  // only scores and recommends, and every mutation is a tool a caller names
  // explicitly. A recommendation path that could mutate is exactly what the
  // dream-cycle dry-run contract exists to prevent.
  registerTierMutationTools(server, dependencies);
  // `tier_lane` graduates lane events into durable thoughts in the SAME
  // namespace, dry-run by default. It sits with the tier family rather than the
  // lane family because what it produces is durable memory, not lane state.
  registerTierLaneTool(server, dependencies);
  registerReportingTools(server, dependencies);
  // Skill/canon usage telemetry (#469). Registered on the REWRITE registry
  // only, not on `src/tools`: the operator placed this on the rewrite path
  // ("We're rewriting it, so this seems like a good place to add new
  // functionality"), so adding it to the stack being replaced would build new
  // surface on the retiring one. It registers next to `reporting.ts` because it
  // is the same kind of thing -- a read-only aggregate over a log table, scoped
  // by joining back to the owning row -- and reuses that module's scoping rule
  // rather than inventing a second one.
  registerSkillUsageTools(server, dependencies);
  registerEntityTools(server, dependencies);
  registerPeopleTools(server, dependencies);
  registerSourceRegistryTools(server, dependencies);
  registerRepoFactTools(server, dependencies);
  registerPromotionTools(server, dependencies);
  // The promotion family's other two surfaces. `scan_namespace` is the planning
  // step that reports what is pending, and `promote_entry` is the general copy
  // path -- any table, any writable target -- next to `promote_shared`'s
  // curated, content-classified thoughts/decisions path. All three delegate the
  // copy itself to one promotion service, so provenance and duplicate detection
  // have a single owner. Both mutating paths are dry-run by default.
  registerScanNamespaceTool(server, dependencies);
  registerPromoteEntryTool(server, dependencies);
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
  // The realtime WRITE half. It registers alongside the pack deliberately: both
  // halves resolve their stores through `realtime-stores.ts`, so an append and
  // the `working_set`/`recovery` sections that read it always address one
  // object. Registering the writes without the pack would accept content
  // nothing could ever read back.
  registerRealtimeAppendTools(server, dependencies);
  // Service-metadata surfaces. Neither is namespaced memory: `get_contract`
  // reports what this server promises downstream clients, `operator_doctor`
  // reports how the deployment is doing, and both reuse the single existing
  // builder so the rewrite cannot answer either question differently from the
  // contract and payload locks that already police it.
  registerGetContractTool(server, dependencies);
  registerOperatorDoctorTool(server, dependencies);
}

export type { MemoryToolDependencies } from "./types.ts";
