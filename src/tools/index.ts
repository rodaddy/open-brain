import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type pg from "pg";
import type { generateEmbedding } from "../embedding.ts";
import { registerLogThought } from "./log-thought.ts";
import { registerLogDecision } from "./log-decision.ts";
import { registerSearchBrain } from "./search-brain.ts";
import { registerFindPerson } from "./find-person.ts";

export interface ToolDeps {
  pool: pg.Pool;
  embedFn: typeof generateEmbedding;
}

export function registerAllTools(server: McpServer, deps: ToolDeps): void {
  registerLogThought(server, deps);
  registerLogDecision(server, deps);
  registerSearchBrain(server, deps);
  registerFindPerson(server, deps);
}
