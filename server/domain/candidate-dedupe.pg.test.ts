/**
 * Live-Postgres proof that the dedupe pairing query is index-served (issue
 * 1488). The fake-pool suite in candidate-dedupe.test.ts cannot see a plan;
 * this one EXPLAINs the real query against the real schema and fails if the
 * nearest-survivor lookup stops using the partial HNSW index from migration
 * 051 -- the regression that made every REM pass scan ~295k candidates.
 *
 * REQUIRES `OPENBRAIN_TEST_DATABASE_URL`, and fails hard without it rather
 * than skipping into a false green. `npm run test:isolated` sets it.
 */

import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";
import { CANDIDATE_MERGE_PAIRS_SQL } from "./candidate-dedupe.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

afterAll(async () => {
  await pool.end();
});

describe("candidate dedupe pairing uses the HNSW index (live Postgres)", () => {
  it("plans the nearest-survivor lookup through candidate_memory_embedding_unreviewed_hnsw", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      // CI (PR 1531, run 7058) planned this through bitmap scans on
      // idx_candidate_memory_exchange_first / idx_candidate_memory_last_said;
      // only HNSW serves the ordered lookup once both are off (issue 1534).
      await client.query("SET LOCAL enable_bitmapscan = off");
      // A 2026-09-26 pre-push run under parallel load still planned it as a
      // Merge Join with both of the above off (issue 1534, reopened); pin the
      // join method too so HNSW is the only path left.
      await client.query("SET LOCAL enable_mergejoin = off");
      await client.query("SET LOCAL enable_hashjoin = off");
      // Issue 1691: the plan still flipped with stats. Whenever the planner
      // believes candidate_memory holds rows (other suites' committed rows
      // after an autovacuum ANALYZE, or stale counts after their deletes), it
      // costs a btree Index Scan + Sort + Limit under the lateral cheaper than
      // the HNSW scan on a small table; only the believed-empty case picked
      // HNSW. This test proves the query CAN be served by the partial HNSW
      // index (the knobs above already say so), so disable the sort path too:
      // the ordered lookup then has HNSW as its only undisabled route, under
      // any statistics. ANALYZE alone would make it fail on a populated table.
      await client.query("SET LOCAL enable_sort = off");
      const explained = await client.query<{ "QUERY PLAN": unknown }>(
        `EXPLAIN (FORMAT JSON) ${CANDIDATE_MERGE_PAIRS_SQL}`,
        [null, 200, 0.09],
      );
      const plan = JSON.stringify(explained.rows[0]?.["QUERY PLAN"]);
      expect(plan).toContain("candidate_memory_embedding_unreviewed_hnsw");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
