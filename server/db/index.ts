import type { ServerModuleBoundary } from "../module.ts";

export const DATABASE_BOUNDARY: ServerModuleBoundary = {
  name: "db",
  owns: ["pool lifecycle", "transactions", "repositories", "append-only migrations"],
  excludes: ["authorization decisions", "MCP schemas", "HTTP responses"],
};
