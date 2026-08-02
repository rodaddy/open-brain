import type { ServerModuleBoundary } from "../module.ts";

export const TRANSPORT_BOUNDARY: ServerModuleBoundary = {
  name: "transport",
  owns: ["HTTP routes", "MCP sessions", "health responses", "worker proxying"],
  excludes: ["tool behavior", "authorization policy", "SQL"],
};
