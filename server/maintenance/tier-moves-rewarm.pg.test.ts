/**
 * The DREAM REM re-warm pass records its moves in `tier_moves` (#1469, item 5).
 *
 * The third of the three existing writers, and the only one that moves a whole
 * cluster in one statement. Two things are proved together, because they are
 * the same property from both ends:
 *
 *   - every row the pass warms gets exactly one history row, carrying the tier
 *     it came from -- `cold` and `warm` rows are distinguishable afterwards,
 *     which the bare UPDATE made impossible;
 *   - a pass over an ALREADY-WARM cluster writes no history, because the
 *     `tier IS DISTINCT FROM 'hot'` filter that makes re-warm converge
 *     (`dream-rem-rewarm.pg.test.ts`) now gates the history too. A history that
 *     grows on every idle pass would be worse than none.
 *
 * Driven through `createDreamRemRepository`, which is where the statement
 * lives; the maintenance tier above it decides only which repo to warm.
 *
 * REQUIRES `OPENBRAIN_TEST_DATABASE_URL`; `npm run test:isolated` sets it.
 */
import { randomUUID } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";
import { createDreamRemRepository } from "../db/dream-rem-repository.ts";
import { REM_REWARM_CAUSE } from "../db/tier-moves.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const suffix = randomUUID().slice(0, 8);
const namespace = `tier-moves-rewarm-${suffix}`;
const repo = `tier-moves-rewarm-repo-${suffix}`;

async function seedThought(tier: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO thoughts (content, namespace, created_by, tier, tags)
     VALUES ($1, $2, $2, $3, ARRAY[$4::text]) RETURNING id`,
    ["tier-moves rewarm fixture", namespace, tier, repo],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("seedThought inserted no row");
  return row.id;
}

async function movesFor(entryIds: string[]) {
  const { rows } = await pool.query<{
    entry_id: string;
    source_table: string;
    from_tier: string | null;
    to_tier: string;
    cause: string;
    routing_run_id: string | null;
  }>(
    `SELECT entry_id, source_table, from_tier, to_tier, cause, routing_run_id
       FROM tier_moves WHERE entry_id = ANY($1::uuid[])`,
    [entryIds],
  );
  return rows;
}

afterAll(async () => {
  await pool.query(`DELETE FROM thoughts WHERE namespace = $1`, [namespace]);
  await pool.end();
});

test("re-warm records one move per warmed row, then nothing once converged", async () => {
  const cold = await seedThought("cold");
  const warm = await seedThought("warm");
  const alreadyHot = await seedThought("hot");
  const rem = createDreamRemRepository(pool);

  const warmed = await rem.warmProjectCluster({ repo, rowLimit: 10 });
  expect(warmed).toBe(2);

  const moves = await movesFor([cold, warm, alreadyHot]);
  expect(moves).toHaveLength(2);
  const byEntry = new Map(moves.map((row) => [row.entry_id, row]));
  expect(byEntry.get(cold)).toMatchObject({
    source_table: "thoughts",
    from_tier: "cold",
    to_tier: "hot",
    cause: REM_REWARM_CAUSE,
    routing_run_id: null,
  });
  expect(byEntry.get(warm)).toMatchObject({ from_tier: "warm", to_tier: "hot" });
  // The already-hot row was never matched, so it has no history at all.
  expect(byEntry.has(alreadyHot)).toBe(false);

  // Converged: the second pass warms nothing and must record nothing.
  expect(await rem.warmProjectCluster({ repo, rowLimit: 10 })).toBe(0);
  expect(await movesFor([cold, warm, alreadyHot])).toHaveLength(2);
});
