import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { Client } from "pg";

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;

const migration030Url = new URL("030_source_sync.sql", import.meta.url);
const migration031Url = new URL(
  "031_source_sync_runs_running_only_unique.sql",
  import.meta.url,
);

// Fixed, code-owned identifier for the isolated test schema so this file never
// disturbs the shared ob_source_sync_runs table while Bun runs test files in
// parallel. Chosen once, never derived from anything mutable.
const TEST_SCHEMA = "ob_test_mig031_running_only";
const TEST_SCHEMA_LOCK = 31_031;

// The exact name Postgres generates for an inline `UNIQUE (source_id,
// observation_hash)` table constraint on ob_source_sync_runs. An earlier
// revision of migration 030 declared uniqueness that way; a database upgraded
// across it carries this PERMANENT (all-status) constraint forward, which is the
// defect 031 repairs.
const LEGACY_CONSTRAINT = "ob_source_sync_runs_source_id_observation_hash_key";
const RUNNING_INDEX = "idx_ob_source_sync_runs_running_obs";

const H = (n: number): string => n.toString(16).padStart(64, "0");

// Drift guard — runs without a database. Proves 031 targets the exact legacy
// constraint by name (no broad dynamic drop) and re-establishes the SAME
// running-only partial unique index the corrected 030 defines, so the two
// upgrade paths converge on one schema.
describe("031 targets the exact legacy constraint and restores the partial index", () => {
  it("drops the legacy constraint by its exact generated name", async () => {
    const sql = await Bun.file(migration031Url).text();
    expect(sql).toContain(`DROP CONSTRAINT IF EXISTS ${LEGACY_CONSTRAINT}`);
  });

  it("recreates the running-only partial unique index identical to corrected 030", async () => {
    const sql031 = await Bun.file(migration031Url).text();
    const sql030 = await Bun.file(migration030Url).text();

    // The corrected 030 must already define the partial running-only index; 031
    // must recreate the identical one so fresh and upgraded DBs converge.
    const indexBody =
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_ob_source_sync_runs_running_obs\s+ON ob_source_sync_runs \(source_id, observation_hash\)\s+WHERE status = 'running'/;
    expect(sql030).toMatch(indexBody);
    expect(sql031).toMatch(indexBody);
  });

  it("does not use broad dynamic constraint discovery", async () => {
    const sql = await Bun.file(migration031Url).text();
    // No catalog scan / dynamic DROP over pg_constraint — the drop is by exact
    // known name only.
    expect(sql).not.toMatch(/pg_constraint/i);
    expect(sql).not.toMatch(/EXECUTE\s/i);
  });
});

