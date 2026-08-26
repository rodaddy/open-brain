/**
 * Shared request normalization for the search tools.
 *
 * `search_brain` and `search_all` publish DIFFERENT argument schemas but agree
 * exactly on how the five common arguments default: `limit` to 10, `offset` to
 * 0, `search_mode` to `hybrid`, and `tier`/`namespace` to undefined. Those
 * defaults are part of both tools' frozen client contract, so they are stated
 * once here rather than restated per tool where the two could drift apart
 * unnoticed.
 *
 * `fts_config` is in the shape because `search_brain` accepts it. `search_all`
 * publishes no such argument, so it normalizes to `undefined` there and that
 * tool keeps passing `{}` to the search engine — the English path — unchanged.
 */
import type { Tier } from "./search-constants.ts";
import type { SearchMode } from "./search-engine.ts";

/** The request-shaped arguments after defaults are applied. */
export interface NormalizedSearchArgs {
  limit: number;
  offset: number;
  mode: SearchMode;
  tier: Tier | undefined;
  requestedNamespace: string | undefined;
  requestedFtsConfig: string | undefined;
}

/**
 * Apply the documented argument defaults.
 *
 * @returns The normalized arguments; the defaults are part of the frozen contract.
 */
export function normalizeSearchArgs(args: {
  limit?: number;
  offset?: number;
  search_mode?: string;
  tier?: string;
  namespace?: string;
  fts_config?: string;
}): NormalizedSearchArgs {
  return {
    limit: args.limit ?? 10,
    offset: args.offset ?? 0,
    mode: (args.search_mode as SearchMode | undefined) ?? "hybrid",
    tier: args.tier as Tier | undefined,
    requestedNamespace: args.namespace,
    requestedFtsConfig: args.fts_config,
  };
}
