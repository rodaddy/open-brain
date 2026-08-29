import { toSql } from "pgvector/pg";
import {
  buildFtsCTE,
  buildRelationalHydrationSelect,
  buildTableCTE,
} from "./legacy-search-query-builders.ts";
import {
  appendNamespaceParam,
  paramRef,
  rowsEvidence,
  withSourceRefs,
  type SearchRow,
} from "./legacy-search-rows-and-fallback.ts";
import { appendSourceScopeParam, type SourceScope } from "../../domain/source-refs.ts";
import type { Table, Tier } from "../../../src/types.ts";
import type { ToolDeps } from "../../../src/tools/index.ts";
import { logger } from "../../../src/logger.ts";
import { traceRetrievalSpan } from "../../observability/langfuse-tracing.ts";
import {
  DEFAULT_FTS_CONFIG,
  ftsStatementTimeoutMsFromReader as ftsStatementTimeoutMs,
  type FtsConfig,
} from "./fts-config.ts";
import {
  parseRelationalQuery,
  AGE_WEIGHT,
  USEFULNESS_WEIGHT,
  VECTOR_WEIGHT,
  type NamespaceFilter,
  type SearchTable,
} from "./legacy-search-tables-and-parsing.ts";
/** Every argument `relationalGraphSearch` takes, in its former positional order. */
export type RelationalGraphSearchOptions = {
  deps: ToolDeps;
  accessibleTables: SearchTable[];
  query: string;
  fetchLimit: number;
  tier?: Tier;
  namespace?: NamespaceFilter;
};

