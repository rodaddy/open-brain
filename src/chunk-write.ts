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
 * What a caller reports after a thought parent has been committed and its
 * chunk rows attempted. Exactly one of `result` / `failed` is meaningful:
 *
 *   result null + failed false -> nothing to chunk (short entry, or a merge
 *                                onto an existing parent whose chunks exist).
 *   result set  + failed false -> chunked; the counts are the receipt.
 *   result null + failed true  -> the parent committed with the COMPLETE text
 *                                and per-section writing threw.
 */
export interface ChunkAttempt {
  result: ChunkWriteResult | null;
  failed: boolean;
}

/**
 * THE THOUGHT-WRITE BOUNDARY (#605).
 *
 * Every writer that commits a row to `thoughts` calls this immediately after,
 * so "a long thought is stored as a complete parent plus per-section rows" is
 * a property of the table rather than of one code path that remembered.
 * Before #605 only src/tools/log-thought.ts chunked; the rewrite-tree
 * `log_thought` (server/tools/capture.ts), REST `POST /api/v1/thoughts`
 * (src/rest-api.ts), and lane graduation (src/tiering.ts) each wrote a parent
 * and stopped, so a long thought arriving through any of them lost its
 * per-section resolution silently.
 *
 * WHY IT SWALLOWS THE THROW. The parent is already committed and holds every
 * character, so the entry is not lost -- only its resolution is. Turning that
 * into a failed write would discard a good parent over a recoverable partial,
 * which is the opposite of the guarantee. So the failure is REPORTED: logged
 * as `entry_chunk_write_failed` here, and returned as `failed: true` so the
 * caller's receipt can say `chunking_status: "failed"`. That distinction is
 * load-bearing -- without it a failed attempt is byte-identical to a short
 * entry that was never chunked, and a repair pass has no signal.
 *
 * NOT applicable when `isNew` is false: a merge means the chunk rows were
 * written on the original insert. Note a merge does NOT repair a parent left
 * partially chunked by an earlier failure; that belongs to the embedding/chunk
 * repair pass (src/embedding-repair.ts), which is what `failed` signals to.
 *
 * This does NOT cover the paths #605 lists as intentionally separate:
 * decompose-entry writes the same columns with REPLACEMENT semantics (see the
 * header above), and raw turns / session events are their own write
 * boundaries by design.
 */
export async function writeThoughtChunks(
  pool: Pool,
  options: {
    parentId: string;
    namespace: string;
    createdBy: string;
    content: string;
    tags?: string[];
    embedFn: (text: string) => Promise<number[] | null>;
    source?: string;
    /** False for a merge onto an existing parent; chunking is skipped. */
    isNew: boolean;
    /** Names the calling writer in the failure log. */
    caller: string;
  },
): Promise<ChunkAttempt> {
  if (!options.isNew) return { result: null, failed: false };

  try {
    const result = await writeEntryChunks(pool, {
      table: "thoughts",
      parentId: options.parentId,
      namespace: options.namespace,
      createdBy: options.createdBy,
      content: options.content,
      tags: options.tags,
      embedFn: options.embedFn,
      source: options.source,
    });
    return { result, failed: false };
  } catch (error) {
    logger.error("entry_chunk_write_failed", {
      caller: options.caller,
      parent_id: options.parentId,
      content_length: options.content.length,
      error_name: error instanceof Error ? error.name : "unknown",
      error_message: error instanceof Error ? error.message : String(error),
    });
    return { result: null, failed: true };
  }
}

/**
 * The chunk fields a caller merges into its response payload.
 *
 * Kept here so all four writers report the same receipt shape: the counts when
 * chunking ran, `chunking_status: "failed"` when the parent committed but
 * per-section writing threw, and NOTHING when chunking did not apply.
 */
export function chunkReceiptFields(attempt: ChunkAttempt): Record<string, unknown> {
  return {
    ...(attempt.result
      ? {
          chunks_written: attempt.result.written,
          chunks_unembedded: attempt.result.unembedded,
        }
      : {}),
    ...(attempt.failed ? { chunking_status: "failed" as const } : {}),
  };
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
