/**
 * The `tier_moves.cause` vocabulary for the three writers that predate the
 * DREAM router (#1469, `_plans/1469-dream-route.md` item 5).
 *
 * `server/db/migrations/050_tier_moves.sql` created the table and deliberately
 * left it unwired: an empty history table is inert, a half-wired one is a
 * history that lies by omission. These constants are what makes the wiring
 * legible -- `cause` is the column a reader GROUPs by to ask which mechanism is
 * moving things (050_tier_moves.sql:46-49), so the three values live together
 * here rather than as string literals scattered across three modules.
 *
 * The naming matches the router's existing causes -- `dream-route-apply`,
 * `dream-route-reversal`, `dream-route-graduation`, `dream-route-undo`
 * (`scripts/dream-route-apply.ts`, `-apply-signals.ts:39`,
 * `-graduate.ts:55-58`) -- one lowercase hyphenated name per writer.
 *
 * The vocabulary is shared. Each of the three writers above builds its own
 * statement, because
 * each has a different pre-image to read: `setTier` matches one id, the bulk
 * tool runs inside a caller-owned transaction, and the REM re-warm pass moves a
 * whole cluster by tag. A single SQL builder over those three would have to be
 * parameterised until it said nothing.
 *
 * `insertTierMove` is for writers that have no pre-image UPDATE of their own:
 * the caller already knows the from and to tiers and only needs the history
 * row, as the public DREAM apply path (issue 1525) does.
 */
import type { QuerySurface } from "./transaction.ts";

/** `tier_moves.cause` for the `set_tier` tool (`server/tools/tier-mutations.ts`). */
export const SET_TIER_CAUSE = "set-tier";

/** `tier_moves.cause` for the `bulk_set_tier` tool. */
export const BULK_SET_TIER_CAUSE = "bulk-set-tier";

/** `tier_moves.cause` for the DREAM REM re-warm pass. */
export const REM_REWARM_CAUSE = "dream-rem-rewarm";

/** `tier_moves.cause` for the DREAM route apply step. */
export const DREAM_ROUTE_APPLY_CAUSE = "dream-route-apply";

/** One `tier_moves` history row, as the caller already knows it. */
export interface InsertTierMoveInput {
  readonly db: QuerySurface;
  readonly entryId: string;
  readonly sourceTable: string;
  readonly fromTier: string | null;
  readonly toTier: string;
  readonly cause: string;
  readonly routingRunId: string | null;
}

/**
 * Append one `tier_moves` row for a writer with no pre-image UPDATE of its own.
 *
 * @param input - The row's columns and the surface to write through.
 */
export async function insertTierMove(input: InsertTierMoveInput): Promise<void> {
  await input.db.query(
    `INSERT INTO tier_moves (entry_id, source_table, from_tier, to_tier, cause, routing_run_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.entryId,
      input.sourceTable,
      input.fromTier,
      input.toTier,
      input.cause,
      input.routingRunId,
    ],
  );
}
