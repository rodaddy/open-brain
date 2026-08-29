/**
 * DISTILL empty-claim classification. Split out of distill-handler.ts.
 *
 * An empty claim is the normal terminal state -- the queue is drained and
 * there is nothing to stamp. It is ALSO exactly what a broken claim looks
 * like, and that ambiguity is what let this pipeline starve for 27 days in
 * silence: 392 `memory.distill` jobs completed as `succeeded` having stamped
 * zero turns, because a claim returning no due work throws nothing and the
 * handler returned without a word.
 *
 * This module separates the two cases before the sweep returns. Asking the
 * database whether due work still exists costs one indexed count on the
 * terminal path only, and turns a silent no-op into a named condition an
 * operator can see. It is never an error: the sweep did not fail, and throwing
 * here would fail a job whose own behaviour was correct.
 */

import type pg from "pg";
import type { MaintenanceQueueLogger } from "../../src/maintenance-queue.ts";
import type { DistillSweepSummary } from "./distill-handler.ts";

/** What the classification needs, as one parameter. */
export interface EmptyClaimInput {
  pool: pg.Pool;
  logger: MaintenanceQueueLogger;
  namespace?: string;
  laneId?: string | null;
  summary: DistillSweepSummary;
}

/** Render a lane id for a log line without leaking undefined. */
function laneLabel(laneId: string | null | undefined): string {
  return laneId === null || laneId === undefined ? "(none)" : laneId;
}

/**
 * Count undistilled turns still outstanding, or null when the probe failed.
 *
 * DOCUMENTED FAIL-OPEN. The probe is observability, never a gate: if it fails,
 * the sweep still returns its summary rather than turning a diagnostic into an
 * outage. Logged rather than swallowed, because a silent fallback here would
 * recreate in the detector the exact defect the detector exists to catch.
 */
async function countOutstandingTurns(input: EmptyClaimInput): Promise<number | null> {
  try {
    const params: unknown[] = [];
    let nsPredicate = "";
    if (input.namespace !== undefined) {
      params.push(input.namespace);
      nsPredicate = ` AND namespace = $${params.length}`;
    }
    const { rows } = await input.pool.query(
      `SELECT count(*)::bigint AS due
         FROM ob_raw_turns
        WHERE distilled_at IS NULL
          AND retention_tier = 'live'${nsPredicate}`,
      params,
    );
    return Number((rows[0] as { due?: unknown } | undefined)?.due ?? 0);
  } catch (error: unknown) {
    input.logger.warn("distill_backlog_probe_failed", {
      namespace: input.namespace ?? "(all)",
      lane_id: laneLabel(input.laneId),
      reason: error instanceof Error ? error.name : "non_error",
      detail:
        "could not count outstanding turns; an empty claim this sweep is unclassified, not proven drained",
    });
    return null;
  }
}

/**
 * Classify an empty claim and record it on the summary.
 *
 * Sets `claim_empty_with_backlog` only on the pathological case, so a caller
 * can treat its presence as the signal rather than comparing counts.
 */
export async function reportEmptyClaim(input: EmptyClaimInput): Promise<void> {
  const outstanding = await countOutstandingTurns(input);
  if (outstanding !== null && outstanding > 0) {
    input.logger.warn("distill_claim_empty_with_backlog", {
      namespace: input.namespace ?? "(all)",
      lane_id: laneLabel(input.laneId),
      turns_outstanding: outstanding,
      detail:
        "claim returned no due turns while undistilled turns remain; the sweep did nothing and would otherwise have reported success",
    });
    input.summary.claim_empty_with_backlog = outstanding;
    return;
  }
  input.logger.info("distill_queue_drained", {
    namespace: input.namespace ?? "(all)",
    lane_id: laneLabel(input.laneId),
  });
}
