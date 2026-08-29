import {
  ftsSearch,
  relationalGraphSearch,
  vectorSearch,
} from "./legacy-search-arms.ts";
import { attachExplicitLinks } from "./legacy-search-query-builders.ts";
import {
  recencyFactor,
  rowEvidence,
  rowIdsEvidence,
  rowsEvidence,
  type SearchRow,
} from "./legacy-search-rows-and-fallback.ts";
import type { Table, Tier } from "../../../src/types.ts";
import type { ToolDeps } from "../../../src/tools/index.ts";
import { logger } from "../../../src/logger.ts";
import {
  traceRetrievalSpan,
  traceRetrievalSpanSync,
} from "../../observability/langfuse-tracing.ts";
import { DEFAULT_FTS_CONFIG } from "./fts-config.ts";
import {
  generateSearchEmbedding,
  HYBRID_FETCH_MULTIPLIER,
  LABEL_TO_TABLE,
  RELATIONAL_GRAPH_FETCH_LIMIT,
  RRF_K,
  TABLE_WEIGHT,
  TIER_BOOST,
  type ExecuteSearchOptions,
} from "./legacy-search-tables-and-parsing.ts";
export function rrfMerge(
  vectorRows: SearchRow[],
  ftsRows: SearchRow[],
  limit: number,
  graphRows: SearchRow[] = [],
): SearchRow[] {
  let ranked: Array<{ row: SearchRow; rrf: number }> = [];
  return traceRetrievalSpanSync({
    name: "retrieval.rank_rrf",
    input: {
      limit,
      vector: rowIdsEvidence(vectorRows),
      keyword: rowIdsEvidence(ftsRows),
      graph: rowIdsEvidence(graphRows),
    },
    metadata: { stage: "scoring_ranking", filter_names: ["rrf_window"] },
    run: () => {
      const scoreMap = new Map<string, { row: SearchRow; rrf: number }>();
      const accumulate = (rows: SearchRow[], multiplier = 1): void => {
        rows.forEach((row, index) => {
          const key = `${row.source_type}:${row.id}`;
          const contribution = multiplier / (RRF_K + index + 1);
          const existing = scoreMap.get(key);
          if (existing) {
            existing.rrf += contribution;
            if (multiplier === 3) {
              existing.row = { ...existing.row, explicit_links: row.explicit_links };
            }
          } else {
            scoreMap.set(key, { row, rrf: contribution });
          }
        });
      };
      accumulate(vectorRows);
      accumulate(ftsRows);
      accumulate(graphRows, 3);
      ranked = Array.from(scoreMap.values())
        .map(({ row, rrf }) => ({
          row,
          rrf: Math.max(
            0,
            (rrf + TIER_BOOST[(row.tier ?? "warm") as Tier]) *
              (TABLE_WEIGHT[row.source_type] ?? 1.0) *
              recencyFactor(row.created_at),
          ),
        }))
        .sort((a, b) => b.rrf - a.rrf);
      return ranked.slice(0, limit).map(({ row }) => row);
    },
    output: (rows) => {
      const selectedKeys = new Set(rows.map((row) => `${row.source_type}:${row.id}`));
      return {
        candidate_count: ranked.length,
        selected_count: rows.length,
        selected_row_ids: rows.map((row) => row.id),
        candidates: ranked.map(({ row, rrf }) => {
          const chosen = selectedKeys.has(`${row.source_type}:${row.id}`);
          return {
            ...rowEvidence(row),
            rank_score: rrf,
            chosen,
            filtered_by: chosen ? null : "rrf_window",
          };
        }),
      };
    },
  });
}

/** Circuit breaker: stop tracking after consecutive failures to avoid log floods */
export const TRACKING_FAILURE_THRESHOLD = 5;
export let trackingConsecutiveFailures = 0;
export let trackingCircuitOpen = false;

/** Every argument `trackUsage` takes, in the legacy positional order. */
export type TrackUsageOptions = {
  deps: ToolDeps;
  rows: SearchRow[];
  queryText: string;
  context?: string;
  accessedBy?: string;
};

