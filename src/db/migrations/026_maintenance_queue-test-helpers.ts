/**
 * Shared fixtures for the two live suites over migration 026.
 *
 * The suites split by subject -- enqueue/claim in
 * `026_maintenance_queue.test.ts`, retry/dead-letter in
 * `026_maintenance_queue-retry.test.ts` -- and both need the same migration
 * apply, the same namespace scrub, and the same enqueue defaults. This module
 * holds no test and creates no pool: each suite owns one pool at module scope
 * and passes it in, so neither file can end the other's connections.
 *
 * `src/db/migrate.ts:28` filters the migrations directory to `.sql` files, so
 * these `.ts` siblings are inert to the migration runner.
 */
import type { Pool } from "pg";
import { MaintenanceQueue } from "../../maintenance-queue.ts";

const migrationUrl = new URL("026_maintenance_queue.sql", import.meta.url);

/** Namespace both live suites scope their rows to. */
export const namespace = "test-maintenance-queue-026";

/** Applies migration 026 to the connected database. */
export async function migrate(pool: Pool): Promise<void> {
  await pool.query(await Bun.file(migrationUrl).text());
}

/** Removes every row this namespace owns. */
export async function cleanup(pool: Pool): Promise<void> {
  await pool.query("DELETE FROM maintenance_jobs WHERE namespace = $1", [namespace]);
}

/** A queue bound to the caller's pool. */
export function queue(pool: Pool): MaintenanceQueue {
  return new MaintenanceQueue(pool);
}

/** Enqueues a job carrying the suite defaults, overridden field by field. */
export async function enqueue(
  pool: Pool,
  input: Partial<Parameters<MaintenanceQueue["enqueue"]>[0]> = {},
) {
  return queue(pool).enqueue({
    kind: "maintenance.test",
    version: 1,
    payload: {},
    idempotencyKey: crypto.randomUUID(),
    scope: { namespace },
    // Default to a far-past run_after so tests that claim with a fixed
    // deterministic `now` see the job as due, instead of racing the DB's NOW().
    runAfter: new Date("2000-01-01T00:00:00.000Z"),
    ...input,
  });
}

/**
 * Narrows an optional value, throwing a labelled error when it is absent.
 *
 * Same assertion meaning as a non-null assertion -- a missing value still
 * fails the test -- except the failure names which value went missing instead
 * of surfacing as a bare TypeError on the next property read.
 */
export function expectDefined<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`${label} is undefined`);
  }
  return value;
}
