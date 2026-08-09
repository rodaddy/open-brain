/**
 * Deploy/backup mutual exclusion (issue #677, cutover blocker B4).
 *
 * WHY THIS EXISTS
 * ---------------
 * `docs/backup-restore.md` records that a dump taken mid-migration can capture
 * a half-applied schema whose `_migrations` rows do not describe it, and that
 * "verify cannot detect this from the outside". That is the dangerous case:
 * not a missing backup, but a backup that PASSES verification and is silently
 * unrestorable. Scheduling backups without this guard would make blocker B4
 * subtler rather than smaller — an unattended 04:00 job that happens to land
 * during a deploy produces exactly that artifact.
 *
 * THE MECHANISM
 * -------------
 * A Postgres SESSION-SCOPED ADVISORY LOCK on the database both operations
 * touch. This is not a new mechanism: `server/db/migrations.ts:65` already
 * serializes migrations with `pg_advisory_lock(hashtext(...))`, and this
 * follows that convention with a distinct key.
 *
 * Advisory locks are the right primitive here rather than a lock FILE because:
 *  - the deploy runs as a shell script and the backup as a bun process, under
 *    launchd, potentially as different working directories — they share a
 *    database, not a filesystem convention;
 *  - the lock is released automatically when the holding session ends, so a
 *    deploy that is killed mid-run cannot wedge backups forever. A stale lock
 *    file has to be reasoned about; a dead connection's lock simply does not
 *    exist.
 *
 * WHO WAITS AND WHO REFUSES — deliberately asymmetric:
 *  - The DEPLOY blocks (bounded) to take the lock. A deploy is operator- or
 *    CI-initiated and someone is watching it; making it wait a few seconds for
 *    a backup to finish is correct, and a deploy that refused would be a new
 *    failure mode on the path that matters most.
 *  - The BACKUP refuses immediately (`pg_try_advisory_lock`) and exits
 *    non-zero. It is an unattended scheduled job; the right behavior when a
 *    deploy is in flight is to skip this run and let the next scheduled one
 *    take a clean dump. Blocking would hold a connection open against a
 *    database being migrated, which is the thing being avoided.
 *
 * The refusal NAMES the deploy, because a refusal that does not tell the
 * operator what to reconcile is a dead end (docs/lane-contract.md, round 15).
 */
import type pg from "pg";

/**
 * The advisory-lock key expression. Namespaced by database name so two
 * databases on one server never serialize against each other, and suffixed
 * distinctly from the migrations lock (`:openbrain-migrations`) so a deploy's
 * own migration step cannot deadlock against the deploy lock it already holds.
 */
export const DEPLOY_LOCK_KEY_SQL =
  "hashtext(current_database() || ':openbrain-deploy')";

/** Exit code used when a backup refuses because a deploy is in flight. */
export const EXIT_DEPLOY_IN_PROGRESS = 4;

export const DEPLOY_IN_PROGRESS_MESSAGE =
  "REFUSED: a deploy is in progress on this database (the openbrain-deploy " +
  "advisory lock is held), so a dump taken now could capture a half-applied " +
  "schema that backup-verify cannot detect from the outside. No backup was " +
  "written. Re-run this backup after the deploy completes, or wait for the " +
  "next scheduled run.";

export interface LockQueryable {
  query(sql: string): Promise<{ rows: unknown[] }>;
}

/**
 * Try to take the deploy lock WITHOUT waiting. Returns true when acquired.
 *
 * Used by the backup path in the negative direction: if this returns false,
 * something else (a deploy) holds it.
 */
