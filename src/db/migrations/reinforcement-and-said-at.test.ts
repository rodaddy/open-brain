import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../../scripts/test-support/require-test-database.ts";
import { runMigrations } from "../migrate.ts";

/**
 * Live-Postgres coverage for migrations 038 (candidate_reinforcement) and 039
 * (candidate_memory said-at timestamps). Issues #396, #398.
 *
 * WHAT ONLY A REAL DATABASE CAN PROVE. Every guarantee below is a CHECK
 * constraint, a unique index, or a foreign-key action -- things a pg fake can
 * only pretend to enforce. Three of them are load-bearing for the operator's
 * queue and for the reversibility that licenses the merge:
 *
 *  1. candidate_memory_review_paired (033:104-105). review_action and
 *     reviewed_at move together or the write is rejected. THIS is the reason
 *     no machine may write review_action: setting it sets reviewed_at, and
 *     `reviewed_at IS NULL` is the operator's queue (037:43-57). A test that
 *     mocked the database could never see this fire.
 *
 *  2. idx_candidate_reinforcement_dedupe. ON CONFLICT DO NOTHING against it is
 *     the idempotency guard for the merge -- reprocessing a batch after a retry
 *     must not inflate reinforcement. It is correctness, not speed.
 *
 *  3. ON DELETE CASCADE from candidate_reinforcement to candidate_memory, which
 *     is why src/candidate-dedupe.ts resolves a merge chain to its OLDEST
 *     member: deleting a mid-chain survivor would cascade away a reinforcement
 *     row and silently lose a restatement.
 *
 * REQUIRES a test database, and fails hard without one (operator ruling
 * 2026-08-27, issue #878). It must point at an isolated test/playground
 * database, never the dogfood database; `bun run test:isolated` arranges that.
 * The suite formerly swapped in `describe.skip` when the variable was absent,
 * which reported `0 pass, 20 skip` and exited 0 -- a run that proved nothing
 * and looked exactly like one that proved everything.
 *
 * Every row this suite writes carries a namespace it owns exclusively, and
 * cleanup deletes by that namespace only -- it never touches captured data.
 */

// The fixture is module-scope rather than nested inside one enclosing
// `describe`. The four suites below are SIBLINGS for two reasons: the anti-skip
// guard's testcase-level cross-check keys on the JUnit `classname`, which for a
// nested suite is the inner name only -- so a wrapping describe registers in
// scripts/assert-db-tests-ran.ts as a suite that executed nothing -- and one
// describe holding all nineteen tests is a single function far past the length
// the repo lint allows.
const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const NS = "test-reinforce-038";

/**
 * The first row of a result that is expected to have one, as a real assertion.
 *
 * Every read below queries by primary key or by this suite's own namespace, so
 * an empty result is a genuine failure of the thing under test rather than a
 * type-level maybe. Throwing here reports that as a named failure on the test
 * that caused it; the `!` operator this replaces would have thrown too, but
 * with no message and against a repo lint rule that forbids it.
 */
function firstRow<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected at least one row, got none");
  return row;
}

async function cleanup(): Promise<void> {
  // candidate_reinforcement rows cascade with their candidates, but they are
  // deleted explicitly first so a broken cascade cannot leave orphans behind
  // and quietly pass the next run.
  await pool.query("DELETE FROM candidate_reinforcement WHERE namespace = $1", [
    NS,
  ]);
  await pool.query("DELETE FROM candidate_memory WHERE namespace = $1", [NS]);
}

beforeEach(async () => {
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  await runMigrations(pool);
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await pool.end();
});

let n = 0;
const turnId = () => `99999999-9999-4999-8999-${String(++n).padStart(12, "0")}`;