export async function relationalGraphSearch(
  options: RelationalGraphSearchOptions,
): Promise<SearchRow[]> {
  const { deps, accessibleTables, query, fetchLimit, tier, namespace } = options;
  const parsed = parseRelationalQuery(query);
  if (!parsed) return [];
  // Relational hydration walks `ob_links` from a seed entity into the physical
  // content tables. `entities` is the seed side, and `session_events` has no
  // rows in the link graph, so neither is a hydration target.
  const targetTables = accessibleTables.filter(
    (table): table is Table => table !== "entities" && table !== "session_events",
  );
  if (targetTables.length === 0) return [];

  const params: unknown[] = [parsed.seed, parsed.relation, fetchLimit];
  const namespaceParamIndex = appendNamespaceParam(params, namespace);
  const namespaceIsArray = Array.isArray(namespace);
  const namespaceFilter = namespaceParamIndex
    ? namespaceIsArray
      ? ` AND e.namespace = ANY(${paramRef(namespaceParamIndex)}::text[])`
      : ` AND e.namespace = ${paramRef(namespaceParamIndex)}`
    : "";
  const hydrationSql = targetTables
    .map((table) => buildRelationalHydrationSelect(table, parsed.direction, tier))
    .join("\nUNION ALL\n");

  try {
    const rows = await traceRetrievalSpan({
      name: "retrieval.graph_query",
      input: {
        relation: parsed.relation,
        direction: parsed.direction,
        seed: parsed.seed,
        fetch_limit: fetchLimit,
        tier,
        namespace,
      },
      metadata: {
        stage: "candidate_generation",
        filter_names: ["namespace", "relation", "archived_at"],
      },
      run: async () => {
        const result = await deps.pool.query<SearchRow>(
          `WITH relational_graph_seed AS (
         SELECT e.id, e.namespace
         FROM ob_entities e
         WHERE (
             lower(e.name) = lower($1)
             OR lower(COALESCE(e.canonical_id, '')) = lower($1)
           )
           AND e.archived_at IS NULL${namespaceFilter}
         ORDER BY e.updated_at DESC
         LIMIT 5
       )
       SELECT *
       FROM (
${hydrationSql}
       ) relational_graph_rows
       ORDER BY fts_rank DESC, created_at DESC
       LIMIT $3`,
          params,
        );
        return withSourceRefs(result.rows);
      },
      output: rowsEvidence,
    });
    logger.info("search_relational_graph", {
      relation: parsed.relation,
      direction: parsed.direction,
      seed_length: parsed.seed.length,
      target_tables: targetTables,
      candidate_count: rows.length,
    });
    return rows;
  } catch (err) {
    logger.warn("search_relational_graph_failed", {
      relation: parsed.relation,
      direction: parsed.direction,
      seed_length: parsed.seed.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** Every argument `vectorSearch` takes, in its former positional order. */
export type VectorSearchOptions = {
  deps: ToolDeps;
  accessibleTables: SearchTable[];
  embedding: number[];
  fetchLimit: number;
  tier?: Tier;
  offset?: number;
  namespace?: NamespaceFilter;
  sourceScope?: SourceScope;
};

export async function vectorSearch(options: VectorSearchOptions): Promise<SearchRow[]> {
  const {
    deps,
    accessibleTables,
    embedding,
    fetchLimit,
    tier,
    offset = 0,
    namespace,
    sourceScope,
  } = options;
  const perTableLimit = fetchLimit;
  const params = [toSql(embedding), fetchLimit, offset];
  const namespaceParamIndex = appendNamespaceParam(params, namespace);
  const sourceScopeParamIndex = appendSourceScopeParam(params, sourceScope);
  const namespaceIsArray = Array.isArray(namespace);
  const ctes = accessibleTables.map((t) =>
    buildTableCTE({
      table: t,
      perTableLimit,
      tier,
      namespaceParamIndex,
      namespaceIsArray,
      sourceScopeParamIndex,
    }),
  );
  const cteNames = accessibleTables.map((t) => `${t}_results`);
  const unionAll = cteNames
    .map((name) => `SELECT * FROM ${name}`)
    .join("\nUNION ALL\n");

  const sql = `WITH query_embedding AS (
  SELECT $1::halfvec(768) AS emb
),
${ctes.join(",\n")}
SELECT * FROM (
${unionAll}
) AS combined
ORDER BY (distance * ${VECTOR_WEIGHT} + (1.0 - COALESCE(usefulness, 0.5)) * ${USEFULNESS_WEIGHT} + EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400.0 * ${AGE_WEIGHT}) ASC
LIMIT $2 OFFSET $3`;

  return traceRetrievalSpan({
    name: "retrieval.vector_query",
    input: {
      accessible_tables: accessibleTables,
      fetch_limit: fetchLimit,
      offset,
      tier,
      namespace,
      source_scope: sourceScope,
    },
    metadata: {
      stage: "candidate_generation",
      filter_names: ["namespace", "tier", "source_scope", "archived_at"],
    },
    run: async () => {
      const { rows } = await deps.pool.query(sql, params);
      return withSourceRefs(rows as SearchRow[]);
    },
    output: rowsEvidence,
  });
}

/**
 * Execute one FTS statement under the cost policy for its configuration
 * (the query execution boundary for the lexical arm).
 *
 * english (default): a plain pooled query. The GIN-indexed stored-column path
 * needs no extra bound and stays byte-identical to the pre-#341 execution.
 *
 * non-default config: the match arm recomputes `to_tsvector` per row with no
 * index (see ftsMatchExpressions), so the statement runs inside a transaction
 * bounded by a transaction-scoped `SET LOCAL statement_timeout`. The bound
 * comes from OPENBRAIN_FTS_STATEMENT_TIMEOUT_MS validated to a positive
 * integer (default 5000 ms) by ftsStatementTimeoutMs -- the raw env string is
 * never interpolated. `SET` accepts no bind parameters, so the vetted number
 * (and only the number) is inlined, mirroring the allowlist-then-interpolate
 * discipline used for table names and the regconfig literal. SET LOCAL scopes
 * the timeout to this transaction, so the pooled connection is returned clean.
 */
export async function runBoundedFtsQuery(
  deps: ToolDeps,
  sql: string,
  params: unknown[],
  ftsConfig: FtsConfig,
): Promise<{ rows: unknown[] }> {
  if (ftsConfig === DEFAULT_FTS_CONFIG) {
    return deps.pool.query(sql, params as unknown[] as never[]);
  }
  const timeoutMs = ftsStatementTimeoutMs();
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const result = await (async () => {
      await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
      const queried = await client.query(sql, params as unknown[] as never[]);
      await client.query("COMMIT");
      return queried;
    })();
    client.release();
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
      client.release();
    } catch {
      // The original error is the signal; a failed ROLLBACK must not mask
      // it. Destroy the client so a connection with an aborted transaction
      // (or a dead socket) can never be handed back to the shared pool.
      client.release(err instanceof Error ? err : new Error(String(err)));
    }
    throw err;
  }
}

/** Every argument `ftsSearch` takes, in its former positional order. */
export type FtsSearchOptions = {
  deps: ToolDeps;
  accessibleTables: SearchTable[];
  query: string;
  fetchLimit: number;
  tier?: Tier;
  offset?: number;
  namespace?: NamespaceFilter;
  sourceScope?: SourceScope;
  ftsConfig?: FtsConfig;
};

export async function ftsSearch(options: FtsSearchOptions): Promise<SearchRow[]> {
  const {
    deps,
    accessibleTables,
    query,
    fetchLimit,
    tier,
    offset = 0,
    namespace,
    sourceScope,
    ftsConfig = DEFAULT_FTS_CONFIG,
  } = options;
  const perTableLimit = fetchLimit;
  const params = [query, fetchLimit, offset];
  const namespaceParamIndex = appendNamespaceParam(params, namespace);
  const sourceScopeParamIndex = appendSourceScopeParam(params, sourceScope);
  const namespaceIsArray = Array.isArray(namespace);
  const ctes = accessibleTables.map((t) =>
    buildFtsCTE({
      table: t,
      perTableLimit,
      ftsConfig,
      tier,
      namespaceParamIndex,
      namespaceIsArray,
      sourceScopeParamIndex,
    }),
  );
  const cteNames = accessibleTables.map((t) => `${t}_fts`);
  const unionAll = cteNames
    .map((name) => `SELECT * FROM ${name}`)
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
      accessible_tables: accessibleTables,
      fetch_limit: fetchLimit,
      offset,
      tier,
      namespace,
      source_scope: sourceScope,
      fts_config: ftsConfig,
    },
    metadata: {
      stage: "candidate_generation",
      filter_names: ["namespace", "tier", "source_scope", "archived_at"],
    },
    run: async () => {
      const { rows } = await runBoundedFtsQuery(deps, sql, params, ftsConfig);
      return withSourceRefs(rows as SearchRow[]);
    },
    output: rowsEvidence,
  });
}

/**
 * Reciprocal Rank Fusion: merge ranked lists from different scoring systems.
 * Items appearing in both lists get summed RRF scores (boosted).
 * Items in only one list get a single RRF score.
 * Hot entries get +0.3 boost, cold entries get -0.2, warm is unchanged.
 */
