/**
 * Functional tests for the semantic near-dupe merge (#398, runs in REM).
 *
 * WHY THIS ONE NEEDS TESTING MORE THAN THE OTHERS. It is the only stage in the
 * whole pipeline that DELETES a row. docs/dream-design.md:116 makes
 * delete/hard-discard ALWAYS ASK, and the merge is exempted from that only
 * because it is REVERSIBLE: candidate_reinforcement keeps the duplicate's hash,
 * its turns, and its time, which is everything needed to re-extract it
 * (dream-design.md:706-708). Reversibility is the entire licence.
 *
 * So these tests hold the merge to the terms of that licence:
 *
 *  - a reviewed candidate is NEVER absorbed (it is the operator's ground truth,
 *    and rewriting it would corrupt the training data the grading exercise
 *    exists to produce);
 *  - the reinforcement row is written BEFORE the delete, so nothing is lost;
 *  - first_said_at never moves and last_said_at only moves forward;
 *  - the count is computed live and never denormalized (dream-design.md:686).
 *
 * The pool fake is statement-shaped rather than a SQL engine: the pairing query
 * is a recursive CTE and reimplementing it would be testing the fake. What the
 * fake DOES model faithfully is the per-pair write sequence, because the ORDER
 * of those three statements is the reversibility guarantee.
 */

import { describe, expect, it } from "bun:test";
import type pg from "pg";
import { expectDefined } from "../../scripts/test-support/expect-defined.ts";
import {
  CANDIDATE_DUP_DISTANCE,
  DEFAULT_DEDUPE_BATCH,
  readReinforcement,
  runCandidateDedupe,
} from "./candidate-dedupe.ts";
import { DEFAULT_DUP_THRESHOLD } from "../../src/tiering.ts";
import type { MaintenanceQueueLogger } from "../maintenance/maintenance-queue-runner.ts";

const silentLogger: MaintenanceQueueLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface Recorded {
  text: string;
  values: unknown[];
}

function pairRow(over: Record<string, unknown> = {}) {
  return {
    dup_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    survivor_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    namespace: "rico",
    dup_content_hash: "hash-dup",
    dup_occurred_at: new Date("2026-07-28T10:00:00Z"),
    dup_source_turn_ids: ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"],
    dup_model: "rule-based-distiller/v1",
    distance: 0.04,
    ...over,
  };
}

function fakePool(
  responder: (sql: string, values: unknown[]) => { rows: unknown[] } | void,
) {
  const seen: Recorded[] = [];
  const run = async (text: string, values: unknown[] = []) => {
    seen.push({ text, values });
    const res = responder(text, values);
    return { rows: res?.rows ?? [], rowCount: res?.rows?.length ?? 0 };
  };
  const pool = {
    query: run,
    connect: async () => ({ query: run, release: () => undefined }),
  } as unknown as pg.Pool;
  return { pool, seen };
}

/** A pool that yields exactly the given merge pairs and accepts every write. */
function mergePool(pairs: Array<ReturnType<typeof pairRow>>) {
  return fakePool((sql) => {
    if (sql.includes("WITH RECURSIVE scoped")) return { rows: pairs };
    if (sql.includes("count(*)::text AS n")) return { rows: [{ n: "0" }] };
    if (sql.includes("INSERT INTO candidate_reinforcement")) {
      return { rows: [{ id: "r1" }] };
    }
    if (sql.includes("DELETE FROM candidate_memory")) return { rows: [{}] };
    return undefined;
  });
}

describe("the merge threshold is settled, not fitted", () => {
  it("is 0.09 cosine distance", () => {
    // dream-design.md:631-649 calls this settled and not a fitting problem.
    expect(CANDIDATE_DUP_DISTANCE).toBe(0.09);
  });

  it("is NOT the lane-event constant, which answers a different question", () => {
    // src/tiering.ts:33 is 0.08, tuned for lane-event-to-durable comparison
    // against a different corpus. The doc is explicit the candidate-to-candidate
    // path needs its own value and the existing constant must not change.
    expect(CANDIDATE_DUP_DISTANCE).not.toBe(DEFAULT_DUP_THRESHOLD);
    expect(DEFAULT_DUP_THRESHOLD).toBe(0.08);
  });

  it("passes the settled threshold to the pairing query by default", async () => {
    const { pool, seen } = mergePool([]);
    await runCandidateDedupe({ pool, logger: silentLogger });
    const pairing = expectDefined(
      seen.find((s) => s.text.includes("WITH RECURSIVE scoped")),
      "pairing",
    );
    expect(pairing.values[2]).toBe(CANDIDATE_DUP_DISTANCE);
    expect(pairing.values[1]).toBe(DEFAULT_DEDUPE_BATCH);
  });
});

