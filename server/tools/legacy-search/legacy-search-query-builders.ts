import type { RelationalDirection } from "./legacy-search-tables-and-parsing.ts";
import {
  appendNamespaceParam,
  paramRef,
  linkKey,
  HAS_EXTRACTED_METADATA,
  type LinkRow,
  type SearchRow,
  type ExplicitLink,
} from "./legacy-search-rows-and-fallback.ts";
import { sourceScopeFilterSql } from "../../domain/source-refs.ts";
import type { Table, Tier } from "../../../src/types.ts";
import type { ToolDeps } from "../../../src/tools/index.ts";
import { logger } from "../../../src/logger.ts";
import {
  SOURCE_LABELS,
  CONTENT_PREVIEW,
  FTS_SOURCE_TEXT,
  TABLE_ALIAS,
  VALID_TIERS,
} from "../../db/table-constants.ts";
import { ftsConfigLiteral, type FtsConfig } from "./fts-config.ts";
import {
  SESSION_EVENTS_SOURCE_LABEL,
  type NamespaceFilter,
  type SearchTable,
} from "./legacy-search-tables-and-parsing.ts";
/** The number of link rows one result set may hydrate from. */
const EXPLICIT_LINK_ROW_MAX = 200;

/** Read the links touching this result set, on either end. */
async function fetchExplicitLinkRows(
  deps: ToolDeps,
  rows: SearchRow[],
  namespace?: NamespaceFilter,
): Promise<LinkRow[]> {
  const resultTypes = rows.map((row) => row.source_type);
  const resultIds = rows.map((row) => row.id);
  const params: unknown[] = [resultTypes, resultIds];
  const namespaceParamIndex = appendNamespaceParam(params, namespace);
  const namespaceFilter = namespaceFilterSql(
    "namespace",
    namespaceParamIndex,
    Array.isArray(namespace),
  );

  const { rows: linkRows } = await deps.pool.query<LinkRow>(
    `SELECT
         l.id, l.from_type, l.from_id, l.to_type, l.to_id, l.relation, l.weight, l.metadata, l.created_at,
         from_entity.name AS from_name,
         from_entity.canonical_id AS from_canonical_id,
         to_entity.name AS to_name,
         to_entity.canonical_id AS to_canonical_id
       FROM ob_links l
       LEFT JOIN ob_entities from_entity
         ON l.from_type = 'entity'
        AND from_entity.id = l.from_id
        AND from_entity.namespace = l.namespace
        AND from_entity.archived_at IS NULL
       LEFT JOIN ob_entities to_entity
         ON l.to_type = 'entity'
        AND to_entity.id = l.to_id
        AND to_entity.namespace = l.namespace
        AND to_entity.archived_at IS NULL
       WHERE (
         (l.from_type, l.from_id) IN (
           SELECT result_type, result_id
           FROM unnest($1::text[], $2::uuid[]) AS result_refs(result_type, result_id)
         )
         OR (l.to_type, l.to_id) IN (
           SELECT result_type, result_id
           FROM unnest($1::text[], $2::uuid[]) AS result_refs(result_type, result_id)
         )
       )
         AND l.archived_at IS NULL
         AND (l.from_type <> 'entity' OR from_entity.id IS NOT NULL)
         AND (l.to_type <> 'entity' OR to_entity.id IS NOT NULL)${namespaceFilter.replaceAll("namespace", "l.namespace")}
       ORDER BY l.weight DESC, l.created_at DESC
       LIMIT ${EXPLICIT_LINK_ROW_MAX}`,
    params,
  );

  if (linkRows.length === EXPLICIT_LINK_ROW_MAX) {
    logger.warn("explicit_links_truncated", {
      result_count: rows.length,
      link_limit: EXPLICIT_LINK_ROW_MAX,
    });
  }
  return linkRows;
}

