// L5 adapter (issue 864): legacy call form over server/domain/tiering.ts; retired with src/ at L6.
import {
  findDurableDuplicate as findDurableDuplicateServer,
  graduateLaneEvent as graduateLaneEventServer,
  type DuplicateMatch,
  type GraduateResult,
  type LaneEventRow,
} from "../server/domain/tiering.ts";
import type pg from "pg";

export * from "../server/domain/tiering.ts";

/** Trailing arguments of the pre-864 positional `graduateLaneEvent` form. */
type LegacyGraduateTail = [
  createdBy: string,
  embedding: number[] | null,
  reason: string,
  embedFn?: (text: string) => Promise<number[] | null>,
];

/** Trailing arguments of the pre-864 positional `findDurableDuplicate` form. */
type LegacyDuplicateTail = [
  hash: string | null,
  embedding: number[] | null,
  threshold?: number,
];

/**
 * Pre-864 positional form of `graduateLaneEvent`, kept for `src/` and
 * `scripts/` callers. The server/ version takes one options object.
 */
export async function graduateLaneEvent(
  pool: pg.Pool,
  event: LaneEventRow,
  namespace: string,
  ...tail: LegacyGraduateTail
): Promise<GraduateResult> {
  const [createdBy, embedding, reason, embedFn] = tail;
  return graduateLaneEventServer(pool, event, namespace, {
    createdBy,
    embedding,
    reason,
    embedFn,
  });
}

/** Pre-864 positional form of `findDurableDuplicate`. */
export async function findDurableDuplicate(
  pool: pg.Pool,
  namespace: string,
  ...tail: LegacyDuplicateTail
): Promise<DuplicateMatch | null> {
  const [hash, embedding, threshold] = tail;
  return findDurableDuplicateServer(pool, namespace, {
    hash,
    embedding,
    threshold,
  });
}
