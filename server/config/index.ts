import type { ServerModuleBoundary } from "../module.ts";

export const CONFIG_BOUNDARY: ServerModuleBoundary = {
  name: "config",
  owns: ["environment parsing", "startup validation", "typed configuration"],
  excludes: ["process startup", "logging", "transport behavior"],
};
