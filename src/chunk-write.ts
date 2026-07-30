import { toSql } from "pgvector/pg";
import type { Pool } from "pg";
import { CHUNK_THRESHOLD, chunkText } from "./chunking.ts";
import { contentHash, EMBEDDING_MODEL } from "./embedding.ts";
import { logger } from "./logger.ts";

/**
 * Write the chunk rows that accompany a long entry.
 *
 * THE SHAPE, decided by the operator 2026-07-30: EVERYTHING IS VECTORIZED.
 * A long entry is stored as
 *
 *   parent row  -- the COMPLETE text, its own whole-text embedding
 *   chunk rows  -- parent_id + chunk_index, each with its own embedding
 *
 * The parent answers "what is this entry about" and the chunks answer "which
 * part of it says X". Neither replaces the other: a query matching an entry's
 * overall meaning may match no single chunk strongly, and a query naming a
 * detail buried at character 40,000 may not move the whole-text vector at all.
 *
 * WHAT THIS IS NOT. `decompose_entry` (src/tools/decompose-entry.ts) also
 * writes parent_id/chunk_index rows, but as REPLACEMENTS -- it archives the
 * source. That is a curation decision made deliberately by an operator or the
 * dream engine. This function never touches the parent; the parent keeps its
 * full text and stays live. Same columns, opposite intent, so they stay
 * separate rather than one growing a mode flag.
 *
 * NOTHING HERE REFUSES OR SHORTENS ANYTHING. Chunking is how all of the text
 * gets embedded, not a way of storing less of it: the parent already holds
 * every character, and the chunks add resolution on top.
 */

/** Chunk size and overlap used when an entry is split for the write path. */
export const WRITE_CHUNK_CHARS = 2000;
export const WRITE_CHUNK_OVERLAP = 400;

export interface ChunkWriteResult {
  /** Rows actually inserted. Zero when the entry was short enough not to split. */
  written: number;
  /** Chunks that resolved to an existing row rather than a new insert. */
  duplicates: number;
  /** Chunks whose embedding call returned nothing; the text is still stored. */
  unembedded: number;
}

/**
 * Split `content` and write one row per chunk, linked to `parentId`.
 *
 * Safe to call for any entry: content at or below {@link CHUNK_THRESHOLD} is a
 * no-op, because a short entry's own vector already represents all of it.
 *
 * Failure is REPORTED, NEVER SILENT. A chunk that cannot be embedded is still
 * written -- the text must land regardless -- and counted in `unembedded` so
 * the caller can log a partial result instead of reading zero errors as
 * success. A chunk that cannot be WRITTEN throws, because losing the text is
 * the one outcome this whole path exists to prevent.
 */
export async function writeEntryChunks(
  pool: Pool,
  options: {
    table: "thoughts";
    parentId: string;
    namespace: string;
    createdBy: string;
    content: string;
    tags?: string[];
    embedFn: (text: string) => Promise<number[] | null>;
    source?: string;
  },
): Promise<ChunkWriteResult> {
  const result: ChunkWriteResult = {
    written: 0,
    duplicates: 0,
    unembedded: 0,
  };

  if (options.content.length <= CHUNK_THRESHOLD) return result;

  const chunks = chunkText(
    options.content,
    WRITE_CHUNK_CHARS,
    WRITE_CHUNK_OVERLAP,
  );

  logger.info("entry_chunk_write_started", {
    table: options.table,
    parent_id: options.parentId,
    content_length: options.content.length,
    chunks: chunks.length,
  });

  for (const chunk of chunks) {
    const hash = contentHash(chunk.text);
    let embedding: number[] | null = null;
    try {
      embedding = await options.embedFn(chunk.text);
    } catch (error) {
      // An embedding failure must not cost the text. Logged as an error and
      // counted, then the row is written unembedded so a repair pass can find
      // it -- src/embedding-repair.ts selects on embedding IS NULL.
      logger.error("entry_chunk_embed_failed", {
        table: options.table,
        parent_id: options.parentId,
        chunk_index: chunk.index,
        error_name: error instanceof Error ? error.name : "unknown",
        error_message: error instanceof Error ? error.message : String(error),
      });
    }
    const { rows } = await pool.query(
      `INSERT INTO thoughts
         (content, tags, source, created_by, namespace, embedding, content_hash,
          embedded_at, embedding_model, parent_id, chunk_index)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL
       DO NOTHING
       RETURNING id`,
      [
        chunk.text,
        options.tags ?? [],
        options.source ?? "chunk",
        options.createdBy,
        options.namespace,
        embedding ? toSql(embedding) : null,
        hash,
        embedding ? new Date().toISOString() : null,
        embedding ? EMBEDDING_MODEL : null,
        options.parentId,
        chunk.index,
      ],
    );

    if (typeof rows[0]?.id === "string") {
      result.written++;
      // Counted against ROWS WRITTEN, not chunks attempted. A duplicate wrote
      // nothing, so counting it here would report unembedded rows that do not
      // exist and send a repair pass looking for them.
      if (!embedding) result.unembedded++;
    } else {
      // Identical text already stored in this namespace. Not an error: the
      // content is present, which is the property that matters.
      result.duplicates++;
    }
  }

  logger.info("entry_chunk_write_finished", {
    table: options.table,
    parent_id: options.parentId,
    chunks: chunks.length,
    written: result.written,
    duplicates: result.duplicates,
    unembedded: result.unembedded,
  });

  return result;
}