describe("runCandidateDedupe — the reversibility contract", () => {
  it("writes the reinforcement row BEFORE deleting the duplicate", async () => {
    // The order IS the guarantee. Deleting first and then failing to write the
    // history is the one sequence that makes a merge unrecoverable.
    const { pool, seen } = mergePool([pairRow()]);
    await runCandidateDedupe({ pool, logger: silentLogger });

    const insertAt = seen.findIndex((s) =>
      s.text.includes("INSERT INTO candidate_reinforcement"),
    );
    const deleteAt = seen.findIndex((s) =>
      s.text.includes("DELETE FROM candidate_memory"),
    );
    expect(insertAt).toBeGreaterThanOrEqual(0);
    expect(deleteAt).toBeGreaterThan(insertAt);
  });

  it("keeps the duplicate's hash, turns, and SAID time -- everything needed to undo", async () => {
    const pair = pairRow();
    const { pool, seen } = mergePool([pair]);
    await runCandidateDedupe({ pool, logger: silentLogger });

    const insert = expectDefined(
      seen.find((s) => s.text.includes("INSERT INTO candidate_reinforcement")),
      "insert",
    );
    expect(insert.values).toEqual([
      pair.namespace,
      pair.survivor_id,
      pair.dup_content_hash,
      pair.dup_occurred_at,
      pair.dup_source_turn_ids,
      pair.distance,
      pair.dup_model,
    ]);
  });

  it("records the time the duplicate was SAID, never the merge time", async () => {
    // #396 hard constraint: a backfill keyed on write time collapses months of
    // history onto the import moment, and the span is itself the evidence.
    const said = new Date("2026-05-01T09:00:00Z");
    const { pool, seen } = mergePool([pairRow({ dup_occurred_at: said })]);
    await runCandidateDedupe({ pool, logger: silentLogger });
    const insert = expectDefined(
      seen.find((s) => s.text.includes("INSERT INTO candidate_reinforcement")),
      "insert",
    );
    expect(insert.values[3]).toBe(said);
    expect(insert.text).not.toContain("now()");
  });

  it("is idempotent on replay -- reinforcement cannot be inflated by a retry", async () => {
    const { pool, seen } = mergePool([pairRow()]);
    await runCandidateDedupe({ pool, logger: silentLogger });
    const insert = expectDefined(
      seen.find((s) => s.text.includes("INSERT INTO candidate_reinforcement")),
      "insert",
    );
    expect(insert.text).toContain(
      "ON CONFLICT (candidate_id, dup_content_hash) DO NOTHING",
    );
  });

  it("counts a conflicted insert as merged but not as newly reinforced", async () => {
    // The dedupe index fired: the history already records this restatement.
    const { pool } = fakePool((sql) => {
      if (sql.includes("WITH RECURSIVE scoped")) return { rows: [pairRow()] };
      if (sql.includes("count(*)::text AS n")) return { rows: [{ n: "0" }] };
      if (sql.includes("INSERT INTO candidate_reinforcement")) return { rows: [] };
      if (sql.includes("DELETE FROM candidate_memory")) return { rows: [{}] };
      return undefined;
    });
    const summary = await runCandidateDedupe({ pool, logger: silentLogger });
    expect(summary.reinforced).toBe(0);
    expect(summary.merged).toBe(1);
  });
});

