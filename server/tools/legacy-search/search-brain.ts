/**
 * Legacy `search_brain` retrieval, moved out of src/ (issue 864) and split by
 * responsibility so each sibling meets the server/ standard. This module is the
 * assembled surface: it re-exports the names the legacy call sites use, so the
 * split is invisible to every importer.
 *
 * The parts, in the order the search pipeline runs them:
 *   legacy-search-tables-and-parsing  readable tables, relational query parse,
 *                                     search-embedding generation
 *   legacy-search-rows-and-fallback   row shapes, evidence, dedupe, the shared
 *                                     fallback merge
 *   legacy-search-query-builders      CTE and query construction
 *   legacy-search-arms                the relational, vector, and FTS searches
 *   legacy-search-execute             RRF merge, usage tracking, executeSearch
 *   legacy-search-fallback-executors  the shared-namespace fallback executors
 *   legacy-search-register            the MCP tool registration
 */
export { ALL_TABLES } from "../../db/table-constants.ts";
export type { SourceScope } from "../../domain/source-refs.ts";
export {
  readableSearchTables,
  setSearchEmbeddingTimeoutReader,
  TIER_BOOST,
  type ExecuteSearchOptions,
  type ExecuteSearchTuning,
  type SearchMode,
  type SearchTable,
} from "./legacy-search-tables-and-parsing.ts";
export {
  mergeFallbackSearchRows,
  type ExplicitLink,
  type SearchRow,
  type SourceRef,
} from "./legacy-search-rows-and-fallback.ts";
export {
  executeSearch,
  rrfMerge,
  trackUsage,
  type TrackUsageOptions,
} from "./legacy-search-execute.ts";
export {
  executeSearchWithScopedSharedFallback,
  executeSearchWithSharedFallback,
} from "./legacy-search-fallback-executors.ts";
export { registerSearchBrain } from "./legacy-search-register.ts";
