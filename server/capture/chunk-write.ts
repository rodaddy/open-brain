import type { ChunkRepository } from "../db/chunk-repository.ts";
import { CHUNK_THRESHOLD, chunkText } from "../embedding/chunking.ts";
import { normalizedContentHash, embeddingModel } from "../embedding/provider.ts";
import { logger } from "../logging/legacy-logger.ts";

/**
 * Write the chunk rows that accompany a long entry: the parent keeps its
 * COMPLETE text and its own whole-text embedding, and the chunk rows
 * (parent_id + chunk_index) add per-section resolution on top of it. This is
 * not `decompose_entry`'s replacement semantics -- the parent stays live.
 *
 * See docs/decisions/chunk-write-parent-plus-chunks.md
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
 * The shared thought-write boundary (#605): every writer that commits a row to
 * `thoughts` calls this immediately after. A failure here is swallowed and
 * REPORTED -- logged as `entry_chunk_write_failed` and returned as
 * `failed: true` -- because the parent already holds every character. Not
 * applicable when `isNew` is false.
 *
 * See docs/decisions/chunk-write-thought-write-boundary.md
 */
export async function writeThoughtChunks(
  repository: ChunkRepository,
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
    const result = await writeEntryChunks(repository, {
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

/** The per-chunk fields both helpers below read off the caller's options. */
type ChunkWriteOptions = {
  table: "thoughts";
  parentId: string;
  namespace: string;
  createdBy: string;
  content: string;
  tags?: string[];
  embedFn: (text: string) => Promise<number[] | null>;
  source?: string;
};

/** One chunk as produced by {@link chunkText}. */
type WritableChunk = { text: string; index: number };

/**
 * Embed one chunk, returning null instead of throwing.
 *
 * An embedding failure must not cost the text. It is logged as an error and
 * the caller still writes the row unembedded, so a repair pass can find it --
 * the embedding repair handler selects on embedding IS NULL.
 */
async function embedChunkOrNull(
  chunk: WritableChunk,
  options: ChunkWriteOptions,
): Promise<number[] | null> {
  try {
    return await options.embedFn(chunk.text);
  } catch (error) {
    logger.error("entry_chunk_embed_failed", {
      table: options.table,
      parent_id: options.parentId,
      chunk_index: chunk.index,
      error_name: error instanceof Error ? error.name : "unknown",
      error_message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Insert one chunk row. Returns true when a row was written, false when an
 * identical text already exists in this namespace and the insert was a no-op.
 */
async function insertChunkRow(
  repository: ChunkRepository,
  chunk: WritableChunk,
  embedding: number[] | null,
  options: ChunkWriteOptions,
): Promise<boolean> {
  const rows = await repository.insertChunkRow({
    content: chunk.text,
    tags: options.tags ?? [],
    source: options.source ?? "chunk",
    createdBy: options.createdBy,
    namespace: options.namespace,
    embedding,
    contentHash: normalizedContentHash(chunk.text),
    embeddedAt: embedding ? new Date().toISOString() : null,
    embeddingModel: embedding ? embeddingModel() : null,
    parentId: options.parentId,
    chunkIndex: chunk.index,
  });
  return typeof rows[0]?.id === "string";
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
  repository: ChunkRepository,
  options: ChunkWriteOptions,
): Promise<ChunkWriteResult> {
  const result: ChunkWriteResult = {
    written: 0,
    duplicates: 0,
    unembedded: 0,
  };

  if (options.content.length <= CHUNK_THRESHOLD) return result;

  const chunks = chunkText(options.content, WRITE_CHUNK_CHARS, WRITE_CHUNK_OVERLAP);

  logger.info("entry_chunk_write_started", {
    table: options.table,
    parent_id: options.parentId,
    content_length: options.content.length,
    chunks: chunks.length,
  });

  for (const chunk of chunks) {
    const embedding = await embedChunkOrNull(chunk, options);
    const inserted = await insertChunkRow(repository, chunk, embedding, options);

    if (inserted) {
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
