import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toSql } from "pgvector/pg";
import { canRead } from "../permissions.ts";
import { canReadNamespace, namespaceFilterFor } from "../read-policy.ts";
import {
  canonicalNamespace,
  isSharedNamespace,
  sharedNamespaceConfig,
} from "../shared-namespace.ts";
import {
  appendSourceScopeParam,
  sourceScopeAuthorizationError,
  sourceScopeFilterSql,
  sourceScopeSchema,
  type SourceScope,
} from "../source-refs.ts";
import type { AuthInfo, LinkRelation, Table, Tier } from "../types.ts";
import type { ToolDeps } from "./index.ts";
import { logger } from "../logger.ts";
import {
  ALL_TABLES,
  SOURCE_LABELS,
  CONTENT_PREVIEW,
  FTS_SOURCE_TEXT,
  LINK_RELATIONS,
  TABLE_ALIAS,
  VALID_TIERS,
} from "./table-constants.ts";
import {
  DEFAULT_FTS_CONFIG,
  ftsConfigLiteral,
  requestFtsConfig,
  SUPPORTED_FTS_CONFIGS,
  type FtsConfig,
} from "./fts-config.ts";

export { ALL_TABLES };

/** Reverse map: singular label -> table name for tracking UPDATEs */
const LABEL_TO_TABLE: Record<string, Table> = Object.fromEntries(
  Object.entries(SOURCE_LABELS).map(([table, label]) => [
    label,
    table as Table,
  ]),
) as Record<string, Table>;

export type SearchMode = "hybrid" | "vector" | "keyword";
type NamespaceFilter = string | string[];
type SearchTable = Table | "entities";
export type { SourceScope };

type ExecuteSearchOptions = {
  enableGraph?: boolean;
  /**
   * Text-search configuration for the lexical arm. When unset, defaults to the
   * shared english configuration. The public `search_brain` handler is the only
   * boundary that resolves its request argument and deployment env; sibling
   * executeSearch callers remain byte-compatible unless they explicitly pass a
   * config.
   */
  ftsConfig?: FtsConfig;
};

const NON_ENGLISH_FTS_AUTHORIZATION_ERROR =
  "Permission denied: non-English FTS configuration requires admin or ob-admin";

/** RRF constant -- standard value from Cormack et al. 2009 */
const RRF_K = 60;

/** Over-fetch multiplier for hybrid mode (fetch N*3 from each path, merge to N) */
const HYBRID_FETCH_MULTIPLIER = 3;
const DEFAULT_SEARCH_EMBEDDING_TIMEOUT_MS = 3000;
const RELATIONAL_GRAPH_FETCH_LIMIT = 50;

/** Tier-based RRF score adjustments for cognitive tiering */
export const TIER_BOOST: Record<Tier, number> = {
  hot: 0.3,
  warm: 0,
  cold: -0.2,
};

/** Scoring weights for vector search ranking formula */
const VECTOR_WEIGHT = 0.7;
const USEFULNESS_WEIGHT = 0.15;
const AGE_WEIGHT = 0.0001;

/** Per-table importance weights: primary content > summaries */
const TABLE_WEIGHT: Record<string, number> = {
  thought: 1.2,
  decision: 1.2,
  relationship: 1.0,
  project: 0.9,
  session: 0.8,
  entity: 1.0,
};

type RelationalDirection = "incoming" | "outgoing";

const RELATIONAL_INCOMING_QUERY_PATTERN =
  /^what\s+(?:is\s+)?(?:was\s+)?(?<relation>depends on|blocked by|implemented by|decided by|supersedes|duplicates|contradicts|mentions|relates to)\s+(?<seed>[^?]{1,160})\??$/iu;

const RELATIONAL_OUTGOING_DEPENDS_PATTERN =
  /^what\s+does\s+(?<seed>[^?]{1,160})\s+depend\s+on\??$/iu;

const RELATIONAL_OUTGOING_BLOCKED_PATTERN =
  /^what\s+(?:is\s+)?(?<seed>[^?]{1,160})\s+blocked\s+by\??$/iu;

const RELATION_ALIASES: Record<string, LinkRelation> = {
  "depends on": "depends_on",
  "blocked by": "blocked_by",
  "implemented by": "implemented_by",
  "decided by": "decided_by",
  supersedes: "supersedes",
  duplicates: "duplicates",
  contradicts: "contradicts",
  mentions: "mentions",
  "relates to": "relates_to",
};