export function trackUsage(options: TrackUsageOptions): void {
  const { deps, rows, queryText, context = "search", accessedBy } = options;
  if (rows.length === 0) return;
  if (trackingCircuitOpen) return;

  const byTable = new Map<Table, string[]>();
  for (const row of rows) {
    const table = LABEL_TO_TABLE[row.source_type];
    if (!table) continue;
    const ids = byTable.get(table) ?? [];
    ids.push(row.id);
    byTable.set(table, ids);
  }

  const trackingPromises: Promise<unknown>[] = [];
  for (const [table, ids] of byTable) {
    trackingPromises.push(
      deps.pool.query(
        `UPDATE ${table} SET access_count = access_count + 1, last_accessed_at = NOW() WHERE id = ANY($1)`,
        [ids],
      ),
    );
  }

  // Bulk-insert into entry_access_log for all returned entries
  const logRows = rows.filter((r) => LABEL_TO_TABLE[r.source_type]);
  if (logRows.length > 0) {
    const entryIds = logRows.map((r) => r.id);
    const sourceTables = logRows.map((r) => LABEL_TO_TABLE[r.source_type]);
    trackingPromises.push(
      deps.pool.query(
        `INSERT INTO entry_access_log (entry_id, source_table, accessed_at, query_text, context, accessed_by)
           SELECT unnest($1::uuid[]), unnest($2::text[]), NOW(), $3, $4, $5`,
        [entryIds, sourceTables, queryText, context, accessedBy ?? null],
      ),
    );
  }

  void Promise.allSettled(trackingPromises).then((results) => {
    const anyFailed = results.some((r) => r.status === "rejected");
    if (anyFailed) {
      trackingConsecutiveFailures++;
      if (trackingConsecutiveFailures >= TRACKING_FAILURE_THRESHOLD) {
        trackingCircuitOpen = true;
        logger.warn("search_tracking_circuit_open", {
          message: `Tracking disabled after ${TRACKING_FAILURE_THRESHOLD} consecutive failures`,
        });
      } else {
        const firstError = results.find((r) => r.status === "rejected") as
          PromiseRejectedResult | undefined;
        logger.warn("search_tracking_error", {
          error:
            firstError?.reason instanceof Error
              ? firstError.reason.message
              : String(firstError?.reason),
        });
      }
    } else {
      trackingConsecutiveFailures = 0;
    }
  });
}

/** The options after the phase-one scope resolution has been applied. */
type ResolvedSearchPlan = {
  options: ExecuteSearchOptions;
  accessibleTables: ExecuteSearchOptions["accessibleTables"];
  enableGraph: boolean;
  ftsConfig: NonNullable<NonNullable<ExecuteSearchOptions["tuning"]>["ftsConfig"]>;
};

/**
 * Phase one: settle the tables and tuning the rest of the pipeline runs against.
 * Returns null when a source scope leaves no table that can honor it.
 */
function resolveSearchPlan(options: ExecuteSearchOptions): ResolvedSearchPlan | null {
  const { accessibleTables: requestedTables, sourceScope, tuning = {} } = options;
  let accessibleTables = requestedTables;
  if (sourceScope) {
    // Neither corpus carries `source_refs`, so a source-scope predicate cannot
    // be evaluated against them. Dropping them is the safe reading: keeping
    // them would return rows the scope never authorized.
    accessibleTables = accessibleTables.filter(
      (table) => table !== "entities" && table !== "session_events",
    );
    if (accessibleTables.length === 0) return null;
  }
  return {
    options,
    accessibleTables,
    enableGraph: tuning.enableGraph === true,
    ftsConfig: tuning.ftsConfig ?? DEFAULT_FTS_CONFIG,
  };
}

/** Phase four: the one link-attachment step every mode ends with. */
async function shapeSearchRows(
  plan: ResolvedSearchPlan,
  rows: SearchRow[],
): Promise<SearchRow[]> {
  const { deps, includeLinks, namespace } = plan.options;
  if (includeLinks === false) return rows;
  return attachExplicitLinks(deps, rows, namespace);
}

/** The graph arm, which both hybrid paths gate identically. */
function runGraphArm(
  plan: ResolvedSearchPlan,
  fetchLimit: number,
): Promise<SearchRow[]> {
  const { deps, query, tier, namespace, sourceScope } = plan.options;
  if (!plan.enableGraph || sourceScope !== undefined) return Promise.resolve([]);
  return relationalGraphSearch({
    deps,
    accessibleTables: plan.accessibleTables,
    query,
    fetchLimit: Math.min(fetchLimit, RELATIONAL_GRAPH_FETCH_LIMIT),
    tier,
    namespace,
  });
}

