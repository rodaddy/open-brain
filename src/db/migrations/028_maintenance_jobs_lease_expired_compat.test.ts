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
const migration026Url = new URL("026_maintenance_queue.sql", import.meta.url);
const migration028Url = new URL(
  "028_maintenance_jobs_lease_expired_compat.sql",
  import.meta.url,
);
const namespace = "test-migration-028-lease-compat";

// Fixed, code-owned identifier for the isolated test schema. Migration 026/028
// SQL is applied verbatim here (never against public) so this file cannot
// disturb the shared maintenance_jobs table while Bun runs test files in
// parallel. Chosen once, never derived from anything mutable.
const TEST_SCHEMA = "ob_test_mig028_lease_compat";

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

// Narrowly extract the last_error_category CHECK allow-list from a migration's
// SQL text. This is a targeted regex over the exact shape both migrations use —
// `last_error_category IN ( 'a', 'b', ... )` — not a general SQL parser. It
// backs the drift guard so a future addition to 026's set that is not mirrored
// into 028 fails loudly.
function extractLastErrorCategorySet(sql: string): Set<string> {
  const match = sql.match(
    /last_error_category\s+(?:TEXT\s+)?(?:CHECK\s*\()?\s*IN\s*\(([^)]*)\)/i,
  );
  if (!match) {
    throw new Error(
      "could not locate a `last_error_category IN (...)` list in the migration SQL",
    );
  }
  const values = [...match[1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
  if (values.length === 0) {
    throw new Error(
      "found a `last_error_category IN (...)` list but it contained no quoted values",
    );
  }
  return new Set(values);
}

// Drift guard — runs without a database. Proves migration 028's repaired CHECK
// accepts exactly the set migration 026 currently defines, so a future value
// added to 026 cannot silently be omitted from the 028 upgrade repair.
describe("028 / 026 last_error_category allow-lists stay in sync", () => {
  it("028's repaired accepted-value set equals 026's current accepted-value set", async () => {
    const set026 = extractLastErrorCategorySet(
      await Bun.file(migration026Url).text(),
    );
    const set028 = extractLastErrorCategorySet(
      await Bun.file(migration028Url).text(),
    );
    // Compare as sorted arrays for a readable diff on failure.
    expect([...set028].sort()).toEqual([...set026].sort());
  });
});

dbDescribe("028 maintenance_jobs lease_expired compat (live Postgres)", () => {
  // A dedicated Client (not a Pool) so the schema-scoping search_path set once
  // at connect time holds for every query in this file. A Pool hands out
  // arbitrary connections, which would let a query leak back to public.
  const client = new Client({ connectionString: DB_URL });

  async function applyMigration026(): Promise<void> {
    await client.query(await Bun.file(migration026Url).text());
  }

  async function applyMigration028(): Promise<void> {
    await client.query(await Bun.file(migration028Url).text());
  }

  async function cleanup(): Promise<void> {
    await client.query("DELETE FROM maintenance_jobs WHERE namespace = $1", [
      namespace,
    ]);
  }

  // Rewind the persisted constraint to the shape a database that applied an
  // earlier revision of 026 (before 'lease_expired') carries forward, so the
  // regression proves the real upgrade path rather than the fresh-DB path.
  // Scoped to the test schema by search_path — public is never touched.
  async function installPreLeaseExpiredConstraint(): Promise<void> {
    // A CHECK constraint definition is DDL and cannot be parameterized, so the
    // fixture list is inlined from the const above (SQL string literals).
    const inList = PRE_LEASE_EXPIRED_CATEGORIES.map((c) => `'${c}'`).join(", ");
    await client.query(
      `ALTER TABLE maintenance_jobs DROP CONSTRAINT IF EXISTS ${CONSTRAINT_NAME}`,
    );
    await client.query(
      `ALTER TABLE maintenance_jobs
         ADD CONSTRAINT ${CONSTRAINT_NAME}
         CHECK (last_error_category IN (${inList}))`,
    );
  }

  async function insertWithCategory(
    idempotencyKey: string,
    category: string | null,
  ): Promise<void> {
    await client.query(
      `INSERT INTO maintenance_jobs
         (job_kind, job_version, idempotency_key, namespace, last_error_category)
       VALUES ($1, 1, $2, $3, $4)`,
      ["maintenance.test", idempotencyKey, namespace, category],
    );
  }

  beforeAll(async () => {
    await client.connect();
    // Own an isolated schema. Everything below runs against it via search_path,
    // so migration 026/028 SQL exercises the exact real DDL without mutating
    // public.maintenance_jobs (which parallel test files may depend on). public
    // stays on the path only so core resolution (e.g. gen_random_uuid) works;
    // maintenance_jobs resolves to the test schema because it is listed first.
    await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
    // Migration 026 creates a trigger that calls update_updated_at(); provide
    // it inside the isolated schema so 026 applies self-contained, without
    // depending on the full base migration chain (which needs pgvector).
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
    // Ensure the table exists (idempotent), then model an upgraded database.
    await applyMigration026();
    await cleanup();
    await installPreLeaseExpiredConstraint();
  });

  afterAll(async () => {
    // Drop the whole test-owned schema; public was never modified.
    await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await client.end();
  });

  it("rejects lease_expired before the migration and accepts it after — proving the upgrade repair", async () => {
    // Precondition: the upgrade-path defect is real on the old constraint.
    await expect(
      insertWithCategory("028-before", "lease_expired"),
    ).rejects.toThrow(/last_error_category/);

    await applyMigration028();

    // After the repair, the queue's dead-letter category is accepted.
    await insertWithCategory("028-after", "lease_expired");
    const { rows } = await client.query(
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

    const { rows } = await client.query(
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
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM maintenance_jobs
        WHERE namespace = $1 AND idempotency_key = $2`,
      [namespace, "028-idempotent"],
    );
    expect(rows[0].n).toBe(1);
  });
});
