/**
 * Retire the dead-lettered `graph.derive` canary job (#384 scope item 1).
 *
 *   bun run scripts/retire-maintenance-canary.ts          # report only
 *   bun run scripts/retire-maintenance-canary.ts --apply  # delete the rows
 *
 * WHY RETIRE RATHER THAN FIX. The canary was hand-enqueued with an empty `{}`
 * payload. `graph.derive`'s contract makes a malformed payload TERMINAL rather
 * than retryable (src/graph-derivation-handler.ts:359), and deliberately so: a
 * payload that cannot be parsed will not parse on the fourth attempt either.
 * `{}` carries no source id, no namespace, and no content hash, so there is no
 * source for the handler to derive and nothing to repair the row INTO. It is
 * not a job that failed; it is a job that was never runnable. The sweep now
 * produces real `graph.derive` jobs from `ob_sources`, which is what the canary
 * was standing in for.
 *
 * WHY THIS IS NOT A MIGRATION. It deletes an operational queue row, not schema
 * or durable memory. Migrations run everywhere and forever; this is a one-time
 * cleanup of one box's queue, and the row's absence on a fresh database is the
 * correct state rather than a migration to replay.
 *
 * SCOPE. Only rows whose `idempotency_key` starts with `canary:` AND which are
 * in `dead_letter` are eligible. A canary that is queued, running, or succeeded
 * is left alone and reported: this script retires abandoned work, and deciding
 * that a live job is abandoned is not its call. Dry-run is the default, so
 * running it with no flag can only print.
 *
 * DreamEngine is untouched: this reads and deletes maintenance queue rows only.
 * No promote, demote, archive, or tier mutation, and no dream planning path.
 */
import pg from "pg";

const CANARY_KEY_PREFIX = "canary:";

interface CanaryRow {
  id: string;
  job_kind: string;
  state: string;
  attempts: number;
  idempotency_key: string;
  last_error_category: string | null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const pool = new pg.Pool({
    host: process.env.DB_HOST ?? process.env.PGHOST ?? "127.0.0.1",
    port: Number.parseInt(
      process.env.DB_PORT ?? process.env.PGPORT ?? "5432",
      10,
    ),
    database: process.env.DB_NAME ?? process.env.PGDATABASE,
    user: process.env.DB_USER ?? process.env.PGUSER,
    ...(process.env.DB_PASSWORD ? { password: process.env.DB_PASSWORD } : {}),
  });

  try {
    const { rows } = await pool.query<CanaryRow>(
      `SELECT id, job_kind, state, attempts, idempotency_key,
              last_error_category
         FROM maintenance_jobs
        WHERE idempotency_key LIKE $1
        ORDER BY created_at`,
      [`${CANARY_KEY_PREFIX}%`],
    );

    if (rows.length === 0) {
      console.log("no canary jobs found; nothing to retire");
      return;
    }

    // Content-free reporting: kinds, states, counts, and the key. The key is an
    // operator-authored label, never payload content.
    for (const row of rows) {
      console.log(
        `${row.idempotency_key}  kind=${row.job_kind} state=${row.state} ` +
          `attempts=${row.attempts} category=${row.last_error_category ?? "-"}`,
      );
    }

    const retirable = rows.filter((row) => row.state === "dead_letter");
    const live = rows.filter((row) => row.state !== "dead_letter");
    for (const row of live) {
      console.log(
        `SKIP ${row.idempotency_key}: state=${row.state} is not dead_letter; ` +
          `not this script's call to retire`,
      );
    }

    if (retirable.length === 0) {
      console.log("no dead-lettered canary jobs; nothing to retire");
      return;
    }

    if (!apply) {
      console.log(
        `\nDRY RUN: ${retirable.length} dead-lettered canary job(s) would be ` +
          `deleted. Re-run with --apply to retire them.`,
      );
      return;
    }

    const { rowCount } = await pool.query(
      `DELETE FROM maintenance_jobs
        WHERE idempotency_key LIKE $1
          AND state = 'dead_letter'`,
      [`${CANARY_KEY_PREFIX}%`],
    );
    console.log(`\nretired ${rowCount ?? 0} dead-lettered canary job(s)`);
  } finally {
    await pool.end();
  }
}

await main();
