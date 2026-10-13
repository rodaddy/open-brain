/**
 * Postgres proof for DREAM route graduation and undo
 * (`scripts/dream-route-graduate.ts`).
 *
 * The cohort, decisions, and verdicts are planted directly, in the shapes
 * `scripts/dream-route-run-store.ts:131-187` writes them: this suite is about
 * WHICH items graduate, and a real routing run would drag a classifier in to
 * prove nothing extra. `ob_raw_turns` is planted in the RUN schema, not in
 * `public` -- the whole ethereal-run design rests on the run touching nothing
 * outside its own schema, and a test that planted turns in `public` would be
 * breaking the property it exists to prove.
 *
 * `public.ob_session_events` and `public.tier_moves` are counted before and
 * after for that same reason.
 *
 * The scratch schema is dropped in `afterAll`.
 */

import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Pool, type PoolClient } from "pg";
import { requireTestDatabaseUrl } from "./test-support/require-test-database.ts";
import {
  activeScopeKeys,
  graduateRecurring,
  graduateScopeKey,
  undoGraduate,
} from "./dream-route-graduate.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const schema = "dream_run_944";
const namespace = `dream-route-graduate-${process.pid}`;
const runId = randomUUID();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** One planted item: its wording, tier, destination, and the target it repeats. */
interface Planted {
  readonly key: string;
  readonly content: string;
  readonly tier: string;
  readonly destination: string;
  readonly reinforces: string | null;
  readonly sessions: readonly string[];
}

/**
 * Five targets, each with the repeat set the rule should or should not accept.
 *
 * `three` spans sessions s1/s2/s3 across its repeats and qualifies; `two`
 * spans only s1/s2; `observed` spans four sessions but its repeats are
 * `observed`, so they never count; `correction` spans three sessions as a
 * `decided` correction, which the ruling excludes by destination.
 */
const PLANTED: readonly Planted[] = [
  {
    key: "t3",
    content: "the three-session fact",
    tier: "decided",
    destination: "fact",
    reinforces: null,
    sessions: ["s1"],
  },
  {
    key: "t3r1",
    content: "restating the fact again",
    tier: "decided",
    destination: "fact",
    reinforces: "t3",
    sessions: ["s2"],
  },
  {
    key: "t3r2",
    content: "restating the fact once more",
    tier: "decided",
    destination: "fact",
    reinforces: "t3",
    sessions: ["s3"],
  },

  {
    key: "t2",
    content: "the two-session decision",
    tier: "decided",
    destination: "decision",
    reinforces: null,
    sessions: ["s1"],
  },
  {
    key: "t2r1",
    content: "restating the decision",
    tier: "decided",
    destination: "decision",
    reinforces: "t2",
    sessions: ["s2"],
  },

  {
    key: "ob",
    content: "the observed-repeat fact",
    tier: "decided",
    destination: "fact",
    reinforces: null,
    sessions: ["s1"],
  },
  {
    key: "obr1",
    content: "an observed restatement",
    tier: "observed",
    destination: "fact",
    reinforces: "ob",
    sessions: ["s2"],
  },
  {
    key: "obr2",
    content: "another observed restatement",
    tier: "observed",
    destination: "fact",
    reinforces: "ob",
    sessions: ["s3"],
  },
  {
    key: "obr3",
    content: "a third observed restatement",
    tier: "observed",
    destination: "fact",
    reinforces: "ob",
    sessions: ["s4"],
  },

  {
    key: "co",
    content: "the recurring correction",
    tier: "decided",
    destination: "correction",
    reinforces: null,
    sessions: ["s1"],
  },
  {
    key: "cor1",
    content: "restating the correction",
    tier: "decided",
    destination: "correction",
    reinforces: "co",
    sessions: ["s2"],
  },
  {
    key: "cor2",
    content: "restating the correction again",
    tier: "decided",
    destination: "correction",
    reinforces: "co",
    sessions: ["s3"],
  },
];

const ids = new Map<string, string>();

