import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type pg from "pg";
import type { generateEmbedding } from "../embedding.ts";
import { registerLogThought } from "./log-thought.ts";
import { registerLogDecision } from "./log-decision.ts";
import { registerSearchBrain } from "./search-brain.ts";
import { registerFindPerson } from "./find-person.ts";
import { registerSessionSave } from "./session-save.ts";
import { registerSessionLoad } from "./session-load.ts";
import { registerArchiveEntry } from "./archive-entry.ts";
import { registerListRecent } from "./list-recent.ts";
import { registerListStale } from "./list-stale.ts";
import { registerUpdateEntry } from "./update-entry.ts";
import { registerRateEntry } from "./rate-entry.ts";
import { registerSearchAll } from "./search-all.ts";
import { registerUpsertPerson } from "./upsert-person.ts";
import { registerSetTier } from "./set-tier.ts";
import { registerGetEntry } from "./get-entry.ts";
import { registerGetStats } from "./get-stats.ts";
import { registerAccessReport } from "./access-report.ts";
import { registerBulkSetTier } from "./bulk-set-tier.ts";
import { registerFindDuplicates } from "./find-duplicates.ts";
import { registerCurateEntries } from "./curate-entries.ts";
import { registerBulkArchive } from "./bulk-archive.ts";
import { registerListNamespaces } from "./list-namespaces.ts";
import { registerTierRecommendations } from "./tier-recommendations.ts";
import { registerLaneUpsert } from "./lane-upsert.ts";
import { registerLaneLoad } from "./lane-load.ts";
import { registerAppendSessionEvent } from "./append-session-event.ts";
import { registerSessionContext } from "./session-context.ts";
import { registerSessionStart } from "./session-start.ts";
import { registerSessionWrap } from "./session-wrap.ts";

export interface ToolDeps {
  pool: pg.Pool;
  embedFn: typeof generateEmbedding;
}

export function registerAllTools(server: McpServer, deps: ToolDeps): void {
  registerLogThought(server, deps);
  registerLogDecision(server, deps);
  registerSearchBrain(server, deps);
  registerFindPerson(server, deps);
  registerSessionSave(server, deps);
  registerSessionLoad(server, deps);
  registerArchiveEntry(server, deps);
  registerListRecent(server, deps);
  registerListStale(server, deps);
  registerUpdateEntry(server, deps);
  registerRateEntry(server, deps);
  registerSearchAll(server, deps);
  registerUpsertPerson(server, deps);
  registerSetTier(server, deps);
  registerGetEntry(server, deps);
  registerGetStats(server, deps);
  registerAccessReport(server, deps);
  registerBulkSetTier(server, deps);
  registerFindDuplicates(server, deps);
  registerCurateEntries(server, deps);
  registerBulkArchive(server, deps);
  registerListNamespaces(server, deps);
  registerTierRecommendations(server, deps);
  registerLaneUpsert(server, deps);
  registerLaneLoad(server, deps);
  registerAppendSessionEvent(server, deps);
  registerSessionContext(server, deps);
  registerSessionStart(server, deps);
  registerSessionWrap(server, deps);
}
