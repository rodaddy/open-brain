/**
 * Every SQL fragment the retrieval arms assemble, and nothing else.
 *
 * Design authority: #341 (FTS regconfig allowlist and the english/non-english
 * split) and `docs/decisions/privilege-isolation-closed-brain.md` (isolation is
 * enforced server-side).
 *
 * SQL discipline, restated here because this is the module that writes the
 * strings. Query text, namespaces, tiers, and every caller value are bound
 * parameters. The only interpolated strings are compile-time literals selected
 * by a validated key -- table names via the Zod-validated {@link ResourceTable}
 * union, and the FTS regconfig via the `SUPPORTED_FTS_CONFIGS` allowlist
 * re-asserted at the interpolation point by `ftsConfigLiteral`.
 *
 * The four CTE builders share {@link CteContext} rather than threading the same
 * four values positionally. That is not only shape: the namespace parameter
 * index and its array-ness must agree with the `params` array the arm already
 * pushed onto, and carrying them as one resolved value makes it impossible to
 * pass one arm's index alongside another arm's array-ness.
 */
import type { ResourceTable } from "../auth/types.ts";
import {
  CONTENT_PREVIEW,
  FTS_SOURCE_TEXT,
  HAS_EXTRACTED_METADATA,
  SOURCE_LABELS,
  TABLE_ALIAS,
  VALID_TIERS,
  type Tier,
} from "./search-constants.ts";
import {
  DEFAULT_FTS_CONFIG,
  ftsConfigLiteral,
  type FtsConfig,
} from "./fts-config.ts";
import type { NamespaceFilter } from "./read-scope.ts";

/**
 * The scope one arm applies to every CTE it builds.
 *
 * `perTableLimit` and `tier` are the caller's filters; `namespaceParamIndex`
 * and `namespaceIsArray` describe the namespace value the arm has already bound
 * into its own parameter array.
 */
export interface CteContext {
  readonly perTableLimit: number;
  readonly tier: Tier | undefined;
  readonly namespaceParamIndex: number | undefined;
  readonly namespaceIsArray: boolean;
}

/** Render a bound-parameter reference, rejecting an out-of-range index. */
export function paramRef(index: number): string {
  if (!Number.isInteger(index) || index < 1) {
    throw new Error(`Invalid SQL parameter index: ${index}`);
  }
  return `$${index}`;
}

/**
 * Push the namespace filter and return its parameter index, or `undefined`.
 *
 * Distinct from `appendReadNamespacePredicate` in `read-scope.ts`, which takes
 * an `AuthIdentity` and resolves the readable set itself, then emits a finished
 * predicate against one column. The arms here bind ONE namespace value shared
 * across several aliased CTEs, so the push and the per-alias predicate are two
 * steps rather than one.
 */
