/**
 * The retrieval engine behind every search and recall surface: one stack, three
 * arms (`keyword`, `vector`, `hybrid`), with the SQL fragments in
 * `search-engine-sql.ts` and every caller value bound as a parameter.
 *
 * See docs/decisions/search-engine-one-retrieval-stack.md
 * See docs/decisions/search-engine-positional-entries-are-the-compat-surface.md
 */
import { toSql } from "pgvector/pg";
import { canRead } from "../auth/permissions.ts";
import { ALL_TABLES, type Tier } from "./search-constants.ts";
import { DEFAULT_FTS_CONFIG, type FtsConfig } from "./fts-config.ts";
import { sharedNamespaceConfig } from "./shared-namespace.ts";
import type { SharedNamespaceConfig } from "./shared-namespace.ts";
import type { NamespaceFilter } from "../domain/read-scope.ts";
import {
  traceMcpGeneration,
  traceRetrievalSpan,
} from "../observability/langfuse-tracing.ts";
import {
  AGE_WEIGHT,
  DEFAULT_SEARCH_EMBEDDING_TIMEOUT_MS,
  HYBRID_FETCH_MULTIPLIER,
  USEFULNESS_WEIGHT,
  VECTOR_WEIGHT,
  rowsEvidence,
  type ExecuteSearchOptions,
  type ExplicitLink,
  type SearchDependencies,
  type SearchMode,
  type SearchRow,
  type SearchSource,
  type SourceRef,
} from "./search-engine-types.ts";
import { runVectorSearchSql } from "../db/vector-search.ts";
import { describeError } from "../observability/log-surface.ts";
import {
  appendNamespaceParam,
  buildFtsCTE,
  buildSessionEventsFtsCTE,
  buildSessionEventsVectorCTE,
  buildVectorCTE,
  type CteContext,
} from "./search-engine-sql.ts";
import { withCanonicalNamespaces, withSourceRefs } from "./search-engine-rows.ts";
import { mergeFallbackRows } from "./search-engine-fallback.ts";
import { attachExplicitLinks } from "./search-engine-links.ts";
import { createEntryReadRepository } from "../db/entry-read-repository.ts";
import { rrfMerge } from "./search-engine-fusion.ts";
import { observeJevFailureSafely, rerankWithJev } from "../integrations/jev.ts";
// Re-exported so the engine module stays the one public name for retrieval;
// the body lives apart because this file is at its 500-code-line bound.
export {
  executeSearchWithScopedSharedFallback,
  type ScopedSharedFallbackRequest,
} from "./search-engine-scoped-fallback.ts";

