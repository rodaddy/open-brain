import type { ServerModuleBoundary } from "../module.ts";

export const OBSERVABILITY_BOUNDARY: ServerModuleBoundary = {
  name: "observability",
  owns: ["logger configuration", "correlation context", "error redaction"],
  excludes: ["domain policy", "transport routing", "database queries"],
};