export async function tryAcquireDeployLock(
  client: LockQueryable,
): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT pg_try_advisory_lock(${DEPLOY_LOCK_KEY_SQL}) AS acquired`,
  );
  const row = rows[0] as { acquired?: boolean } | undefined;
  return row?.acquired === true;
}

/** Release a previously acquired deploy lock held by THIS session. */
export async function releaseDeployLock(client: LockQueryable): Promise<void> {
  await client.query(`SELECT pg_advisory_unlock(${DEPLOY_LOCK_KEY_SQL})`);
}

/**
 * Assert that no deploy is in flight, from the backup side.
 *
 * Implemented as take-and-release rather than a read of `pg_locks`: a read is
 * a race (the lock can be taken in the window between the read and the dump),
 * and more importantly `pg_locks` reports advisory locks by a split
 * classid/objid pair that is awkward to match reliably. Taking the lock is the
 * only reading that is true at the moment it is taken.
 *
 * The lock is released immediately rather than held for the dump's duration.
 * That is a deliberate, narrow choice and worth stating plainly: it closes the
 * overlap window at the START of the backup (a deploy already running is
 * detected), and the deploy side's own bounded WAIT closes the other direction
 * (a deploy that starts mid-dump waits for the backup to finish rather than
 * migrating underneath it). Holding it across the whole dump would be
 * stronger, but the dump runs on a separate pooled connection from a
 * REPEATABLE READ snapshot, and coupling a long-lived lock to that pool's
 * lifetime risks a backup failure leaving the lock held for the pool's idle
 * timeout — trading a rare corrupt dump for a recurring blocked deploy.
 *
 * @throws when a deploy holds the lock. The thrown message names the cause.
 */
export async function assertNoDeployInProgress(
  client: LockQueryable,
): Promise<void> {
  const acquired = await tryAcquireDeployLock(client);
  if (!acquired) {
    throw new DeployInProgressError(DEPLOY_IN_PROGRESS_MESSAGE);
  }
  await releaseDeployLock(client);
}

export class DeployInProgressError extends Error {
  readonly exitCode = EXIT_DEPLOY_IN_PROGRESS;
  constructor(message: string) {
    super(message);
    this.name = "DeployInProgressError";
  }
}

/**
 * CLI entry point used by the DEPLOY side (scripts/core01-deploy-local.sh).
 *
 * Takes the lock and holds it for as long as this process lives, so the shell
 * script can hold it across staging + migrate + swap simply by keeping this
 * process alive. It waits (bounded) rather than refusing, per the asymmetry
 * documented above.
 *
 *   bun run scripts/deploy-lock.ts --hold [--timeout-seconds N]
 *
 * Prints READY on stdout once the lock is held, then blocks until killed.
 */
async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  let hold = false;
  let timeoutSeconds = 900;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--hold") hold = true;
    else if (arg === "--timeout-seconds") {
      const parsed = Number(argv[++i]);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        console.error("--timeout-seconds requires a positive number");
        process.exit(2);
      }
      timeoutSeconds = parsed;
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  if (!hold) {
    console.error(
      "Usage: bun run scripts/deploy-lock.ts --hold [--timeout-seconds N]",
    );
    process.exit(2);
  }

  const { createPool } = await import("../src/db/pool.ts");
  const pool = createPool({ max: 1, application_name: "openbrain-deploy-lock" });
  const client = await pool.connect();
  // Bounded wait: a deploy should queue behind a running backup, but it must
  // not hang forever if something is wedged. lock_timeout makes the WAIT
  // bounded server-side; without it a stuck holder blocks the deploy silently.
  await client.query(`SET lock_timeout = '${Math.floor(timeoutSeconds)}s'`);
  try {
    await client.query(`SELECT pg_advisory_lock(${DEPLOY_LOCK_KEY_SQL})`);
  } catch (err) {
    console.error(
      "FATAL: could not acquire the openbrain-deploy lock within " +
        `${timeoutSeconds}s — a backup or another deploy is holding it. ` +
        (err instanceof Error ? err.message : String(err)),
    );
    process.exit(1);
  }
  console.log("READY");
  // Hold until killed. The lock is session-scoped, so process death releases
  // it — there is no stale-lock cleanup path to get wrong.
  await new Promise<void>(() => {});
}

if (import.meta.main) {
  await main();
}
