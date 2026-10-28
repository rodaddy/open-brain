/**
 * DREAM REM re-warm reaches a fixed point (issue 1469, gap G4).
 *
 * `warmProjectCluster` (server/db/dream-rem-repository.ts:89) flips only rows
 * where `tier IS DISTINCT FROM 'hot'` and `archived_at IS NULL`. That is what
 * makes repeated passes converge: each pass warms the next slice, and a pass
 * over a fully-warmed project must write nothing at all -- not even a fresh
 * `updated_at`. This proves it against live Postgres, importing
 * REWARM_BEGIN_LIMIT from production rather than restating its value.
 */

import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";
import { createDreamRemGradingRepository } from "../db/dream-rem-grading-repository.ts";
import { createDreamRemRepository } from "../db/dream-rem-repository.ts";
import type { MaintenanceQueueLogger } from "./maintenance-queue-runner.ts";
import { REWARM_BEGIN_LIMIT, runRemRewarm } from "./dream-rem.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const suffix = randomUUID().slice(0, 8);
const namespace = `rewarm-fp-${suffix}`;
const repoA = `rewarm-fp-a-${suffix}`;
const repoB = `rewarm-fp-b-${suffix}`;
const content = "Re-warming a fully warmed project cluster must write nothing.";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

const logger: MaintenanceQueueLogger = {
  info() {},
  warn() {},
  error() {},
};

const deps = {
  pool,
  rem: createDreamRemRepository(pool),
  grading: createDreamRemGradingRepository(pool),
  logger,
  namespace,
};

interface ThoughtState {
  id: string;
  tier: string;
  updated_at: Date;
}

async function insertTurn(input: { session: string; sequence: number; repo: string }) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO ob_raw_turns
       (id, namespace, turn_uuid, session_ref, turn_index, session_seq, role,
        is_human_prompt, content, metadata, content_hash, runtime,
        redaction_applied, distilled_at, created_by, occurred_at, retention_tier, repo)
     VALUES ($1, $2, $6, $3, $4, $4, 'user', true, $5, '{}'::jsonb, $7,
             'rewarm-fp-fixture', '[]'::jsonb, now(), 'rewarm-fp-fixture',
             now(), 'live', $8)`,
    [
      id,
      namespace,
      input.session,
      input.sequence,
      content,
      `${id}-turn`,
      hash(id),
      input.repo,
    ],
  );
}

async function insertThought(input: { tag: string; tier: string; archived: boolean }) {
  await pool.query(
    `INSERT INTO thoughts (content, namespace, created_by, tier, tags, archived_at, updated_at)
     VALUES ($1, $2, $2, $3, ARRAY[$4::text], ${input.archived ? "now()" : "NULL"},
             now() - INTERVAL '10 days')`,
    [`${content} ${randomUUID()}`, namespace, input.tier, input.tag],
  );
}

async function seedThoughts(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await insertThought({ tag: repoA, tier: "cold", archived: false });
  }
  for (let i = 0; i < 5; i += 1) {
    await insertThought({ tag: repoA, tier: "warm", archived: false });
  }
  await insertThought({ tag: repoA, tier: "hot", archived: false });
  await insertThought({ tag: repoA, tier: "cold", archived: true });
  for (let i = 0; i < 3; i += 1) {
    await insertThought({ tag: repoB, tier: "cold", archived: false });
  }
}

async function readState(): Promise<ThoughtState[]> {
  const { rows } = await pool.query<ThoughtState>(
    `SELECT id::text AS id, tier, updated_at FROM thoughts
      WHERE namespace = $1 ORDER BY id`,
    [namespace],
  );
  return rows;
}

async function tierCounts(
  tag: string,
  archived: boolean,
): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ tier: string; n: string }>(
    `SELECT tier, count(*)::text AS n FROM thoughts
      WHERE namespace = $1 AND tags @> ARRAY[$2::text]
        AND archived_at IS ${archived ? "NOT NULL" : "NULL"}
      GROUP BY tier`,
    [namespace, tag],
  );
  return Object.fromEntries(rows.map((row) => [row.tier, Number(row.n)]));
}

beforeAll(async () => {
  await insertTurn({ session: `${namespace}-a1`, sequence: 1, repo: repoA });
  await insertTurn({ session: `${namespace}-a2`, sequence: 2, repo: repoA });
  await insertTurn({ session: `${namespace}-b1`, sequence: 3, repo: repoB });
  await seedThoughts();
});

afterAll(async () => {
  await pool.query("DELETE FROM thoughts WHERE namespace = $1", [namespace]);
  await pool.query("DELETE FROM ob_raw_turns WHERE namespace = $1", [namespace]);
  await pool.end();
});

test("repeated re-warm passes over a finite project cluster reach a fixed point", async () => {
  // Pass 1: both projects are seen, B has one session ("notice, no action"),
  // A has two so it warms REWARM_BEGIN_LIMIT rows -- coldest first.
  const first = await runRemRewarm(deps);
  expect(first).toEqual({
    projects_seen: 2,
    noticed_only: 1,
    warmed: REWARM_BEGIN_LIMIT,
  });
  // 1 row was already hot, so 10 warmed leaves 11 hot and 3 of the 5 warm.
  expect(await tierCounts(repoA, false)).toEqual({
    hot: REWARM_BEGIN_LIMIT + 1,
    warm: 3,
  });
  // Coldest first: no non-archived A row is still cold after one pass.
  expect(await tierCounts(repoA, false)).not.toHaveProperty("cold");

  // Pass 2: the remaining non-archived A rows flip, and nothing else does.
  const second = await runRemRewarm(deps);
  expect(second.warmed).toBe(3);
  expect(await tierCounts(repoA, false)).toEqual({ hot: 14 });

  // Pass 3 over a fully warmed cluster is the fixed point: no row rewritten,
  // so even `updated_at` is untouched.
  const before = await readState();
  const third = await runRemRewarm(deps);
  expect(third.warmed).toBe(0);
  expect(await readState()).toEqual(before);

  // Archived and out-of-project rows were never in scope.
  expect(await tierCounts(repoA, true)).toEqual({ cold: 1 });
  expect(await tierCounts(repoB, false)).toEqual({ cold: 3 });
});
