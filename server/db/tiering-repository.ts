/**
 * Owns the statements the lane → durable tiering path and the tiering tools
 * execute.
 *
 * It exists so the domain and tools tiers hold no SQL text:
 * server/domain/tiering.ts, server/tools/tiering.ts and
 * server/tools/tier-mutations.ts take a port instead of a Pool (issue 1209).
 * Design authority: `_plans/463-server-rewrite-charter.md` reserves raw SQL for
 * server/db repositories, and port methods take one object argument.
 *
 * The three the domain round moved are the exact-hash duplicate SELECT, the
 * near-duplicate SELECT by embedding distance, and the graduation
 * INSERT ... ON CONFLICT. They moved verbatim; nothing about what is written,
 * or when, is decided here.
 *
 * The tools round added seven more, on their own `TieringStatements`
 * interface:
 *   4. scanDemotionCandidates .. `COALESCE(${alias}.tier, 'warm') = 'warm'`
 *   5. scanPromotionCandidates . `recent_accesses`
 *   6. runStaleScan ............ `list_stale`'s assembled UNION data and count
 *   7. setTier ................. `SET tier = $1`
 *   8. selectDemoteSource ...... `promoted_from`
 *   9. archiveDemotedEntry ..... `SET archived_at = NOW()`
 *  10. runBulkStatement ........ one bulk entry's statement, inside a
 *                                caller-owned transaction
 *
 * `TieringStatements` takes a `QuerySurface`, so the bulk tools build it from
 * the transaction client `tx` inside `withTransaction`. `TieringRepository`
 * still takes a `pg.Pool`, because `chunks` needs a real pool to build the
 * chunk-write port from; splitting the two is what keeps that requirement from
 * leaking onto the transactional callers.
 *
 * `chunks` rides along because graduation writes a thought and then its chunk
 * rows through the shared write boundary (#605). That boundary already has its
 * own port, so the domain module receives it here rather than holding a pool of
 * its own to build one from.
 */
import { toSql } from "pgvector/pg";
import type pg from "pg";
import type { ChunkRepository } from "./chunk-repository.ts";
import { createChunkRepository } from "./chunk-repository.ts";
import type { QuerySurface } from "./transaction.ts";
import { SET_TIER_CAUSE } from "./tier-moves.ts";
import type { Table } from "../types.ts";

/** One recommendation-scan row, as both scan arms project it. */
export interface TierCandidateRow {
  id: string;
  content_preview: string;
  tier: string;
  access_count: number;
  recent_accesses?: number;
  last_accessed_at: string | null;
}

/** The `list_stale` count statement's single row. */
export interface StaleCountRow {
  total_count: number | null;
}

/**
 * The tiering tools' statements, on any query surface.
 *
 * Separate from `TieringRepository` because these run both on a pool and, for
 * the bulk tools, on a transaction client.
 */
export interface TieringStatements {
  /** Warm entries that have gone quiet, coarsest signal first. */
  scanDemotionCandidates(values: {
    table: Table;
    alias: string;
    preview: string;
    previewWidth: number;
    scopedPredicate: string;
    params: unknown[];
  }): Promise<TierCandidateRow[]>;

  /** Entries whose ACCESS LOG shows real recent traffic. */
  scanPromotionCandidates(values: {
    table: Table;
    alias: string;
    preview: string;
    previewWidth: number;
    scopedPredicate: string;
    params: unknown[];
  }): Promise<TierCandidateRow[]>;

  /**
   * `list_stale`'s data and count statements, whose UNION text its own helpers
   * assemble from validated table names and predicate fragments.
   */
  runStaleScan(values: {
    text: string;
    params: unknown[];
  }): Promise<Record<string, unknown>[]>;

  /** `set_tier`: retier one entry under the caller's write predicate. */
  setTier(values: {
    table: Table;
    predicateClause: string;
    params: unknown[];
  }): Promise<Record<string, unknown>[]>;

  /** `demote_entry`'s source lookup under the caller's read predicate. */
  selectDemoteSource(values: {
    table: Table;
    predicateClause: string;
    params: unknown[];
  }): Promise<Record<string, unknown>[]>;

