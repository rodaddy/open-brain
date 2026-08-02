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
 * {@link ResourceTable} union, and the FTS regconfig via the `SUPPORTED_FTS_CONFIGS`
 * allowlist re-asserted at the interpolation point by `ftsConfigLiteral`.
 */
import { toSql } from "pgvector/pg";
import type { Logger } from "pino";
import type { Pool } from "pg";
import type { ResourceTable } from "../auth/types.ts";
import {
  ALL_TABLES,
  CONTENT_PREVIEW,
  FTS_SOURCE_TEXT,
  HAS_EXTRACTED_METADATA,
  RRF_K,
  SOURCE_LABELS,
  TABLE_ALIAS,
  TABLE_WEIGHT,
  TIER_BOOST,
  VALID_TIERS,
  type Tier,
} from "./search-constants.ts";
import {
  DEFAULT_FTS_CONFIG,
  ftsConfigLiteral,
  type FtsConfig,
} from "./fts-config.ts";
import { canonicalNamespace, sharedNamespaceConfig } from "./shared-namespace.ts";
import type { NamespaceFilter } from "./read-scope.ts";

export type SearchMode = "hybrid" | "vector" | "keyword";

/** Over-fetch factor per arm in hybrid mode; fusion needs depth to reorder. */
const HYBRID_FETCH_MULTIPLIER = 3;
/** Default ceiling on how long the embedding provider may hold up a search. */
const DEFAULT_SEARCH_EMBEDDING_TIMEOUT_MS = 3000;

/** Vector-mode ranking weights: similarity dominates, usefulness and age nudge. */
const VECTOR_WEIGHT = 0.7;
const USEFULNESS_WEIGHT = 0.15;
const AGE_WEIGHT = 0.0001;

export interface SourceRef {
  source: "brain";
  type: string;
  id: string;
  namespace?: string;
  created_by?: string | null;
  created_at?: string;
  last_updated_at?: string;
  label: string;
  preview: string;
}

export interface SearchRow {
  source_type: string;
  id: string;
  namespace?: string;
  content_preview: string | null;
  tags: string[] | null;
  created_by?: string | null;
  created_at: string;
  updated_at?: string | null;
  usefulness: number;
  tier?: string;
  distance?: number;
  fts_rank?: number;
  access_count?: number;
  source_ref?: SourceRef;
  extracted_metadata?: Record<string, unknown>;
}

export interface SearchDependencies {
  readonly pool: Pool;
  readonly embedFn: (text: string) => Promise<number[] | null>;
  readonly logger: Logger;
}

export interface ExecuteSearchOptions {
  /** Text-search configuration for the lexical arm; english when unset. */
  readonly ftsConfig?: FtsConfig;
}

