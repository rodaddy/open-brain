/**
 * Owns the statements the entry-READ surfaces execute (issue 1209).
 *
 * It exists so those surfaces hold no SQL text: `get_entry`, `resolve_entry`,
 * `list_recent`, the retrieval engine, and the two entry-read REST transport
 * modules each take this port instead of running statements against a Pool.
 * Design authority: `_plans/463-server-rewrite-charter.md:111` gives server/db
 * the repositories, and :117-119 reserves raw SQL for them.
 *
 * The files it serves:
 *   server/tools/get-entry.ts
 *   server/tools/resolve-entry.ts
 *   server/tools/list-recent.ts
 *   server/tools/search-engine.ts
 *   server/tools/search-engine-links.ts
 *   server/tools/adjacent-context.ts
 *   server/transport/rest-api-reads.ts
 *   server/transport/rest-api-entries.ts
 *
 * Two methods take an already-built statement (`runSearchSql`,
 * `listRecentData`/`listRecentCount` share that shape only in spirit): the
 * retrieval engine composes its CTE stack from `search-engine-sql.ts` helpers
 * that are outside this lane's scope, so the built text arrives as a parameter
 * rather than being duplicated here.
 */
import type { LinkRelation } from "../types.ts";
import type { QuerySurface } from "./transaction.ts";

/** One `ob_links` row joined to the entity names on either end. */
export interface LinkJoinRow {
  id: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  relation: LinkRelation;
  weight: number;
  metadata: Record<string, unknown> | null;
  created_at: string;
  from_name?: string | null;
  from_canonical_id?: string | null;
  to_name?: string | null;
  to_canonical_id?: string | null;
}

/** One `ob_links` row as `adjacent_context` reads it, both endpoint names present. */
export interface AdjacentLinkRow {
  id: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  relation: string;
  weight: number;
  metadata: Record<string, unknown> | null;
  created_at: string;
  from_name: string | null;
  from_canonical_id: string | null;
  to_name: string | null;
  to_canonical_id: string | null;
}

/** The number of link rows one result set may hydrate from. */
export const EXPLICIT_LINK_ROW_MAX = 200;

/**
 * A row array in exactly the shape the `pg` driver's untyped
 * `QueryResult.rows` handed these callers before the move: indexing it yields
 * a row rather than `row | undefined`, and a field read off it is not
 * pre-narrowed. Keeping that shape is what lets each caller's existing
 * `rows[0].id` / `source_refs` read stay byte-identical.
 */
// oxlint-disable-next-line typescript/no-explicit-any
export type EntryRows = any[];

export interface EntryReadRepository {
  /**
   * Fetch one row as the bounded compact preview envelope for `get_entry`.
   *
   * `columnsSql`, `contentExpression`, `updatedAtExpression`, `predicateClause`
   * and `table` are compile-time literals or values already cleared by the
   * `tableEnum` allowlist; every caller value is bound as a parameter.
   */
  selectCompactEntry(values: {
    table: string;
    updatedAtExpression: string;
    contentExpression: string;
    maxCharsParameter: string;
    predicateClause: string;
    params: unknown[];
  }): Promise<EntryRows>;

  /** Fetch one row as the table's own full projection, under the read predicate. */
  selectFullEntry(values: {
    table: string;
    columnsSql: string;
    predicateClause: string;
    params: unknown[];
  }): Promise<EntryRows>;

  /** Probe one table for an id under read namespace scope (`resolve_entry`). */
  probeEntryById(values: {
    table: string;
    archivedIsClause: string;
    scopeClause: string;
    params: unknown[];
  }): Promise<EntryRows>;

  /** Run the `list_recent` data query, whose SQL the tool composed per table. */
  listRecentData(values: { sql: string; params: unknown[] }): Promise<EntryRows>;

  /** Run the `list_recent` count query. Independently recoverable by the caller. */
  listRecentCount(values: { sql: string; params: unknown[] }): Promise<EntryRows>;

  /** Run one retrieval arm's composed statement (vector or keyword). */
  runSearchSql(values: { sql: string; params: unknown[] }): Promise<EntryRows>;

  /** REST `GET /:table/:id`: one entry under the read namespace predicate. */
  selectRestEntry(values: {
    table: string;
    columnsSql: string;
    predicateClause: string;
    params: unknown[];
  }): Promise<EntryRows>;

  /** REST namespace counts for one table. */
  countNamespaces(values: {
    table: string;
    predicateClause: string;
    params: unknown[];
  }): Promise<EntryRows>;

  /** REST `POST /thoughts`: upsert one thought, returning id and `is_new`. */
  insertThought(values: { params: unknown[] }): Promise<EntryRows>;

  /** REST `POST /decisions`: upsert one decision, returning id and `is_new`. */
  insertDecision(values: { params: unknown[] }): Promise<EntryRows>;

  /**
   * Read the `ob_links` edges touching one result set, on either end.
   *
   * `namespaceFilter` is the fragment `namespaceFilterSql` produced for an
   * index already assigned in `params`; every caller value is bound.
   */
  selectExplicitLinkRows(input: {
    params: unknown[];
    namespaceFilter: string;
  }): Promise<LinkJoinRow[]>;