type RelationalQuery = {
  relation: LinkRelation;
  seed: string;
  direction: RelationalDirection;
};

function parseRelationalQuery(query: string): RelationalQuery | undefined {
  const trimmed = query.trim();
  const outgoingDepends =
    RELATIONAL_OUTGOING_DEPENDS_PATTERN.exec(trimmed)?.groups;
  if (outgoingDepends?.seed) {
    const seed = outgoingDepends.seed.trim().replace(/\s+/g, " ");
    if (!seed) return undefined;
    return {
      relation: "depends_on",
      seed,
      direction: "outgoing",
    };
  }
  const outgoingBlocked =
    RELATIONAL_OUTGOING_BLOCKED_PATTERN.exec(trimmed)?.groups;
  if (outgoingBlocked?.seed) {
    const seed = outgoingBlocked.seed.trim().replace(/\s+/g, " ");
    if (!seed) return undefined;
    return {
      relation: "blocked_by",
      seed,
      direction: "outgoing",
    };
  }

  const groups = RELATIONAL_INCOMING_QUERY_PATTERN.exec(trimmed)?.groups;
  if (!groups?.relation || !groups.seed) return undefined;
  const relation = RELATION_ALIASES[groups.relation.toLowerCase()];
  const seed = groups.seed.trim().replace(/\s+/g, " ");
  if (!relation || !seed || !LINK_RELATIONS.includes(relation))
    return undefined;
  return { relation, seed, direction: "incoming" };
}

function searchEmbeddingTimeoutMs(): number {
  const raw =
    process.env.OPENBRAIN_SEARCH_EMBEDDING_TIMEOUT_MS ??
    process.env.SEARCH_EMBEDDING_TIMEOUT_MS;
  if (!raw) return DEFAULT_SEARCH_EMBEDDING_TIMEOUT_MS;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed < 1
    ? DEFAULT_SEARCH_EMBEDDING_TIMEOUT_MS
    : parsed;
}

