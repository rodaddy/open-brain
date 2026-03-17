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
import { registerUpdateEntry } from "./update-entry.ts";
import { registerRateEntry } from "./rate-entry.ts";
import { registerSearchAll } from "./search-all.ts";

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
  registerUpdateEntry(server, deps);
  registerRateEntry(server, deps);
  registerSearchAll(server, deps);
}