  /** Run the one-hop `adjacent_context` statement the tool composed. */
  runAdjacencyQuery(values: {
    sql: string;
    params: unknown[];
  }): Promise<AdjacentLinkRow[]>;
}

const THOUGHT_INSERT_SQL = `INSERT INTO thoughts (content, tags, source, created_by, namespace, embedding, content_hash, embedded_at, embedding_model)
       VALUES ($1, $2, 'rest', $3, $4, $5, $6, $7, $8)
       ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL
       DO UPDATE SET
         tags = (
           SELECT COALESCE(array_agg(DISTINCT tag), '{}')
           FROM unnest(thoughts.tags || EXCLUDED.tags) AS tag
           WHERE tag IS NOT NULL
         ),
         updated_at = NOW()
       RETURNING id, (xmax = 0) AS is_new`;

const DECISION_INSERT_SQL = `INSERT INTO decisions (title, rationale, alternatives, tags, context, created_by, namespace, embedding, content_hash, embedded_at, embedding_model)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL
       DO UPDATE SET
         tags = (
           SELECT COALESCE(array_agg(DISTINCT tag), '{}')
           FROM unnest(decisions.tags || EXCLUDED.tags) AS tag
           WHERE tag IS NOT NULL
         ),
         updated_at = NOW()
       RETURNING id, (xmax = 0) AS is_new`;

/** The link-graph statements the search and adjacency surfaces execute. */
function linkStatements(
  db: QuerySurface,
): Pick<EntryReadRepository, "selectExplicitLinkRows" | "runAdjacencyQuery"> {
  return {
    async selectExplicitLinkRows({ params, namespaceFilter }) {
      const { rows } = await db.query(
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
         AND (l.to_type <> 'entity' OR to_entity.id IS NOT NULL)${namespaceFilter}
       ORDER BY l.weight DESC, l.created_at DESC
       LIMIT ${EXPLICIT_LINK_ROW_MAX}`,
        params,
      );
      return rows as LinkJoinRow[];
    },

    async runAdjacencyQuery(values) {
      const { rows } = await db.query(values.sql, values.params);
      return rows as AdjacentLinkRow[];
    },
  };
}

export function createEntryReadRepository(db: QuerySurface): EntryReadRepository {
  return {
    ...linkStatements(db),
    ...linkStatements(db),
    async selectCompactEntry(values) {
      const { rows } = await db.query(
        `SELECT entry.id, entry.namespace, entry.created_by, entry.created_at,
            entry.updated_at, entry.tier, entry.tags,
            LEFT(entry.content_text, ${values.maxCharsParameter}) AS content_preview,
            length(entry.content_text) AS content_length,
            length(entry.content_text) > ${values.maxCharsParameter} AS content_truncated
       FROM (
         SELECT id, namespace, created_by, created_at, ${values.updatedAtExpression} AS updated_at,
                tier, tags, ${values.contentExpression} AS content_text
           FROM ${values.table}
          WHERE id = $1 AND archived_at IS NULL${values.predicateClause}
       ) entry`,
        values.params,
      );
      return rows as EntryRows;
    },

    async selectFullEntry(values) {
      const { rows } = await db.query(
        `SELECT ${values.columnsSql} FROM ${values.table}
      WHERE id = $1 AND archived_at IS NULL${values.predicateClause}`,
        values.params,
      );
      return rows as EntryRows;
    },

    async probeEntryById(values) {
      const { rows } = await db.query(
        `SELECT id, namespace FROM ${values.table}
        WHERE id = $1 AND archived_at IS ${values.archivedIsClause}${values.scopeClause}
        FETCH FIRST 1 ROW ONLY`,
        values.params,
      );
      return rows as EntryRows;
    },

    async listRecentData(values) {
      const { rows } = await db.query(values.sql, values.params);
      return rows as EntryRows;
    },

    async listRecentCount(values) {
      const { rows } = await db.query(values.sql, values.params);
      return rows as EntryRows;
    },

    async runSearchSql(values) {
      const { rows } = await db.query(values.sql, values.params);
      return rows as EntryRows;
    },

    async selectRestEntry(values) {
      const { rows } = await db.query(
        `SELECT ${values.columnsSql} FROM ${values.table} WHERE id = $1${values.predicateClause} AND archived_at IS NULL`,
        values.params,
      );
      return rows as EntryRows;
    },

    async countNamespaces(values) {
      const { rows } = await db.query(
        `SELECT '${values.table}' AS table_name, namespace, COUNT(*) AS count
         FROM ${values.table} WHERE archived_at IS NULL${values.predicateClause}
         GROUP BY namespace ORDER BY count DESC`,
        values.params,
      );
      return rows as EntryRows;
    },

    async insertThought(values) {
      const { rows } = await db.query(THOUGHT_INSERT_SQL, values.params);
      return rows as EntryRows;
    },

    async insertDecision(values) {
      const { rows } = await db.query(DECISION_INSERT_SQL, values.params);
      return rows as EntryRows;
    },
  };
}
