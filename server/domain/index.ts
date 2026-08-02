import type { ServerModuleBoundary } from "../module.ts";

export const DOMAIN_BOUNDARY: ServerModuleBoundary = {
  name: "domain",
  owns: ["memory rules", "session rules", "promotion rules", "dream rules"],
  excludes: ["SQL execution", "HTTP framing", "environment reads"],
};