export function appendNamespaceParam(
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
 * The VALUE is always bound; only the alias and column name -- both compile-time
 * literals -- are inlined. An absent filter yields `""`, which is a global read
 * and is only ever reachable for a role whose reads are global by design.
 */
export function namespaceFilterSql(
  alias: string,
  paramIndex: number | undefined,
  isArray: boolean,
): string {
  if (!paramIndex) return "";
  return isArray
    ? ` AND ${alias}.namespace = ANY(${paramRef(paramIndex)}::text[])`
    : ` AND ${alias}.namespace = ${paramRef(paramIndex)}`;
}

/** The namespace predicate for one alias under an arm's resolved scope. */
function scopedNamespaceSql(alias: string, context: CteContext): string {
  return namespaceFilterSql(
    alias,
    context.namespaceParamIndex,
    context.namespaceIsArray,
  );
}

/** Reject a tier that is not on the allowlist before it can reach SQL. */
export function assertTier(tier: Tier | undefined): void {
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

/**
 * Session events are namespaced INDIRECTLY.
 *
 * `ob_session_events` has no `namespace` column at all (verified against
 * information_schema on the dogfood DB, 2026-08-07); scope lives on
 * `ob_session_lanes` and is reachable only through
 * `ob_session_events.lane_id`. Both builders below therefore JOIN the lane
 * table and apply the auth-derived namespace predicate to `sl.namespace`.
 * Omitting that join would not merely widen results -- it would expose every
 * agent's session history to every other namespace.
 *
 * The corpus also lacks `archived_at`, `tier`, `tags`, `usefulness_score`,
 * `access_count`, and `search_vector`. Those slots are filled with typed
 * literals so the UNION arms stay type-compatible, and two consequences are
 * deliberate:
 *   - no stored `search_vector` -> the lexical arm matches `content` with
 *     ILIKE, so it is substring matching, not stemming. That is the honest
 *     capability of a column that does not exist, and it is why `ftsConfig`
 *     has nothing to configure for this source.
 *   - no `tier` -> `importance` carries the same hot/warm/cold vocabulary
 *     under the same CHECK constraint, so it fills the tier slot.
 */
const SESSION_EVENTS_LABEL = "session_event";

/** Shared SELECT list for the session-event arms; `rank` differs per arm. */
function sessionEventColumns(rankExpression: string): string {
  return `'${SESSION_EVENTS_LABEL}' AS source_type,
    se.id,
    sl.namespace,
    se.content AS content_preview,
    NULL::text[] AS tags,
    se.created_by,
    se.created_at,
    se.created_at AS updated_at,
    se.importance AS tier,
    ${rankExpression},
    0.5 AS usefulness,
    0 AS access_count,
    se.metadata AS extracted_metadata`;
}

/** Build the session-event vector-similarity CTE. */
export function buildSessionEventsVectorCTE(context: CteContext): string {
  assertTier(context.tier);
  const tierFilter = context.tier
    ? ` AND se.importance = '${context.tier}'`
    : "";
  const nsFilter = scopedNamespaceSql("sl", context);
  const distance = `se.embedding <=> (SELECT emb FROM query_embedding)`;
  return `session_events_results AS (
  SELECT ${sessionEventColumns(`${distance} AS distance`)}
  FROM ob_session_events se
  JOIN ob_session_lanes sl ON sl.id = se.lane_id
  WHERE se.embedding IS NOT NULL${tierFilter}${nsFilter}
  ORDER BY ${distance} ASC
  LIMIT ${context.perTableLimit}
)`;
}

/** Build the session-event lexical CTE. */
export function buildSessionEventsFtsCTE(context: CteContext): string {
  assertTier(context.tier);
  const tierFilter = context.tier
    ? ` AND se.importance = '${context.tier}'`
    : "";
  const nsFilter = scopedNamespaceSql("sl", context);
  return `session_events_fts AS (
  SELECT ${sessionEventColumns("1.0 AS fts_rank")}
  FROM ob_session_events se
  JOIN ob_session_lanes sl ON sl.id = se.lane_id
  WHERE se.content ILIKE '%' || (SELECT q FROM fts_query) || '%'${tierFilter}${nsFilter}
  ORDER BY se.created_at DESC
  LIMIT ${context.perTableLimit}
)`;
}

/** Build one table's vector-similarity CTE. */
export function buildVectorCTE(
  table: ResourceTable,
  context: CteContext,
): string {
  assertTier(context.tier);
  const alias = TABLE_ALIAS[table];
  const tierFilter = context.tier
    ? ` AND ${alias}.tier = '${context.tier}'`
    : "";
  const nsFilter = scopedNamespaceSql(alias, context);
  const distance = `${alias}.embedding <=> (SELECT emb FROM query_embedding)`;
  return `${table}_results AS (
  SELECT ${selectColumns(table, `${distance} AS distance`)}
  FROM ${table} ${alias}
  WHERE ${alias}.embedding IS NOT NULL
    AND ${alias}.archived_at IS NULL${tierFilter}${nsFilter}
  ORDER BY ${distance} ASC
  LIMIT ${context.perTableLimit}
)`;
}

/**
 * Build the lexical match and rank expressions for one table under a chosen
 * text-search configuration (#341).
 *
 * `english` reads the stored, GIN-indexed `search_vector` column and is
 * byte-identical to the pre-#341 behavior. Any other allowlisted configuration
 * recomputes `to_tsvector(<config>, <same source columns>)` on the fly, so the
 * query arm and the analyzed text always share one configuration -- no per-row
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
export function buildFtsCTE(
  table: ResourceTable,
  ftsConfig: FtsConfig,
  context: CteContext,
): string {
  assertTier(context.tier);
  const alias = TABLE_ALIAS[table];
  const tierFilter = context.tier
    ? ` AND ${alias}.tier = '${context.tier}'`
    : "";
  const nsFilter = scopedNamespaceSql(alias, context);
  const { vectorSql, querySql } = ftsMatchExpressions(table, ftsConfig);
  return `${table}_fts AS (
  SELECT ${selectColumns(table, `ts_rank_cd(${vectorSql}, ${querySql}) AS fts_rank`)}
  FROM ${table} ${alias}
  WHERE ${vectorSql} @@ ${querySql}
    AND ${alias}.archived_at IS NULL${tierFilter}${nsFilter}
  ORDER BY fts_rank DESC
  LIMIT ${context.perTableLimit}
)`;
}
