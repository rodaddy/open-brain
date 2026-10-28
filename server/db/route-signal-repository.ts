/** Durable database facts used by the automatic DREAM route producer (issue 1525). */
import { DREAM_ROUTE_JOB_KIND } from "../maintenance/dream-route.ts";
import { readUnroutedSlice } from "./dream-route-repository.ts";
import type { QuerySurface } from "./transaction.ts";

export interface RouteSignalFacts {
  readonly last_route_terminal_at: Date | null;
  readonly has_unrouted: boolean;
}

export interface RouteSignalRepository {
  readFacts(): Promise<RouteSignalFacts>;
}

/**
 * Read the two system-wide facts the route producer decides on.
 *
 * The gap is measured from the last TERMINAL `dream.route` job, succeeded or
 * dead-lettered, on purpose: a dead-lettered job releases its idempotency key
 * (issue 1524's finding), so measuring from successes alone would let a
 * failing route job re-enqueue on every sweep -- the pattern behind the 3,113
 * Light dead letters. "Unrouted" is the handler's own read
 * (`readUnroutedSlice`), so the producer and the handler cannot disagree about
 * what is left to route. Neither read accepts a caller-controlled namespace.
 *
 * Production passes no options and reads every namespace. The optional
 * `namespace` exists only so the live suite is hermetic -- the same shape as
 * the handler's optional `namespace` dep in `server/maintenance/dream-route.ts`.
 */
export function createRouteSignalRepository(
  db: QuerySurface,
  options: { namespace?: string } = {},
): RouteSignalRepository {
  return {
    async readFacts() {
      const result = await db.query<{ last_route_terminal_at: Date | null }>(
        `SELECT max(terminal_at) AS last_route_terminal_at
           FROM maintenance_jobs
          WHERE job_kind = $1
            AND state IN ('succeeded', 'dead_letter')`,
        [DREAM_ROUTE_JOB_KIND],
      );
      const row = result.rows[0];
      if (!row) throw new Error("route signal facts query returned no row");
      const unrouted = await readUnroutedSlice({
        db,
        namespace: options.namespace ?? null,
        sliceSize: 1,
      });
      return {
        last_route_terminal_at: row.last_route_terminal_at,
        has_unrouted: unrouted.length > 0,
      };
    },
  };
}
