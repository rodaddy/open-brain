/** Durable database facts used by the automatic DREAM REM trigger. */
import type { QuerySurface } from "./transaction.ts";

export interface RemSignalFacts {
  readonly light_backlog: string;
  readonly last_rem_completed_at: Date | null;
}

export interface RemSignalRepository {
  readFacts(): Promise<RemSignalFacts>;
}

/**
 * Read the two system-wide facts settled by issue #391.
 *
 * The backlog is undistilled raw turns, not occurrence rows or ungraded
 * candidates (`docs/dream-design.md`, "Correction: light does NOT own the REM
 * backlog counter"). The completion time comes only from successful durable
 * `dream.rem` jobs. Neither read accepts a namespace: the maintenance producer
 * is a server-owned global lane, and no caller-controlled scope reaches it.
 */
export function createRemSignalRepository(db: QuerySurface): RemSignalRepository {
  return {
    async readFacts() {
      const result = await db.query<RemSignalFacts>(
        `SELECT
           (SELECT count(*)::text
              FROM ob_raw_turns
             WHERE distilled_at IS NULL) AS light_backlog,
           (SELECT max(terminal_at)
              FROM maintenance_jobs
             WHERE job_kind = 'dream.rem'
               AND state = 'succeeded') AS last_rem_completed_at`,
      );
      const row = result.rows[0];
      if (!row) throw new Error("REM signal facts query returned no row");
      return row;
    },
  };
}
