/**
 * The retrieval engine behind every search and recall surface.
 *
 * Design authority: #327 (durable-memory recall is one hybrid stack, not one per
 * consumer), #341 (FTS regconfig allowlist and the english/non-english split),
 * and `docs/decisions/shared-kb-canonical-namespace.md` (canonical vs physical
 * namespace translation on read).
 *
 * THERE IS EXACTLY ONE RETRIEVAL STACK. `search_brain`, `search_all`,
 * `brain_answer`, and the context pack's `durable_memory` section all enter
 * through {@link executeSearch}. That is a load-bearing property, not tidiness:
 * ranking, namespace isolation, archived filtering, and the graph arm are
 * defined once, so a fix to any of them lands everywhere at once and two
 * surfaces cannot answer the same question differently.
 *
 * Three arms, and the difference between them is what fails when input is bad:
 *
 *   - `keyword` — lexical only. Runs without an embedding, so it is the arm that
 *     still works when the embedding provider is down.
 *   - `vector` — semantic only. A null embedding is a HARD ERROR here: there is
 *     no lexical result to degrade to, and returning `[]` would report "nothing
 *     matched" for what was actually an outage.
 *   - `hybrid` (default) — both in parallel, fused by RRF. A null embedding
 *     degrades to keyword-only WITH a logged warning, because a usable lexical
 *     answer beats an error.
 *
 * SQL discipline. Query text, namespaces, tiers, and every caller value are
 * bound parameters. The only interpolated strings are compile-time literals
 * selected by a validated key — table names via the Zod-validated
 * `ResourceTable` union, and the FTS regconfig via the `SUPPORTED_FTS_CONFIGS`
 * allowlist re-asserted at the interpolation point by `ftsConfigLiteral`. The
 * fragments themselves live in `search-engine-sql.ts`; this file owns the arms,
 * the fusion, and the dispatch between them.
 *
 * WHY THE TWO PUBLIC ENTRIES STILL TAKE POSITIONAL ARGUMENTS. Everything
 * internal to the engine now threads one options object, but {@link executeSearch}
 * and {@link executeSearchWithSharedFallback} are called positionally from
 * `server/tools/` consumers and from tests that this change does not touch.
 * Their shapes are the compatibility surface; internally they immediately
 * collapse to {@link SearchRequest}.
 */
import { toSql } from "pgvector/pg";
import { canRead } from "../auth/permissions.ts";
import {
  ALL_TABLES,
  RRF_K,
  TABLE_WEIGHT,
  TIER_BOOST,
  type Tier,
} from "./search-constants.ts";
import { DEFAULT_FTS_CONFIG, type FtsConfig } from "./fts-config.ts";
import { sharedNamespaceConfig } from "./shared-namespace.ts";
import type { SharedNamespaceConfig } from "./shared-namespace.ts";
import type { NamespaceFilter } from "./read-scope.ts";
import {
  traceRetrievalSpan,
  traceRetrievalSpanSync,
} from "../observability/langfuse-tracing.ts";
import {
  AGE_WEIGHT,
  DEFAULT_SEARCH_EMBEDDING_TIMEOUT_MS,
  HYBRID_FETCH_MULTIPLIER,
  USEFULNESS_WEIGHT,
  VECTOR_WEIGHT,
  rowEvidence,
  rowIdsEvidence,
  rowsEvidence,
  type ExecuteSearchOptions,
  type SearchDependencies,
  type SearchMode,
  type SearchRow,
  type SearchSource,
  type SourceRef,
} from "./search-engine-types.ts";
import {
  appendNamespaceParam,
  buildFtsCTE,
  buildSessionEventsFtsCTE,
  buildSessionEventsVectorCTE,
  buildVectorCTE,
  type CteContext,
} from "./search-engine-sql.ts";
import {
  withCanonicalNamespaces,
  withSourceRefs,
} from "./search-engine-rows.ts";
import { mergeFallbackRows } from "./search-engine-fallback.ts";

