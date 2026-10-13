/**
 * Owns the one INSERT that writes a chunk row into `thoughts`.
 *
 * It exists so the capture tier holds no SQL text: chunk-write takes this port
 * instead of a Pool (issue 1209). Design authority:
 * `_plans/463-server-rewrite-charter.md` reserves raw SQL for server/db
 * repositories.
 */
import { toSql } from "pgvector/pg";
import type pg from "pg";

export interface ChunkRow {
  readonly id?: string;
}

export interface ChunkRepository {
  /**
   * Insert one chunk row, returning the inserted rows. An empty array means an
   * identical text already exists in this namespace and the insert was a no-op.
   */
  insertChunkRow(values: {
    content: string;
    tags: string[];
    source: string;
    createdBy: string;
    namespace: string;
    embedding: number[] | null;
    contentHash: string;
    embeddedAt: string | null;
    embeddingModel: string | null;
    parentId: string;
    chunkIndex: number;
  }): Promise<ChunkRow[]>;
}

export function createChunkRepository(pool: pg.Pool): ChunkRepository {
  return {
    async insertChunkRow(values) {
      const { rows } = await pool.query<ChunkRow>(
        `INSERT INTO thoughts
       (content, tags, source, created_by, namespace, embedding, content_hash,
        embedded_at, embedding_model, parent_id, chunk_index)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL
     DO NOTHING
     RETURNING id`,
        [
          values.content,
          values.tags,
          values.source,
          values.createdBy,
          values.namespace,
          values.embedding ? toSql(values.embedding) : null,
          values.contentHash,
          values.embeddedAt,
          values.embeddingModel,
          values.parentId,
          values.chunkIndex,
        ],
      );
      return rows;
    },
  };
}