export type {
  ExecuteSearchOptions,
  ExplicitLink,
  SearchDependencies,
  SearchMode,
  SearchRow,
  SearchSource,
  SourceRef,
};
export { attachExplicitLinks, mergeFallbackRows };

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
  const sources: SearchSource[] = ALL_TABLES.filter((table) => canRead(role, table));
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
    lexicalCandidateMode: request.mode === "hybrid" ? "partial_coverage" : "all_terms",
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
      const rows = await runVectorSearchSql({
        pool: dependencies.pool,
        sql,
        params,
        onRollbackFailure: (rollbackError) => {
          dependencies.logger.warn(
            describeError(rollbackError),
            "vector_search_rollback_failed",
          );
        },
      });
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
      ? buildSessionEventsFtsCTE(context, ftsConfig)
      : buildFtsCTE(table, ftsConfig, context),
  );
  const unionAll = tables
    .map((table) => `SELECT * FROM ${table}_fts`)
    .join("\nUNION ALL\n");

  const ordering =
    request.mode === "hybrid"
      ? "lexical_coverage DESC, fts_rank DESC, source_type ASC, id ASC"
      : "fts_rank DESC";
  const sql = `WITH fts_query AS (
  SELECT $1::text AS q
),
${ctes.join(",\n")}
SELECT * FROM (
${unionAll}
) AS combined
ORDER BY ${ordering}
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
      lexical_normalization:
        request.mode === "hybrid"
          ? "compound_components_and_english_digit_aliases"
          : "canonical",
    },
    run: async () => {
      const repository = createEntryReadRepository(dependencies.pool);
      const rows = (await repository.runSearchSql({ sql, params })) as SearchRow[];
      return withSourceRefs(rows);
    },
    output: rowsEvidence,
  });
}

/** Remove fusion-only metadata without mutating rows retained by observers. */
function toPublicSearchRows(rows: readonly SearchRow[]): SearchRow[] {
  return rows.map(
    ({ lexical_coverage: _coverage, query_lexeme_count: _count, ...row }) => row,
  );
}

/**
 * Hybrid: both arms in parallel, over-fetched so fusion has depth to reorder,
 * then sliced to the requested window AFTER merging. Slicing before the merge
 * would page through each arm independently and produce an order no consumer
 * could reproduce.
 */
export async function hybridSearch(
  dependencies: SearchDependencies,
  request: SearchRequest,
  embedding: number[],
  observe?: (arms: { vectorRows: SearchRow[]; ftsRows: SearchRow[] }) => void,
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
  observe?.({ vectorRows, ftsRows });
  const jev = dependencies.jev;
  const jevEnabled = jev?.config.enabled === true;
  const fused = rrfMerge(
    vectorRows,
    ftsRows,
    jevEnabled ? vectorRows.length + ftsRows.length : totalNeeded,
  );
  const rrfWindow = fused.slice(0, totalNeeded);
  let ranked = rrfWindow;
  if (jevEnabled && jev) {
    const rerankInput = fused.map((row) => ({
      row,
      id: `${row.source_type}:${row.id}`,
      content: row.content_preview ?? "",
    }));
    try {
      ranked = (
        await rerankWithJev(jev.config, request.query, rerankInput, {
          fetchFn: jev.fetchFn,
          observeBatch: (batch, work) =>
            observeJevFailureSafely(
              work,
              {
                candidate_count: batch.records.length,
                candidate_ids: batch.records.map(({ key }) => key),
              },
              (safeWork, failureMetadata) =>
                traceMcpGeneration({
                  name: "retrieval.jev.batch",
                  model: jev.config.model,
                  input: {
                    state: batch.state,
                    model: jev.config.model,
                    questions: batch.questions,
                  },
                  run: safeWork,
                  output: (response) => response,
                  servedModel: (response) => response.model,
                  usageDetails: (response) => ({
                    input: response.usage.input_tokens,
                    output: response.usage.output_tokens,
                  }),
                  metadata: failureMetadata,
                }),
            ),
          onFailure: ({ reason, status }) =>
            dependencies.logger.warn(
              { candidate_count: fused.length, reason, status },
              "jev_rerank_failed_fallback_rrf",
            ),
        })
      )
        .map(({ row }) => row)
        .slice(0, totalNeeded);
    } catch (error) {
      dependencies.logger.warn(
        { candidate_count: fused.length, error: describeError(error) },
        "jev_rerank_failed_fallback_rrf",
      );
    }
  }
  return toPublicSearchRows(ranked.slice(request.offset));
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
    return toPublicSearchRows(await ftsSearch(dependencies, request, window));
  }

  if (request.mode === "vector") {
    return vectorSearch(dependencies, request, embedding, window);
  }

  return hybridSearch(dependencies, request, embedding);
}

/**
 * The positional argument list {@link executeSearch} accepts.
 *
 * A labelled tuple, not a loose parameter list: the order and the optionality
 * are the compatibility contract every existing call site depends on.
 * See docs/decisions/search-engine-positional-entries-are-the-compat-surface.md
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
function toSearchRequest(args: ExecuteSearchArgs | SharedFallbackArgs): SearchRequest {
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

export function executeSearch(...args: ExecuteSearchArgs): Promise<SearchRow[]> {
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
      filter_names: ["permissions", "namespace", "tier", "archived_at", "pagination"],
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
 * EXPLICIT LINKS. This entry is one of the two surfaces the legacy REST route
 * used, and legacy attached `explicit_links` as the last shaping step of its
 * core execute (issue 841 cut 2, D3). Both return paths therefore hydrate the
 * rows they are about to return, with the caller-facing `namespace` the entry
 * searched with, so the payload matches what those consumers always received.
 * The modern core {@link executeSearch} deliberately does NOT attach: widening
 * the direct-execute consumers is outside cut 2.
 *
 * @param requestedShared Whether the caller explicitly asked for the shared
 *   namespace (as opposed to it merely appearing in their readable list).
 */
export async function executeSearchWithSharedFallback(
  ...args: SharedFallbackArgs
): Promise<SearchRow[]> {
  const [dependencies, tables, query, rows, mode, tier, offset, namespace] = args;
  const request = toSearchRequest(args);
  const requestedShared = args[9] ?? false;
  const names = dependencies.sharedNamespaceNames;
  if (!sharedFallbackApplies(request, requestedShared, names)) {
    return attachExplicitLinks(
      dependencies,
      withCanonicalNamespaces(
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
      ),
      namespace,
    );
  }
  return attachExplicitLinks(
    dependencies,
    withCanonicalNamespaces(await searchWithLegacyTopUp(dependencies, request), names),
    namespace,
  );
}

export { ALL_TABLES };
