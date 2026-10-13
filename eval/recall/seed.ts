/**
 * Per-run scaffolding for a recall evaluation, under the disposable-run
 * protocol in `docs/dream-ethereal-runs.md`.
 *
 * WHY A SCHEMA PER RUN. A recall eval reads the real dogfood corpus and must
 * leave it byte-identical: the fixtures in `fixtures.json` name live row ids,
 * so a run that mutated `public` would invalidate the very rows the next run
 * asserts against. The protocol's answer is that a run owns exactly one
 * schema, `dream_run_NNN`, writes only inside it, and is torn down with a
 * single `DROP SCHEMA ... CASCADE`. Every row still carries `run_id` so a
 * schema that outlives its teardown is still attributable.
 *
 * THIS MODULE NEVER WRITES TO `public`. Its only unqualified statements are
 * DDL and DML against `${schemaName}.*`, which is derived from the run id and
 * validated below. `scripts/done-means/1412-recall-fixtures.sh` clause (f)
 * enforces that mechanically, so a future edit that reaches for a bare table
 * name fails the check rather than the corpus.
 *
 * Schemas `dream_run_001` through `dream_run_004` belong to earlier runs and
 * are not this module's to touch. The named reserved set below enforces that
 * ownership rule both when an identity is constructed and at every SQL
 * boundary, including teardown.
 */
import type { Pool } from "pg";

/** A run's identity: the zero-padded number that names its schema. */
export interface RunIdentity {
  /** The three-digit run number, e.g. `"005"`. */
  readonly runId: string;
  /** The schema the run owns, e.g. `"dream_run_005"`. */
  readonly schemaName: string;
}

/** What a run records about itself before it starts scoring fixtures. */
export interface ManifestEntry {
  /** sha256 of the fixture file the run was scored against. */
  readonly fixturesSha256: string;
  /** How many fixtures that file held. */
  readonly fixtureCount: number;
  /** Free text: what this run was for, what varied from the last one. */
  readonly note: string;
}

/** One fixture's outcome, as the run observed it. */
export interface FixtureResult {
  /** The fixture's `id` from `fixtures.json`. */
  readonly fixtureId: string;
  /** Rank of the first label-2 row, or null when it was not returned at all. */
  readonly firstRelevantRank: number | null;
  /** How many rows the retrieval call returned. */
  readonly returnedCount: number;
  /** True when an isolation fixture saw one of its forbidden rows. */
  readonly isolationBreach: boolean;
  /** Free text: what the run wants a human to see about this fixture. */
  readonly detail: string;
}

const RUN_ID_PATTERN = /^\d{3}$/u;
const RESERVED_RUN_IDS = new Set(["001", "002", "003", "004"]);

/**
 * Derives a run identity from a run number.
 *
 * @param runNumber - The run's number; 5 or greater, since 1-4 are taken.
 * @returns The zero-padded run id and the schema name it owns.
 * @throws {Error} `invalid_run_number` when the number is out of range.
 * @throws {Error} `reserved_run_number` when the number belongs to an earlier run.
 */
export function runIdentity(runNumber: number): RunIdentity {
  if (!Number.isInteger(runNumber) || runNumber < 1 || runNumber > 999) {
    throw new Error(
      `invalid_run_number: ${String(runNumber)} is not an integer in 1..999`,
    );
  }
  const runId = String(runNumber).padStart(3, "0");
  if (RESERVED_RUN_IDS.has(runId)) {
    throw new Error(
      `reserved_run_number: ${String(runNumber)} belongs to an earlier run`,
    );
  }
  return { runId, schemaName: `dream_run_${runId}` };
}

/**
 * Rejects any identity whose schema name is not exactly `dream_run_NNN`.
 *
 * The schema name is the one identifier this module interpolates into SQL,
 * because Postgres does not accept a bound parameter in a DDL position. This
 * is the allowlist that makes that interpolation safe, and it is re-asserted
 * at every call site rather than trusted from construction.
 *
 * @param identity - The run identity to validate.
 * @returns The same identity, once proven well-formed.
 * @throws {Error} `invalid_run_id` when the run id is not three digits.
 */
