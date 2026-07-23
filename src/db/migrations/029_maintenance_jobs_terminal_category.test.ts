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
const migration029Url = new URL(
  "029_maintenance_jobs_terminal_category.sql",
  import.meta.url,
);
const namespace = "test-migration-029-terminal";

// Fixed, code-owned identifier for the isolated test schema so this file never
// disturbs the shared maintenance_jobs table while Bun runs test files in
// parallel. Chosen once, never derived from anything mutable.
const TEST_SCHEMA = "ob_test_mig029_terminal";
const TEST_SCHEMA_LOCK = 29_029;

// The canonical last_error_category allow-list minus the value a database
// upgraded across an earlier revision of 026/028 is missing: 'terminal'. This
// models the pre-'terminal' constraint so the regression reproduces the real
// upgrade-path defect the same way 028's test models the pre-'lease_expired'
// constraint.
const PRE_TERMINAL_CATEGORIES = [
  "syntax_error",
  "type_error",
  "range_error",
  "error",
  "non_error",
  "unsupported_job_kind",
  "lease_expired",
] as const;

const CONSTRAINT_NAME = "maintenance_jobs_last_error_category_check";

// Narrowly extract the last_error_category CHECK allow-list from a migration's
// SQL text — the same targeted regex the 028 test uses, not a general parser.
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

// Drift guard — runs without a database. Proves migration 029's repaired CHECK
// accepts exactly the set migration 026 currently defines, so a future value
// added to 026 cannot silently be omitted from the 029 upgrade repair.
describe("029 / 026 last_error_category allow-lists stay in sync", () => {
  it("029's repaired accepted-value set equals 026's current accepted-value set", async () => {
    const set026 = extractLastErrorCategorySet(
      await Bun.file(migration026Url).text(),
    );
    const set029 = extractLastErrorCategorySet(
      await Bun.file(migration029Url).text(),
    );
    expect([...set029].sort()).toEqual([...set026].sort());
  });

  it("026's current allow-list includes 'terminal'", async () => {
    const set026 = extractLastErrorCategorySet(
      await Bun.file(migration026Url).text(),
    );
    expect(set026.has("terminal")).toBe(true);
  });
});

dbDescribe(
  "029 maintenance_jobs terminal category compat (live Postgres)",
  () => {
    const client = new Client({ connectionString: DB_URL });

    async function applyMigration026(): Promise<void> {
      await client.query(await Bun.file(migration026Url).text());
    }

    async function applyMigration029(): Promise<void> {
      await client.query(await Bun.file(migration029Url).text());
    }

    async function cleanup(): Promise<void> {
      await client.query("DELETE FROM maintenance_jobs WHERE namespace = $1", [
        namespace,
      ]);
    }

    // Rewind the persisted constraint to the shape a database that applied an
    // earlier revision of 026/028 (before 'terminal') carries forward, so the
    // regression proves the real upgrade path rather than the fresh-DB path.
    async function installPreTerminalConstraint(): Promise<void> {
      const inList = PRE_TERMINAL_CATEGORIES.map((c) => `'${c}'`).join(", ");
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
      await client.query("SELECT pg_advisory_lock($1)", [TEST_SCHEMA_LOCK]);
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
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
      await applyMigration026();
      await cleanup();
      await installPreTerminalConstraint();
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

    it("rejects terminal before the migration and accepts it after — proving the upgrade repair", async () => {
      await expect(
        insertWithCategory("029-before", "terminal"),
      ).rejects.toThrow(/last_error_category/);

      await applyMigration029();

      await insertWithCategory("029-after", "terminal");
      const { rows } = await client.query(
        `SELECT last_error_category FROM maintenance_jobs
        WHERE namespace = $1 AND idempotency_key = $2`,
        [namespace, "029-after"],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].last_error_category).toBe("terminal");
    });

    it("preserves every previously allowed category and still rejects unknown values", async () => {
      for (const category of PRE_TERMINAL_CATEGORIES) {
        await insertWithCategory(`029-preserve-${category}`, category);
      }
      await insertWithCategory("029-preserve-null", null);

      await applyMigration029();

      const { rows } = await client.query(
        `SELECT idempotency_key, last_error_category FROM maintenance_jobs
        WHERE namespace = $1
        ORDER BY idempotency_key`,
        [namespace],
      );
      const persisted = new Map(
        rows.map((r) => [r.idempotency_key as string, r.last_error_category]),
      );
      for (const category of PRE_TERMINAL_CATEGORIES) {
        expect(persisted.get(`029-preserve-${category}`)).toBe(category);
      }
      expect(persisted.get("029-preserve-null")).toBeNull();

      await expect(
        insertWithCategory("029-preserve-bogus", "not_a_real_category"),
      ).rejects.toThrow(/last_error_category/);
    });

    it("is idempotent — re-running the repair leaves the constraint intact", async () => {
      await applyMigration029();
      await applyMigration029();

      await insertWithCategory("029-idempotent", "terminal");
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM maintenance_jobs
        WHERE namespace = $1 AND idempotency_key = $2`,
        [namespace, "029-idempotent"],
      );
      expect(rows[0].n).toBe(1);
    });
  },
);
