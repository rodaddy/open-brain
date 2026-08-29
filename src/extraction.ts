// L5 adapter (issue 864): legacy call form over server/domain/extraction.ts; retired with src/ at L6.
import type pg from "pg";
import { backgroundExtract as extractForTarget } from "../server/domain/extraction.ts";

export * from "../server/domain/extraction.ts";

/**
 * The legacy positional argument list, kept for src/ callers and their tests.
 * The server/ version groups the per-row fields into one object; this tuple is
 * how the six positional arguments were spelled before that split.
 */
type LegacyArgs = [
  pool: pg.Pool,
  table: string,
  entryId: string,
  namespace: string,
  text: string,
  existingTags: string[],
];

/**
 * Legacy six-positional call form mapped onto the server/ target object. A rest
 * tuple keeps the call sites and their type checking identical while this
 * adapter itself stays within the signature rule the server/ standard applies.
 */
export function backgroundExtract(...args: LegacyArgs): void {
  const [pool, table, entryId, namespace, text, existingTags] = args;
  extractForTarget(pool, table, { entryId, namespace, text, existingTags });
}
