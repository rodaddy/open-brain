import type { PoolClient } from "pg";

import { isHarnessNoise } from "../../src/tools/ingest-raw-turn.ts";
import { isCountable, MAX_SESSION_REFS } from "./dream-light.ts";

/** One unswept raw turn, as claimed by a Light sweep. */
export interface SweepRow {
  id: string;
  namespace: string;
  content: string;
  content_hash: string;
  session_ref: string | null;
  role: string | null;
  occurred_at: Date;
}

/** What recording one turn did to `content_occurrences`. */
export type OccurrenceOutcome =
  "skipped_noise" | "created" | "updated" | "corroborated";

/**
 * Record one claimed turn against `content_occurrences`.
 *
 * Extracted from runLightSweep so the sweep reads as claim -> record -> stamp
 * and this upsert -- the part with the corroboration semantics -- is one named
 * unit. Behaviour is identical to the inline version it replaces.
 */
export async function recordTurnOccurrence(
  client: PoolClient,
  row: SweepRow,
): Promise<OccurrenceOutcome> {
  // Stamped as swept but never counted: must not be reconsidered next
  // sweep, and must not inflate corroboration. Two separate reasons to
  // skip -- harness noise (which ingest should not have stored) and
  // uncountable-but-legitimate content like tool-call stubs.
  if (isHarnessNoise(row.content) || !isCountable(row.content, row.role ?? undefined)) {
    return "skipped_noise";
  }

  const sessionRef = row.session_ref ?? "";

  // The upsert. session_count increments ONLY when this session has not
  // already contributed — that condition is what makes the number
  // corroboration rather than repetition. occurred_at drives both
  // timestamps; first_seen_at never moves once set.
  // session_bumped MUST be computed from the PRE-update row
  // (`content_occurrences.session_refs`, the excluded-row alias inside DO
  // UPDATE), never from the returned row. Evaluating `session_refs @> $3`
  // in RETURNING reads the row AFTER the append, so the ref is always
  // present and the flag is always false — measured: the counter reported 0
  // corroborations on a sweep that produced a session_count of 3.
  const upserted = await client.query<{
    existed: boolean;
    session_bumped: boolean;
  }>(
    `INSERT INTO content_occurrences (
       namespace, content_hash, occurrence_count, session_count,
       session_refs, sample_content, first_seen_at, last_seen_at, updated_at
     ) VALUES ($1, $2, 1, 1, $3, $4, $5, $5, now())
     ON CONFLICT (namespace, content_hash) DO UPDATE SET
       occurrence_count = content_occurrences.occurrence_count + 1,
       session_count = content_occurrences.session_count
         + CASE WHEN $6 <> '' AND NOT (content_occurrences.session_refs @> $3)
                THEN 1 ELSE 0 END,
       session_refs = CASE
         WHEN $6 <> '' AND NOT (content_occurrences.session_refs @> $3)
         THEN (content_occurrences.session_refs || $3)[1:${MAX_SESSION_REFS}]
         ELSE content_occurrences.session_refs
       END,
       last_seen_at = GREATEST(content_occurrences.last_seen_at, $5),
       first_seen_at = LEAST(content_occurrences.first_seen_at, $5),
       updated_at = now()
     RETURNING (xmax <> 0) AS existed,
               (xmax <> 0
                AND $6 <> ''
                AND NOT (content_occurrences.session_refs @> $3)) AS session_bumped`,
    [
      row.namespace,
      row.content_hash,
      sessionRef === "" ? [] : [sessionRef],
      row.content.slice(0, 500),
      row.occurred_at,
      sessionRef,
    ],
  );

  // xmax <> 0 distinguishes an UPDATE from an INSERT on a conflicting
  // upsert — the standard Postgres idiom, and cheaper than a pre-SELECT.
  const first = upserted.rows[0];
  if (first?.existed !== true) return "created";
  return first.session_bumped === true ? "corroborated" : "updated";
}
