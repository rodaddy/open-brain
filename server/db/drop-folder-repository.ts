/**
 * The four durable statements the drop-folder capture path runs against the
 * `thoughts` table. It exists so the capture tier holds no SQL text (issue 1209).
 */
import { toSql } from "pgvector/pg";
import type pg from "pg";

// The durable table drop files land in. Reused (not re-implemented) so identical
// content dedupes via the existing (content_hash, namespace) upsert, and the
// same background metadata enrichment runs. Kept as an explicit constant so the
// interpolation-free INSERT below never targets an arbitrary table.
export const DURABLE_TABLE = "thoughts" as const;

/** One durable row as the capture path reads it. */
export interface DropFolderRow {
  id: string;
  tags: string[] | null;
}

/** The insert's returned row: the durable id, and whether it was freshly inserted. */
export interface DropFolderInsertRow {
  id: string;
  is_new: boolean;
}

export interface DropFolderRepository {
  /** Probe for an existing (namespace, content_hash) row. */
  findByContentHash(
    hash: string,
    namespace: string,
  ): Promise<DropFolderRow | undefined>;
  /** Merge a strictly larger tag set onto an existing row; returns the row's id. */
  mergeTags(
    hash: string,
    namespace: string,
    tags: string[],
  ): Promise<string | undefined>;
  /** Insert new content race-safely; returns no row when the ON CONFLICT arm excluded the update. */
  insertContent(values: {
    content: string;
    tags: string[];
    createdBy: string;
    namespace: string;
    embedding: number[] | null;
    hash: string;
    embeddedAt: string | null;
    embeddingModel: string | null;
  }): Promise<DropFolderInsertRow | undefined>;
  /** Re-read the durable id after an excluded ON CONFLICT update. */
  idByContentHash(hash: string, namespace: string): Promise<string | undefined>;
}

export function createDropFolderRepository(pool: pg.Pool): DropFolderRepository {
  return {
    async findByContentHash(hash, namespace) {
      const existing = await pool.query(
        `SELECT id, tags FROM ${DURABLE_TABLE} WHERE content_hash = $1 AND namespace = $2`,
        [hash, namespace],
      );
      return existing.rows[0] as DropFolderRow | undefined;
    },

    async mergeTags(hash, namespace, tags) {
      const updated = await pool.query(
        `UPDATE ${DURABLE_TABLE}
       SET tags = (
             SELECT COALESCE(array_agg(DISTINCT tag), '{}')
             FROM unnest(COALESCE(${DURABLE_TABLE}.tags, '{}') || $3::text[]) AS tag
             WHERE tag IS NOT NULL
           ),
           updated_at = NOW()
     WHERE content_hash = $1 AND namespace = $2
     RETURNING id`,
        [hash, namespace, tags],
      );
      return updated.rows[0]?.id as string | undefined;
    },

    async insertContent(values) {
      const { rows } = await pool.query(
        `INSERT INTO ${DURABLE_TABLE} (content, tags, source, created_by, namespace, embedding, content_hash, embedded_at, embedding_model, source_refs)
     VALUES ($1, $2, 'drop', $3, $4, $5, $6, $7, $8, '[]'::jsonb)
     ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL
     DO UPDATE SET
       tags = (
         SELECT COALESCE(array_agg(DISTINCT tag), '{}')
         FROM unnest(COALESCE(${DURABLE_TABLE}.tags, '{}') || EXCLUDED.tags) AS tag
         WHERE tag IS NOT NULL
       ),
       updated_at = NOW()
     WHERE NOT (EXCLUDED.tags <@ COALESCE(${DURABLE_TABLE}.tags, '{}'))
     RETURNING id, (xmax = 0) AS is_new`,
        [
          values.content,
          values.tags,
          values.createdBy,
          values.namespace,
          values.embedding ? toSql(values.embedding) : null,
          values.hash,
          values.embeddedAt,
          values.embeddingModel,
        ],
      );
      return rows[0] as DropFolderInsertRow | undefined;
    },

    async idByContentHash(hash, namespace) {
      const reread = await pool.query(
        `SELECT id FROM ${DURABLE_TABLE} WHERE content_hash = $1 AND namespace = $2`,
        [hash, namespace],
      );
      return reread.rows[0]?.id as string | undefined;
    },
  };
}