/** Resolve the embedding timeout, ignoring an unusable environment value. */
function searchEmbeddingTimeoutMs(): number {
  const raw =
    process.env.OPENBRAIN_SEARCH_EMBEDDING_TIMEOUT_MS ??
    process.env.SEARCH_EMBEDDING_TIMEOUT_MS;
  if (!raw) return DEFAULT_SEARCH_EMBEDDING_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed < 1
    ? DEFAULT_SEARCH_EMBEDDING_TIMEOUT_MS
    : parsed;
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
  const timeoutMs = searchEmbeddingTimeoutMs();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
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

/** Render a bound-parameter reference, rejecting an out-of-range index. */
function paramRef(index: number): string {
  if (!Number.isInteger(index) || index < 1) {
    throw new Error(`Invalid SQL parameter index: ${index}`);
  }
  return `$${index}`;
}

/** Push the namespace filter and return its parameter index, or `undefined`. */
function appendNamespaceParam(
  params: unknown[],
  namespace?: NamespaceFilter,
): number | undefined {
  if (namespace === undefined) return undefined;
  params.push(namespace);
  return params.length;
}

/**
 * Build the namespace predicate for one aliased table.
 *
 * The VALUE is always bound; only the alias and column name — both compile-time
 * literals — are inlined. An absent filter yields `""`, which is a global read
 * and is only ever reachable for a role whose reads are global by design.
 */
function namespaceFilterSql(
  alias: string,
  paramIndex: number | undefined,
  isArray: boolean,
): string {
  if (!paramIndex) return "";
  return isArray
    ? ` AND ${alias}.namespace = ANY(${paramRef(paramIndex)}::text[])`
    : ` AND ${alias}.namespace = ${paramRef(paramIndex)}`;
}

/** Reject a tier that is not on the allowlist before it can reach SQL. */
function assertTier(tier: Tier | undefined): void {
  if (tier && !VALID_TIERS.has(tier)) throw new Error(`Invalid tier: ${tier}`);
}

/** Per-table SELECT list shared by the vector and lexical CTEs. */
function selectColumns(table: ResourceTable, rankExpression: string): string {
  const alias = TABLE_ALIAS[table];
  const metadata = HAS_EXTRACTED_METADATA.has(table)
    ? `${alias}.extracted_metadata`
    : "NULL::jsonb AS extracted_metadata";
  return `'${SOURCE_LABELS[table]}' AS source_type,
    ${alias}.id,
    ${alias}.namespace,
    ${CONTENT_PREVIEW[table]} AS content_preview,
    ${alias}.tags,
    ${alias}.created_by,
    ${alias}.created_at,
    ${alias}.updated_at,
    ${alias}.tier,
    ${rankExpression},
    COALESCE(${alias}.usefulness_score, 0.5) AS usefulness,
    COALESCE(${alias}.access_count, 0) AS access_count,
    ${metadata}`;
}

/** Build one table's vector-similarity CTE. */
function buildVectorCTE(
  table: ResourceTable,
  perTableLimit: number,
  tier: Tier | undefined,
  namespaceParamIndex: number | undefined,
  namespaceIsArray: boolean,
): string {
  assertTier(tier);
  const alias = TABLE_ALIAS[table];
  const tierFilter = tier ? ` AND ${alias}.tier = '${tier}'` : "";
  const nsFilter = namespaceFilterSql(alias, namespaceParamIndex, namespaceIsArray);
  const distance = `${alias}.embedding <=> (SELECT emb FROM query_embedding)`;
  return `${table}_results AS (
  SELECT ${selectColumns(table, `${distance} AS distance`)}
  FROM ${table} ${alias}
  WHERE ${alias}.embedding IS NOT NULL
    AND ${alias}.archived_at IS NULL${tierFilter}${nsFilter}
  ORDER BY ${distance} ASC
  LIMIT ${perTableLimit}
)`;
}

/**
 * Build the lexical match and rank expressions for one table under a chosen
 * text-search configuration (#341).
 *
 * `english` reads the stored, GIN-indexed `search_vector` column and is
 * byte-identical to the pre-#341 behavior. Any other allowlisted configuration
 * recomputes `to_tsvector(<config>, <same source columns>)` on the fly, so the
 * query arm and the analyzed text always share one configuration — no per-row
 * language column and no migration, at the cost of losing the index.
 *
 * `ftsConfigLiteral` re-asserts the allowlist HERE, at the one place a
 * configuration becomes SQL text, so the guarantee holds even for a future
 * caller that reaches this function without passing the schema first.
 */
function ftsMatchExpressions(
  table: ResourceTable,
  config: FtsConfig,
): { vectorSql: string; querySql: string } {
  const literal = ftsConfigLiteral(config);
  const querySql = `plainto_tsquery('${literal}', (SELECT q FROM fts_query))`;
  if (config === DEFAULT_FTS_CONFIG) {
    return { vectorSql: `${TABLE_ALIAS[table]}.search_vector`, querySql };
  }
  return {
    vectorSql: `to_tsvector('${literal}', ${FTS_SOURCE_TEXT[table]})`,
    querySql,
  };
}

/** Build one table's full-text-search CTE. */
function buildFtsCTE(
  table: ResourceTable,
  perTableLimit: number,
  ftsConfig: FtsConfig,
  tier: Tier | undefined,
  namespaceParamIndex: number | undefined,
  namespaceIsArray: boolean,
): string {
  assertTier(tier);
  const alias = TABLE_ALIAS[table];
  const tierFilter = tier ? ` AND ${alias}.tier = '${tier}'` : "";
  const nsFilter = namespaceFilterSql(alias, namespaceParamIndex, namespaceIsArray);
  const { vectorSql, querySql } = ftsMatchExpressions(table, ftsConfig);
  return `${table}_fts AS (
  SELECT ${selectColumns(table, `ts_rank_cd(${vectorSql}, ${querySql}) AS fts_rank`)}
  FROM ${table} ${alias}
  WHERE ${vectorSql} @@ ${querySql}
    AND ${alias}.archived_at IS NULL${tierFilter}${nsFilter}
  ORDER BY fts_rank DESC
  LIMIT ${perTableLimit}
)`;
}

/** Convert a timestamp-ish value to an ISO string, or `undefined`. */
function toIsoString(value: unknown): string | undefined {
  if (typeof value !== "string" && !(value instanceof Date)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Attach the resolvable `source_ref` every consumer cites from.
 *
 * Built once here rather than in each consumer so a citation emitted by
 * `brain_answer`, a pointer emitted by the context pack, and a row emitted by
 * `search_brain` all address the same record identically.
 */
function withSourceRefs(rows: SearchRow[]): SearchRow[] {
  return rows.map((row) => ({
    ...row,
    source_ref: {
      source: "brain" as const,
      type: row.source_type,
      id: row.id,
      namespace: row.namespace,
      created_by: row.created_by,
      created_at: toIsoString(row.created_at),
      last_updated_at:
        toIsoString(row.updated_at) ?? toIsoString(row.created_at),
      label: (row.content_preview ?? "").slice(0, 120),
      preview: (row.content_preview ?? "").slice(0, 300),
    },
  }));
}

/** Report the canonical shared name on emitted rows and their source refs. */
function withCanonicalNamespaces(rows: SearchRow[]): SearchRow[] {
  return rows.map((row) => ({
    ...row,
    namespace: row.namespace ? canonicalNamespace(row.namespace) : row.namespace,
    source_ref: row.source_ref
      ? {
          ...row.source_ref,
          namespace: row.source_ref.namespace
            ? canonicalNamespace(row.source_ref.namespace)
            : row.source_ref.namespace,
        }
      : row.source_ref,
  }));
}

/** Run the vector arm across every accessible table. */
async function vectorSearch(
  dependencies: SearchDependencies,
  tables: readonly ResourceTable[],
  embedding: number[],
  fetchLimit: number,
  tier: Tier | undefined,
  offset: number,
  namespace: NamespaceFilter | undefined,
): Promise<SearchRow[]> {
  const params: unknown[] = [toSql(embedding), fetchLimit, offset];
  const namespaceParamIndex = appendNamespaceParam(params, namespace);
  const namespaceIsArray = Array.isArray(namespace);
  const ctes = tables.map((table) =>
    buildVectorCTE(table, fetchLimit, tier, namespaceParamIndex, namespaceIsArray),
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

  const { rows } = await dependencies.pool.query(sql, params);
  return withSourceRefs(rows as SearchRow[]);
}

/** Run the lexical arm across every accessible table. */
async function ftsSearch(
  dependencies: SearchDependencies,
  tables: readonly ResourceTable[],
  query: string,
  fetchLimit: number,
  tier: Tier | undefined,
  offset: number,
  namespace: NamespaceFilter | undefined,
  ftsConfig: FtsConfig,
): Promise<SearchRow[]> {
  const params: unknown[] = [query, fetchLimit, offset];
  const namespaceParamIndex = appendNamespaceParam(params, namespace);
  const namespaceIsArray = Array.isArray(namespace);
  const ctes = tables.map((table) =>
    buildFtsCTE(
      table,
      fetchLimit,
      ftsConfig,
      tier,
      namespaceParamIndex,
      namespaceIsArray,
    ),
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

  const { rows } = await dependencies.pool.query(sql, params);
  return withSourceRefs(rows as SearchRow[]);
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
  const scored = new Map<string, { row: SearchRow; rrf: number }>();

  const accumulate = (rows: readonly SearchRow[]): void => {
    rows.forEach((row, index) => {
      const key = `${row.source_type}:${row.id}`;
      const contribution = 1 / (RRF_K + index + 1);
      const existing = scored.get(key);
      if (existing) existing.rrf += contribution;
      else scored.set(key, { row, rrf: contribution });
    });
  };

  accumulate(vectorRows);
  accumulate(ftsRows);

  return Array.from(scored.values())
    .map(({ row, rrf }) => ({
      row,
      rrf: Math.max(
        0,
        (rrf + TIER_BOOST[(row.tier ?? "warm") as Tier]) *
          (TABLE_WEIGHT[row.source_type] ?? 1) *
          recencyFactor(row.created_at),
      ),
    }))
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, limit)
    .map(({ row }) => row);
}

/**
 * Run one search across the caller's accessible tables.
 *
 * @param dependencies Pool, embedder, and logger.
 * @param tables Tables the caller may read; the caller resolves this from the
 *   permission matrix, so an empty list here means "no readable tables" and is
 *   the caller's error to report, not this function's.
 * @param query Natural-language query text; always a bound parameter.
 * @param limit Maximum rows to return.
 * @param mode Which arm to run.
 * @param tier Optional cognitive-tier filter.
 * @param offset Rows to skip, for pagination.
 * @param namespace Auth-derived namespace filter; `undefined` is a global read
 *   and is only reachable for a role whose reads are global by design.
 * @param options Lexical-arm configuration.
 * @throws When `mode` is `vector` and the embedding could not be generated.
 */
export async function executeSearch(
  dependencies: SearchDependencies,
  tables: readonly ResourceTable[],
  query: string,
  limit: number,
  mode: SearchMode = "hybrid",
  tier?: Tier,
  offset = 0,
  namespace?: NamespaceFilter,
  options: ExecuteSearchOptions = {},
): Promise<SearchRow[]> {
  const ftsConfig = options.ftsConfig ?? DEFAULT_FTS_CONFIG;
  if (tables.length === 0) return [];

  if (mode === "keyword") {
    return ftsSearch(
      dependencies,
      tables,
      query,
      limit,
      tier,
      offset,
      namespace,
      ftsConfig,
    );
  }

  const embedding = await generateSearchEmbedding(dependencies, query);
  if (!embedding) {
    if (mode === "vector") {
      // No lexical result to degrade to. Returning [] here would report
      // "nothing matched" for what is actually a provider outage.
      throw new Error("Failed to generate query embedding");
    }
    dependencies.logger.warn(
      { query_chars: query.length },
      "embedding_failed_fallback_fts",
    );
    return ftsSearch(
      dependencies,
      tables,
      query,
      limit,
      tier,
      offset,
      namespace,
      ftsConfig,
    );
  }

  if (mode === "vector") {
    return vectorSearch(
      dependencies,
      tables,
      embedding,
      limit,
      tier,
      offset,
      namespace,
    );
  }

  // Hybrid: both arms in parallel, over-fetched so fusion has depth to reorder,
  // then sliced to the requested window AFTER merging. Slicing before the merge
  // would page through each arm independently and produce an order no consumer
  // could reproduce.
  const totalNeeded = offset + limit;
  const fetchLimit = totalNeeded * HYBRID_FETCH_MULTIPLIER;
  const [vectorRows, ftsRows] = await Promise.all([
    vectorSearch(dependencies, tables, embedding, fetchLimit, tier, 0, namespace),
    ftsSearch(
      dependencies,
      tables,
      query,
      fetchLimit,
      tier,
      0,
      namespace,
      ftsConfig,
    ),
  ]);
  return rrfMerge(vectorRows, ftsRows, totalNeeded).slice(offset);
}

/** Dedupe key used when topping up from the legacy namespace. */
function fallbackDedupeKey(row: SearchRow): string {
  const preview = row.content_preview?.replace(/\s+/g, " ").trim();
  // Migrated rows carry NEW ids in the canonical namespace, so identity cannot
  // dedupe them against their legacy originals. Content does.
  return preview
    ? `${row.source_type}:content:${preview}`
    : `${row.source_type}:id:${row.id}`;
}

/** Drop repeats, keeping the highest-ranked occurrence of each record. */
function dedupeFallbackRows(rows: readonly SearchRow[]): SearchRow[] {
  const seen = new Set<string>();
  const deduped: SearchRow[] = [];
  for (const row of rows) {
    const key = fallbackDedupeKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

/**
 * Merge canonical results with legacy top-up results.
 *
 * Canonical rows always win a content collision. When canonical already fills
 * the limit but legacy found something canonical did not, one canonical row is
 * displaced so the caller can SEE that unmigrated content exists — a silent
 * omission is what makes a stalled migration invisible.
 */
function mergeFallbackRows(
  primaryRows: readonly SearchRow[],
  legacyRows: readonly SearchRow[],
  limit: number,
): SearchRow[] {
  const primary = dedupeFallbackRows(primaryRows);
  const primaryKeys = new Set(primary.map(fallbackDedupeKey));
  const legacy = dedupeFallbackRows(
    legacyRows.filter((row) => !primaryKeys.has(fallbackDedupeKey(row))),
  );
  if (legacy.length === 0) return primary.slice(0, limit);
  if (primary.length >= limit) {
    const first = legacy[0];
    if (!first) return primary.slice(0, limit);
    return [...primary.slice(0, Math.max(0, limit - 1)), first];
  }
  return [...primary, ...legacy.slice(0, limit - primary.length)];
}

/**
 * Search with the optional legacy-namespace top-up, then canonicalize.
 *
 * The fallback is OFF by default: #167 retired `collab`, so
 * `legacySharedNamespace` is empty and this is a plain {@link executeSearch}
 * call. It exists for the window in which an operator has explicitly configured
 * a migration source and shared results are still thin.
 *
 * It is skipped entirely when `offset !== 0`. Paginating a two-source merge
 * cannot produce a stable window — the legacy top-up depends on how many
 * canonical rows the CURRENT page found — so pages would overlap or skip rows.
 *
 * @param requestedShared Whether the caller explicitly asked for the shared
 *   namespace (as opposed to it merely appearing in their readable list).
 */
export async function executeSearchWithSharedFallback(
  dependencies: SearchDependencies,
  tables: readonly ResourceTable[],
  query: string,
  limit: number,
  mode: SearchMode,
  tier: Tier | undefined,
  offset: number,
  namespace: NamespaceFilter | undefined,
  options: ExecuteSearchOptions = {},
  requestedShared = false,
): Promise<SearchRow[]> {
  const config = sharedNamespaceConfig();
  const scoped = Array.isArray(namespace) ? namespace : [];
  const fallbackApplies = requestedShared
    ? namespace === config.physicalSharedNamespace
    : scoped.includes(config.physicalSharedNamespace);

  if (
    !config.legacyFallbackEnabled ||
    config.legacySharedNamespace === "" ||
    offset !== 0 ||
    !fallbackApplies
  ) {
    return withCanonicalNamespaces(
      await executeSearch(
        dependencies,
        tables,
        query,
        limit,
        mode,
        tier,
        offset,
        namespace,
        options,
      ),
    );
  }

  const primaryRows = await executeSearch(
    dependencies,
    tables,
    query,
    limit,
    mode,
    tier,
    0,
    namespace,
    options,
  );
  // Enough shared truth was found; the legacy namespace has nothing to add.
  if (
    primaryRows.length >= limit ||
    primaryRows.length >= config.fallbackMinResults
  ) {
    return withCanonicalNamespaces(primaryRows);
  }

  const legacyRows = await executeSearch(
    dependencies,
    tables,
    query,
    limit,
    mode,
    tier,
    0,
    config.legacySharedNamespace,
    options,
  );
  return withCanonicalNamespaces(
    mergeFallbackRows(primaryRows, legacyRows, limit),
  );
}

export { ALL_TABLES };
