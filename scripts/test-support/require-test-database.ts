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
      "test_database_required: OPENBRAIN_TEST_DATABASE_URL is unset; run npm run test:isolated",
    );
  }
  return url;
}

/**
 * Returns the local-clone test database connection string, or throws when unset.
 *
 * The local-clone boundary suite reaches a real loopback clone, which is a
 * different database from the migrated test one -- issue #904 gives it the same
 * demand-do-not-hope treatment `requireTestDatabaseUrl` gives `.pg.test.ts`.
 *
 * @throws {Error} `test_database_required` when the variable is missing or empty.
 */
export function requireLocalCloneTestDatabaseUrl(): string {
  const url = process.env.OPENBRAIN_LOCAL_CLONE_TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "test_database_required: OPENBRAIN_LOCAL_CLONE_TEST_DATABASE_URL is unset; run npm run test:isolated",
    );
  }
  return url;
}

/**
 * Returns the scratch admin connection string, or throws when it is unset.
 *
 * The retire-collab suite builds and drops its own scratch databases from the
 * real migrations, so it needs an owner/superuser connection rather than the
 * migrated test database.
 *
 * @throws {Error} `test_database_required` when the variable is missing or empty.
 */
export function requireScratchAdminUrl(): string {
  const url = process.env.OPENBRAIN_SCRATCH_ADMIN_URL;
  if (!url) {
    throw new Error(
      "test_database_required: OPENBRAIN_SCRATCH_ADMIN_URL is unset; run npm run test:isolated",
    );
  }
  return url;
}

/**
 * Whether a golden-fixture suite should REWRITE its fixture instead of asserting.
 *
 * Read here rather than in the test that uses it for the same reason the
 * database URLs are: `.oxlintrc.json` bans `process.env` under `server/**`, and
 * `scripts/**` is where this repo puts the environment reads its tests need.
 *
 * Capture mode is deliberately opt-in and deliberately loud in its naming. A
 * golden file exists to be compared against; a suite that silently refreshed it
 * on mismatch would report green while asserting nothing, which is precisely the
 * failure the fixture was written to catch.
 *
 * @returns True only when `GOLDEN_WRITE` is exactly `"1"`.
 */
export function goldenWriteMode(): boolean {
  return process.env.GOLDEN_WRITE === "1";
}

/**
 * Returns the connection string for the DOGFOOD CORPUS, demanded rather than
 * hoped for.
 *
 * The recall fixture suite (`eval/recall/fixtures.test.ts`) is the odd one out
 * among this repo's Postgres tests: it asserts that rows which ALREADY EXIST
 * still do. `npm run test:isolated` deliberately hands every suite a FRESH
 * migrated database, so the corpus lookups cannot use
 * `OPENBRAIN_TEST_DATABASE_URL` -- against an empty schema all 32 resolve to
 * zero rows and report a fixture defect that is really an environment
 * mismatch.
 *
 * WHERE THE CONNECTION FACTS COME FROM. `.env` at the repo root carries the
 * standard libpq variables (`PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER`). Node and
 * Vitest do not auto-load that file: `scripts/test-isolated.ts` reads it for
 * isolated-database provisioning, while this dogfood-only suite needs either
 * `OPENBRAIN_RECALL_CORPUS_URL` or `PGDATABASE` exported by its caller.
 *
 * An explicit `OPENBRAIN_RECALL_CORPUS_URL` still wins when it is set, for
 * pointing the suite at a corpus other than the one `.env` names.
 *
 * There is no skip path here, by #878: a suite that skips itself reports
 * `0 fail` and exits 0, which is indistinguishable from one that ran. When
 * neither route yields a database name this throws `recall_corpus_required`
 * and the suite fails loudly.
 *
 * The suite only ever SELECTs through this connection.
 *
 * @returns The corpus connection string.
 * @throws {Error} `recall_corpus_required` when no corpus database can be resolved.
 */
export function requireRecallCorpusUrl(): string {
  const explicit = process.env.OPENBRAIN_RECALL_CORPUS_URL;
  if (explicit) {
    return explicit;
  }
  const database = process.env.PGDATABASE;
  if (!database) {
    throw new Error(
      "recall_corpus_required: neither OPENBRAIN_RECALL_CORPUS_URL nor PGDATABASE is set; " +
        "the recall fixture suite needs the dogfood corpus, which .env at the repo root names",
    );
  }
  const host = process.env.PGHOST ?? "127.0.0.1";
  const port = process.env.PGPORT ?? "5432";
  const user = process.env.PGUSER;
  const credentials = user ? `${encodeURIComponent(user)}@` : "";
  return `postgres://${credentials}${host}:${port}/${encodeURIComponent(database)}`;
}
