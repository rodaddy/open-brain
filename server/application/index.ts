import type { ServerModuleBoundary } from "../module.ts";

export const APPLICATION_BOUNDARY: ServerModuleBoundary = {
  name: "application",
  owns: ["composition", "startup ordering", "shutdown ordering"],
  excludes: ["HTTP routing", "SQL", "authorization policy", "tool behavior"],
};