describe("runCandidateDedupe — the operator's grade is ground truth", () => {
  it("only ever considers UNREVIEWED candidates", async () => {
    // Absorbing a graded candidate would rewrite the training data the whole
    // grading exercise exists to produce.
    const { pool, seen } = mergePool([]);
    await runCandidateDedupe({ pool, logger: silentLogger });
    const pairing = expectDefined(
      seen.find((s) => s.text.includes("WITH RECURSIVE scoped")),
      "pairing",
    );
    expect(pairing.text).toContain("reviewed_at IS NULL");
  });

  it("restates the guard at the point of deletion", async () => {
    // Cheap, and it makes the invariant impossible to lose in a refactor that
    // moves the SELECT.
    const { pool, seen } = mergePool([pairRow()]);
    await runCandidateDedupe({ pool, logger: silentLogger });
    const del = expectDefined(
      seen.find((s) => s.text.includes("DELETE FROM candidate_memory")),
      "del",
    );
    expect(del.text).toContain("reviewed_at IS NULL");
  });

  it("never writes review_action, reviewed_at, graded_by, or machine_grade", async () => {
    const { pool, seen } = mergePool([pairRow()]);
    await runCandidateDedupe({ pool, logger: silentLogger });
    for (const s of seen) {
      expect(s.text).not.toContain("review_action");
      expect(s.text).not.toContain("reviewed_at =");
      expect(s.text).not.toContain("graded_by");
      expect(s.text).not.toContain("machine_grade");
    }
  });

  it("never touches confidence -- reinforcement is not arithmetic on truth", async () => {
    // dream-design.md:559-578: confidence answers "is this true", reinforcement
    // answers "how well established". One number cannot hold both.
    const { pool, seen } = mergePool([pairRow()]);
    await runCandidateDedupe({ pool, logger: silentLogger });
    for (const s of seen) expect(s.text).not.toContain("confidence");
  });
});

describe("runCandidateDedupe — the survivor's timestamps", () => {
  it("advances last_said_at and never first_said_at", async () => {
    // The span between them is the evidence that defends an old claim against a
    // bare new one; overwriting first_said_at erases it.
    const { pool, seen } = mergePool([pairRow()]);
    await runCandidateDedupe({ pool, logger: silentLogger });
    const update = expectDefined(
      seen.find((s) => s.text.includes("SET last_said_at")),
      "update",
    );
    expect(update.text).toContain("last_said_at = GREATEST(");
    expect(update.text).not.toContain("first_said_at =");
  });

  it("uses GREATEST so an older duplicate cannot drag recency backwards", async () => {
    // Merges arrive in no particular order.
    const { pool, seen } = mergePool([
      pairRow({ dup_occurred_at: new Date("2020-01-01T00:00:00Z") }),
    ]);
    await runCandidateDedupe({ pool, logger: silentLogger });
    const update = expectDefined(
      seen.find((s) => s.text.includes("SET last_said_at")),
      "update",
    );
    expect(update.text).toContain("GREATEST");
    expect(update.values[0]).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });

  it("does not append to source_refs -- refs go to the history table", async () => {
    // Otherwise a hot item's row grows without bound (dream-design.md:616-618).
    const { pool, seen } = mergePool([pairRow()]);
    await runCandidateDedupe({ pool, logger: silentLogger });
    for (const s of seen) expect(s.text).not.toContain("source_refs");
  });
});

