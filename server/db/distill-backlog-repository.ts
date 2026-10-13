/**
 * Owns the one SELECT that counts undistilled turns still outstanding.
 *
 * It exists so the maintenance tier holds no SQL text: distill-backlog takes
 * this port instead of a Pool (issue 1209). Design authority:
 * `_plans/463-server-rewrite-charter.md` reserves raw SQL for server/db
 * repositories.
 */
import type pg from "pg";

export interface DistillBacklogRepository {
  /**
   * Count undistilled live turns, optionally narrowed to one namespace.
   * Throws on a database failure; the caller owns the fail-open decision.
   */
  countOutstandingTurns(input: { namespace?: string }): Promise<number>;
}

export function createDistillBacklogRepository(
  pool: pg.Pool,
): DistillBacklogRepository {
  return {
    async countOutstandingTurns(input) {
      const params: unknown[] = [];
      let nsPredicate = "";
      if (input.namespace !== undefined) {
        params.push(input.namespace);
        nsPredicate = ` AND namespace = $${params.length}`;
      }
      const { rows } = await pool.query(
        `SELECT count(*)::bigint AS due
         FROM ob_raw_turns
        WHERE distilled_at IS NULL
          AND retention_tier = 'live'${nsPredicate}`,
        params,
      );
      return Number((rows[0] as { due?: unknown } | undefined)?.due ?? 0);
    },
  };
}
