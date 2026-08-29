// L5 adapter (issue 864): legacy call form over server/tools/legacy-search/search-brain.ts; retired with src/ at L6.
//
// The moved module takes its search-embedding timeout from a registered reader
// (rule M13a) because server/ code may not read process.env. This adapter
// registers a reader that performs exactly the parse the original module did,
// at the same moment it used to happen -- per call, so a test that mutates the
// environment after import still sees its change.
import { setFtsEnvReader } from "../../server/tools/legacy-search/fts-config.ts";
import { setSearchEmbeddingTimeoutReader } from "../../server/tools/legacy-search/search-brain.ts";

setFtsEnvReader(() => process.env);

setSearchEmbeddingTimeoutReader(() => {
  const raw =
    process.env.OPENBRAIN_SEARCH_EMBEDDING_TIMEOUT_MS ??
    process.env.SEARCH_EMBEDDING_TIMEOUT_MS;
  if (!raw) return undefined;
  return parseInt(raw, 10);
});

// Names whose legacy call form the server/ module still has verbatim.
export {
  ALL_TABLES,
  mergeFallbackSearchRows,
  readableSearchTables,
  registerSearchBrain,
  rrfMerge,
  TIER_BOOST,
  type ExplicitLink,
  type SearchMode,
  type SearchRow,
  type SearchTable,
  type SourceRef,
  type SourceScope,
} from "../../server/tools/legacy-search/search-brain.ts";

// Names the server/ module now takes as one options object; the positional
// wrappers below restore the legacy form.
import {
  executeSearch as executeSearchOptions,
  executeSearchWithScopedSharedFallback as executeSearchWithScopedSharedFallbackOptions,
  executeSearchWithSharedFallback as executeSearchWithSharedFallbackOptions,
  trackUsage as trackUsageOptions,
  type ExecuteSearchOptions,
  type ExecuteSearchTuning,
  type SearchMode,
  type SearchRow,
  type SearchTable,
  type SourceScope,
  type TrackUsageOptions,
} from "../../server/tools/legacy-search/search-brain.ts";

// The tier type is taken from the moved options type rather than imported from
// `../types.ts`: an L5 adapter's relative dependencies all resolve under
// server/ (rule M9), and this is the same `Tier` either way.
type Tier = NonNullable<ExecuteSearchOptions["tier"]>;

// --- legacy positional call forms (rule M9/M15) -------------------------
//
// server/ takes one options object per function; every legacy src/ caller
// still passes the historical positional list. These wrappers are that
// translation and nothing else. The tuple element labels are the former
// parameter names, in the former order, so the two forms read identically.

type ExecuteArgs = [
  deps: Parameters<typeof executeSearchOptions>[0]["deps"],
  accessibleTables: SearchTable[],
  query: string,
  count: number,
  mode?: SearchMode,
  tier?: Tier,
  offset?: number,
  namespace?: string | string[],
  includeLinks?: boolean,
  sourceScope?: SourceScope,
  tuning?: ExecuteSearchTuning,
];

function toExecuteOptions(args: ExecuteArgs): ExecuteSearchOptions {
  const [
    deps,
    accessibleTables,
    query,
    count,
    mode,
    tier,
    offset,
    namespace,
    includeLinks,
    sourceScope,
    tuning,
  ] = args;
  return {
    deps,
    accessibleTables,
    query,
    limit: count,
    mode,
    tier,
    offset,
    namespace,
    includeLinks,
    sourceScope,
    tuning,
  };
}

export function executeSearch(...args: ExecuteArgs): Promise<SearchRow[]> {
  return executeSearchOptions(toExecuteOptions(args));
}

export function executeSearchWithSharedFallback(
  ...args: ExecuteArgs
): Promise<SearchRow[]> {
  return executeSearchWithSharedFallbackOptions(toExecuteOptions(args));
}

export function executeSearchWithScopedSharedFallback(
  ...args: ExecuteArgs
): Promise<SearchRow[]> {
  return executeSearchWithScopedSharedFallbackOptions(toExecuteOptions(args));
}

type TrackUsageArgs = [
  deps: TrackUsageOptions["deps"],
  rows: SearchRow[],
  queryText: string,
  context?: string,
  accessedBy?: string,
];

export function trackUsage(...args: TrackUsageArgs): void {
  const [deps, rows, queryText, context = "search", accessedBy] = args;
  trackUsageOptions({ deps, rows, queryText, context, accessedBy });
}
