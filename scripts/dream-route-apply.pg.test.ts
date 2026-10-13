/**
 * Postgres proof for the DREAM apply step (`scripts/dream-route-apply.ts`).
 *
 * The cohort and verdict rows are planted directly rather than produced by a
 * real routing run: this suite is about what the APPLY step writes, and a full
 * run would drag a classifier backend in to prove nothing extra. The planted
 * columns are exactly the ones the apply step reads, in the shapes
 * `scripts/dream-route-run-store.ts:150-187` and `rem-ethereal-cohort.ts`
 * write them.
 *
 * `public` is counted before and after, because "writes only into the run
 * schema" is the property the whole ethereal-run design rests on.
 *
 * The scratch schema is dropped in `afterAll`.
 */

import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "./test-support/require-test-database.ts";
import { applyRouting, ruleScopeKey } from "./dream-route-apply.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const schema = "dream_run_931";
const namespace = `dream-route-apply-${process.pid}`;
const runId = randomUUID();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** One planted candidate plus the verdict the router gave it. */
interface Planted {
  readonly content: string;
  readonly action: string;
}

const PLANTED: readonly Planted[] = [
  { content: "a fact the router committed", action: "thought" },
  { content: "a correction the router committed", action: "thought" },
  { content: "always use the fast tools", action: "rule_event" },
  { content: "steering chatter nobody commits", action: "none" },
  { content: "a fact the router committed", action: "thought" },
];

async function publicCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of ["thoughts", "ob_session_events", "tier_moves"]) {
    const result = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.${table}`,
    );
    counts[table] = Number(result.rows[0]?.n ?? 0);
  }
  return counts;
}

async function plant(): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`CREATE TABLE ${schema}.cohort (
    ordinal INTEGER PRIMARY KEY,
    candidate_id UUID NOT NULL,
    namespace TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    source TEXT NOT NULL,
    neighbour_of UUID,
    snapshot JSONB NOT NULL)`);
  await pool.query(`CREATE TABLE ${schema}.would_apply (
    run_id UUID NOT NULL,
    candidate_id UUID NOT NULL,
    action TEXT NOT NULL,
    reinforces UUID,
    reason TEXT NOT NULL,
    PRIMARY KEY (run_id, candidate_id))`);

  let ordinal = 0;
  for (const item of PLANTED) {
    const candidateId = randomUUID();
    const contentHash = hash(item.content);
    await pool.query(
      `INSERT INTO ${schema}.cohort
         (ordinal, candidate_id, namespace, content_hash, source, neighbour_of,
          snapshot)
       VALUES ($1, $2, $3, $4, 'drawn', NULL, $5::jsonb)`,
      [
        ordinal,
        candidateId,
        namespace,
        contentHash,
        JSON.stringify({
          id: candidateId,
          namespace,
          content: item.content,
          content_hash: contentHash,
          source_turn_ids: [`turn-${ordinal}`],
        }),
      ],
    );
    await pool.query(
      `INSERT INTO ${schema}.would_apply
         (run_id, candidate_id, action, reinforces, reason)
       VALUES ($1, $2, $3, NULL, 'planted')`,
      [runId, candidateId, item.action],
    );
    ordinal += 1;
  }
}

async function apply(): Promise<Awaited<ReturnType<typeof applyRouting>>> {
  const client = await pool.connect();
  try {
    return await applyRouting({ client, schema, runId });
  } finally {
    client.release();
  }
}

async function mirrorCount(table: string): Promise<number> {
  const result = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${schema}.${table}`,
  );
  return Number(result.rows[0]?.n ?? 0);
}

let before: Record<string, number>;
let first: Awaited<ReturnType<typeof applyRouting>>;

beforeAll(async () => {
  await plant();
  before = await publicCounts();
  first = await apply();
});

afterAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.end();
});

describe("dream route apply step (live Postgres)", () => {
  test("commits each distinct thought once and skips the duplicate", async () => {
    expect(first.thoughts).toBe(2);
    expect(first.skippedExisting).toBe(1);
    expect(await mirrorCount("thoughts")).toBe(2);
  });

  test("a none verdict is never applied", () => {
    expect(first.notApplied).toBe(1);
  });

  test("every mirrored thought carries dream-route provenance and the run id", async () => {
    const rows = await pool.query<{
      source: string;
      namespace: string;
      run_id: string;
      promoted_from: { source: string; candidate_id: string };
    }>(`SELECT source, namespace, run_id, promoted_from FROM ${schema}.thoughts`);
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) {
      expect(row.source).toBe("dream-route");
      expect(row.namespace).toBe(namespace);
      expect(row.run_id).toBe(runId);
      expect(row.promoted_from.source).toBe("dream-route");
      expect(row.promoted_from.candidate_id).toEqual(expect.any(String));
    }
  });

  test("a rule becomes a promote event in the shape the context pack reads", async () => {
    expect(first.promotes).toBe(1);
    const rows = await pool.query<{
      action: string;
      candidate_type: string;
      key: string;
      run_id: string;
    }>(
      `SELECT metadata->>'memory_lifecycle_action' AS action,
              metadata->>'candidate_type' AS candidate_type,
              metadata->'candidate_scope'->>'key' AS key,
              run_id
         FROM ${schema}.ob_session_events`,
    );
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0];
    expect(row?.action).toBe("promote");
    expect(row?.candidate_type).toBe("process_rule");
    expect(row?.key).toBe(ruleScopeKey(hash("always use the fast tools")));
    expect(row?.run_id).toBe(runId);
  });

  test("every applied item gets one tier move naming its source table", async () => {
    expect(first.tierMoves).toBe(3);
    const rows = await pool.query<{
      source_table: string;
      from_tier: string | null;
      to_tier: string;
      cause: string;
      routing_run_id: string;
    }>(
      `SELECT source_table, from_tier, to_tier, cause, routing_run_id
         FROM ${schema}.tier_moves ORDER BY source_table`,
    );
    expect(rows.rows.map((row) => row.source_table)).toEqual([
      "ob_session_events",
      "thoughts",
      "thoughts",
    ]);
    for (const row of rows.rows) {
      expect(row.from_tier).toBeNull();
      expect(row.to_tier).toBe("warm");
      expect(row.cause).toBe("dream-route");
      expect(row.routing_run_id).toBe(runId);
    }
  });

  test("a second call writes nothing new", async () => {
    const second = await apply();
    expect(second.thoughts).toBe(0);
    expect(second.promotes).toBe(0);
    expect(second.tierMoves).toBe(0);
    expect(second.skippedExisting).toBe(4);
    expect(await mirrorCount("thoughts")).toBe(2);
    expect(await mirrorCount("ob_session_events")).toBe(1);
    expect(await mirrorCount("tier_moves")).toBe(3);
  });

  test("public is untouched", async () => {
    expect(await publicCounts()).toEqual(before);
  });
});
