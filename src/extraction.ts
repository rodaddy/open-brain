import type pg from "pg";
import { logger } from "./logger.ts";

export interface ExtractedMetadata {
  topics: string[];
  people: string[];
  action_items: string[];
  dates: string[];
}

export async function extractMetadata(text: string): Promise<ExtractedMetadata | null> {
  if (!text || text.length < 10) return null;
  return null;
}

/**
 * Merge extracted topics and people into existing tags array.
 * People are prefixed with "person:" for filtering.
 * Deduplicates against existing tags (case-insensitive).
 */
export function mergeTags(
  existingTags: string[],
  extracted: ExtractedMetadata | null,
): string[] {
  if (!extracted) return existingTags;

  const seen = new Set(existingTags.map((t) => t.toLowerCase()));
  const merged = [...existingTags];

  for (const topic of extracted.topics) {
    const key = topic.toLowerCase();
    if (!seen.has(key)) {
      merged.push(topic);
      seen.add(key);
    }
  }

  for (const person of extracted.people) {
    const tagged = `person:${person}`;
    const key = tagged.toLowerCase();
    if (!seen.has(key)) {
      merged.push(tagged);
      seen.add(key);
    }
  }

  return merged;
}

/**
 * Fire-and-forget background extraction: fetch metadata, merge tags, update DB.
 * Shared by log-thought and log-decision to avoid duplicated extraction blocks.
 */
export function backgroundExtract(
  pool: pg.Pool,
  table: string,
  entryId: string,
  text: string,
  existingTags: string[],
): void {
  extractMetadata(text)
    .then((extracted) => {
      if (!extracted) return;
      const enrichedTags = mergeTags(existingTags, extracted);
      pool
        .query(
          `UPDATE ${table} SET tags = $1, extracted_metadata = $2 WHERE id = $3`,
          [enrichedTags, JSON.stringify(extracted), entryId],
        )
        .catch((err: unknown) => {
          logger.warn("extraction_update_error", {
            table,
            id: entryId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    })
    .catch((err) =>
      logger.warn("extraction_background_error", {
        table,
        id: entryId,
        error: String(err),
      }),
    );
}