describe("runCandidateDedupe — bounds, locking, and reporting", () => {
  it("locks duplicates AND survivors in id order so concurrent passes block, not deadlock", async () => {
    const { pool, seen } = mergePool([pairRow()]);
    await runCandidateDedupe({ pool, logger: silentLogger });
    const lock = expectDefined(
      seen.find((s) => s.text.includes("FOR UPDATE")),
      "lock",
    );
    expect(lock.text).toContain("ORDER BY id");
    // Both sides of every pair.
    expect(lock.values[0]).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ]);
  });

  it("takes no lock when there is nothing to merge", async () => {
    const { pool, seen } = mergePool([]);
    const summary = await runCandidateDedupe({ pool, logger: silentLogger });
    expect(summary.examined).toBe(0);
    expect(seen.some((s) => s.text.includes("FOR UPDATE"))).toBe(false);
  });

  it("reports unmergeable candidates rather than hiding them", async () => {
    // A candidate with no embedding cannot be compared by similarity. That is a
    // real gap and it belongs in the summary, not swallowed.
    const { pool } = fakePool((sql) => {
      if (sql.includes("count(*)::text AS n")) return { rows: [{ n: "17" }] };
      if (sql.includes("WITH RECURSIVE scoped")) return { rows: [] };
      return undefined;
    });
    const summary = await runCandidateDedupe({ pool, logger: silentLogger });
    expect(summary.skipped_no_embedding).toBe(17);
  });

  it("scopes to a namespace when asked", async () => {
    const { pool, seen } = mergePool([]);
    await runCandidateDedupe({ pool, logger: silentLogger, namespace: "rico" });
    const pairing = expectDefined(
      seen.find((s) => s.text.includes("WITH RECURSIVE scoped")),
      "pairing",
    );
    expect(pairing.values[0]).toBe("rico");
  });

  it("rolls back and rethrows on a failed write", async () => {
    const { pool } = fakePool((sql) => {
      if (sql.includes("count(*)::text AS n")) return { rows: [{ n: "0" }] };
      if (sql.includes("WITH RECURSIVE scoped")) return { rows: [pairRow()] };
      if (sql.includes("DELETE FROM candidate_memory")) {
        throw new Error("deadlock detected");
      }
      return undefined;
    });
    await expect(runCandidateDedupe({ pool, logger: silentLogger })).rejects.toThrow(
      "deadlock detected",
    );
  });

  it("logs counts and a distance, never content or a hash", async () => {
    const records: Array<{ msg: string; fields: Record<string, unknown> }> = [];
    const logger = {
      info: (msg: string, fields: Record<string, unknown>) =>
        records.push({ msg, fields }),
      warn: () => {},
      error: () => {},
    } as unknown as MaintenanceQueueLogger;
    const { pool } = mergePool([pairRow()]);
    await runCandidateDedupe({ pool, logger });
    const done = expectDefined(
      records.find((r) => r.msg === "candidate_dedupe_complete"),
      "done",
    );
    expect(JSON.stringify(done.fields)).not.toContain("hash-dup");
    expect(done.fields).toMatchObject({ merged: 1, reinforced: 1 });
  });
});

describe("readReinforcement — receipts, computed every time", () => {
  it("returns count, first, and last for each candidate", async () => {
    // "0.3 baseline, reinforced three times across sessions on Jun 12, Jul 3,
    // Jul 19" instead of an unexplained number (dream-design.md:709-712).
    const { pool } = fakePool(() => ({
      rows: [
        {
          candidate_id: "c1",
          n: "3",
          first_at: new Date("2026-06-12T00:00:00Z"),
          last_at: new Date("2026-07-19T00:00:00Z"),
        },
      ],
    }));
    const out = await readReinforcement(pool, ["c1"]);
    expect(out.get("c1")).toEqual({
      count: 3,
      first_at: "2026-06-12T00:00:00.000Z",
      last_at: "2026-07-19T00:00:00.000Z",
    });
  });

  it("reads the history table, never a cached column on the candidate", async () => {
    // dream-design.md:686 -- "Reinforcement count must never be denormalized
    // onto the candidate row or cached." A cached count is exactly the
    // staleness bug this epic exists to remove.
    const { pool, seen } = fakePool(() => ({ rows: [] }));
    await readReinforcement(pool, ["c1"]);
    expect(expectDefined(seen[0], "seen[0]").text).toContain(
      "FROM candidate_reinforcement",
    );
    expect(expectDefined(seen[0], "seen[0]").text).not.toContain("candidate_memory");
    expect(expectDefined(seen[0], "seen[0]").text).toContain("count(*)");
  });

  it("issues no query at all for an empty id list", async () => {
    const { pool, seen } = fakePool(() => ({ rows: [] }));
    expect(await readReinforcement(pool, [])).toEqual(new Map());
    expect(seen).toHaveLength(0);
  });

  it("omits a candidate with no reinforcement rather than reporting a zero receipt", async () => {
    // The caller distinguishes "no restatements" from "not looked up"; a
    // fabricated zero row would collapse them.
    const { pool } = fakePool(() => ({ rows: [] }));
    const out = await readReinforcement(pool, ["c1", "c2"]);
    expect(out.has("c1")).toBe(false);
    expect(out.size).toBe(0);
  });
});