async function publicCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of ["ob_session_events", "tier_moves"]) {
    const result = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.${table}`,
    );
    counts[table] = Number(result.rows[0]?.n ?? 0);
  }
  return counts;
}

async function createTables(): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`CREATE TABLE ${schema}.cohort (
    ordinal INTEGER PRIMARY KEY,
    candidate_id UUID NOT NULL UNIQUE,
    namespace TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    source TEXT NOT NULL,
    neighbour_of UUID,
    snapshot JSONB NOT NULL)`);
  await pool.query(`CREATE TABLE ${schema}.routing_runs (
    run_id UUID PRIMARY KEY,
    matrix_fingerprint TEXT NOT NULL,
    classifier_version TEXT NOT NULL,
    thresholds JSONB NOT NULL,
    backend TEXT NOT NULL,
    served_models TEXT[] NOT NULL,
    records INTEGER NOT NULL,
    requests INTEGER NOT NULL,
    input_tokens BIGINT NOT NULL,
    estimated_usd NUMERIC NOT NULL,
    actual_usd NUMERIC NOT NULL,
    ms INTEGER NOT NULL,
    note TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE ${schema}.routing_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES ${schema}.routing_runs (run_id),
    candidate_id UUID NOT NULL,
    namespace TEXT NOT NULL,
    destination TEXT,
    agreement TEXT NOT NULL,
    authority_tier TEXT NOT NULL,
    restates BOOLEAN NOT NULL,
    drove_decision BOOLEAN NOT NULL,
    reasons JSONB NOT NULL,
    raw JSONB NOT NULL,
    served_model TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, candidate_id))`);
  await pool.query(`CREATE TABLE ${schema}.would_apply (
    run_id UUID NOT NULL,
    candidate_id UUID NOT NULL,
    action TEXT NOT NULL,
    reinforces UUID,
    reason TEXT NOT NULL,
    PRIMARY KEY (run_id, candidate_id))`);
  await pool.query(`CREATE TABLE ${schema}.ob_raw_turns (
    id UUID PRIMARY KEY,
    session_ref TEXT)`);
  await pool.query(
    `INSERT INTO ${schema}.routing_runs VALUES
       ($1,'fp','v1','{}'::jsonb,'fake','{}'::text[],0,0,0,0,0,0,'planted')`,
    [runId],
  );
}

async function plantItem(item: Planted, ordinal: number): Promise<void> {
  const candidateId = ids.get(item.key) ?? randomUUID();
  ids.set(item.key, candidateId);
  const contentHash = hash(item.content);
  const turnIds: string[] = [];
  for (const session of item.sessions) {
    const turnId = randomUUID();
    turnIds.push(turnId);
    await pool.query(
      `INSERT INTO ${schema}.ob_raw_turns (id, session_ref) VALUES ($1, $2)`,
      [turnId, session],
    );
  }
  await pool.query(
    `INSERT INTO ${schema}.cohort
       (ordinal, candidate_id, namespace, content_hash, source, neighbour_of, snapshot)
     VALUES ($1, $2, $3, $4, 'draw', NULL, $5::jsonb)`,
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
        source_turn_ids: turnIds,
      }),
    ],
  );
  await pool.query(
    `INSERT INTO ${schema}.routing_decisions
       (run_id, candidate_id, namespace, destination, agreement, authority_tier,
        restates, drove_decision, reasons, raw, served_model)
     VALUES ($1,$2,$3,$4,'agree',$5,$6,true,'[]'::jsonb,'{}'::jsonb,NULL)`,
    [
      runId,
      candidateId,
      namespace,
      item.destination,
      item.tier,
      item.reinforces !== null,
    ],
  );
  await pool.query(
    `INSERT INTO ${schema}.would_apply (run_id, candidate_id, action, reinforces, reason)
     VALUES ($1, $2, $3, $4, 'planted')`,
    [
      runId,
      candidateId,
      item.reinforces === null ? "thought" : "reinforce",
      item.reinforces === null ? null : ids.get(item.reinforces),
    ],
  );
}

async function plant(): Promise<void> {
  await createTables();
  for (const item of PLANTED) ids.set(item.key, randomUUID());
  let ordinal = 1;
  for (const item of PLANTED) {
    await plantItem(item, ordinal);
    ordinal += 1;
  }
}

async function withClient<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await run(client);
  } finally {
    client.release();
  }
}

const graduate = () =>
  withClient((client) => graduateRecurring({ client, schema, runId }));

const undo = (scopeKey: string) =>
  withClient((client) => undoGraduate({ client, schema, runId, scopeKey }));

async function readEvents(): Promise<
  { action: string | null; scopeKey: string | null; createdAt: string }[]
> {
  const result = await pool.query<{
    action: string | null;
    scope_key: string | null;
    created_at: string;
  }>(
    `SELECT metadata->>'memory_lifecycle_action' AS action,
            metadata->'candidate_scope'->>'key' AS scope_key,
            created_at
       FROM ${schema}.ob_session_events ORDER BY created_at`,
  );
  return result.rows.map((row) => ({
    action: row.action,
    scopeKey: row.scope_key,
    createdAt: row.created_at,
  }));
}

const threeKey = graduateScopeKey(hash("the three-session fact"));

let before: Record<string, number>;
let first: Awaited<ReturnType<typeof graduateRecurring>>;

beforeAll(async () => {
  await plant();
  before = await publicCounts();
  first = await graduate();
}, 60_000);

afterAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.end();
});

describe("dream route graduation and undo (live Postgres)", () => {
  test("a decided item repeated across three sessions graduates, alone", () => {
    expect(first.graduated).toBe(1);
    expect(first.graduatedCandidateIds).toEqual([ids.get("t3")]);
    expect(first.tierMoves).toBe(1);
  });

  test("two sessions is not enough, and an observed repeat never counts", async () => {
    const keys = activeScopeKeys(await readEvents());
    expect(keys).not.toContain(graduateScopeKey(hash("the two-session decision")));
    expect(keys).not.toContain(graduateScopeKey(hash("the observed-repeat fact")));
  });

  test("a correction never graduates, however often it recurs", async () => {
    const keys = activeScopeKeys(await readEvents());
    expect(keys).not.toContain(graduateScopeKey(hash("the recurring correction")));
  });

  test("the graduate carries its session count and the threshold is recorded", async () => {
    const row = await pool.query<{ sessions: string; note: string }>(
      `SELECT e.metadata->>'graduated_from_sessions' AS sessions,
              (SELECT note FROM ${schema}.routing_runs WHERE run_id = $1) AS note
         FROM ${schema}.ob_session_events e
        WHERE e.metadata->'candidate_scope'->>'key' = $2`,
      [runId, threeKey],
    );
    expect(row.rows[0]?.sessions).toBe("3");
    expect(row.rows[0]?.note).toContain("graduationSessions=3");
    expect(first.graduationSessions).toBe(3);
    expect(first.parameterRecordedAt).toContain("routing_runs.note");
  });

  test("a second call writes nothing", async () => {
    const eventsBefore = (await readEvents()).length;
    const second = await graduate();
    expect(second.graduated).toBe(0);
    expect(second.skippedExisting).toBe(1);
    expect((await readEvents()).length).toBe(eventsBefore);
  });

  test("undo retires the graduate for a latest-wins reader, and repeats cheaply", async () => {
    expect(activeScopeKeys(await readEvents())).toContain(threeKey);
    const undone = await undo(threeKey);
    expect(undone.relegated).toBe(1);
    expect(activeScopeKeys(await readEvents())).not.toContain(threeKey);

    const eventsAfter = (await readEvents()).length;
    expect((await undo(threeKey)).relegated).toBe(0);
    expect((await readEvents()).length).toBe(eventsAfter);
  });

  test("the promote is still on the record; nothing was deleted", async () => {
    const promotes = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${schema}.ob_session_events
        WHERE metadata->'candidate_scope'->>'key' = $1
          AND metadata->>'memory_lifecycle_action' = 'promote'`,
      [threeKey],
    );
    expect(Number(promotes.rows[0]?.n)).toBe(1);
    const moves = await pool.query<{ cause: string }>(
      `SELECT cause FROM ${schema}.tier_moves ORDER BY moved_at`,
    );
    expect(moves.rows.map((row) => row.cause)).toEqual([
      "dream-route-graduation",
      "dream-route-undo",
    ]);
  });

  test("public row counts are unchanged", async () => {
    expect(await publicCounts()).toEqual(before);
  });
});