async function generateSearchEmbedding(
  deps: ToolDeps,
  query: string,
): Promise<number[] | null> {
  const timeoutMs = searchEmbeddingTimeoutMs();
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      deps.embedFn(query, undefined, { signal: controller.signal }),
      new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          logger.warn("search_embedding_timeout", {
            timeoutMs,
            queryLength: query.length,
          });
          resolve(null);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/** Gentle recency factor: today=1.0, 30d=0.97, 90d=0.92, 365d=0.73 */
function recencyFactor(createdAt: string): number {
  const ms = new Date(createdAt).getTime();
  if (isNaN(ms)) return 1.0;
  const ageDays = (Date.now() - ms) / (1000 * 60 * 60 * 24);
  return 1 / (1 + Math.max(0, ageDays) * 0.001);
}

export interface ExplicitLink {
  id: string;
  direction: "outgoing" | "incoming";
  relation: LinkRelation;
  weight: number;
  linked_type: string;
  linked_id: string;
  linked_name?: string | null;
  canonical_id?: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

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
  explicit_links?: ExplicitLink[];
  source_ref?: SourceRef;
  extracted_metadata?: {
    topics?: string[];
    people?: string[];
    action_items?: string[];
    dates?: string[];
    // Deterministic, content-free structural keys the write-time extractor
    // emits alongside the semantic fields. The digest, algorithm tag, and byte
    // length reveal no source excerpt.
    content_hash?: string;
    hash_version?: string;
    byte_length?: number;
  };
}

const HAS_EXTRACTED_METADATA: Set<Table> = new Set(["thoughts", "decisions"]);

type LinkRow = {
  id: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  relation: LinkRelation;
  weight: number;
  metadata: Record<string, unknown>;
  created_at: string;
  from_name: string | null;
  from_canonical_id: string | null;
  to_name: string | null;
  to_canonical_id: string | null;
};

function linkKey(type: string, id: string): string {
  return `${type}:${id}`;
}

function toIsoString(value: unknown): string | undefined {
  if (typeof value !== "string" && !(value instanceof Date)) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function withSourceRefs(rows: SearchRow[]): SearchRow[] {
  return rows.map((row) => ({
    ...row,
    source_ref: {
      source: "brain",
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

function withCanonicalNamespaces(rows: SearchRow[]): SearchRow[] {
  return rows.map((row) => {
    const namespace = row.namespace
      ? canonicalNamespace(row.namespace)
      : row.namespace;
    return {
      ...row,
      namespace,
      source_ref: row.source_ref
        ? {
            ...row.source_ref,
            namespace: row.source_ref.namespace
              ? canonicalNamespace(row.source_ref.namespace)
              : row.source_ref.namespace,
          }
        : row.source_ref,
    };
  });
}

function dedupeSearchRows(rows: SearchRow[]): SearchRow[] {
  const seen = new Set<string>();
  const deduped: SearchRow[] = [];
  for (const row of rows) {
    const key = `${row.source_type}:${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

function fallbackDedupeKey(row: SearchRow): string {
  const preview = row.content_preview?.replace(/\s+/g, " ").trim();
  if (preview) {
    return `${row.source_type}:content:${preview}`;
  }
  return `${row.source_type}:id:${row.id}`;
}

function dedupeFallbackSearchRows(rows: SearchRow[]): SearchRow[] {
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

function mergeFallbackSearchRows(
  primaryRows: SearchRow[],
  legacyRows: SearchRow[],
  limit: number,
): SearchRow[] {
  const primary = dedupeFallbackSearchRows(primaryRows);
  const primaryKeys = new Set(primary.map(fallbackDedupeKey));
  const legacy = dedupeFallbackSearchRows(
    legacyRows.filter((row) => !primaryKeys.has(fallbackDedupeKey(row))),
  );
  if (legacy.length === 0) return primary.slice(0, limit);
  if (primary.length >= limit) {
    const fallbackRow = legacy[0];
    if (!fallbackRow) return primary.slice(0, limit);
    return [...primary.slice(0, Math.max(0, limit - 1)), fallbackRow];
  }
  return [...primary, ...legacy.slice(0, limit - primary.length)];
}

function appendNamespaceParam(
  params: unknown[],
  namespace?: NamespaceFilter,
): number | undefined {
  if (namespace === undefined) return undefined;
  params.push(namespace);
  return params.length;
}

function paramRef(index: number): string {
  if (!Number.isInteger(index) || index < 1) {
    throw new Error(`Invalid SQL parameter index: ${index}`);
  }
  return `$${index}`;
}

async function attachExplicitLinks(
  deps: ToolDeps,
  rows: SearchRow[],
  namespace?: NamespaceFilter,
): Promise<SearchRow[]> {
  if (rows.length === 0) return rows;

  const resultTypes = rows.map((row) => row.source_type);
  const resultIds = rows.map((row) => row.id);
  const params: unknown[] = [resultTypes, resultIds];
  const namespaceParamIndex = appendNamespaceParam(params, namespace);
  const namespaceFilter = namespaceParamIndex
    ? Array.isArray(namespace)
      ? ` AND namespace = ANY(${paramRef(namespaceParamIndex)}::text[])`
      : ` AND namespace = ${paramRef(namespaceParamIndex)}`
    : "";

  try {
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
       LIMIT 200`,
      params,
    );

    if (linkRows.length === 200) {
      logger.warn("explicit_links_truncated", {
        result_count: rows.length,
        link_limit: 200,
      });
    }

    const linksByResult = new Map<string, ExplicitLink[]>();
    for (const link of linkRows) {
      const outgoingKey = linkKey(link.from_type, link.from_id);
      const incomingKey = linkKey(link.to_type, link.to_id);
      const outgoing = linksByResult.get(outgoingKey) ?? [];
      outgoing.push({
        id: link.id,
        direction: "outgoing",
        relation: link.relation,
        weight: link.weight,
        linked_type: link.to_type,
        linked_id: link.to_id,
        linked_name: link.to_name,
        canonical_id: link.to_canonical_id,
        metadata: link.metadata ?? {},
        created_at: new Date(link.created_at).toISOString(),
      });
      linksByResult.set(outgoingKey, outgoing);

      const incoming = linksByResult.get(incomingKey) ?? [];
      incoming.push({
        id: link.id,
        direction: "incoming",
        relation: link.relation,
        weight: link.weight,
        linked_type: link.from_type,
        linked_id: link.from_id,
        linked_name: link.from_name,
        canonical_id: link.from_canonical_id,
        metadata: link.metadata ?? {},
        created_at: new Date(link.created_at).toISOString(),
      });
      linksByResult.set(incomingKey, incoming);
    }

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

function buildTableCTE(
  table: SearchTable,
  perTableLimit: number,
  tier?: Tier,
  namespaceParamIndex?: number,
  namespaceIsArray = false,
  sourceScopeParamIndex?: number,
): string {
  if (tier && !VALID_TIERS.has(tier)) throw new Error(`Invalid tier: ${tier}`);
  if (table === "entities") {
    const tierFilter = tier && tier !== "warm" ? " AND FALSE" : "";
    const nsFilter = namespaceParamIndex
      ? namespaceIsArray
        ? ` AND e.namespace = ANY(${paramRef(namespaceParamIndex)}::text[])`
        : ` AND e.namespace = ${paramRef(namespaceParamIndex)}`
      : "";
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
  const alias = TABLE_ALIAS[table];
  const label = SOURCE_LABELS[table];
  const preview = CONTENT_PREVIEW[table];
  const cteName = `${table}_results`;
  const tierFilter = tier ? ` AND ${alias}.tier = '${tier}'` : "";
  const nsFilter = namespaceParamIndex
    ? namespaceIsArray
      ? ` AND ${alias}.namespace = ANY(${paramRef(namespaceParamIndex)}::text[])`
      : ` AND ${alias}.namespace = ${paramRef(namespaceParamIndex)}`
    : "";
  const sourceScopeFilter = sourceScopeFilterSql(alias, sourceScopeParamIndex);
  const metaCol = HAS_EXTRACTED_METADATA.has(table)
    ? `${alias}.extracted_metadata`
    : "NULL::jsonb AS extracted_metadata";

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
function ftsMatchExpressions(
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

function buildFtsCTE(
  table: SearchTable,
  perTableLimit: number,
  ftsConfig: FtsConfig,
  tier?: Tier,
  namespaceParamIndex?: number,
  namespaceIsArray = false,
  sourceScopeParamIndex?: number,
): string {
  if (tier && !VALID_TIERS.has(tier)) throw new Error(`Invalid tier: ${tier}`);
  if (table === "entities") {
    const tierFilter = tier && tier !== "warm" ? " AND FALSE" : "";
    const nsFilter = namespaceParamIndex
      ? namespaceIsArray
        ? ` AND e.namespace = ANY(${paramRef(namespaceParamIndex)}::text[])`
        : ` AND e.namespace = ${paramRef(namespaceParamIndex)}`
      : "";
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
  const alias = TABLE_ALIAS[table];
  const label = SOURCE_LABELS[table];
  const preview = CONTENT_PREVIEW[table];
  const cteName = `${table}_fts`;
  const tierFilter = tier ? ` AND ${alias}.tier = '${tier}'` : "";
  const nsFilter = namespaceParamIndex
    ? namespaceIsArray
      ? ` AND ${alias}.namespace = ANY(${paramRef(namespaceParamIndex)}::text[])`
      : ` AND ${alias}.namespace = ${paramRef(namespaceParamIndex)}`
    : "";
  const sourceScopeFilter = sourceScopeFilterSql(alias, sourceScopeParamIndex);

  const metaCol = HAS_EXTRACTED_METADATA.has(table)
    ? `${alias}.extracted_metadata`
    : "NULL::jsonb AS extracted_metadata";

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

function buildRelationalHydrationSelect(
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

async function relationalGraphSearch(
  deps: ToolDeps,
  accessibleTables: SearchTable[],
  query: string,
  fetchLimit: number,
  tier?: Tier,
  namespace?: NamespaceFilter,
): Promise<SearchRow[]> {
  const parsed = parseRelationalQuery(query);
  if (!parsed) return [];
  const targetTables = accessibleTables.filter(
    (table): table is Table => table !== "entities",
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
    .map((table) =>
      buildRelationalHydrationSelect(table, parsed.direction, tier),
    )
    .join("\nUNION ALL\n");

  try {
    const { rows } = await deps.pool.query<SearchRow>(
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
    logger.info("search_relational_graph", {
      relation: parsed.relation,
      direction: parsed.direction,
      seed_length: parsed.seed.length,
      target_tables: targetTables,
      candidate_count: rows.length,
    });
    return withSourceRefs(rows);
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

async function vectorSearch(
  deps: ToolDeps,
  accessibleTables: SearchTable[],
  embedding: number[],
  fetchLimit: number,
  tier?: Tier,
  offset = 0,
  namespace?: NamespaceFilter,
  sourceScope?: SourceScope,
): Promise<SearchRow[]> {
  const perTableLimit = fetchLimit;
  const params = [toSql(embedding), fetchLimit, offset];
  const namespaceParamIndex = appendNamespaceParam(params, namespace);
  const sourceScopeParamIndex = appendSourceScopeParam(params, sourceScope);
  const namespaceIsArray = Array.isArray(namespace);
  const ctes = accessibleTables.map((t) =>
    buildTableCTE(
      t,
      perTableLimit,
      tier,
      namespaceParamIndex,
      namespaceIsArray,
      sourceScopeParamIndex,
    ),
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

  const { rows } = await deps.pool.query(sql, params);
  return withSourceRefs(rows as SearchRow[]);
}

async function ftsSearch(
  deps: ToolDeps,
  accessibleTables: SearchTable[],
  query: string,
  fetchLimit: number,
  tier?: Tier,
  offset = 0,
  namespace?: NamespaceFilter,
  sourceScope?: SourceScope,
  ftsConfig: FtsConfig = DEFAULT_FTS_CONFIG,
): Promise<SearchRow[]> {
  const perTableLimit = fetchLimit;
  const params = [query, fetchLimit, offset];
  const namespaceParamIndex = appendNamespaceParam(params, namespace);
  const sourceScopeParamIndex = appendSourceScopeParam(params, sourceScope);
  const namespaceIsArray = Array.isArray(namespace);
  const ctes = accessibleTables.map((t) =>
    buildFtsCTE(
      t,
      perTableLimit,
      ftsConfig,
      tier,
      namespaceParamIndex,
      namespaceIsArray,
      sourceScopeParamIndex,
    ),
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

  const { rows } = await deps.pool.query(sql, params);
  return withSourceRefs(rows as SearchRow[]);
}

/**
 * Reciprocal Rank Fusion: merge ranked lists from different scoring systems.
 * Items appearing in both lists get summed RRF scores (boosted).
 * Items in only one list get a single RRF score.
 * Hot entries get +0.3 boost, cold entries get -0.2, warm is unchanged.
 */
function rrfMerge(
  vectorRows: SearchRow[],
  ftsRows: SearchRow[],
  limit: number,
  graphRows: SearchRow[] = [],
): SearchRow[] {
  const scoreMap = new Map<string, { row: SearchRow; rrf: number }>();

  for (let i = 0; i < vectorRows.length; i++) {
    const row = vectorRows[i]!;
    const key = `${row.source_type}:${row.id}`;
    scoreMap.set(key, { row, rrf: 1 / (RRF_K + i + 1) });
  }

  for (let i = 0; i < ftsRows.length; i++) {
    const row = ftsRows[i]!;
    const key = `${row.source_type}:${row.id}`;
    const existing = scoreMap.get(key);
    if (existing) {
      existing.rrf += 1 / (RRF_K + i + 1);
    } else {
      scoreMap.set(key, { row, rrf: 1 / (RRF_K + i + 1) });
    }
  }

  for (let i = 0; i < graphRows.length; i++) {
    const row = graphRows[i]!;
    const key = `${row.source_type}:${row.id}`;
    const existing = scoreMap.get(key);
    const graphRrf = 3 / (RRF_K + i + 1);
    if (existing) {
      existing.rrf += graphRrf;
      existing.row = { ...existing.row, explicit_links: row.explicit_links };
    } else {
      scoreMap.set(key, { row, rrf: graphRrf });
    }
  }

  return Array.from(scoreMap.values())
    .map(({ row, rrf }) => {
      const tier = TIER_BOOST[(row.tier ?? "warm") as Tier];
      const weight = TABLE_WEIGHT[row.source_type] ?? 1.0;
      const recency = recencyFactor(row.created_at);
      return { row, rrf: Math.max(0, (rrf + tier) * weight * recency) };
    })
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, limit)
    .map(({ row }) => row);
}

/** Circuit breaker: stop tracking after consecutive failures to avoid log floods */
const TRACKING_FAILURE_THRESHOLD = 5;
let trackingConsecutiveFailures = 0;
let trackingCircuitOpen = false;

export function trackUsage(
  deps: ToolDeps,
  rows: SearchRow[],
  queryText: string,
  context = "search",
  accessedBy?: string,
): void {
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

export async function executeSearch(
  deps: ToolDeps,
  accessibleTables: SearchTable[],
  query: string,
  limit: number,
  mode: SearchMode = "hybrid",
  tier?: Tier,
  offset = 0,
  namespace?: NamespaceFilter,
  includeLinks?: boolean,
  sourceScope?: SourceScope,
  options: ExecuteSearchOptions = {},
): Promise<SearchRow[]> {
  const enableGraph = options.enableGraph === true;
  const ftsConfig = options.ftsConfig ?? DEFAULT_FTS_CONFIG;
  if (sourceScope) {
    accessibleTables = accessibleTables.filter((table) => table !== "entities");
    if (accessibleTables.length === 0) return [];
  }
  let rows: SearchRow[];
  if (mode === "keyword") {
    rows = await ftsSearch(
      deps,
      accessibleTables,
      query,
      limit,
      tier,
      offset,
      namespace,
      sourceScope,
      ftsConfig,
    );
    if (includeLinks !== false) {
      rows = await attachExplicitLinks(deps, rows, namespace);
    }
    return rows;
  }

  // Vector and hybrid both need an embedding
  const embedding = await generateSearchEmbedding(deps, query);
  if (!embedding) {
    // Fall back to keyword-only if embedding fails in hybrid mode
    if (mode === "hybrid") {
      logger.warn("embedding_failed_fallback_fts", {
        queryLength: query.length,
      });
      const totalNeeded = offset + limit;
      const fetchLimit = totalNeeded * HYBRID_FETCH_MULTIPLIER;
      const graphRows =
        enableGraph && sourceScope === undefined
          ? await relationalGraphSearch(
              deps,
              accessibleTables,
              query,
              Math.min(fetchLimit, RELATIONAL_GRAPH_FETCH_LIMIT),
              tier,
              namespace,
            )
          : [];
      if (graphRows.length > 0) {
        const ftsRows = await ftsSearch(
          deps,
          accessibleTables,
          query,
          fetchLimit,
          tier,
          0,
          namespace,
          sourceScope,
          ftsConfig,
        );
        rows = rrfMerge([], ftsRows, totalNeeded, graphRows).slice(offset);
      } else {
        rows = await ftsSearch(
          deps,
          accessibleTables,
          query,
          limit,
          tier,
          offset,
          namespace,
          sourceScope,
          ftsConfig,
        );
      }
      if (includeLinks !== false) {
        rows = await attachExplicitLinks(deps, rows, namespace);
      }
      return rows;
    }
    // In vector mode, null embedding is a hard failure -- signal via thrown error
    throw new Error("Failed to generate query embedding");
  }

  if (mode === "vector") {
    rows = await vectorSearch(
      deps,
      accessibleTables,
      embedding,
      limit,
      tier,
      offset,
      namespace,
      sourceScope,
    );
    if (includeLinks !== false) {
      rows = await attachExplicitLinks(deps, rows, namespace);
    }
    return rows;
  }

  // Hybrid: run both in parallel, merge with RRF
  // Over-fetch to cover offset + limit, then slice after merge
  const totalNeeded = offset + limit;
  const fetchLimit = totalNeeded * HYBRID_FETCH_MULTIPLIER;
  const [vectorRows, ftsRows] = await Promise.all([
    vectorSearch(
      deps,
      accessibleTables,
      embedding,
      fetchLimit,
      tier,
      0,
      namespace,
      sourceScope,
    ),
    ftsSearch(
      deps,
      accessibleTables,
      query,
      fetchLimit,
      tier,
      0,
      namespace,
      sourceScope,
      ftsConfig,
    ),
  ]);
  const graphRows =
    enableGraph && sourceScope === undefined
      ? await relationalGraphSearch(
          deps,
          accessibleTables,
          query,
          Math.min(fetchLimit, RELATIONAL_GRAPH_FETCH_LIMIT),
          tier,
          namespace,
        )
      : [];

  const merged = rrfMerge(vectorRows, ftsRows, totalNeeded, graphRows);
  rows = merged.slice(offset);
  if (includeLinks !== false) {
    rows = await attachExplicitLinks(deps, rows, namespace);
  }
  return rows;
}

export async function executeSearchWithSharedFallback(
  deps: ToolDeps,
  accessibleTables: SearchTable[],
  query: string,
  limit: number,
  mode: SearchMode,
  tier: Tier | undefined,
  offset: number,
  namespace: NamespaceFilter | undefined,
  includeLinks?: boolean,
  sourceScope?: SourceScope,
  options: ExecuteSearchOptions = {},
): Promise<SearchRow[]> {
  const config = sharedNamespaceConfig();
  if (
    !config.legacyFallbackEnabled ||
    config.legacySharedNamespace === "" ||
    offset !== 0 ||
    namespace !== config.sharedNamespace
  ) {
    return withCanonicalNamespaces(
      await executeSearch(
        deps,
        accessibleTables,
        query,
        limit,
        mode,
        tier,
        offset,
        namespace,
        includeLinks,
        sourceScope,
        options,
      ),
    );
  }

  const sharedRows = await executeSearch(
    deps,
    accessibleTables,
    query,
    limit,
    mode,
    tier,
    0,
    config.sharedNamespace,
    includeLinks,
    sourceScope,
    options,
  );
  if (
    sharedRows.length >= limit ||
    sharedRows.length >= config.fallbackMinResults
  ) {
    return withCanonicalNamespaces(sharedRows);
  }

  const legacyRows = await executeSearch(
    deps,
    accessibleTables,
    query,
    limit - sharedRows.length,
    mode,
    tier,
    0,
    config.legacySharedNamespace,
    includeLinks,
    sourceScope,
    options,
  );
  return withCanonicalNamespaces(
    mergeFallbackSearchRows(sharedRows, legacyRows, limit),
  );
}

export async function executeSearchWithScopedSharedFallback(
  deps: ToolDeps,
  accessibleTables: SearchTable[],
  query: string,
  limit: number,
  mode: SearchMode,
  tier: Tier | undefined,
  offset: number,
  namespace: NamespaceFilter | undefined,
  includeLinks?: boolean,
  sourceScope?: SourceScope,
  options: ExecuteSearchOptions = {},
): Promise<SearchRow[]> {
  const config = sharedNamespaceConfig();
  const scopedNamespaces = Array.isArray(namespace) ? namespace : [];
  if (
    !config.legacyFallbackEnabled ||
    config.legacySharedNamespace === "" ||
    offset !== 0 ||
    !scopedNamespaces.includes(config.physicalSharedNamespace)
  ) {
    return withCanonicalNamespaces(
      await executeSearch(
        deps,
        accessibleTables,
        query,
        limit,
        mode,
        tier,
        offset,
        namespace,
        includeLinks,
        sourceScope,
        options,
      ),
    );
  }

  const [primaryRows, sharedRows] = await Promise.all([
    executeSearch(
      deps,
      accessibleTables,
      query,
      limit,
      mode,
      tier,
      0,
      namespace,
      includeLinks,
      sourceScope,
      options,
    ),
    executeSearch(
      deps,
      accessibleTables,
      query,
      limit,
      mode,
      tier,
      0,
      config.physicalSharedNamespace,
      includeLinks,
      sourceScope,
      options,
    ),
  ]);
  if (
    sharedRows.length >= limit ||
    sharedRows.length >= config.fallbackMinResults
  ) {
    return withCanonicalNamespaces(primaryRows);
  }

  const legacyRows = await executeSearch(
    deps,
    accessibleTables,
    query,
    limit,
    mode,
    tier,
    0,
    config.legacySharedNamespace,
    includeLinks,
    sourceScope,
    options,
  );
  return withCanonicalNamespaces(
    mergeFallbackSearchRows(primaryRows, legacyRows, limit),
  );
}

export function registerSearchBrain(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "search_brain",
    {
      description:
        "Search across all brain tables. Supports hybrid (vector + keyword), pure vector, or keyword-only modes.",
      inputSchema: {
        query: z.string().min(1).describe("Natural language search query"),
        table: z
          .enum([
            "thoughts",
            "decisions",
            "relationships",
            "projects",
            "sessions",
            "entities",
          ])
          .optional()
          .describe("Optional: limit search to a specific table"),
        namespace: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .optional()
          .describe(
            "Optional: filter results to a specific namespace (e.g. clientId or 'shared-kb')",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(250)
          .optional()
          .describe("Maximum results to return (default 10)"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Number of results to skip for pagination (default 0)"),
        search_mode: z
          .enum(["hybrid", "vector", "keyword"])
          .optional()
          .describe(
            "Search mode: hybrid (default) = vector + keyword with RRF fusion, vector = semantic only, keyword = full-text only",
          ),
        tier: z
          .enum(["hot", "warm", "cold"])
          .optional()
          .describe("Optional: filter results to a specific cognitive tier"),
        source_scope: sourceScopeSchema
          .optional()
          .describe(
            "Optional: require matching source reference client_id, matter_id, document_id, path, and/or dms_id.",
          ),
        fts_config: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .optional()
          .describe(
            `Optional: keyword full-text-search language configuration for this request. ` +
              `Accepts a supported Postgres regconfig (${SUPPORTED_FTS_CONFIGS.join(", ")}) ` +
              `or a language token (e.g. 'de', 'de-DE', 'spanish'). Unrecognized values ` +
              `fall back to the deployment corpus default (OPENBRAIN_FTS_CONFIG, else english). ` +
              `An explicitly requested effective non-English config requires admin or ob-admin. ` +
              `Affects keyword/hybrid stemming only; english is byte-identical to prior behavior.`,
          ),
      },
      annotations: {
        title: "Search Brain",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: no readable tables",
            },
          ],
          isError: true,
        };
      }

      const tableFilter = args.table as SearchTable | undefined;
      let accessibleTables: SearchTable[];

      if (tableFilter) {
        if (tableFilter === "entities") {
          if (!canRead(auth.role, "sessions")) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Permission denied: cannot read entities",
                },
              ],
              isError: true,
            };
          }
          accessibleTables = ["entities"];
        } else if (!canRead(auth.role, tableFilter)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Permission denied: cannot read ${tableFilter}`,
              },
            ],
            isError: true,
          };
        } else {
          accessibleTables = [tableFilter];
        }
      } else {
        accessibleTables = ALL_TABLES.filter((t) => canRead(auth.role, t));
        if (canRead(auth.role, "sessions")) {
          accessibleTables.push("entities");
        }
      }

      if (accessibleTables.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: no readable tables",
            },
          ],
          isError: true,
        };
      }

      const limit = args.limit ?? 10;
      const offset = args.offset ?? 0;
      const mode = (args.search_mode as SearchMode) ?? "hybrid";
      const tier = args.tier as Tier | undefined;
      const requestedNamespace = args.namespace as string | undefined;
      const sourceScope = args.source_scope as SourceScope | undefined;
      const requestedFtsConfig = args.fts_config as string | undefined;
      const ftsConfig = requestFtsConfig(requestedFtsConfig);
      if (
        requestedFtsConfig !== undefined &&
        ftsConfig !== DEFAULT_FTS_CONFIG &&
        auth.role !== "admin" &&
        auth.role !== "ob-admin"
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: NON_ENGLISH_FTS_AUTHORIZATION_ERROR,
            },
          ],
          isError: true,
        };
      }
      const sourceScopeError = sourceScopeAuthorizationError(auth, sourceScope);
      if (sourceScopeError) {
        return {
          content: [{ type: "text" as const, text: sourceScopeError }],
          isError: true,
        };
      }
      if (sourceScope) {
        accessibleTables = accessibleTables.filter(
          (table) => table !== "entities",
        );
      }
      if (accessibleTables.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No source-scoped tables are readable",
            },
          ],
        };
      }
      if (requestedNamespace && !canReadNamespace(auth, requestedNamespace)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: namespace read access denied",
            },
          ],
          isError: true,
        };
      }
      const namespace = namespaceFilterFor(auth, requestedNamespace);
      const shouldUseSharedFallback =
        requestedNamespace !== undefined &&
        isSharedNamespace(requestedNamespace);

      let rows;
      try {
        rows = shouldUseSharedFallback
          ? await executeSearchWithSharedFallback(
              deps,
              accessibleTables,
              args.query,
              limit,
              mode,
              tier,
              offset,
              namespace,
              undefined,
              sourceScope,
              { enableGraph: true, ftsConfig },
            )
          : await executeSearchWithScopedSharedFallback(
              deps,
              accessibleTables,
              args.query,
              limit,
              mode,
              tier,
              offset,
              namespace,
              undefined,
              sourceScope,
              { enableGraph: true, ftsConfig },
            );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
        };
      }

      trackUsage(deps, rows, args.query, "search", auth.clientId);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(rows),
          },
        ],
      };
    },
  );
}
