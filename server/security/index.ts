import type { ServerModuleBoundary } from "../module.ts";

export const SECURITY_BOUNDARY: ServerModuleBoundary = {
  name: "security",
  owns: ["token authentication", "role permissions", "namespace policy"],
  excludes: ["SQL construction", "tool orchestration", "session storage"],
};
