/**
 * Postgres proof for the apply step's route signals
 * (`scripts/dream-route-apply-signals.ts`).
 *
 * Signals are PLANTED, which is the decided design rather than a shortcut:
 * detection is not built, so `plantSignal` is the supported way a row gets
 * into `route_signals` and this suite exercises the same path a proof run
 * would. Cohort, verdict, and `routing_decisions` rows are planted directly
 * for the same reason `dream-route-apply.pg.test.ts` does it -- the subject is
 * what the apply step WRITES, and a real routing run would drag a classifier
 * backend in to prove nothing extra.
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
import { applyRouting } from "./dream-route-apply.ts";
import { ensureSignalTables, plantSignal } from "./dream-route-signals-store.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const schema = "dream_run_932";
const namespace = `dream-route-signals-${process.pid}`;
const runId = randomUUID();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

const REVERSED_RULE_KEY = "dream-route:rule:the-standing-rule";

/** One planted candidate: its verdict, its authority tier, and its signal. */
interface Planted {
  readonly label: string;
  readonly content: string;
  readonly action: string;
  readonly authorityTier: string;
  readonly signal?: "contradicts_canon" | "reverses_rule";
}

const PLANTED: readonly Planted[] = [
  {
    label: "clean",
    content: "an ordinary fact",
    action: "thought",
    authorityTier: "observed",
  },
  {
    label: "canon",
    content: "a claim that contradicts canon",
    action: "thought",
    authorityTier: "decided",
    signal: "contradicts_canon",
  },
  {
    label: "decidedReversal",
    content: "the operator reversed the standing rule",
    action: "thought",
    authorityTier: "decided",
    signal: "reverses_rule",
  },
  {
    label: "observedReversal",
    content: "somebody noticed the rule being ignored",
    action: "thought",
    authorityTier: "observed",
    signal: "reverses_rule",
  },
];

const ids = new Map<string, string>();

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

async function createRunTables(): Promise<void> {
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
  await pool.query(`CREATE TABLE ${schema}.routing_decisions (
    run_id UUID NOT NULL,
    candidate_id UUID NOT NULL,
    authority_tier TEXT NOT NULL,
    UNIQUE (run_id, candidate_id))`);
  await ensureSignalTables({ client: pool, schema });
}

async function plantOne(item: Planted, ordinal: number): Promise<void> {
  const candidateId = randomUUID();
  ids.set(item.label, candidateId);
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
    `INSERT INTO ${schema}.would_apply (run_id, candidate_id, action, reason)
     VALUES ($1, $2, $3, 'planted')`,
    [runId, candidateId, item.action],
  );
  await pool.query(
    `INSERT INTO ${schema}.routing_decisions (run_id, candidate_id, authority_tier)
     VALUES ($1, $2, $3)`,
    [runId, candidateId, item.authorityTier],
  );
  if (item.signal !== undefined) {
    await plantSignal({
      client: pool,
      schema,
      runId,
      candidateId,
      signal: item.signal,
      targetScopeKey: item.signal === "reverses_rule" ? REVERSED_RULE_KEY : undefined,
    });
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

/** The tally of mirrored thoughts one planted candidate produced. */
async function appliedCount(label: string): Promise<number> {
  const result = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${schema}.thoughts
      WHERE promoted_from->>'candidate_id' = $1`,
    [ids.get(label)],
  );
  return Number(result.rows[0]?.n ?? 0);
}

interface FlagRow {
  applied: boolean;
  needs_operator_approval: boolean;
  target_scope_key: string | null;
}

/** The one flag row a candidate carries for a given kind. */
async function flagRow(label: string, kind: string): Promise<FlagRow | undefined> {
  const result = await pool.query<FlagRow>(
    `SELECT applied, needs_operator_approval, target_scope_key
       FROM ${schema}.apply_flags
      WHERE candidate_id = $1 AND kind = $2`,
    [ids.get(label), kind],
  );
  return result.rows[0];
}

let before: Record<string, number>;
let first: Awaited<ReturnType<typeof applyRouting>>;

beforeAll(async () => {
  await createRunTables();
  let ordinal = 0;
  for (const item of PLANTED) {
    await plantOne(item, ordinal);
    ordinal += 1;
  }
  before = await publicCounts();
  first = await apply();
});

afterAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.end();
});

describe("dream route apply signals (live Postgres)", () => {
  test("a canon contradiction is flagged and never applied", async () => {
    expect(first.canonBlocked).toBe(1);
    expect(await appliedCount("canon")).toBe(0);
    const flag = await flagRow("canon", "canon_contradiction");
    expect(flag?.applied).toBe(false);
    expect(flag?.needs_operator_approval).toBe(true);
  });

  test("a decided reversal relegates the rule and still applies the candidate", async () => {
    expect(first.relegates).toBe(1);
    expect(first.reversalTierMoves).toBe(1);
    const event = await pool.query<{
      action: string;
      key: string;
      needs: boolean;
      candidate_type: string;
    }>(
      `SELECT metadata->>'memory_lifecycle_action' AS action,
              metadata->'candidate_scope'->>'key' AS key,
              (metadata->>'needs_operator_approval')::boolean AS needs,
              metadata->>'candidate_type' AS candidate_type
         FROM ${schema}.ob_session_events
        WHERE metadata->>'memory_lifecycle_action' = 'relegate'`,
    );
    expect(event.rows).toHaveLength(1);
    expect(event.rows[0]?.key).toBe(REVERSED_RULE_KEY);
    expect(event.rows[0]?.needs).toBe(true);
    expect(event.rows[0]?.candidate_type).toBe("process_rule");
    const move = await pool.query<{ from_tier: string; to_tier: string }>(
      `SELECT from_tier, to_tier FROM ${schema}.tier_moves
        WHERE cause = 'dream-route-reversal'`,
    );
    expect(move.rows).toHaveLength(1);
    expect(move.rows[0]?.from_tier).toBe("warm");
    expect(move.rows[0]?.to_tier).toBe("cold");
    expect(await appliedCount("decidedReversal")).toBe(1);
    expect((await flagRow("decidedReversal", "rule_reversal"))?.applied).toBe(true);
  });

  test("an observed reversal is flagged only", async () => {
    const flag = await flagRow("observedReversal", "rule_reversal");
    expect(flag?.applied).toBe(false);
    expect(flag?.needs_operator_approval).toBe(true);
    expect(flag?.target_scope_key).toBe(REVERSED_RULE_KEY);
    // The candidate itself is ordinary work and still lands.
    expect(await appliedCount("observedReversal")).toBe(1);
    expect(first.applyFlags).toBe(3);
  });

  test("a second call writes nothing new", async () => {
    const flagsBefore = await mirrorCount("apply_flags");
    const eventsBefore = await mirrorCount("ob_session_events");
    const movesBefore = await mirrorCount("tier_moves");
    const second = await apply();
    expect(second.applyFlags).toBe(0);
    expect(second.relegates).toBe(0);
    expect(second.reversalTierMoves).toBe(0);
    expect(second.thoughts).toBe(0);
    expect(await mirrorCount("apply_flags")).toBe(flagsBefore);
    expect(await mirrorCount("ob_session_events")).toBe(eventsBefore);
    expect(await mirrorCount("tier_moves")).toBe(movesBefore);
  });

  test("public is untouched", async () => {
    expect(await publicCounts()).toEqual(before);
  });
});
