import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";
import {
  runVectorSearchSql,
  VECTOR_SEARCH_EF_SEARCH,
  VECTOR_SEARCH_ITERATIVE_SCAN,
} from "./vector-search.ts";

const DATABASE_URL = requireTestDatabaseUrl();
const schema = `vector_search_${process.pid}`;
const zeroVector = `[${Array.from({ length: 768 }, () => "0").join(",")}]`;
const vectorWithFirst = (first: number): string =>
  `[${[String(first), ...Array.from({ length: 767 }, () => "0")].join(",")}]`;

void describe("runVectorSearchSql against real Postgres", () => {
  let pool: Pool;
  let initialSettings: { ef_search: string; iterative_scan: string };

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(
      `CREATE TABLE ${schema}.entries (id text PRIMARY KEY, namespace text NOT NULL, embedding halfvec(768) NOT NULL)`,
    );
    await pool.query(
      `CREATE INDEX entries_embedding_hnsw ON ${schema}.entries USING hnsw (embedding halfvec_l2_ops)`,
    );
    const initial = await pool.query<{
      ef_search: string;
      iterative_scan: string;
    }>(
      `SELECT current_setting('hnsw.ef_search') AS ef_search, current_setting('hnsw.iterative_scan') AS iterative_scan`,
    );
    initialSettings = initial.rows[0] as {
      ef_search: string;
      iterative_scan: string;
    };
    await pool.query("SET enable_seqscan = off");
    await pool.query(
      `INSERT INTO ${schema}.entries (id, namespace, embedding) VALUES ($1, $2, $3::halfvec), ($4, $5, $6::halfvec), ($7, $8, $9::halfvec)`,
      [
        "hidden-nearest",
        "private",
        zeroVector,
        "visible-target",
        "allowed",
        vectorWithFirst(0.1),
        "visible-farther",
        "allowed",
        vectorWithFirst(0.8),
      ],
    );
  });

  afterAll(async () => {
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      // Closing this dedicated test pool destroys the session-local
      // enable_seqscan override even when schema cleanup fails.
      await pool.end();
    }
  });

  it("returns effective ANN settings from a read-only candidate transaction and restores them", async () => {
    const rows = await runVectorSearchSql({
      pool,
      sql: `SELECT current_setting('hnsw.ef_search') AS ef_search, current_setting('hnsw.iterative_scan') AS iterative_scan, current_setting('transaction_read_only') AS transaction_read_only`,
      params: [],
    });
    assert.equal(rows[0]?.ef_search, VECTOR_SEARCH_EF_SEARCH);
    assert.equal(rows[0]?.iterative_scan, VECTOR_SEARCH_ITERATIVE_SCAN);
    assert.equal(rows[0]?.transaction_read_only, "on");

    const restored = await pool.query(
      `SELECT current_setting('hnsw.ef_search') AS ef_search, current_setting('hnsw.iterative_scan') AS iterative_scan`,
    );
    assert.equal(restored.rows[0]?.ef_search, initialSettings.ef_search);
    assert.equal(restored.rows[0]?.iterative_scan, initialSettings.iterative_scan);
  });

  it("preserves the query error and restores settings after rollback", async () => {
    let thrown: unknown;
    try {
      await runVectorSearchSql({
        pool,
        sql: "SELECT * FROM vector_search_missing_relation",
        params: [],
      });
    } catch (error) {
      thrown = error;
    }
    assert.equal((thrown as { code?: string }).code, "42P01");

    const restored = await pool.query(
      `SELECT current_setting('hnsw.ef_search') AS ef_search, current_setting('hnsw.iterative_scan') AS iterative_scan`,
    );
    assert.equal(restored.rows[0]?.ef_search, initialSettings.ef_search);
    assert.equal(restored.rows[0]?.iterative_scan, initialSettings.iterative_scan);
  });

  it("uses the forced HNSW index plan and excludes a nearer inaccessible namespace", async () => {
    const rows = await runVectorSearchSql({
      pool,
      sql: `SELECT id, namespace FROM ${schema}.entries WHERE namespace = $2 ORDER BY embedding <-> $1::halfvec LIMIT 1`,
      params: [zeroVector, "allowed"],
    });
    assert.deepEqual(rows, [{ id: "visible-target", namespace: "allowed" }]);

    const explained = await runVectorSearchSql({
      pool,
      sql: `EXPLAIN (FORMAT JSON) SELECT id FROM ${schema}.entries WHERE namespace = $2 ORDER BY embedding <-> $1::halfvec LIMIT 1`,
      params: [zeroVector, "allowed"],
    });
    assert.match(
      JSON.stringify(explained),
      /entries_embedding_hnsw/,
      "enable_seqscan=off must produce the intended HNSW index plan",
    );
  });
});
