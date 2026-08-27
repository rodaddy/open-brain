/**
 * The Postgres test database, demanded rather than hoped for.
 *
 * Operator ruling 2026-08-27 (issue #878): a `.pg.test.ts` file always runs
 * against a real test database. Absent `OPENBRAIN_TEST_DATABASE_URL` it fails
 * hard -- it does NOT downgrade itself to `describe.skip`.
 *
 * A suite that skips itself reports `0 pass, N skip, 0 fail` and exits 0, which
 * is indistinguishable at the exit code from a suite that ran and passed. That
 * is the false green: CI stays green while the Postgres behavior nobody is
 * exercising drifts underneath it. Throwing a named error converts a silent
 * non-run into a loud one, and `test_database_required` is the string to search
 * for when it fires.
 *
 * This module lives under `scripts/` deliberately. `.oxlintrc.json` scopes
 * `node/no-process-env` to `server/**\/*.ts`; `scripts/**` carries only a
 * `no-console` relaxation, so the environment read belongs here rather than
 * beside the tests it serves.
 */

/**
 * Returns the test database connection string, or throws when it is unset.
 *
 * @throws {Error} `test_database_required` when the variable is missing or empty.
 */
export function requireTestDatabaseUrl(): string {
  const url = process.env.OPENBRAIN_TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "test_database_required: OPENBRAIN_TEST_DATABASE_URL is unset; run bun run test:isolated",
    );
  }
  return url;
}
