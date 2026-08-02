import { logger } from "./logger.ts";

/**
 * Default chunk size in characters (~500 tokens).
 * Embedding models work best with focused, coherent text.
 */
const DEFAULT_CHUNK_SIZE = 2000;

/**
 * Overlap between chunks in characters (~10%).
 * Ensures context continuity at chunk boundaries.
 */
const DEFAULT_OVERLAP = 200;

/**
 * Content length threshold before chunking kicks in.
 * Short thoughts get a single embedding on the parent row directly.
 */
export const CHUNK_THRESHOLD = 2000;

export interface Chunk {
  text: string;
  index: number;
}

/**
 * Split text into overlapping chunks for embedding.
 * Tries to break at sentence boundaries to keep chunks coherent.
 * Falls back to word boundaries if no sentence break in the overlap zone.
 */
export function chunkText(
  text: string,
  chunkSize = DEFAULT_CHUNK_SIZE,
  overlap = DEFAULT_OVERLAP,
): Chunk[] {
  if (!text || text.length <= chunkSize) {
    return [{ text, index: 0 }];
  }

  const chunks: Chunk[] = [];
  let start = 0;
  let index = 0;

  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length);

    // If not at end, try to break at a sentence boundary
    if (end < text.length) {
      const breakZone = text.slice(Math.max(start, end - overlap), end);
      // Look for sentence-ending punctuation followed by whitespace + uppercase
      const sentenceBreak = breakZone.search(/[.!?\n]\s+[A-Z]/);
      if (sentenceBreak !== -1) {
        end = Math.max(start, end - overlap) + sentenceBreak + 1;
      } else {
        // Fall back to last word boundary
        const lastSpace = text.lastIndexOf(" ", end);
        if (lastSpace > start + chunkSize / 2) {
          end = lastSpace;
        }
      }
    }

    const chunkText = text.slice(start, end).trim();
    if (chunkText.length > 0) {
      chunks.push({ text: chunkText, index });
      index++;
    }

    // THIS CHUNK REACHED THE END, SO THERE IS NOTHING LEFT TO SPLIT.
    // Without this, the loop never terminates on its own terms: once `end`
    // clamps to text.length it is PINNED there, so `end - overlap` stops
    // advancing and the `start + 1` floor below crawls forward ONE CHARACTER
    // per iteration, emitting one near-duplicate tail chunk per remaining
    // character. Measured on 2026-08-02 before this line existed: 14,000 chars
    // at chunkSize=2000/overlap=400 produced 410 chunks instead of 11 -- the
    // first 10 correct, then 400 shrinking copies of the tail down to a final
    // chunk whose entire text was ".". Every caller paid for them: log-thought
    // wrote them as rows, and embedText (src/embedding.ts) spent one network
    // embed call on each.
    if (end >= text.length) break;

    // Next chunk starts overlap chars back for continuity. The `start + 1`
    // floor remains as a belt-and-braces guarantee of forward progress for a
    // short/degenerate chunk in the MIDDLE of the text (where end < length),
    // which is the only case that can still reach it.
    const nextStart = end - overlap;
    start = Math.max(nextStart, start + 1);
  }

  logger.info("chunked_text", {
    original_length: text.length,
    chunk_count: chunks.length,
    avg_chunk_size: Math.round(
      chunks.reduce((sum, c) => sum + c.text.length, 0) / chunks.length,
    ),
  });

  return chunks;
}

/**
 * Determine whether content should be chunked.
 */
export function shouldChunk(content: string): boolean {
  return content.length > CHUNK_THRESHOLD;
}