export type {
  ExecuteSearchOptions,
  SearchDependencies,
  SearchMode,
  SearchRow,
  SearchSource,
  SourceRef,
};
export { mergeFallbackRows };

/**
 * One search, as the engine's internals carry it.
 *
 * The two exported entries build this from their positional arguments and
 * nothing below them takes a loose parameter list again.
 */
interface SearchRequest {
  readonly tables: readonly SearchSource[];
  readonly query: string;
  readonly limit: number;
  readonly mode: SearchMode;
  readonly tier: Tier | undefined;
  readonly offset: number;
  readonly namespace: NamespaceFilter | undefined;
  readonly ftsConfig: FtsConfig;
}

/** One arm's window into a request: how many rows, skipping how many. */
interface ArmWindow {
  readonly fetchLimit: number;
  readonly offset: number;
}

/**
 * Resolve the embedding timeout from the injected dependencies.
 *
 * The value arrives from the ONE validated parse
 * (`config.search.embeddingTimeoutMs`, `server/config/env-groups.ts`
 * `searchGroup`), which already applies the same two names, the same
 * `OPENBRAIN_`-first precedence, and the same fallback for a blank or
 * unusable value. Absent means the caller injected nothing, and the same
 * default answers — the value an unset environment produced before this
 * became injected.
 */
function searchEmbeddingTimeoutMs(dependencies: SearchDependencies): number {
  const injected = dependencies.searchEmbeddingTimeoutMs;
  if (injected === undefined) return DEFAULT_SEARCH_EMBEDDING_TIMEOUT_MS;
  return Number.isNaN(injected) || injected < 1
    ? DEFAULT_SEARCH_EMBEDDING_TIMEOUT_MS
    : injected;
}

/**
 * Embed the query, giving up after the configured timeout.
 *
 * Returns `null` rather than throwing on timeout so each arm can decide what a
 * missing embedding means for it — hybrid degrades, vector fails. The timer is
 * always cleared, so a fast provider never leaves a pending timeout holding the
 * event loop open.
 */
