/**
 * Unit identity and the `status()` aggregation pass for the JSONL spool.
 *
 * Extracted verbatim from `./spool.ts` so that module keeps to the repo's
 * per-file size standard. A unit's identity — its group id plus its record
 * keys — is what both replay bookkeeping and the status summary key on, so
 * the two travel together. Imported only from `./spool.ts`; no caller or test
 * reaches these directly.
 */

import type { SpoolRecord } from "./spool-record.ts";
import type { RetryState, SpoolUnit } from "./spool-sidecar.ts";

/** A unit's content-free identity: its group id and its record keys. */
export function unitSignature(
  unit: SpoolUnit<SpoolRecord>,
): [string | null, string[]] | null {
  if (unit.records === null || unit.records.length === 0) {
    return null;
  }
  const first = unit.records[0] as SpoolRecord;
  return [first.group_id ?? null, unit.records.map((record) => record.idempotency_key)];
}

export function unitKeyOf(signature: [string | null, string[]]): string {
  return JSON.stringify([signature[0], signature[1]]);
}

/** Aggregate counters `status()` reports over the parsed spool. */
export interface UnitSummary {
  operationCounts: Record<string, number>;
  retryCounts: Record<string, number>;
  pendingCount: number;
  corruptedLineCount: number;
  oldest: number | null;
  newest: number | null;
}

/**
 * Walk the parsed units once, accumulating everything `status()` reports.
 *
 * Retry counts are keyed by each unit's FIRST record key — content-free, and
 * the same key quarantine receipts use.
 */
export function summarizeUnits(
  units: readonly SpoolUnit<SpoolRecord>[],
  retryState: RetryState,
): UnitSummary {
  const summary: UnitSummary = {
    operationCounts: {},
    retryCounts: {},
    pendingCount: 0,
    corruptedLineCount: 0,
    oldest: null,
    newest: null,
  };
  for (const unit of units) {
    summary.corruptedLineCount += unit.corrupted_line_count;
    if (unit.records === null) {
      continue;
    }
    addUnitRetryCount(summary, unit, retryState);
    for (const record of unit.records) {
      summary.pendingCount += 1;
      summary.operationCounts[record.operation] =
        (summary.operationCounts[record.operation] ?? 0) + 1;
      if (summary.oldest === null || record.created_at < summary.oldest) {
        summary.oldest = record.created_at;
      }
      if (summary.newest === null || record.created_at > summary.newest) {
        summary.newest = record.created_at;
      }
    }
  }
  return summary;
}

function addUnitRetryCount(
  summary: UnitSummary,
  unit: SpoolUnit<SpoolRecord>,
  retryState: RetryState,
): void {
  const signature = unitSignature(unit);
  if (signature === null || unit.records === null) {
    return;
  }
  const state = retryState.units.get(unitKeyOf(signature));
  if (state === undefined) {
    return;
  }
  summary.retryCounts[(unit.records[0] as SpoolRecord).idempotency_key] =
    state.consecutive_failures;
}