async function insertCandidate(
  over: {
    content?: string;
    hash?: string;
    firstSaid?: string | null;
    lastSaid?: string | null;
  } = {},
): Promise<string> {
  const hash = over.hash ?? `hash-${++n}`;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO candidate_memory
       (namespace, candidate_type, content, content_hash, source_turn_ids,
        model, first_said_at, last_said_at)
     VALUES ($1, 'decision', $2, $3, ARRAY[$4]::uuid[], 'test-model', $5, $6)
     RETURNING id`,
    [
      NS,
      over.content ?? `claim ${hash}`,
      hash,
      turnId(),
      over.firstSaid ?? null,
      over.lastSaid ?? null,
    ],
  );
  return firstRow(rows).id;
}

/** Inserts one reinforcement row, deduped by (candidate_id, dup_content_hash). */
async function reinforce(
  candidateId: string,
  over: {
    hash?: string;
    occurredAt?: string;
    similarity?: number | null;
    turns?: string[];
  } = {},
) {
  return pool.query(
    `INSERT INTO candidate_reinforcement
       (namespace, candidate_id, dup_content_hash, dup_occurred_at,
        dup_source_turn_ids, similarity, model)
     VALUES ($1, $2, $3, $4, $5::uuid[], $6, 'test-model')
     ON CONFLICT (candidate_id, dup_content_hash) DO NOTHING
     RETURNING id`,
    [
      NS,
      candidateId,
      over.hash ?? "dup-hash-1",
      over.occurredAt ?? "2026-07-20T00:00:00Z",
      over.turns ?? [turnId()],
      over.similarity === undefined ? 0.04 : over.similarity,
    ],
  );
}

describe("the operator queue is enforced by the database, not by convention (live Postgres)", () => {
  it("rejects review_action without reviewed_at", async () => {
    // candidate_memory_review_paired. A half-written review would make every
    // "unreviewed" query silently wrong.
    const id = await insertCandidate();
    await expect(
      pool.query(
        "UPDATE candidate_memory SET review_action = 'promoted' WHERE id = $1",
        [id],
      ),
    ).rejects.toThrow(/review_paired/);
  });

  it("rejects reviewed_at without review_action", async () => {
    const id = await insertCandidate();
    await expect(
      pool.query(
        "UPDATE candidate_memory SET reviewed_at = now() WHERE id = $1",
        [id],
      ),
    ).rejects.toThrow(/review_paired/);
  });

  it("accepts the pair together, which is why a machine must never write it", async () => {
    // THE MECHANISM behind the whole no-machine-grading rule: writing
    // review_action necessarily sets reviewed_at, which necessarily removes
    // the row from `reviewed_at IS NULL`.
    const id = await insertCandidate();
    await pool.query(
      `UPDATE candidate_memory
            SET review_action = 'inconclusive', reviewed_at = now(), graded_by = 'rico'
          WHERE id = $1`,
      [id],
    );
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM candidate_memory WHERE namespace = $1 AND reviewed_at IS NULL",
      [NS],
    );
    expect(firstRow(rows).n).toBe("0");
  });

  it("lets a machine_grade write leave reviewed_at NULL -- the row stays on the queue", async () => {
    // 037:43-57. The two columns exist so their disagreement rate is
    // measurable, and that only works while writing one does not consume the
    // other.
    const id = await insertCandidate();
    await pool.query(
      `UPDATE candidate_memory
            SET machine_grade = 'promoted', machine_grade_model = 'rem-heuristic-v1'
          WHERE id = $1`,
      [id],
    );
    const { rows } = await pool.query<{
      reviewed_at: Date | null;
      review_action: string | null;
      graded_by: string | null;
      machine_grade: string;
    }>(
      "SELECT reviewed_at, review_action, graded_by, machine_grade FROM candidate_memory WHERE id = $1",
      [id],
    );
    expect(firstRow(rows).machine_grade).toBe("promoted");
    expect(firstRow(rows).reviewed_at).toBeNull();
    expect(firstRow(rows).review_action).toBeNull();
    expect(firstRow(rows).graded_by).toBeNull();
  });

  it("rejects a machine_grade with no model naming it", async () => {
    // Grades from different models are not comparable, so an unattributed
    // grade is not usable evidence.
    const id = await insertCandidate();
    await expect(
      pool.query(
        "UPDATE candidate_memory SET machine_grade = 'promoted' WHERE id = $1",
        [id],
      ),
    ).rejects.toThrow();
  });

  it("accepts exactly the four review values and nothing else", async () => {
    for (const action of [
      "promoted",
      "rejected",
      "duplicate",
      "inconclusive",
    ]) {
      const id = await insertCandidate();
      await pool.query(
        "UPDATE candidate_memory SET review_action = $2, reviewed_at = now() WHERE id = $1",
        [id, action],
      );
    }
    const bad = await insertCandidate();
    await expect(
      pool.query(
        "UPDATE candidate_memory SET review_action = 'approved', reviewed_at = now() WHERE id = $1",
        [bad],
      ),
    ).rejects.toThrow();
  });
});

describe("039 said-at timestamps (live Postgres)", () => {
  it("refuses a last_said_at earlier than first_said_at", async () => {
    // candidate_memory_said_order. A backwards move would mean a "duplicate"
    // older than the original was absorbed as the newer statement, inverting
    // the recency signal #396 reads.
    await expect(
      insertCandidate({
        firstSaid: "2026-07-28T00:00:00Z",
        lastSaid: "2026-07-01T00:00:00Z",
      }),
    ).rejects.toThrow(/said_order/);
  });

  it("allows equal timestamps -- said once", async () => {
    const id = await insertCandidate({
      firstSaid: "2026-07-28T00:00:00Z",
      lastSaid: "2026-07-28T00:00:00Z",
    });
    expect(id).toBeTruthy();
  });

  it("allows both NULL, so a candidate with purged turns keeps no fabricated time", async () => {
    const id = await insertCandidate({ firstSaid: null, lastSaid: null });
    const { rows } = await pool.query(
      "SELECT first_said_at, last_said_at FROM candidate_memory WHERE id = $1",
      [id],
    );
    expect(firstRow(rows).first_said_at).toBeNull();
    expect(firstRow(rows).last_said_at).toBeNull();
  });

  it("lets last_said_at advance while first_said_at stays put", async () => {
    // The merge behaviour of #398, at the storage level. The SPAN is the
    // evidence.
    const id = await insertCandidate({
      firstSaid: "2026-05-01T00:00:00Z",
      lastSaid: "2026-05-01T00:00:00Z",
    });
    await pool.query(
      "UPDATE candidate_memory SET last_said_at = $2 WHERE id = $1",
      [id, "2026-07-28T00:00:00Z"],
    );
    const { rows } = await pool.query<{
      first_said_at: Date;
      last_said_at: Date;
    }>(
      "SELECT first_said_at, last_said_at FROM candidate_memory WHERE id = $1",
      [id],
    );
    expect(firstRow(rows).first_said_at.toISOString()).toBe(
      "2026-05-01T00:00:00.000Z",
    );
    expect(firstRow(rows).last_said_at.toISOString()).toBe(
      "2026-07-28T00:00:00.000Z",
    );
  });
});

describe("038 candidate_reinforcement writes (live Postgres)", () => {
  it("counts a repeat merge once -- a retry cannot inflate reinforcement", async () => {
    // idx_candidate_reinforcement_dedupe. This is correctness, not speed: the
    // maintenance queue is at-least-once.
    const id = await insertCandidate();
    const first = await reinforce(id);
    const second = await reinforce(id);
    expect(first.rowCount).toBe(1);
    expect(second.rowCount).toBe(0);

    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM candidate_reinforcement WHERE candidate_id = $1",
      [id],
    );
    expect(firstRow(rows).n).toBe("1");
  });

  it("records distinct restatements separately", async () => {
    const id = await insertCandidate();
    await reinforce(id, {
      hash: "dup-a",
      occurredAt: "2026-06-12T00:00:00Z",
    });
    await reinforce(id, {
      hash: "dup-b",
      occurredAt: "2026-07-19T00:00:00Z",
    });

    // The receipt query: count, first, and last from one index scan
    // (dream-design.md:688-692).
    const { rows } = await pool.query<{
      n: string;
      first_at: Date;
      last_at: Date;
    }>(
      `SELECT count(*)::text AS n, min(dup_occurred_at) AS first_at,
              max(dup_occurred_at) AS last_at
         FROM candidate_reinforcement WHERE candidate_id = $1`,
      [id],
    );
    expect(firstRow(rows).n).toBe("2");
    expect(firstRow(rows).first_at.toISOString()).toBe(
      "2026-06-12T00:00:00.000Z",
    );
    expect(firstRow(rows).last_at.toISOString()).toBe(
      "2026-07-19T00:00:00.000Z",
    );
  });

  it("refuses a reinforcement with no source turns", async () => {
    // Non-empty by constraint: a reinforcement with no source cannot be
    // audited and cannot be undone, which defeats the reversibility that
    // licenses the merge at all.
    const id = await insertCandidate();
    await expect(reinforce(id, { turns: [] })).rejects.toThrow(
      /source_turns_check/,
    );
  });

  it("refuses a similarity outside the cosine-distance range", async () => {
    // A value outside [0, 2] is a unit error -- similarity written where
    // distance was meant -- which would silently invert every later audit of
    // the threshold.
    const id = await insertCandidate();
    await expect(reinforce(id, { similarity: -0.1 })).rejects.toThrow(
      /similarity_range/,
    );
    await expect(reinforce(id, { hash: "x", similarity: 2.5 })).rejects.toThrow(
      /similarity_range/,
    );
    // The bounds themselves are legal.
    expect((await reinforce(id, { hash: "lo", similarity: 0 })).rowCount).toBe(
      1,
    );
    expect((await reinforce(id, { hash: "hi", similarity: 2 })).rowCount).toBe(
      1,
    );
  });

  it("allows a NULL similarity rather than forcing a fabricated distance", async () => {
    const id = await insertCandidate();
    expect((await reinforce(id, { similarity: null })).rowCount).toBe(1);
  });
});

// Split from the suite above by subject: that one covers what the table ACCEPTS
// and REJECTS on write, this one covers what happens to a row afterwards --
// deletion, reverse lookup, the time it preserves, and the shape it must never
// grow.
describe("038 candidate_reinforcement lifecycle (live Postgres)", () => {
  it("cascades away with its candidate -- which is why chains resolve to the oldest", async () => {
    // src/candidate-dedupe.ts walks a merge chain to its terminal node
    // precisely because of this: deleting a mid-chain survivor would cascade
    // away a reinforcement row pointing at it and silently lose a
    // restatement.
    const id = await insertCandidate();
    await reinforce(id);
    await pool.query("DELETE FROM candidate_memory WHERE id = $1", [id]);
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM candidate_reinforcement WHERE candidate_id = $1",
      [id],
    );
    expect(firstRow(rows).n).toBe("0");
  });

  it("supports the reverse lookup that makes a bad merge recoverable", async () => {
    // "Which candidate absorbed this hash?" -- the unmerge and audit path.
    const id = await insertCandidate();
    await reinforce(id, { hash: "findable-hash" });
    const { rows } = await pool.query<{ candidate_id: string }>(
      `SELECT candidate_id FROM candidate_reinforcement
        WHERE namespace = $1 AND dup_content_hash = $2`,
      [NS, "findable-hash"],
    );
    expect(rows).toHaveLength(1);
    expect(firstRow(rows).candidate_id).toBe(id);
  });

  it("stores the said time, distinct from the merge time", async () => {
    // #396 hard constraint. A backfill keyed on write time would collapse
    // months of history onto the import moment.
    const id = await insertCandidate();
    await reinforce(id, { occurredAt: "2026-01-15T08:30:00Z" });
    const { rows } = await pool.query<{
      dup_occurred_at: Date;
      created_at: Date;
    }>(
      "SELECT dup_occurred_at, created_at FROM candidate_reinforcement WHERE candidate_id = $1",
      [id],
    );
    expect(firstRow(rows).dup_occurred_at.toISOString()).toBe(
      "2026-01-15T08:30:00.000Z",
    );
    expect(firstRow(rows).created_at.getTime()).toBeGreaterThan(
      firstRow(rows).dup_occurred_at.getTime(),
    );
  });

  it("has no count column on the candidate row to go stale", async () => {
    // dream-design.md:686 -- the count must never be denormalized. This
    // asserts against the live catalog, which is the only place a well-meant
    // future ALTER TABLE would show up.
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'candidate_memory'`,
    );
    const columns = rows.map((r) => r.column_name);
    for (const forbidden of [
      "reinforcement_count",
      "occurrence_count",
      "session_count",
      "dup_count",
    ]) {
      expect(columns).not.toContain(forbidden);
    }
  });
});