  /**
   * `demote_entry`'s archive, under a freshly derived DELETE predicate: the
   * read scope is wider than the write scope, so it is never reused here.
   */
  archiveDemotedEntry(values: {
    table: Table;
    predicateClause: string;
    params: unknown[];
  }): Promise<number>;

  /** One bulk entry's statement, executed on this surface. */
  runBulkStatement(values: { sql: string; params: unknown[] }): Promise<number>;
}

/**
 * Retiering an entry also appends its `tier_moves` row (#1469 item 5,
 * `_plans/1469-dream-route.md`). `pre` reads the row BEFORE the UPDATE
 * because `RETURNING` projects only the new one and `from_tier` is the
 * point of a history table. The UPDATE itself is unchanged -- same
 * predicates, same `RETURNING id, tier` -- so which entry moves, and to
 * what, is decided exactly where it was.
 */
function setTierWithHistorySql(
  table: Table,
  predicateClause: string,
  cause: number,
  source: number,
): string {
  return `WITH pre AS (
           SELECT id, tier FROM ${table} WHERE id = $2
         ), moved AS (
           UPDATE ${table} SET tier = $1
            WHERE id = $2 AND archived_at IS NULL${predicateClause}
            RETURNING id, tier
         ), history AS (
           INSERT INTO tier_moves
             (entry_id, source_table, from_tier, to_tier, cause, routing_run_id)
           SELECT moved.id, $${source}, pre.tier, moved.tier, $${cause}, NULL
             FROM moved JOIN pre ON pre.id = moved.id
         )
         SELECT id, tier FROM moved`;
}

export function createTieringStatements(db: QuerySurface): TieringStatements {
  return {
    async scanDemotionCandidates({
      table,
      alias,
      preview,
      previewWidth,
      scopedPredicate,
      params,
    }) {
      const { rows } = await db.query<TierCandidateRow>(
        `SELECT ${alias}.id,
                    LEFT(${preview}, ${previewWidth}) AS content_preview,
                    COALESCE(${alias}.tier, 'warm') AS tier,
                    COALESCE(${alias}.access_count, 0) AS access_count,
                    ${alias}.last_accessed_at
               FROM ${table} ${alias}
              WHERE ${alias}.archived_at IS NULL
                AND COALESCE(${alias}.tier, 'warm') = 'warm'
                AND (${alias}.last_accessed_at IS NULL
                     OR ${alias}.last_accessed_at < NOW() - INTERVAL '1 day' * $1)
                AND COALESCE(${alias}.access_count, 0) < 3
                ${scopedPredicate}
              ORDER BY COALESCE(${alias}.access_count, 0) ASC, ${alias}.created_at ASC
              FETCH FIRST $2 ROWS ONLY`,
        params,
      );
      return rows;
    },

    async scanPromotionCandidates({
      table,
      alias,
      preview,
      previewWidth,
      scopedPredicate,
      params,
    }) {
      const { rows } = await db.query<TierCandidateRow>(
        `SELECT sub.id, sub.content_preview, sub.tier, sub.access_count,
                    sub.last_accessed_at, sub.recent_accesses
               FROM (
                 SELECT ${alias}.id,
                        LEFT(${preview}, ${previewWidth}) AS content_preview,
                        COALESCE(${alias}.tier, 'warm') AS tier,
                        COALESCE(${alias}.access_count, 0) AS access_count,
                        ${alias}.last_accessed_at,
                        (SELECT COUNT(*) FROM entry_access_log eal
                          WHERE eal.entry_id = ${alias}.id
                            AND eal.source_table = $3
                            AND eal.accessed_at >= NOW() - INTERVAL '1 day' * $1) AS recent_accesses
                   FROM ${table} ${alias}
                  WHERE ${alias}.archived_at IS NULL
                    AND COALESCE(${alias}.tier, 'warm') IN ('warm', 'cold')
                    ${scopedPredicate}
               ) sub
              WHERE sub.recent_accesses > 5
              ORDER BY sub.recent_accesses DESC
              FETCH FIRST $2 ROWS ONLY`,
        params,
      );
      return rows;
    },

    async runStaleScan({ text, params }) {
      const { rows } = await db.query(text, params);
      return rows;
    },

    // SQL text (and why `pre` exists) is `setTierWithHistorySql` above.
    async setTier({ table, predicateClause, params }) {
      const { rows } = await db.query(
        setTierWithHistorySql(
          table,
          predicateClause,
          params.length + 1,
          params.length + 2,
        ),
        [...params, SET_TIER_CAUSE, table],
      );
      return rows;
    },

    async selectDemoteSource({ table, predicateClause, params }) {
      const { rows } = await db.query(
        `SELECT id, namespace, promoted_from FROM ${table}
          WHERE id = $1 AND archived_at IS NULL${predicateClause}`,
        params,
      );
      return rows;
    },

    async archiveDemotedEntry({ table, predicateClause, params }) {
      const { rowCount } = await db.query(
        `UPDATE ${table} SET archived_at = NOW()
          WHERE id = $1 AND archived_at IS NULL${predicateClause}`,
        params,
      );
      return rowCount ?? 0;
    },

    async runBulkStatement({ sql, params }) {
      const { rowCount } = await db.query(sql, params);
      return rowCount ?? 0;
    },
  };
}

