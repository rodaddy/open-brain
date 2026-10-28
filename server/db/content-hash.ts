import { createHash } from "node:crypto";

/**
 * The two content-hash policies, in one place, named for what they DO.
 *
 * Both once lived as a function called `contentHash` — one in
 * `server/tools/memory-helpers.ts`, one in `server/embedding/provider.ts` —
 * with different behavior behind the same name. operator ruling 2026-09-01: the
 * two behaviors are both correct and both stay; the NAME collision dies. Hence
 * one module and two deliberately-named exports.
 *
 * WHY THE OUTPUTS ARE FROZEN: each digest feeds an
 * `ON CONFLICT (content_hash, namespace)` dedupe key. Changing what either
 * function returns for any input silently re-partitions every existing row —
 * previously-deduped content stops matching its stored hash, and duplicates
 * appear with no error anywhere. So neither behavior may change silently.
 * `server/db/content-hash.test.ts` pins exact digests for both to make any such
 * change loud.
 */

/**
 * Hash the value exactly as given: sha256 of the raw bytes, hex encoded.
 *
 * Case, whitespace, and surrounding padding are all significant. Use this
 * where the stored text is the thing being deduped and an edit that only
 * touches formatting is a genuinely different entry.
 */
export function contentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Hash the value after folding away presentational differences: lowercase,
 * trim, and collapse every internal whitespace run to a single space, then
 * sha256, hex encoded.
 *
 * Use this where two texts that differ only in case or spacing should be
 * treated as the same content — the embedding path, where a re-capture with
 * different wrapping must not produce a second vector for the same material.
 */
export function normalizedContentHash(text: string): string {
  const normalized = text.toLowerCase().trim().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex");
}
