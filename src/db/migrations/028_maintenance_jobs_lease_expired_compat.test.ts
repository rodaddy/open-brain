import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Pool } from "pg";

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;
const migration026Url = new URL("026_maintenance_queue.sql", import.meta.url);
const migration028Url = new URL(
  "028_maintenance_jobs_lease_expired_compat.sql",
  import.meta.url,
);
const namespace = "test-migration-028-lease-compat";

// The canonical last_error_category allow-list minus the value that a
// database upgraded across an earlier revision of migration 026 is missing.
// Modelling the pre-'lease_expired' constraint is how we reproduce the
// upgrade-path defect: migration 026 is CREATE TABLE IF NOT EXISTS, so a
// database that already has the table keeps its stale inline CHECK.
const PRE_LEASE_EXPIRED_CATEGORIES = [
  "syntax_error",
  "type_error",
  "range_error",
  "error",
  "non_error",
  "unsupported_job_kind",
] as const;

const CONSTRAINT_NAME = "maintenance_jobs_last_error_category_check";

dbDescribe("028 maintenance_jobs lease_expired compat (live Postgres)", () => {
  const pool = new Pool({ connectionString: DB_URL });

  async function cleanup(): Promise<void> {
    await pool.query("DELETE FROM maintenance_jobs WHERE namespace = $1", [
      namespace,
    ]);
  }

  async function applyMigration026(): Promise<void> {
    await pool.query(await Bun.file(migration026Url).text());
  }

  async function applyMigration028(): Promise<void> {
    await pool.query(await Bun.file(migration028Url).text());
  }

  // Rewind the persisted constraint to the shape a database that applied an
  // earlier revision of 026 (before 'lease_expired') carries forward, so the
  // regression proves the real upgrade path rather than the fresh-DB path.
  async function installPreLeaseExpiredConstraint(): Promise<void> {
    // A CHECK constraint definition is DDL and cannot be parameterized, so the
    // fixture list is inlined from the const above (SQL string literals).
    const inList = PRE_LEASE_EXPIRED_CATEGORIES.map((c) => `'${c}'`).join(", ");
    await pool.query(
      `ALTER TABLE maintenance_jobs DROP CONSTRAINT IF EXISTS ${CONSTRAINT_NAME}`,
    );
    await pool.query(
      `ALTER TABLE maintenance_jobs
         ADD CONSTRAINT ${CONSTRAINT_NAME}
         CHECK (last_error_category IN (${inList}))`,
    );
  }

  async function insertWithCategory(
    idempotencyKey: string,
    category: string | null,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO maintenance_jobs
         (job_kind, job_version, idempotency_key, namespace, last_error_category)
       VALUES ($1, 1, $2, $3, $4)`,
      ["maintenance.test", idempotencyKey, namespace, category],
    );
  }

  beforeEach(async () => {
    // Ensure the table exists (idempotent), then model an upgraded database.
    await applyMigration026();
    await cleanup();
    await installPreLeaseExpiredConstraint();
  });
  afterAll(async () => {
    await cleanup();
    // Leave the table in the canonical (repaired) state for reuse.
    await applyMigration028();
    await pool.end();
  });

  it("rejects lease_expired before the migration and accepts it after — proving the upgrade repair", async () => {
    // Precondition: the upgrade-path defect is real on the old constraint.
    await expect(
      insertWithCategory("028-before", "lease_expired"),
    ).rejects.toThrow(/last_error_category/);

    await applyMigration028();

    // After the repair, the queue's dead-letter category is accepted.
    await insertWithCategory("028-after", "lease_expired");
    const { rows } = await pool.query(
      `SELECT last_error_category FROM maintenance_jobs
        WHERE namespace = $1 AND idempotency_key = $2`,
      [namespace, "028-after"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].last_error_category).toBe("lease_expired");
  });

  it("preserves every previously allowed category and still rejects unknown values", async () => {
    // Seed one row per pre-existing category under the old constraint so the
    // repair must validate real persisted rows, proving no data loss.
    for (const category of PRE_LEASE_EXPIRED_CATEGORIES) {
      await insertWithCategory(`028-preserve-${category}`, category);
    }
    await insertWithCategory("028-preserve-null", null);

    await applyMigration028();

    const { rows } = await pool.query(
      `SELECT idempotency_key, last_error_category FROM maintenance_jobs
        WHERE namespace = $1
        ORDER BY idempotency_key`,
      [namespace],
    );
    const persisted = new Map(
      rows.map((r) => [r.idempotency_key as string, r.last_error_category]),
    );
    for (const category of PRE_LEASE_EXPIRED_CATEGORIES) {
      expect(persisted.get(`028-preserve-${category}`)).toBe(category);
    }
    expect(persisted.get("028-preserve-null")).toBeNull();

    // The repaired constraint still enforces the allow-list.
    await expect(
      insertWithCategory("028-preserve-bogus", "not_a_real_category"),
    ).rejects.toThrow(/last_error_category/);
  });

  it("is idempotent — re-running the repair leaves the constraint intact", async () => {
    await applyMigration028();
    await applyMigration028();

    await insertWithCategory("028-idempotent", "lease_expired");
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM maintenance_jobs
        WHERE namespace = $1 AND idempotency_key = $2`,
      [namespace, "028-idempotent"],
    );
    expect(rows[0].n).toBe(1);
  });
});