function assertSafeIdentity(identity: RunIdentity): RunIdentity {
  if (!RUN_ID_PATTERN.test(identity.runId)) {
    throw new Error(`invalid_run_id: ${identity.runId} is not three digits`);
  }
  if (identity.schemaName !== `dream_run_${identity.runId}`) {
    throw new Error(
      `invalid_run_id: schema ${identity.schemaName} does not match run ${identity.runId}`,
    );
  }
  if (RESERVED_RUN_IDS.has(identity.runId)) {
    throw new Error(`reserved_run_id: ${identity.runId} belongs to an earlier run`);
  }
  return identity;
}

/**
 * Creates the run's schema and its two tables.
 *
 * Fails rather than adopting a schema that already exists: silently reusing
 * one would mix two runs' rows under two different `run_id` values in the same
 * tables, which is exactly the ambiguity the per-run schema exists to remove.
 *
 * @param pool - A connected pool. Only `${schemaName}.*` is written.
 * @param identity - The run's identity.
 */
export async function createRunSchema(
  pool: Pool,
  identity: RunIdentity,
): Promise<void> {
  const { schemaName } = assertSafeIdentity(identity);
  await pool.query(`CREATE SCHEMA ${schemaName}`);
  await pool.query(
    `CREATE TABLE ${schemaName}.manifest (
       run_id text NOT NULL,
       fixtures_sha256 text NOT NULL,
       fixture_count integer NOT NULL,
       started_at timestamptz NOT NULL DEFAULT now(),
       ended_at timestamptz,
       note text NOT NULL DEFAULT ''
     )`,
  );
  await pool.query(
    `CREATE TABLE ${schemaName}.fixture_result (
       run_id text NOT NULL,
       fixture_id text NOT NULL,
       first_relevant_rank integer,
       returned_count integer NOT NULL,
       isolation_breach boolean NOT NULL DEFAULT false,
       detail text NOT NULL DEFAULT '',
       recorded_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

/**
 * Records the run's manifest row and stamps its start time.
 *
 * @param pool - A connected pool.
 * @param identity - The run's identity.
 * @param entry - What the run was scored against.
 */
export async function recordManifest(
  pool: Pool,
  identity: RunIdentity,
  entry: ManifestEntry,
): Promise<void> {
  const { schemaName, runId } = assertSafeIdentity(identity);
  await pool.query(
    `INSERT INTO ${schemaName}.manifest (run_id, fixtures_sha256, fixture_count, note)
     VALUES ($1, $2, $3, $4)`,
    [runId, entry.fixturesSha256, entry.fixtureCount, entry.note],
  );
}

/**
 * Stamps the manifest's end time, closing the run.
 *
 * @param pool - A connected pool.
 * @param identity - The run's identity.
 */
export async function closeManifest(pool: Pool, identity: RunIdentity): Promise<void> {
  const { schemaName, runId } = assertSafeIdentity(identity);
  await pool.query(
    `UPDATE ${schemaName}.manifest SET ended_at = now() WHERE run_id = $1`,
    [runId],
  );
}

/**
 * Records one fixture's outcome inside the run's own schema.
 *
 * @param pool - A connected pool.
 * @param identity - The run's identity.
 * @param result - The observed outcome for a single fixture.
 */
export async function recordFixtureResult(
  pool: Pool,
  identity: RunIdentity,
  result: FixtureResult,
): Promise<void> {
  const { schemaName, runId } = assertSafeIdentity(identity);
  await pool.query(
    `INSERT INTO ${schemaName}.fixture_result
       (run_id, fixture_id, first_relevant_rank, returned_count, isolation_breach, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      runId,
      result.fixtureId,
      result.firstRelevantRank,
      result.returnedCount,
      result.isolationBreach,
      result.detail,
    ],
  );
}

/**
 * Drops the run's schema and everything in it.
 *
 * `IF EXISTS` so teardown is idempotent: a run that failed before
 * `createRunSchema` still calls this on the way out, and that must not raise a
 * second error over the first.
 *
 * @param pool - A connected pool.
 * @param identity - The run's identity.
 */
export async function teardownRunSchema(
  pool: Pool,
  identity: RunIdentity,
): Promise<void> {
  const { schemaName } = assertSafeIdentity(identity);
  await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
}
