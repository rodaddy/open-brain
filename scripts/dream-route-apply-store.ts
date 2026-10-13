/**
 * The run-schema MIRROR tables a DREAM apply step writes into.
 *
 * `docs/dream-ethereal-runs.md:44-64` fixes the shape: stage output goes into
 * the run's own `dream_run_NNN` schema, in tables that carry the SAME column
 * shapes as the real ones, and every row also carries `run_id`. That is what
 * makes a run's output comparable against `public` column by column, and what
 * makes teardown `DROP SCHEMA ... CASCADE` rather than a delete sweep.
 *
 * `CREATE TABLE ... (LIKE public.<t> INCLUDING DEFAULTS INCLUDING GENERATED)`
 * is the whole mechanism. `LIKE` copies columns, types, NOT NULLs, and -- with
 * those two options -- the column defaults and generated expressions. It
 * deliberately copies NOTHING else: no foreign keys back into `public` (a
 * mirror row must be able to reference a candidate that the apply step never
 * wrote to `public`), no triggers, no indexes, no primary key. A mirror that
 * inherited `public`'s constraints would refuse exactly the rows a dry run
 * exists to produce.
 *
 * Nothing here writes to `public`; the only statements issued are CREATE
 * against a schema name that `assertDreamRunSchema` has already accepted.
 */

import type { Pool, PoolClient } from "pg";
import { assertDreamRunSchema } from "./rem-ethereal-cohort.ts";

/**
 * The three `public` tables an apply step mirrors, in creation order.
 *
 * `thoughts` takes the promoted entries, `ob_session_events` the lifecycle
 * events, and `tier_moves` the tier history the router produces
 * (`server/db/migrations/050_tier_moves.sql`).
 */
export const APPLY_MIRROR_TABLES = [
  "thoughts",
  "ob_session_events",
  "tier_moves",
] as const;

/** One of the three mirrored table names. */
export type ApplyMirrorTable = (typeof APPLY_MIRROR_TABLES)[number];

/** What `ensureApplyMirrors` is pointed at. */
export interface EnsureApplyMirrorsInput {
  /** A pool, or a client already inside the caller's transaction. */
  readonly client: Pool | PoolClient;
  /** A `dream_run_NNN` schema name. */
  readonly schema: string;
}

/**
 * Creates the three apply mirror tables inside one run schema, if absent.
 *
 * Idempotent by construction: every statement is `IF NOT EXISTS`, so a second
 * call over a schema that already holds rows neither fails nor rewrites them.
 *
 * @param input - The client or pool to issue against, and the run schema.
 * @returns The mirrored table names, in creation order.
 * @throws {Error} When the schema is not a `dream_run_NNN` name.
 */
export async function ensureApplyMirrors(
  input: EnsureApplyMirrorsInput,
): Promise<readonly ApplyMirrorTable[]> {
  const { client, schema } = input;
  assertDreamRunSchema(schema);
  for (const table of APPLY_MIRROR_TABLES) {
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${schema}.${table} (
         LIKE public.${table} INCLUDING DEFAULTS INCLUDING GENERATED)`,
    );
    // Added after the LIKE rather than inside it: `run_id` is the one column a
    // mirror has that the real table does not, and it is what makes a row
    // attributable to the run that produced it.
    await client.query(
      `ALTER TABLE ${schema}.${table} ADD COLUMN IF NOT EXISTS run_id UUID NOT NULL`,
    );
  }
  return APPLY_MIRROR_TABLES;
}