async function generateSearchEmbedding(
  dependencies: SearchDependencies,
  query: string,
): Promise<number[] | null> {
  const timeoutMs = searchEmbeddingTimeoutMs(dependencies);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  return traceRetrievalSpan({
    name: "retrieval.embedding",
    input: { query, timeout_ms: timeoutMs },
    metadata: { stage: "candidate_generation" },
    run: async () => {
      try {
        return await Promise.race([
          dependencies.embedFn(query),
          new Promise<null>((resolve) => {
            timeoutId = setTimeout(() => {
              dependencies.logger.warn(
                { timeout_ms: timeoutMs, query_chars: query.length },
                "search_embedding_timeout",
              );
              resolve(null);
            }, timeoutMs);
          }),
        ]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    },
    output: (embedding) => ({
      generated: embedding !== null,
      dimensions: embedding?.length ?? 0,
    }),
  });
}

/**
 * Gentle recency decay applied after fusion: today 1.0, ~30d 0.97, ~365d 0.73.
 *
 * Deliberately shallow. Recency is a tiebreaker between comparably relevant
 * records, not a ranking signal in its own right — an old decision that answers
 * the question must still outrank a fresh note that does not.
 */
function recencyFactor(createdAt: string): number {
  const ms = new Date(createdAt).getTime();
  if (Number.isNaN(ms)) return 1;
  const ageDays = (Date.now() - ms) / 86_400_000;
  return 1 / (1 + Math.max(0, ageDays) * 0.001);
}

/**
 * The recall sources a role may read, in one place.
 *
 * This exists because the selection was OPEN-CODED at each call site, and that
 * is exactly how #433 defect 1 happened: every caller filtered `ALL_TABLES`
 * independently and nothing added the session-event corpus anywhere, so
 * 11,136 rows were unreachable from the tool agents actually ask. One copy per
 * caller is one chance per caller to forget. Callers needing the default set
 * MUST use this function, so a new source is added once and appears on every
 * recall surface at once.
 *
 * `session_events` has no PERMISSIONS row: it is a read-only retrieval source,
 * never written through this surface, and it rides the `sessions` read
 * permission because a session event is session-scoped content.
 */
export function readableSearchSources(
  role: Parameters<typeof canRead>[0],
): SearchSource[] {
  const sources: SearchSource[] = ALL_TABLES.filter((table) =>
    canRead(role, table),
  );
  if (canRead(role, "sessions")) sources.push("session_events");
  return sources;
}

/** Resolve the per-CTE scope for one arm over one request window. */
function cteContextFor(
  request: SearchRequest,
  window: ArmWindow,
  namespaceParamIndex: number | undefined,
): CteContext {
  return {
    perTableLimit: window.fetchLimit,
    tier: request.tier,
    namespaceParamIndex,
    namespaceIsArray: Array.isArray(request.namespace),
  };
}

/** Run the vector arm across every accessible table. */
async function vectorSearch(
  dependencies: SearchDependencies,
  request: SearchRequest,
  embedding: number[],
  window: ArmWindow,
): Promise<SearchRow[]> {
  const { tables, tier, namespace } = request;
  const { fetchLimit, offset } = window;
  const params: unknown[] = [toSql(embedding), fetchLimit, offset];
  const context = cteContextFor(
    request,
    window,
    appendNamespaceParam(params, namespace),
  );
  const ctes = tables.map((table) =>
    table === "session_events"
      ? buildSessionEventsVectorCTE(context)
      : buildVectorCTE(table, context),
  );
  const unionAll = tables
    .map((table) => `SELECT * FROM ${table}_results`)
    .join("\nUNION ALL\n");

  const sql = `WITH query_embedding AS (
  SELECT $1::halfvec(768) AS emb
),
${ctes.join(",\n")}
SELECT * FROM (
${unionAll}
) AS combined
ORDER BY (distance * ${VECTOR_WEIGHT}
  + (1.0 - COALESCE(usefulness, 0.5)) * ${USEFULNESS_WEIGHT}
  + EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400.0 * ${AGE_WEIGHT}) ASC
LIMIT $2 OFFSET $3`;

  return traceRetrievalSpan({
    name: "retrieval.vector_query",
    input: { tables, fetch_limit: fetchLimit, offset, tier, namespace },
    metadata: {
      stage: "candidate_generation",
      filter_names: ["namespace", "tier", "archived_at"],
    },
    run: async () => {
      const { rows } = await dependencies.pool.query(sql, params);
      return withSourceRefs(rows as SearchRow[]);
    },
    output: rowsEvidence,
  });
}

/** Run the lexical arm across every accessible table. */
async function ftsSearch(
  dependencies: SearchDependencies,
  request: SearchRequest,
  window: ArmWindow,
): Promise<SearchRow[]> {
  const { tables, query, tier, namespace, ftsConfig } = request;
  const { fetchLimit, offset } = window;
  const params: unknown[] = [query, fetchLimit, offset];
  const context = cteContextFor(
    request,
    window,
    appendNamespaceParam(params, namespace),
  );
  const ctes = tables.map((table) =>
    table === "session_events"
      ? buildSessionEventsFtsCTE(context)
      : buildFtsCTE(table, ftsConfig, context),
  );
  const unionAll = tables
    .map((table) => `SELECT * FROM ${table}_fts`)
    .join("\nUNION ALL\n");

  const sql = `WITH fts_query AS (
  SELECT $1::text AS q
),
${ctes.join(",\n")}
SELECT * FROM (
${unionAll}
) AS combined
ORDER BY fts_rank DESC
LIMIT $2 OFFSET $3`;

  return traceRetrievalSpan({
    name: "retrieval.keyword_query",
    input: {
      query,
      tables,
      fetch_limit: fetchLimit,
      offset,
      tier,
      namespace,
      fts_config: ftsConfig,
    },
    metadata: {
      stage: "candidate_generation",
      filter_names: ["namespace", "tier", "archived_at"],
    },
    run: async () => {
      const { rows } = await dependencies.pool.query(sql, params);
      return withSourceRefs(rows as SearchRow[]);
    },
    output: rowsEvidence,
  });
}

/** Post-fusion score for one record: tier boost, table weight, recency decay. */
function fusedScore(row: SearchRow, rrf: number): number {
  return Math.max(
    0,
    (rrf + TIER_BOOST[(row.tier ?? "warm") as Tier]) *
      (TABLE_WEIGHT[row.source_type] ?? 1) *
      recencyFactor(row.created_at),
  );
}

/** Sum reciprocal-rank contributions across both arms, keyed by record. */
function accumulateRrf(
  arms: ReadonlyArray<readonly SearchRow[]>,
): Map<string, { row: SearchRow; rrf: number }> {
  const scored = new Map<string, { row: SearchRow; rrf: number }>();
  for (const rows of arms) {
    rows.forEach((row, index) => {
      const key = `${row.source_type}:${row.id}`;
      const contribution = 1 / (RRF_K + index + 1);
      const existing = scored.get(key);
      if (existing) existing.rrf += contribution;
      else scored.set(key, { row, rrf: contribution });
    });
  }
  return scored;
}

/**
 * Reciprocal Rank Fusion (Cormack et al. 2009).
 *
 * Fusion is by POSITION, never by raw score, and that is the whole point: cosine
 * distance and `ts_rank_cd` are incomparable scales, so any attempt to blend the
 * numbers directly lets whichever arm happens to produce larger values dominate.
 * Rank is the one currency both arms share. A record found by both arms sums two
 * contributions and rises, which is exactly the signal hybrid search exists to
 * capture.
 *
 * Tier boost, per-table weight, and recency are applied AFTER fusion, and the
 * result is floored at zero so a cold-tier penalty can never produce a negative
 * score that sorts below an irrelevant row.
 */
function rrfMerge(
  vectorRows: readonly SearchRow[],
  ftsRows: readonly SearchRow[],
  limit: number,
): SearchRow[] {
  let ranked: Array<{ row: SearchRow; rrf: number }> = [];
  return traceRetrievalSpanSync({
    name: "retrieval.rank_rrf",
    input: {
      limit,
      vector: rowIdsEvidence(vectorRows),
      keyword: rowIdsEvidence(ftsRows),
    },
    metadata: { stage: "scoring_ranking", filter_names: ["rrf_limit"] },
    run: () => {
      ranked = Array.from(accumulateRrf([vectorRows, ftsRows]).values())
        .map(({ row, rrf }) => ({ row, rrf: fusedScore(row, rrf) }))
        .sort((a, b) => b.rrf - a.rrf);
      return ranked.slice(0, limit).map(({ row }) => row);
    },
    output: (selected) => {
      const selectedKeys = new Set(
        selected.map((row) => `${row.source_type}:${row.id}`),
      );
      return {
        candidate_count: ranked.length,
        selected_count: selected.length,
        candidates: ranked.map(({ row, rrf }) => ({
          ...rowEvidence(row),
          rrf_score: rrf,
          chosen: selectedKeys.has(`${row.source_type}:${row.id}`),
          filtered_by: selectedKeys.has(`${row.source_type}:${row.id}`)
            ? null
            : "rrf_limit",
        })),
      };
    },
  });
}

/**
 * Hybrid: both arms in parallel, over-fetched so fusion has depth to reorder,
 * then sliced to the requested window AFTER merging. Slicing before the merge
 * would page through each arm independently and produce an order no consumer
 * could reproduce.
 */
async function hybridSearch(
  dependencies: SearchDependencies,
  request: SearchRequest,
  embedding: number[],
): Promise<SearchRow[]> {
  const totalNeeded = request.offset + request.limit;
  const window: ArmWindow = {
    fetchLimit: totalNeeded * HYBRID_FETCH_MULTIPLIER,
    offset: 0,
  };
  const [vectorRows, ftsRows] = await Promise.all([
    vectorSearch(dependencies, request, embedding, window),
    ftsSearch(dependencies, request, window),
  ]);
  return rrfMerge(vectorRows, ftsRows, totalNeeded).slice(request.offset);
}

/**
 * Run one search across the caller's accessible tables.
 *
 * @param dependencies Pool, embedder, and logger.
 * @param request The resolved request; `tables` comes from the caller's
 *   permission matrix, so an empty list means "no readable tables" and is the
 *   caller's error to report, not this function's.
 * @throws When `mode` is `vector` and the embedding could not be generated.
 */
async function executeSearchInternal(
  dependencies: SearchDependencies,
  request: SearchRequest,
): Promise<SearchRow[]> {
  if (request.tables.length === 0) return [];
  const window: ArmWindow = {
    fetchLimit: request.limit,
    offset: request.offset,
  };

  if (request.mode === "keyword") {
    return ftsSearch(dependencies, request, window);
  }

  const embedding = await generateSearchEmbedding(dependencies, request.query);
  if (!embedding) {
    if (request.mode === "vector") {
      // No lexical result to degrade to. Returning [] here would report
      // "nothing matched" for what is actually a provider outage.
      throw new Error("Failed to generate query embedding");
    }
    dependencies.logger.warn(
      { query_chars: request.query.length },
      "embedding_failed_fallback_fts",
    );
    return ftsSearch(dependencies, request, window);
  }

  if (request.mode === "vector") {
    return vectorSearch(dependencies, request, embedding, window);
  }

  return hybridSearch(dependencies, request, embedding);
}

/**
 * The positional argument list {@link executeSearch} accepts.
 *
 * A LABELLED TUPLE, not a loose parameter list, and the distinction is the
 * whole reason this compiles clean. Every existing call site passes these
 * positionally and this change does not touch those files, so the order and the
 * optionality are the compatibility contract. Expressing that contract as a
 * named tuple keeps each position's type checked exactly as before — passing a
 * `Tier` where `mode` belongs is still a compile error — while letting the
 * engine carry one argument internally instead of nine.
 *
 * @param dependencies Pool, embedder, and logger.
 * @param tables Tables the caller may read; the caller resolves this from the
 *   permission matrix, so an empty list means "no readable tables" and is the
 *   caller's error to report, not this function's.
 * @param query Natural-language query text; always a bound parameter.
 * @param limit Maximum rows to return.
 * @param mode Which arm to run.
 * @param tier Optional cognitive-tier filter.
 * @param offset Rows to skip, for pagination.
 * @param namespace Auth-derived namespace filter; `undefined` is a global read
 *   and is only reachable for a role whose reads are global by design.
 * @param options Lexical-arm configuration.
 */
type ExecuteSearchArgs = [
  dependencies: SearchDependencies,
  tables: readonly SearchSource[],
  query: string,
  limit: number,
  mode?: SearchMode,
  tier?: Tier,
  offset?: number,
  namespace?: NamespaceFilter,
  options?: ExecuteSearchOptions,
];

/** The same list for {@link executeSearchWithSharedFallback}, which adds one. */
type SharedFallbackArgs = [
  dependencies: SearchDependencies,
  tables: readonly SearchSource[],
  query: string,
  limit: number,
  mode: SearchMode,
  tier: Tier | undefined,
  offset: number,
  namespace: NamespaceFilter | undefined,
  options?: ExecuteSearchOptions,
  requestedShared?: boolean,
];

/** Collapse the positional compatibility surface into one request. */
function toSearchRequest(
  args: ExecuteSearchArgs | SharedFallbackArgs,
): SearchRequest {
  const [
    ,
    tables,
    query,
    limit,
    mode = "hybrid",
    tier,
    offset = 0,
    namespace,
    options = {},
  ] = args;
  return {
    tables,
    query,
    limit,
    mode,
    tier,
    offset,
    namespace,
    ftsConfig: options.ftsConfig ?? DEFAULT_FTS_CONFIG,
  };
}

export function executeSearch(
  ...args: ExecuteSearchArgs
): Promise<SearchRow[]> {
  const [dependencies, tables, query, limit] = args;
  const request = toSearchRequest(args);
  const { mode, tier, offset, namespace } = request;
  const options = args[8] ?? {};
  return traceRetrievalSpan({
    name: "retrieval.execute",
    input: { query, tables, limit, mode, tier, offset, namespace, options },
    metadata: {
      stage: "retrieval_pipeline",
      resolved_namespace: namespace ?? null,
      filter_names: [
        "permissions",
        "namespace",
        "tier",
        "archived_at",
        "pagination",
      ],
    },
    run: () => executeSearchInternal(dependencies, request),
    output: rowsEvidence,
  });
}

/**
 * Whether the legacy top-up is reachable for this request at all.
 *
 * It is skipped when no migration source is configured, when `offset !== 0`
 * (paginating a two-source merge cannot produce a stable window — the legacy
 * top-up depends on how many canonical rows the CURRENT page found, so pages
 * would overlap or skip rows), and when the request is not actually scoped to
 * the shared namespace.
 *
 * @param names Validated shared-namespace names from `ServerConfig`. Omitting
 * it leaves the environment-derived resolution unchanged.
 */
function sharedFallbackApplies(
  request: SearchRequest,
  requestedShared: boolean,
  names?: SharedNamespaceConfig,
): boolean {
  const config = sharedNamespaceConfig(names);
  if (!config.legacyFallbackEnabled) return false;
  if (config.legacySharedNamespace === "") return false;
  if (request.offset !== 0) return false;
  if (requestedShared) {
    return request.namespace === config.physicalSharedNamespace;
  }
  const scoped = Array.isArray(request.namespace) ? request.namespace : [];
  return scoped.includes(config.physicalSharedNamespace);
}

/** Run the canonical search, then top it up from the legacy namespace. */
async function searchWithLegacyTopUp(
  dependencies: SearchDependencies,
  request: SearchRequest,
): Promise<SearchRow[]> {
  const config = sharedNamespaceConfig(dependencies.sharedNamespaceNames);
  const primaryRows = await executeSearchInternal(dependencies, request);
  // Enough shared truth was found; the legacy namespace has nothing to add.
  if (
    primaryRows.length >= request.limit ||
    primaryRows.length >= config.fallbackMinResults
  ) {
    return primaryRows;
  }
  const legacyRows = await executeSearchInternal(dependencies, {
    ...request,
    namespace: config.legacySharedNamespace,
  });
  return mergeFallbackRows(primaryRows, legacyRows, request.limit);
}

/**
 * Search with the optional legacy-namespace top-up, then canonicalize.
 *
 * The fallback is OFF by default: #167 retired `collab`, so
 * `legacySharedNamespace` is empty and this is a plain {@link executeSearch}
 * call. It exists for the window in which an operator has explicitly configured
 * a migration source and shared results are still thin.
 *
 * @param requestedShared Whether the caller explicitly asked for the shared
 *   namespace (as opposed to it merely appearing in their readable list).
 */
export async function executeSearchWithSharedFallback(
  ...args: SharedFallbackArgs
): Promise<SearchRow[]> {
  const [dependencies, tables, query, rows, mode, tier, offset, namespace] =
    args;
  const request = toSearchRequest(args);
  const requestedShared = args[9] ?? false;
  const names = dependencies.sharedNamespaceNames;
  if (!sharedFallbackApplies(request, requestedShared, names)) {
    return withCanonicalNamespaces(
      await executeSearch(
        dependencies,
        tables,
        query,
        rows,
        mode,
        tier,
        offset,
        namespace,
        args[8] ?? {},
      ),
      names,
    );
  }
  return withCanonicalNamespaces(
    await searchWithLegacyTopUp(dependencies, request),
    names,
  );
}

export { ALL_TABLES };