/** The FTS arm, with the caller choosing how far to fetch and skip. */
function runFtsArm(
  plan: ResolvedSearchPlan,
  fetchLimit: number,
  offset: number,
): Promise<SearchRow[]> {
  const { deps, query, tier, namespace, sourceScope } = plan.options;
  return ftsSearch({
    deps,
    accessibleTables: plan.accessibleTables,
    query,
    fetchLimit,
    tier,
    offset,
    namespace,
    sourceScope,
    ftsConfig: plan.ftsConfig,
  });
}

/** The vector arm, with the caller choosing how far to fetch and skip. */
function runVectorArm(
  plan: ResolvedSearchPlan,
  embedding: number[],
  fetchLimit: number,
  offset: number,
): Promise<SearchRow[]> {
  const { deps, tier, namespace, sourceScope } = plan.options;
  return vectorSearch({
    deps,
    accessibleTables: plan.accessibleTables,
    embedding,
    fetchLimit,
    tier,
    offset,
    namespace,
    sourceScope,
  });
}

/**
 * The hybrid path taken when the embedding could not be generated: keyword
 * only, joined with the graph arm when that arm returned anything.
 */
async function runEmbeddinglessHybrid(plan: ResolvedSearchPlan): Promise<SearchRow[]> {
  const { query, limit, offset = 0 } = plan.options;
  logger.warn("embedding_failed_fallback_fts", { queryLength: query.length });
  const totalNeeded = offset + limit;
  const fetchLimit = totalNeeded * HYBRID_FETCH_MULTIPLIER;
  const graphRows = await runGraphArm(plan, fetchLimit);
  if (graphRows.length === 0) {
    return runFtsArm(plan, limit, offset);
  }
  const ftsRows = await runFtsArm(plan, fetchLimit, 0);
  return rrfMerge([], ftsRows, totalNeeded, graphRows).slice(offset);
}

/** The full hybrid path: both arms in parallel, plus graph, merged with RRF. */
async function runHybrid(
  plan: ResolvedSearchPlan,
  embedding: number[],
): Promise<SearchRow[]> {
  const { limit, offset = 0 } = plan.options;
  // Over-fetch to cover offset + limit, then slice after merge
  const totalNeeded = offset + limit;
  const fetchLimit = totalNeeded * HYBRID_FETCH_MULTIPLIER;
  const [vectorRows, ftsRows] = await Promise.all([
    runVectorArm(plan, embedding, fetchLimit, 0),
    runFtsArm(plan, fetchLimit, 0),
  ]);
  const graphRows = await runGraphArm(plan, fetchLimit);
  return rrfMerge(vectorRows, ftsRows, totalNeeded, graphRows).slice(offset);
}

/** Phases two and three: pick the arms for the mode and merge what they return. */
async function runSearchArms(plan: ResolvedSearchPlan): Promise<SearchRow[]> {
  const { deps, query, limit, mode = "hybrid", offset = 0 } = plan.options;
  if (mode === "keyword") {
    return runFtsArm(plan, limit, offset);
  }

  // Vector and hybrid both need an embedding
  const embedding = await generateSearchEmbedding(deps, query);
  if (!embedding) {
    // Fall back to keyword-only if embedding fails in hybrid mode
    if (mode === "hybrid") return runEmbeddinglessHybrid(plan);
    // In vector mode, null embedding is a hard failure -- signal via thrown error
    throw new Error("Failed to generate query embedding");
  }

  if (mode === "vector") {
    return runVectorArm(plan, embedding, limit, offset);
  }
  return runHybrid(plan, embedding);
}

export async function executeSearchInternal(
  options: ExecuteSearchOptions,
): Promise<SearchRow[]> {
  const plan = resolveSearchPlan(options);
  if (!plan) return [];
  return shapeSearchRows(plan, await runSearchArms(plan));
}

export function executeSearch(options: ExecuteSearchOptions): Promise<SearchRow[]> {
  const {
    accessibleTables,
    query,
    limit,
    mode = "hybrid",
    tier,
    offset = 0,
    namespace,
    includeLinks,
    sourceScope,
  } = options;
  return traceRetrievalSpan({
    name: "retrieval.execute",
    input: {
      query,
      tables: accessibleTables,
      limit,
      mode,
      tier,
      offset,
      namespace,
      include_links: includeLinks,
      source_scope: sourceScope,
      options,
    },
    metadata: {
      stage: "retrieval_pipeline",
      resolved_namespace: namespace ?? null,
      filter_names: [
        "permissions",
        "namespace",
        "tier",
        "source_scope",
        "archived_at",
        "pagination",
      ],
    },
    run: () => executeSearchInternal(options),
    output: rowsEvidence,
  });
}