dbDescribe(
  "031 ob_source_sync_runs running-only uniqueness compat (live Postgres)",
  () => {
    const client = new Client({ connectionString: DB_URL });

    async function applyMigration030(): Promise<void> {
      await client.query(await Bun.file(migration030Url).text());
    }

    async function applyMigration031(): Promise<void> {
      await client.query(await Bun.file(migration031Url).text());
    }

    // Rewind the schema to the shape a database that applied an EARLIER revision
    // of 030 carries forward: the permanent all-status UNIQUE constraint present,
    // the running-only partial index absent. Models the real upgrade path (like
    // 028/029's installers) rather than the fresh-DB path.
    async function installLegacyPermanentConstraint(): Promise<void> {
      await client.query(`DROP INDEX IF EXISTS ${RUNNING_INDEX}`);
      await client.query(
        `ALTER TABLE ob_source_sync_runs
           DROP CONSTRAINT IF EXISTS ${LEGACY_CONSTRAINT}`,
      );
      await client.query(
        `ALTER TABLE ob_source_sync_runs
           ADD CONSTRAINT ${LEGACY_CONSTRAINT}
           UNIQUE (source_id, observation_hash)`,
      );
    }

    async function constraintExists(name: string): Promise<boolean> {
      const { rows } = await client.query(
        `SELECT 1 FROM pg_constraint
          WHERE conrelid = 'ob_source_sync_runs'::regclass AND conname = $1`,
        [name],
      );
      return rows.length > 0;
    }

    async function indexExists(name: string): Promise<boolean> {
      const { rows } = await client.query(
        `SELECT 1 FROM pg_indexes
          WHERE tablename = 'ob_source_sync_runs' AND indexname = $1`,
        [name],
      );
      return rows.length > 0;
    }

    // Insert a sync run with the given observation_hash and status. A minimal
    // synthetic source_id is enough: the FK to ob_sources is dropped in this
    // isolated schema (no ob_sources table here), so uniqueness is exercised in
    // isolation from the registry.
    async function insertRun(
      sourceId: string,
      obsHash: string,
      status: "running" | "completed",
    ): Promise<void> {
      await client.query(
        `INSERT INTO ob_source_sync_runs
           (source_id, namespace, observation_hash, status)
         VALUES ($1, $2, $3, $4)`,
        [sourceId, "test-migration-031", obsHash, status],
      );
    }

    const SOURCE_ID = "11111111-1111-1111-1111-111111111111";

    beforeAll(async () => {
      await client.connect();
      await client.query("SELECT pg_advisory_lock($1)", [TEST_SCHEMA_LOCK]);
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      // 030 reuses the shared updated_at trigger function from 001_init.sql;
      // provide it in the isolated schema so the CREATE TRIGGER in 030 resolves.
      await client.query(
        `CREATE OR REPLACE FUNCTION ${TEST_SCHEMA}.update_updated_at()
         RETURNS TRIGGER AS $$
         BEGIN
           NEW.updated_at = NOW();
           RETURN NEW;
         END;
         $$ LANGUAGE plpgsql`,
      );
    });

    beforeEach(async () => {
      // Rebuild the tables 030 owns from scratch each test, then rewind to the
      // legacy permanent-constraint shape. gen_random_uuid() is a core function
      // in Postgres 18, so no pgcrypto is required for the UUID defaults.
      await client.query(`DROP TABLE IF EXISTS ob_source_sync_runs CASCADE`);
      await client.query(`DROP TABLE IF EXISTS ob_source_files CASCADE`);
      // ob_source_sync_runs FK-references ob_sources (id); in this isolated
      // schema there is no registry, so strip the FK from the 030 body before
      // applying it. Uniqueness — the only thing under test — is untouched.
      const sql030 = (await Bun.file(migration030Url).text()).replace(
        /REFERENCES ob_sources \(id\) ON DELETE CASCADE/g,
        "",
      );
      await client.query(sql030);
      await installLegacyPermanentConstraint();
    });

    afterAll(async () => {
      try {
        await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      } finally {
        try {
          await client.query("SELECT pg_advisory_unlock($1)", [
            TEST_SCHEMA_LOCK,
          ]);
        } finally {
          await client.end();
        }
      }
    });

    it("before 031: the legacy permanent constraint rejects two completed runs sharing an observation", async () => {
      expect(await constraintExists(LEGACY_CONSTRAINT)).toBe(true);
      await insertRun(SOURCE_ID, H(1), "completed");
      // The all-status constraint blocks a second row with the same
      // (source_id, observation_hash), even though both are terminal history.
      await expect(insertRun(SOURCE_ID, H(1), "completed")).rejects.toThrow(
        /unique/i,
      );
    });

    it("after 031: the legacy constraint is gone and the running-only partial index exists", async () => {
      await applyMigration031();

      expect(await constraintExists(LEGACY_CONSTRAINT)).toBe(false);
      expect(await indexExists(RUNNING_INDEX)).toBe(true);
    });

    it("after 031: two completed runs with the SAME observation coexist (repeated / A->B->A revert)", async () => {
      await applyMigration031();

      await insertRun(SOURCE_ID, H(2), "completed");
      // A repeated observation and the A->B->A revert both plan a fresh run whose
      // hash equals a completed history row's; that must be allowed now.
      await insertRun(SOURCE_ID, H(2), "completed");

      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM ob_source_sync_runs
          WHERE source_id = $1 AND observation_hash = $2 AND status = 'completed'`,
        [SOURCE_ID, H(2)],
      );
      expect(rows[0].n).toBe(2);
    });

    it("after 031: the running-only index still forbids two RUNNING runs for one observation", async () => {
      await applyMigration031();

      await insertRun(SOURCE_ID, H(3), "running");
      // Concurrent planners must still converge on ONE running row.
      await expect(insertRun(SOURCE_ID, H(3), "running")).rejects.toThrow(
        /unique/i,
      );

      // ...but a completed history row for that same observation never blocks it.
      await client.query(
        `UPDATE ob_source_sync_runs SET status = 'completed'
          WHERE source_id = $1 AND observation_hash = $2`,
        [SOURCE_ID, H(3)],
      );
      await insertRun(SOURCE_ID, H(3), "running");
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM ob_source_sync_runs
          WHERE source_id = $1 AND observation_hash = $2 AND status = 'running'`,
        [SOURCE_ID, H(3)],
      );
      expect(rows[0].n).toBe(1);
    });

    it("is idempotent — re-running 031 leaves the schema at the same converged shape", async () => {
      await applyMigration031();
      await applyMigration031();

      expect(await constraintExists(LEGACY_CONSTRAINT)).toBe(false);
      expect(await indexExists(RUNNING_INDEX)).toBe(true);

      await insertRun(SOURCE_ID, H(4), "completed");
      await insertRun(SOURCE_ID, H(4), "completed");
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM ob_source_sync_runs
          WHERE source_id = $1 AND observation_hash = $2`,
        [SOURCE_ID, H(4)],
      );
      expect(rows[0].n).toBe(2);
    });

    it("harmless on a fresh corrected-030 database (no legacy constraint to drop)", async () => {
      // Simulate the fresh path: corrected 030 already produced the partial
      // index and never had the permanent constraint.
      await client.query(
        `ALTER TABLE ob_source_sync_runs
           DROP CONSTRAINT IF EXISTS ${LEGACY_CONSTRAINT}`,
      );
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${RUNNING_INDEX}
           ON ob_source_sync_runs (source_id, observation_hash)
           WHERE status = 'running'`,
      );

      // 031 must be a clean no-op here.
      await applyMigration031();

      expect(await constraintExists(LEGACY_CONSTRAINT)).toBe(false);
      expect(await indexExists(RUNNING_INDEX)).toBe(true);
      await insertRun(SOURCE_ID, H(5), "completed");
      await insertRun(SOURCE_ID, H(5), "completed");
    });
  },
);