export interface DuplicateIdRow {
  readonly id: string;
}

export interface DuplicateDistanceRow {
  readonly id: string;
  readonly distance: number;
}

export interface GraduatedThoughtRow {
  readonly id: string;
  readonly is_new: boolean;
}

export interface TieringRepository {
  /** Rows whose content hash already exists, live, in this namespace. */
  findExactDuplicate(input: {
    hash: string;
    namespace: string;
  }): Promise<DuplicateIdRow[]>;

  /** The nearest live row within `threshold` cosine distance, if any. */
  findNearDuplicate(input: {
    embedding: number[];
    namespace: string;
    threshold: number;
  }): Promise<DuplicateDistanceRow[]>;

  /** Insert or merge the graduated thought, reporting whether it was new. */
  upsertGraduatedThought(input: {
    content: string;
    tags: string[];
    createdBy: string;
    namespace: string;
    embedding: number[] | null;
    contentHash: string;
    embeddedAt: string | null;
    embeddingModel: string | null;
    promotedFrom: string;
  }): Promise<GraduatedThoughtRow[]>;

  /** The chunk-write port for the same database, for the graduation follow-up. */
  readonly chunks: ChunkRepository;
}

export function createTieringRepository(pool: pg.Pool): TieringRepository {
  return {
    async findExactDuplicate({ hash, namespace }) {
      const { rows } = await pool.query<DuplicateIdRow>(
        `SELECT id FROM thoughts
       WHERE content_hash = $1 AND namespace = $2 AND archived_at IS NULL
       LIMIT 1`,
        [hash, namespace],
      );
      return rows;
    },

    async findNearDuplicate({ embedding, namespace, threshold }) {
      const { rows } = await pool.query<DuplicateDistanceRow>(
        `SELECT id, embedding <=> $1 AS distance
       FROM thoughts
       WHERE namespace = $2
         AND archived_at IS NULL
         AND embedding IS NOT NULL
         AND embedding <=> $1 < $3
       ORDER BY distance ASC
       LIMIT 1`,
        [toSql(embedding), namespace, threshold],
      );
      return rows;
    },

    async upsertGraduatedThought(values) {
      const { rows } = await pool.query<GraduatedThoughtRow>(
        `INSERT INTO thoughts
       (content, tags, source, created_by, namespace, embedding, content_hash,
        embedded_at, embedding_model, promoted_from)
     VALUES ($1, $2, 'lane-tiering', $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL
     DO UPDATE SET
       tags = (
         SELECT COALESCE(array_agg(DISTINCT tag), '{}')
         FROM unnest(thoughts.tags || EXCLUDED.tags) AS tag
         WHERE tag IS NOT NULL
       ),
       updated_at = NOW()
     RETURNING id, (xmax = 0) AS is_new`,
        [
          values.content,
          values.tags,
          values.createdBy,
          values.namespace,
          values.embedding ? toSql(values.embedding) : null,
          values.contentHash,
          values.embeddedAt,
          values.embeddingModel,
          values.promotedFrom,
        ],
      );
      return rows;
    },

    chunks: createChunkRepository(pool),
  };
}