/** Index the link rows by each end they touch, so a result can look itself up. */
function groupLinksByResult(linkRows: LinkRow[]): Map<string, ExplicitLink[]> {
  const linksByResult = new Map<string, ExplicitLink[]>();
  const add = (key: string, link: ExplicitLink): void => {
    const existing = linksByResult.get(key) ?? [];
    existing.push(link);
    linksByResult.set(key, existing);
  };
  for (const link of linkRows) {
    const shared = {
      id: link.id,
      relation: link.relation,
      weight: link.weight,
      metadata: link.metadata ?? {},
      created_at: new Date(link.created_at).toISOString(),
    };
    add(linkKey(link.from_type, link.from_id), {
      ...shared,
      direction: "outgoing",
      linked_type: link.to_type,
      linked_id: link.to_id,
      linked_name: link.to_name,
      canonical_id: link.to_canonical_id,
    });
    add(linkKey(link.to_type, link.to_id), {
      ...shared,
      direction: "incoming",
      linked_type: link.from_type,
      linked_id: link.from_id,
      linked_name: link.from_name,
      canonical_id: link.from_canonical_id,
    });
  }
  return linksByResult;
}

export async function attachExplicitLinks(
  deps: ToolDeps,
  rows: SearchRow[],
  namespace?: NamespaceFilter,
): Promise<SearchRow[]> {
  if (rows.length === 0) return rows;
  try {
    const linkRows = await fetchExplicitLinkRows(deps, rows, namespace);
    const linksByResult = groupLinksByResult(linkRows);
    return rows.map((row) => ({
      ...row,
      explicit_links: linksByResult.get(linkKey(row.source_type, row.id)) ?? [],
    }));
  } catch (err) {
    logger.warn("explicit_links_lookup_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return rows.map((row) => ({ ...row, explicit_links: [] }));
  }
}

/**
 * Every argument the CTE builders take, in the legacy positional order. The
 * builders are internal to this module family, so an options object is the
 * shape (rule M15) rather than a positional list.
 */
export type TableCTEOptions = {
  table: SearchTable;
  perTableLimit: number;
  tier?: Tier;
  namespaceParamIndex?: number;
  namespaceIsArray?: boolean;
  sourceScopeParamIndex?: number;
};

export type FtsCTEOptions = TableCTEOptions & { ftsConfig: FtsConfig };

/**
 * The options once the two source-specific tables have been dispatched away, so
 * `table` is one of the standard brain tables the shared shape indexes by.
 */
type StandardTableCTEOptions = Omit<TableCTEOptions, "table"> & { table: Table };
type StandardFtsCTEOptions = StandardTableCTEOptions & { ftsConfig: FtsConfig };

/**
 * The ` AND <alias>.namespace = ...` fragment both builders append, for the
 * qualified column name the caller's table family uses.
 */
function namespaceFilterSql(
  column: string,
  namespaceParamIndex?: number,
  namespaceIsArray = false,
): string {
  if (!namespaceParamIndex) return "";
  return namespaceIsArray
    ? ` AND ${column} = ANY(${paramRef(namespaceParamIndex)}::text[])`
    : ` AND ${column} = ${paramRef(namespaceParamIndex)}`;
}

/** The extracted-metadata column, or the typed null the table stands in with. */
function metadataColumnSql(table: Table, alias: string): string {
  return HAS_EXTRACTED_METADATA.has(table)
    ? `${alias}.extracted_metadata`
    : "NULL::jsonb AS extracted_metadata";
}

/** The vector arm over ob_entities, which carries no tier and no source_refs. */
function buildEntitiesTableCTE(options: TableCTEOptions): string {
  const { perTableLimit, tier, namespaceParamIndex, namespaceIsArray } = options;
  const tierFilter = tier && tier !== "warm" ? " AND FALSE" : "";
  const nsFilter = namespaceFilterSql(
    "e.namespace",
    namespaceParamIndex,
    namespaceIsArray,
  );
  return `entities_results AS (
  SELECT
    'entity' AS source_type,
    e.id,
    e.namespace,
    e.entity_type || ': ' || e.name ||
      CASE WHEN e.canonical_id IS NOT NULL THEN ' (' || e.canonical_id || ')' ELSE '' END AS content_preview,
    NULL::text[] AS tags,
    e.created_by,
    e.created_at,
    e.updated_at,
    'warm'::text AS tier,
    e.embedding <=> (SELECT emb FROM query_embedding) AS distance,
    0.5 AS usefulness,
    0 AS access_count,
    NULL::jsonb AS extracted_metadata
  FROM ob_entities e
  WHERE e.embedding IS NOT NULL AND e.archived_at IS NULL${tierFilter}${nsFilter}
  ORDER BY e.embedding <=> (SELECT emb FROM query_embedding) ASC
  LIMIT ${perTableLimit}
)`;
}

/**
 * The vector arm over ob_session_events. A source scope cannot be evaluated
 * against a corpus with no source_refs; the caller drops this table from the
 * list in that case (see executeSearchInternal), rather than ignoring the scope
 * and leaking out-of-scope rows into a scoped query.
 */
function buildSessionEventsTableCTE(options: TableCTEOptions): string {
  const { perTableLimit, tier, namespaceParamIndex, namespaceIsArray } = options;
  const tierFilter = tier ? ` AND se.importance = '${tier}'` : "";
  const nsFilter = namespaceFilterSql(
    "sl.namespace",
    namespaceParamIndex,
    namespaceIsArray,
  );
  return `session_events_results AS (
  SELECT
    '${SESSION_EVENTS_SOURCE_LABEL}' AS source_type,
    se.id,
    sl.namespace,
    se.content AS content_preview,
    NULL::text[] AS tags,
    se.created_by,
    se.created_at,
    se.created_at AS updated_at,
    se.importance AS tier,
    se.embedding <=> (SELECT emb FROM query_embedding) AS distance,
    0.5 AS usefulness,
    0 AS access_count,
    se.metadata AS extracted_metadata
  FROM ob_session_events se
  JOIN ob_session_lanes sl ON sl.id = se.lane_id
  WHERE se.embedding IS NOT NULL${tierFilter}${nsFilter}
  ORDER BY se.embedding <=> (SELECT emb FROM query_embedding) ASC
  LIMIT ${perTableLimit}
)`;
}

/** The vector arm over the standard brain tables, which share one shape. */
function buildStandardTableCTE(options: StandardTableCTEOptions): string {
  const {
    table,
    perTableLimit,
    tier,
    namespaceParamIndex,
    namespaceIsArray,
    sourceScopeParamIndex,
  } = options;
  const alias = TABLE_ALIAS[table];
  const label = SOURCE_LABELS[table];
  const preview = CONTENT_PREVIEW[table];
  const cteName = `${table}_results`;
  const tierFilter = tier ? ` AND ${alias}.tier = '${tier}'` : "";
  const nsFilter = namespaceFilterSql(
    `${alias}.namespace`,
    namespaceParamIndex,
    namespaceIsArray,
  );
  const sourceScopeFilter = sourceScopeFilterSql(alias, sourceScopeParamIndex);
  const metaCol = metadataColumnSql(table, alias);

  return `${cteName} AS (
  SELECT
    '${label}' AS source_type,
    ${alias}.id,
    ${alias}.namespace,
    ${preview} AS content_preview,
    ${alias}.tags,
    ${alias}.created_by,
    ${alias}.created_at,
    ${alias}.updated_at,
    ${alias}.tier,
    ${alias}.embedding <=> (SELECT emb FROM query_embedding) AS distance,
    COALESCE(${alias}.usefulness_score, 0.5) AS usefulness,
    COALESCE(${alias}.access_count, 0) AS access_count,
    ${metaCol}
  FROM ${table} ${alias}
  WHERE ${alias}.embedding IS NOT NULL AND ${alias}.archived_at IS NULL${tierFilter}${nsFilter}${sourceScopeFilter}
  ORDER BY ${alias}.embedding <=> (SELECT emb FROM query_embedding) ASC
  LIMIT ${perTableLimit}
)`;
}

export function buildTableCTE(options: TableCTEOptions): string {
  const { table, tier } = options;
  if (tier && !VALID_TIERS.has(tier)) throw new Error(`Invalid tier: ${tier}`);
  if (table === "entities") return buildEntitiesTableCTE(options);
  if (table === "session_events") return buildSessionEventsTableCTE(options);
  return buildStandardTableCTE({ ...options, table });
}

/**
 * Build the lexical (FTS) match + rank expressions for one table under a chosen
 * text-search configuration.
 *
 * english (default): use the GIN-indexed stored `search_vector` column exactly
 * as before -- byte-identical to the pre-#341 behavior and index-fast.
 *
 * non-english supported config: recompute `to_tsvector(<config>, <source text>)`
 * on the fly against the same columns the stored column indexes, so the query
 * arm and the analyzed text share one configuration (correct stemming, no
 * index/query mismatch, no migration). `config` is an allowlist-validated
 * FtsConfig; ftsConfigLiteral re-asserts that before it is interpolated.
 */
export function ftsMatchExpressions(
  table: Table,
  config: FtsConfig,
): {
  vectorSql: string;
  querySql: string;
} {
  const querySql = `plainto_tsquery('${ftsConfigLiteral(config)}', (SELECT q FROM fts_query))`;
  if (config === "english") {
    const alias = TABLE_ALIAS[table];
    return { vectorSql: `${alias}.search_vector`, querySql };
  }
  const vectorSql = `to_tsvector('${ftsConfigLiteral(config)}', ${FTS_SOURCE_TEXT[table]})`;
  return { vectorSql, querySql };
}

/**
 * The lexical arm over ob_entities: no stored tsvector, so the match is ILIKE
 * over the text columns rather than FTS.
 */
function buildEntitiesFtsCTE(options: FtsCTEOptions): string {
  const { perTableLimit, tier, namespaceParamIndex, namespaceIsArray } = options;
  const tierFilter = tier && tier !== "warm" ? " AND FALSE" : "";
  const nsFilter = namespaceFilterSql(
    "e.namespace",
    namespaceParamIndex,
    namespaceIsArray,
  );
  return `entities_fts AS (
  SELECT
    'entity' AS source_type,
    e.id,
    e.namespace,
    e.entity_type || ': ' || e.name ||
      CASE WHEN e.canonical_id IS NOT NULL THEN ' (' || e.canonical_id || ')' ELSE '' END AS content_preview,
    NULL::text[] AS tags,
    e.created_by,
    e.created_at,
    e.updated_at,
    'warm'::text AS tier,
    1.0 AS fts_rank,
    0.5 AS usefulness,
    0 AS access_count,
    NULL::jsonb AS extracted_metadata
  FROM ob_entities e
  WHERE (
      e.name ILIKE '%' || (SELECT q FROM fts_query) || '%'
      OR e.entity_type ILIKE '%' || (SELECT q FROM fts_query) || '%'
      OR e.canonical_id ILIKE '%' || (SELECT q FROM fts_query) || '%'
      OR e.metadata::text ILIKE '%' || (SELECT q FROM fts_query) || '%'
    )
    AND e.archived_at IS NULL${tierFilter}${nsFilter}
  ORDER BY e.updated_at DESC
  LIMIT ${perTableLimit}
)`;
}

/**
 * The lexical arm over ob_session_events. That table has no stored
 * `search_vector` generated column, so there is no tsvector to match against
 * and no GIN index to ride. The arm matches `content` with ILIKE, exactly as
 * the entities arm does for its own unindexed text. This is substring matching,
 * not stemming: it is the honest capability of a column that does not exist,
 * and it is stated here so a reader does not assume FTS parity. The `ftsConfig`
 * option is deliberately unused for this table -- a text search configuration
 * has nothing to configure without a tsvector.
 */
function buildSessionEventsFtsCTE(options: FtsCTEOptions): string {
  const { perTableLimit, tier, namespaceParamIndex, namespaceIsArray } = options;
  const tierFilter = tier ? ` AND se.importance = '${tier}'` : "";
  const nsFilter = namespaceFilterSql(
    "sl.namespace",
    namespaceParamIndex,
    namespaceIsArray,
  );
  return `session_events_fts AS (
  SELECT
    '${SESSION_EVENTS_SOURCE_LABEL}' AS source_type,
    se.id,
    sl.namespace,
    se.content AS content_preview,
    NULL::text[] AS tags,
    se.created_by,
    se.created_at,
    se.created_at AS updated_at,
    se.importance AS tier,
    1.0 AS fts_rank,
    0.5 AS usefulness,
    0 AS access_count,
    se.metadata AS extracted_metadata
  FROM ob_session_events se
  JOIN ob_session_lanes sl ON sl.id = se.lane_id
  WHERE se.content ILIKE '%' || (SELECT q FROM fts_query) || '%'${tierFilter}${nsFilter}
  ORDER BY se.created_at DESC
  LIMIT ${perTableLimit}
)`;
}

/** The lexical arm over the standard brain tables, which share one shape. */
function buildStandardFtsCTE(options: StandardFtsCTEOptions): string {
  const {
    table,
    perTableLimit,
    ftsConfig,
    tier,
    namespaceParamIndex,
    namespaceIsArray,
    sourceScopeParamIndex,
  } = options;
  const alias = TABLE_ALIAS[table];
  const label = SOURCE_LABELS[table];
  const preview = CONTENT_PREVIEW[table];
  const cteName = `${table}_fts`;
  const tierFilter = tier ? ` AND ${alias}.tier = '${tier}'` : "";
  const nsFilter = namespaceFilterSql(
    `${alias}.namespace`,
    namespaceParamIndex,
    namespaceIsArray,
  );
  const sourceScopeFilter = sourceScopeFilterSql(alias, sourceScopeParamIndex);
  const metaCol = metadataColumnSql(table, alias);
  const { vectorSql, querySql } = ftsMatchExpressions(table, ftsConfig);

  return `${cteName} AS (
  SELECT
    '${label}' AS source_type,
    ${alias}.id,
    ${alias}.namespace,
    ${preview} AS content_preview,
    ${alias}.tags,
    ${alias}.created_by,
    ${alias}.created_at,
    ${alias}.updated_at,
    ${alias}.tier,
    ts_rank_cd(${vectorSql}, ${querySql}) AS fts_rank,
    COALESCE(${alias}.usefulness_score, 0.5) AS usefulness,
    COALESCE(${alias}.access_count, 0) AS access_count,
    ${metaCol}
  FROM ${table} ${alias}
  WHERE ${vectorSql} @@ ${querySql}
    AND ${alias}.archived_at IS NULL${tierFilter}${nsFilter}${sourceScopeFilter}
  ORDER BY fts_rank DESC
  LIMIT ${perTableLimit}
)`;
}

export function buildFtsCTE(options: FtsCTEOptions): string {
  const { table, tier } = options;
  if (tier && !VALID_TIERS.has(tier)) throw new Error(`Invalid tier: ${tier}`);
  if (table === "entities") return buildEntitiesFtsCTE(options);
  if (table === "session_events") return buildSessionEventsFtsCTE(options);
  return buildStandardFtsCTE({ ...options, table });
}

export function buildRelationalHydrationSelect(
  table: Table,
  direction: RelationalDirection,
  tier?: Tier,
): string {
  if (tier && !VALID_TIERS.has(tier)) throw new Error(`Invalid tier: ${tier}`);
  const alias = TABLE_ALIAS[table];
  const label = SOURCE_LABELS[table];
  const preview = CONTENT_PREVIEW[table];
  const tierFilter = tier ? ` AND ${alias}.tier = '${tier}'` : "";
  const metaCol = HAS_EXTRACTED_METADATA.has(table)
    ? `${alias}.extracted_metadata`
    : "NULL::jsonb AS extracted_metadata";
  const linkJoin =
    direction === "incoming"
      ? `l.to_type = 'entity'
   AND l.to_id = seed.id`
      : `l.from_type = 'entity'
   AND l.from_id = seed.id`;
  const targetJoin =
    direction === "incoming"
      ? `l.from_type = '${label}'
   AND ${alias}.id = l.from_id`
      : `l.to_type = '${label}'
   AND ${alias}.id = l.to_id`;

  return `SELECT
    '${label}' AS source_type,
    ${alias}.id,
    ${alias}.namespace,
    ${preview} AS content_preview,
    ${alias}.tags,
    ${alias}.created_by,
    ${alias}.created_at,
    ${alias}.updated_at,
    ${alias}.tier,
    NULL::double precision AS distance,
    GREATEST(l.weight, 0)::double precision AS fts_rank,
    COALESCE(${alias}.usefulness_score, 0.5) AS usefulness,
    COALESCE(${alias}.access_count, 0) AS access_count,
    ${metaCol}
  FROM relational_graph_seed seed
  JOIN ob_links l
    ON ${linkJoin}
   AND l.namespace = seed.namespace
   AND l.relation = $2
   AND l.archived_at IS NULL
  JOIN ${table} ${alias}
    ON ${targetJoin}
   AND ${alias}.namespace = l.namespace
   AND ${alias}.archived_at IS NULL${tierFilter}`;
}
