/**
 * Refuses to let the DREAM route scripts write `dream_run_NNN` schemas into
 * the live dogfood database unless the operator passes `--allow-live-db`
 * (issue 1501).
 */

/** Databases the DREAM route scripts must not write into without opt-in. */
export const LIVE_DATABASE_NAMES: readonly string[] = ["open_brain_local_20260724"];

/** The CLI flag that overrides the refusal. */
export const ALLOW_LIVE_DB_FLAG = "--allow-live-db";

/**
 * The database name `scripts/settings.ts` `createPool` connects to.
 *
 * @param env - The process environment.
 * @returns `DB_NAME`, or the same `open_brain` default `createPool` uses.
 */
export function resolvedDatabaseName(env: NodeJS.ProcessEnv): string {
  return env.DB_NAME || "open_brain";
}

/**
 * Throws when the target database is live and the operator did not opt in.
 *
 * @param input - The resolved database name and whether `--allow-live-db` was passed.
 * @throws {Error} When `databaseName` is live and `allowLive` is false.
 */
export function assertNotLiveDatabase(input: {
  databaseName: string;
  allowLive: boolean;
}): void {
  if (input.allowLive) return;
  if (LIVE_DATABASE_NAMES.includes(input.databaseName)) {
    throw new Error(
      `refusing to write dream_run schemas into the live database ${input.databaseName}; ` +
        `pass ${ALLOW_LIVE_DB_FLAG} to override`,
    );
  }
}
