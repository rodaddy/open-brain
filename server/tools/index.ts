import type { ServerModuleBoundary } from "../module.ts";

export const TOOLS_BOUNDARY: ServerModuleBoundary = {
  name: "tools",
  owns: ["MCP schemas", "tool handlers", "contract registration"],
  excludes: ["raw SQL", "token parsing", "HTTP session lifecycle"],
};
