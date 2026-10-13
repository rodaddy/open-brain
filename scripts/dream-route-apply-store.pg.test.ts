/**
 * The apply mirror tables against a real Postgres.
 *
 * `LIKE public.<t>` is the kind of DDL that can only be proven against a real
 * server: whether it survives this schema's column types (halfvec, generated
 * columns, domains) is a property of the running database, not of the SQL
 * text. The suite therefore creates a scratch `dream_run_9NN` schema in the
 * isolated test database, runs the real function against it, and drops it.
 *
 * `public` is asserted untouched, because a mirror that quietly wrote to the
 * real tables would be the single worst failure this design can have.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "./test-support/require-test-database.ts";
import { APPLY_MIRROR_TABLES, ensureApplyMirrors } from "./dream-route-apply-store.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const schema = "dream_run_907";

async function publicCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of APPLY_MIRROR_TABLES) {
    const result = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.${table}`,
    );
    counts[table] = Number(result.rows[0]?.n ?? 0);
  }
  return counts;
}

beforeAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.query(`CREATE SCHEMA ${schema}`);
});

afterAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.end();
});

describe("dream route apply mirrors (live Postgres)", () => {
  test("a second call creates the same three tables and does not fail", async () => {
    const first = await ensureApplyMirrors({ client: pool, schema });
    const second = await ensureApplyMirrors({ client: pool, schema });
    expect(first).toEqual(APPLY_MIRROR_TABLES);
    expect(second).toEqual(APPLY_MIRROR_TABLES);

    const tables = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename`,
      [schema],
    );
    expect(tables.rows.map((row) => row.tablename).sort()).toEqual(
      [...APPLY_MIRROR_TABLES].sort(),
    );
  });

  test("every mirror carries a NOT NULL uuid run_id", async () => {
    await ensureApplyMirrors({ client: pool, schema });
    for (const table of APPLY_MIRROR_TABLES) {
      const column = await pool.query<{ data_type: string; is_nullable: string }>(
        `SELECT data_type, is_nullable FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2 AND column_name = 'run_id'`,
        [schema, table],
      );
      expect(column.rows).toHaveLength(1);
      expect(column.rows[0]?.data_type).toBe("uuid");
      expect(column.rows[0]?.is_nullable).toBe("NO");
    }
  });

  test("a mirror carries the real table's columns and no foreign keys", async () => {
    await ensureApplyMirrors({ client: pool, schema });
    const real = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'tier_moves'
        ORDER BY column_name`,
    );
    const mirror = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'tier_moves'
          AND column_name <> 'run_id'
        ORDER BY column_name`,
      [schema],
    );
    expect(mirror.rows).toEqual(real.rows);

    const constraints = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = $1 AND c.contype = 'f'`,
      [schema],
    );
    expect(Number(constraints.rows[0]?.n)).toBe(0);
  });

  test("nothing in the mirrored public tables changes", async () => {
    const before = await publicCounts();
    await ensureApplyMirrors({ client: pool, schema });
    expect(await publicCounts()).toEqual(before);
  });

  test("an invalid schema name is refused before any statement runs", async () => {
    await expect(
      ensureApplyMirrors({ client: pool, schema: "public" }),
    ).rejects.toThrow(/invalid dream run schema: public/);
    await expect(
      ensureApplyMirrors({ client: pool, schema: 'dream_run_001"; DROP TABLE x --' }),
    ).rejects.toThrow(/invalid dream run schema/);
  });
});
