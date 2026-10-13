import type { DreamLightRepository } from "../db/dream-light-repository.ts";

import { isHarnessNoise } from "../capture/ingest-raw-turn.ts";
import { isCountable } from "./dream-light.ts";

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
  repository: DreamLightRepository,
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

  const upserted = await repository.upsertOccurrence({
    namespace: row.namespace,
    contentHash: row.content_hash,
    sessionRef,
    sampleContent: row.content.slice(0, 500),
    occurredAt: row.occurred_at,
  });

  // xmax <> 0 distinguishes an UPDATE from an INSERT on a conflicting
  // upsert — the standard Postgres idiom, and cheaper than a pre-SELECT.
  const first = upserted[0];
  if (first?.existed !== true) return "created";
  return first.session_bumped === true ? "corroborated" : "updated";
}
