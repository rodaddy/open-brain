import { afterAll, expect, test } from "vitest";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "./test-support/require-test-database.ts";
import { allocateGradingSchema } from "./rem-ethereal-run.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const created: string[] = [];

afterAll(async () => {
  for (const schema of created) await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

test("concurrent grading-schema allocations each get their own schema", async () => {
  const names = await Promise.all(
    Array.from({ length: 5 }, () => allocateGradingSchema(pool)),
  );
  created.push(...names);

  expect(names).toHaveLength(5);
  expect(new Set(names).size).toBe(5);
  for (const name of names) expect(name).toMatch(/^dream_run_\d{3}$/);

  const present = await pool.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace WHERE nspname = ANY($1::text[])`,
    [names],
  );
  expect(present.rows.map((row) => row.nspname).sort()).toEqual([...names].sort());

  for (const name of names) {
    const tables = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename`,
      [name],
    );
    expect(tables.rows.map((row) => row.tablename)).toEqual(["judgement", "manifest"]);
  }
});
