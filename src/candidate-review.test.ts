/**
 * Functional tests for the grading boundary. Issue #394.
 *
 * These are input/output tests at the public boundary, per the repo standard:
 * no coverage target, no assertions about SQL shape. The fake `Queryable`
 * records the statements it is handed only so a test can prove a SECURITY
 * property that is invisible from the return value -- that machine_grade is
 * never named in an UPDATE, and that every statement carries a namespace
 * parameter. Those are the two invariants 037:43-63 exists to protect, and a
 * regression in either is silent by construction.
 *
 * The HTTP layer is exercised through `makeGradingHandler` with real `Request`
 * objects rather than a live socket: same code path, no port allocation, no
 * teardown race.
 */

import { describe, expect, it } from "bun:test";
import type pg from "pg";
import {
  assertNotMachineIdentity,
  clampLimit,
  clampOffset,
  fetchGradeHistory,
  fetchQueue,
  fetchStats,
  gradeCandidate,
  MAX_BATCH_SIZE,
  MAX_QUEUE_LIMIT,
  parseGradedBy,
  parseReviewAction,
  ReviewInputError,
  submitGradeBatch,
  type TransactionalDb,
  undoBatch,
  ungradeCandidate,
} from "./candidate-review.ts";
import { makeGradingHandler } from "./grading-server.ts";

interface Recorded {
  text: string;
  values: unknown[];
}

/**
 * A `pg`-shaped fake that replays canned rows and records what it was asked.
 *
 * `query` is cast to pg's overloaded signature rather than reimplemented: the
 * real type has several overloads (text, config, callback forms) and only the
 * two-argument text form is ever used here. Widening the fake to satisfy all of
 * them would add surface no test exercises.
 */
function fakeDb(responder: (sql: string, values: unknown[]) => unknown[]) {
  const seen: Recorded[] = [];
  const query = (async (text: string, values: unknown[] = []) => {
    seen.push({ text, values });
    return { rows: responder(text, values) };
  }) as unknown as pg.Pool["query"];
  return { seen, query };
}

const CANDIDATE_ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  namespace: "rico",
  candidate_type: "decision",
  content: "switched both",
  content_hash: "hash-a",
  uncertain: true,
  uncertainty_reason: "bare ack",
  authority_tier: null,
  model: "rule-based-distiller/v1",
  machine_grade: null,
  machine_grade_model: null,
  created_at: new Date("2026-07-28T00:00:00Z"),
  source_turn_ids: ["22222222-2222-4222-8222-222222222222"],
};

function queueResponder(sql: string): unknown[] {
  if (sql.includes("FILTER (WHERE reviewed_at IS NULL) AS total")) {
    return [{ total: "3", graded: "7" }];
  }
  if (sql.includes("FROM candidate_memory c")) return [CANDIDATE_ROW];
  if (sql.includes("FROM ob_raw_turns")) {
    return [
      {
        source_id: CANDIDATE_ROW.source_turn_ids[0],
        id: "33333333-3333-4333-8333-333333333333",
        role: "assistant",
        content: "Both hooks now point at the new host.",
        session_ref: "s1",
        session_seq: 4,
        repo: "open-brain",
        occurred_at: new Date("2026-07-27T23:59:00Z"),
        is_human_prompt: false,
      },
      {
        source_id: CANDIDATE_ROW.source_turn_ids[0],
        id: CANDIDATE_ROW.source_turn_ids[0],
        role: "user",
        content: "switched both",
        session_ref: "s1",
        session_seq: 5,
        repo: "open-brain",
        occurred_at: new Date("2026-07-28T00:00:00Z"),
        is_human_prompt: true,
      },
    ];
  }
  if (sql.includes("FROM content_occurrences")) {
    return [
      {
        content_hash: "hash-a",
        occurrence_count: 3,
        session_count: 2,
        first_seen_at: new Date("2026-07-20T00:00:00Z"),
        last_seen_at: new Date("2026-07-28T00:00:00Z"),
      },
    ];
  }
  return [];
}

describe("review action vocabulary", () => {
  it("accepts exactly the four values migration 037 allows", () => {
    for (const a of ["promoted", "rejected", "duplicate", "inconclusive"]) {
      expect(parseReviewAction(a)).toBe(a as never);
    }
  });

  it("rejects a near-miss rather than coercing it", () => {
    // 'pass' is what a UI author would plausibly send. Coercing it to
    // 'promoted' would write a label the operator never chose into the table
    // that is meant to be ground truth (037:78-81).
    for (const bad of [
      "pass",
      "promote",
      "PROMOTED",
      "",
      "approved",
      1,
      null,
    ]) {
      expect(() => parseReviewAction(bad)).toThrow(ReviewInputError);
    }
  });

  it("keeps inconclusive distinct from rejected", () => {
    // 037:35-37: treating "unsure" as "no" is the silent data loss the whole
    // migration exists to stop.
    expect(parseReviewAction("inconclusive")).not.toBe(
      parseReviewAction("rejected"),
    );
  });
});

describe("grader identity", () => {
  it("accepts a human name", () => {
    expect(parseGradedBy("  rico  ")).toBe("rico");
    expect(parseGradedBy("Rico Fowler")).toBe("Rico Fowler");
  });

  it("refuses model-shaped identities with 403", () => {
    for (const m of [
      "claude-opus-5",
      "gpt-4o",
      "REM",
      "qwen3.5",
      "some-agent",
    ]) {
      let status: number | undefined;
      try {
        assertNotMachineIdentity(m);
      } catch (e) {
        status = (e as ReviewInputError).status;
      }
      expect(status).toBe(403);
    }
  });

  it("refuses empty and over-long identities", () => {
    expect(() => parseGradedBy("   ")).toThrow(ReviewInputError);
    expect(() => parseGradedBy("x".repeat(201))).toThrow(ReviewInputError);
  });

  it("refuses model families the original list never named", () => {
    // REGRESSION. The denylist only covered the families this repo runs, so a
    // review pass drove a real grade through as "grok-4" (HTTP 200, row written
    // with graded_by=grok-4). Measured before the fix, all of these were
    // ACCEPTED: grok-4, deepseek-v3, kimi-k2.
    for (const m of [
      "grok-4",
      "deepseek-v3",
      "kimi-k2",
      "gemma-3",
      "mixtral-8x7b",
      "copilot",
      "devin",
    ]) {
      expect(() => parseGradedBy(m)).toThrow(ReviewInputError);
    }
  });

  it("refuses model-SHAPED names whose family word is unknown", () => {
    // The structural layer: the next model ships under a word nobody listed, so
    // the version/size shape is what has to catch it.
    for (const m of [
      "zephyrus-v2",
      "newthing-4.5",
      "unknown-70b",
      "vendor/model",
      "vendor:model",
    ]) {
      expect(() => parseGradedBy(m)).toThrow(ReviewInputError);
    }
  });

  it("still accepts a human operator handle -- no silent lockout", () => {
    // The design (candidate-review.ts:200-207) rejects an allowlist precisely
    // because locking out a new human operator looks like a bug. Tightening the
    // denylist must not acquire that failure mode by accident.
    for (const h of [
      "rico",
      "Rico",
      "rico-m4",
      "jane.doe",
      "operator",
      "rico@bulkbridge.ai",
    ]) {
      expect(parseGradedBy(h)).toBe(h.trim());
    }
  });
});

describe("attention budget", () => {
  it("caps a page at MAX_QUEUE_LIMIT however much is asked for", () => {
    // dream-design.md:825-827 -- "20 is reviewable, 200 gets skipped". A client
    // asking for all 1,104 must not get them.
    expect(clampLimit(1104)).toBe(MAX_QUEUE_LIMIT);
    expect(clampLimit("999")).toBe(MAX_QUEUE_LIMIT);
    expect(clampLimit(5)).toBe(5);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit("nonsense")).toBe(20);
  });

  it("floors a negative offset at zero", () => {
    expect(clampOffset(-10)).toBe(0);
    expect(clampOffset("30")).toBe(30);
  });
});

describe("fetchQueue", () => {
  it("returns candidates hydrated with context, source flags, and live reinforcement", async () => {
    const db = fakeDb(queueResponder);
    const res = await fetchQueue(db, { namespace: "rico", limit: 10 });

    expect(res.total).toBe(3);
    expect(res.graded).toBe(7);
    expect(res.items).toHaveLength(1);

    const item = res.items[0]!;
    expect(item.content).toBe("switched both");
    // Context is what makes a 13-character candidate judgeable at all.
    expect(item.context).toHaveLength(2);
    expect(item.context.map((t) => t.is_source)).toEqual([false, true]);
    // Transcript order, oldest first -- the reviewer reads it as a conversation.
    expect(item.context[0]!.content).toBe(
      "Both hooks now point at the new host.",
    );
    // Computed live from content_occurrences, never denormalized (:686).
    expect(item.reinforcement).toEqual({
      occurrence_count: 3,
      session_count: 2,
      first_seen: "2026-07-20T00:00:00.000Z",
      last_seen: "2026-07-28T00:00:00.000Z",
    });
  });

  it("scopes every statement it issues to the namespace", async () => {
    const db = fakeDb(queueResponder);
    await fetchQueue(db, { namespace: "rico", limit: 10 });
    expect(db.seen.length).toBeGreaterThan(0);
    for (const q of db.seen) {
      expect(q.text).toContain("namespace = $1");
      expect(q.values[0]).toBe("rico");
    }
  });

  it("uses the unreviewed predicate, not a confidence band", async () => {
    // The 0.2-0.5 band of dream-design.md:775-781 is superseded by the
    // let-everything-pass decision encoded in 037:59-63.
    const db = fakeDb(queueResponder);
    await fetchQueue(db, { namespace: "rico" });
    const page = db.seen.find((q) =>
      q.text.includes("FROM candidate_memory c"),
    )!;
    expect(page.text).toContain("reviewed_at IS NULL");
    // uncertain reaches ORDER BY only -- it sorts, it never filters.
    expect(page.text).toContain("ORDER BY c.uncertain DESC");
    expect(page.text).not.toContain("WHERE c.uncertain");
  });

  it("tolerates an empty table -- day-one state", async () => {
    const db = fakeDb((sql) =>
      sql.includes("FILTER (WHERE reviewed_at IS NULL) AS total")
        ? [{ total: "0", graded: "0" }]
        : [],
    );
    const res = await fetchQueue(db, { namespace: "rico" });
    expect(res).toEqual({ items: [], total: 0, graded: 0 });
  });
});

describe("gradeCandidate", () => {
  const graded = {
    id: CANDIDATE_ROW.id,
    review_action: "promoted",
    reviewed_at: new Date("2026-07-28T06:00:00Z"),
    graded_by: "rico",
    machine_grade: null,
  };

  it("writes the action, timestamp, and grader together", async () => {
    const db = fakeDb(() => [graded]);
    const res = await gradeCandidate(db, {
      namespace: "rico",
      id: CANDIDATE_ROW.id,
      action: "promoted",
      gradedBy: "rico",
    });
    expect(res).toMatchObject({
      review_action: "promoted",
      graded_by: "rico",
      reviewed_at: "2026-07-28T06:00:00.000Z",
      agreed: null,
    });
    const sql = db.seen[0]!.text;
    // reviewed_at and review_action must move together or
    // candidate_memory_review_paired (033:104-105) rejects the write.
    expect(sql).toContain("review_action = $3");
    expect(sql).toContain("reviewed_at = now()");
    expect(sql).toContain("graded_by = $4");
  });

  it("NEVER names machine_grade in the update", async () => {
    // Invariant 2. 037:43-57 -- a machine writing there sets reviewed_at and
    // drops the item out of the human queue.
    const db = fakeDb(() => [graded]);
    await gradeCandidate(db, {
      namespace: "rico",
      id: CANDIDATE_ROW.id,
      action: "rejected",
      gradedBy: "rico",
    });
    const sql = db.seen[0]!.text;
    expect(sql).not.toContain("machine_grade =");
    expect(sql).not.toContain("machine_grade_model =");
  });

  it("scopes the write by namespace and reports a cross-namespace miss as not-found", async () => {
    const db = fakeDb(() => []);
    const res = await gradeCandidate(db, {
      namespace: "other",
      id: CANDIDATE_ROW.id,
      action: "promoted",
      gradedBy: "rico",
    });
    expect(res).toBeNull();
    expect(db.seen[0]!.text).toContain("namespace = $1");
    expect(db.seen[0]!.values[0]).toBe("other");
  });

  it("reports agreement against a machine guess when one exists", async () => {
    const db = fakeDb(() => [{ ...graded, machine_grade: "rejected" }]);
    const res = await gradeCandidate(db, {
      namespace: "rico",
      id: CANDIDATE_ROW.id,
      action: "promoted",
      gradedBy: "rico",
    });
    expect(res!.agreed).toBe(false);
    expect(res!.machine_grade).toBe("rejected");
  });

  it("stamps a note with the grader so it cannot be mistaken for a distiller reason", async () => {
    const db = fakeDb(() => [graded]);
    await gradeCandidate(db, {
      namespace: "rico",
      id: CANDIDATE_ROW.id,
      action: "inconclusive",
      gradedBy: "rico",
      note: "cannot tell without the PR",
    });
    expect(db.seen[0]!.values[4]).toBe("[rico] cannot tell without the PR");
  });

  it("leaves uncertainty_reason untouched when there is no note", async () => {
    const db = fakeDb(() => [graded]);
    await gradeCandidate(db, {
      namespace: "rico",
      id: CANDIDATE_ROW.id,
      action: "promoted",
      gradedBy: "rico",
      note: "   ",
    });
    expect(db.seen[0]!.values[4]).toBeNull();
    expect(db.seen[0]!.text).toContain("COALESCE($5, uncertainty_reason)");
  });
});

describe("ungradeCandidate", () => {
  it("clears all three review columns together and only for a graded row", async () => {
    const db = fakeDb(() => [{ id: CANDIDATE_ROW.id }]);
    const res = await ungradeCandidate(db, {
      namespace: "rico",
      id: CANDIDATE_ROW.id,
    });
    expect(res).toEqual({ id: CANDIDATE_ROW.id });
    const sql = db.seen[0]!.text;
    expect(sql).toContain("review_action = NULL");
    expect(sql).toContain("reviewed_at = NULL");
    expect(sql).toContain("graded_by = NULL");
    // Guards against "undoing" a row that was never graded.
    expect(sql).toContain("reviewed_at IS NOT NULL");
    // Undo is the operator's; machine_grade is REM's and is not touched.
    expect(sql).not.toContain("machine_grade");
  });
});

describe("fetchStats", () => {
  it("reports null agreement when nothing is comparable yet", async () => {
    // Reporting 0% from zero samples reads as "the machine is always wrong".
    const db = fakeDb(() => [
      {
        total: "1104",
        ungraded: "1104",
        graded: "0",
        uncertain_ungraded: "830",
        promoted: "0",
        rejected: "0",
        duplicate: "0",
        inconclusive: "0",
        compared: "0",
        agreed: "0",
        distinct_machine_grades: "0",
      },
    ]);
    const s = await fetchStats(db, { namespace: "rico" });
    expect(s.total).toBe(1104);
    expect(s.uncertain_ungraded).toBe(830);
    expect(s.machine_agreement).toEqual({
      compared: 0,
      agreed: 0,
      rate: null,
      distinct_machine_grades: 0,
    });
  });

  it("flags a constant machine grader, whose rate is not a trust signal", async () => {
    // dream-design.md:807-814 requires confidence be MEASURED, not claimed, and
    // calls thresholds on a self-reported number theatre. Measured on the
    // dogfood clone 2026-07-28, REM graded 1103 of 1104 candidates
    // `inconclusive`; against a constant predictor the rate reflects only the
    // operator's own action mix, so the degeneracy must be visible in the stat
    // instead of hidden behind a plausible percentage. This asserts the
    // disclosure, not a grader change -- the one-off promotion rule is still
    // the open hole at dream-design.md:816-821.
    const db = fakeDb(() => [
      {
        total: "1104",
        ungraded: "1101",
        graded: "3",
        uncertain_ungraded: "829",
        promoted: "3",
        rejected: "0",
        duplicate: "0",
        inconclusive: "0",
        compared: "3",
        agreed: "0",
        distinct_machine_grades: "1",
      },
    ]);
    const s = await fetchStats(db, { namespace: "rico" });
    expect(s.machine_agreement.rate).toBe(0);
    expect(s.machine_agreement.distinct_machine_grades).toBe(1);
  });

  it("computes the agreement rate once there are comparable pairs", async () => {
    const db = fakeDb(() => [
      {
        total: "10",
        ungraded: "6",
        graded: "4",
        uncertain_ungraded: "2",
        promoted: "2",
        rejected: "1",
        duplicate: "0",
        inconclusive: "1",
        compared: "4",
        agreed: "3",
        distinct_machine_grades: "3",
      },
    ]);
    const s = await fetchStats(db, { namespace: "rico" });
    expect(s.machine_agreement.rate).toBeCloseTo(0.75, 5);
    // >1 distinct grade is what makes the rate meaningful at all.
    expect(s.machine_agreement.distinct_machine_grades).toBe(3);
    expect(s.by_action).toEqual({
      promoted: 2,
      rejected: 1,
      duplicate: 0,
      inconclusive: 1,
    });
  });
});

/**
 * A transactional fake.
 *
 * It models the ONE property the batch writer depends on and that a plain
 * `query` fake cannot express: statements issued after BEGIN are provisional
 * until COMMIT. `committed` holds only what survived, so "the batch rolled back"
 * is observable as an outcome rather than inferred from the SQL text.
 */
function fakeTxDb(responder: (sql: string, values: unknown[]) => unknown[]) {
  const seen: Recorded[] = [];
  const committed: Recorded[] = [];
  let pending: Recorded[] = [];
  let inTx = false;
  let released = 0;

  const query = (async (text: string, values: unknown[] = []) => {
    const rec = { text, values };
    seen.push(rec);
    if (text === "BEGIN") {
      inTx = true;
      pending = [];
      return { rows: [] };
    }
    if (text === "COMMIT") {
      committed.push(...pending);
      pending = [];
      inTx = false;
      return { rows: [] };
    }
    if (text === "ROLLBACK") {
      pending = [];
      inTx = false;
      return { rows: [] };
    }
    if (inTx && /\bUPDATE\b|\bINSERT\b|\bDELETE\b/.test(text))
      pending.push(rec);
    return { rows: responder(text, values) };
  }) as unknown as pg.Pool["query"];

  const db: TransactionalDb & {
    seen: Recorded[];
    committed: Recorded[];
    released: () => number;
  } = {
    query,
    connect: async () => ({
      query,
      release: () => {
        released += 1;
      },
    }),
    seen,
    committed,
    released: () => released,
  };
  return db;
}

const BATCH_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ID = "44444444-4444-4444-8444-444444444444";

/** Responder for a batch that grades two real candidates for the first time. */
function batchResponder(sql: string): unknown[] {
  if (sql.includes("gen_random_uuid() AS batch_id")) {
    return [{ batch_id: BATCH_ID }];
  }
  if (sql.includes("UPDATE candidate_memory")) {
    return [{ id: CANDIDATE_ROW.id, machine_grade: "inconclusive" }];
  }
  // No live grade to supersede: a first grade on this candidate.
  if (sql.includes("UPDATE candidate_grade")) return [];
  if (sql.includes("INSERT INTO candidate_grade")) {
    return [{ id: "99999999-9999-4999-8999-999999999999" }];
  }
  return [];
}

describe("submitGradeBatch", () => {
  const grades = [
    { candidateId: CANDIDATE_ROW.id, action: "promoted", note: "clear call" },
    { candidateId: OTHER_ID, action: "rejected" },
  ];

  it("commits the whole batch under one batch_id", async () => {
    const db = fakeTxDb(batchResponder);
    const res = await submitGradeBatch(db, {
      namespace: "rico",
      gradedBy: "rico",
      grades,
    });
    expect(res.batch_id).toBe(BATCH_ID);
    expect(res.graded_by).toBe("rico");
    expect(res.results).toHaveLength(2);
    expect(res.results.map((r) => r.action)).toEqual(["promoted", "rejected"]);
    // Every insert carries the same batch id, which is what makes undo able to
    // pull the submission back as a unit.
    const inserts = db.committed.filter((q) =>
      q.text.includes("INSERT INTO candidate_grade"),
    );
    expect(inserts).toHaveLength(2);
    for (const i of inserts) expect(i.values[5]).toBe(BATCH_ID);
  });

  it("puts the note in candidate_grade.note and NEVER in uncertainty_reason", async () => {
    // The whole reason 040 exists. uncertainty_reason is the DISTILLER's
    // statement about its own doubt; the pre-040 path overwrote it with operator
    // prose, destroying the machine's reason and filing the human's words under
    // a machine-owned meaning.
    const db = fakeTxDb(batchResponder);
    await submitGradeBatch(db, {
      namespace: "rico",
      gradedBy: "rico",
      grades,
    });
    const insert = db.committed.find((q) =>
      q.text.includes("INSERT INTO candidate_grade"),
    )!;
    expect(insert.values[3]).toBe("clear call");
    for (const q of db.seen) {
      expect(q.text).not.toContain("uncertainty_reason");
    }
  });

  it("rolls the WHOLE batch back when one item is not in this namespace", async () => {
    // A partial batch is the worst outcome: the operator sent 20 grades, some
    // number landed, and the page cannot say which.
    const db = fakeTxDb((sql, values) => {
      if (sql.includes("UPDATE candidate_memory")) {
        // Second candidate matches no row -- an id from another namespace.
        return values[1] === OTHER_ID
          ? []
          : [{ id: CANDIDATE_ROW.id, machine_grade: null }];
      }
      return batchResponder(sql);
    });
    await expect(
      submitGradeBatch(db, { namespace: "rico", gradedBy: "rico", grades }),
    ).rejects.toThrow(ReviewInputError);

    // The first item's writes were issued but did NOT survive.
    expect(
      db.seen.some((q) => q.text.includes("INSERT INTO candidate_grade")),
    ).toBe(true);
    expect(db.committed).toHaveLength(0);
    expect(db.seen.some((q) => q.text === "ROLLBACK")).toBe(true);
    expect(db.seen.some((q) => q.text === "COMMIT")).toBe(false);
  });

  it("rolls back when the database fails mid-batch, and releases the connection", async () => {
    let inserts = 0;
    const db = fakeTxDb((sql) => {
      if (sql.includes("INSERT INTO candidate_grade")) {
        inserts += 1;
        if (inserts === 2) throw new Error("deadlock detected");
      }
      return batchResponder(sql);
    });
    await expect(
      submitGradeBatch(db, { namespace: "rico", gradedBy: "rico", grades }),
    ).rejects.toThrow("deadlock detected");
    expect(db.committed).toHaveLength(0);
    // A leaked connection exhausts the pool and the next Send hangs.
    expect(db.released()).toBe(1);
  });

  it("validates every action before opening the transaction", async () => {
    const db = fakeTxDb(batchResponder);
    await expect(
      submitGradeBatch(db, {
        namespace: "rico",
        gradedBy: "rico",
        grades: [
          { candidateId: CANDIDATE_ROW.id, action: "promoted" },
          { candidateId: OTHER_ID, action: "pass" },
        ],
      }),
    ).rejects.toThrow(ReviewInputError);
    // Not one statement issued -- not even BEGIN.
    expect(db.seen).toHaveLength(0);
  });

  it("names which item was bad so the operator can fix that one", async () => {
    const db = fakeTxDb(batchResponder);
    let message = "";
    try {
      await submitGradeBatch(db, {
        namespace: "rico",
        gradedBy: "rico",
        grades: [
          { candidateId: CANDIDATE_ROW.id, action: "promoted" },
          { candidateId: OTHER_ID, action: "approve" },
        ],
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("grades[1]");
  });

  it("refuses a batch that grades the same candidate twice", async () => {
    // Both inserts would collide on idx_candidate_grade_current inside the
    // transaction, failing the whole submission with a constraint error the
    // operator cannot act on.
    const db = fakeTxDb(batchResponder);
    await expect(
      submitGradeBatch(db, {
        namespace: "rico",
        gradedBy: "rico",
        grades: [
          { candidateId: CANDIDATE_ROW.id, action: "promoted" },
          { candidateId: CANDIDATE_ROW.id, action: "rejected" },
        ],
      }),
    ).rejects.toThrow(/appears twice/);
    expect(db.seen).toHaveLength(0);
  });

  it("refuses an empty, non-array, or over-large batch", async () => {
    const db = fakeTxDb(batchResponder);
    for (const bad of [[], "nope", null, 5, undefined]) {
      await expect(
        submitGradeBatch(db, {
          namespace: "rico",
          gradedBy: "rico",
          grades: bad,
        }),
      ).rejects.toThrow(ReviewInputError);
    }
    const huge = Array.from({ length: MAX_BATCH_SIZE + 1 }, () => ({
      candidateId: CANDIDATE_ROW.id,
      action: "promoted",
    }));
    await expect(
      submitGradeBatch(db, {
        namespace: "rico",
        gradedBy: "rico",
        grades: huge,
      }),
    ).rejects.toThrow(/at most/);
    expect(db.seen).toHaveLength(0);
  });

  it("refuses a machine grader identity for the whole batch", async () => {
    const db = fakeTxDb(batchResponder);
    await expect(
      submitGradeBatch(db, {
        namespace: "rico",
        gradedBy: "claude-opus-5",
        grades,
      }),
    ).rejects.toThrow(ReviewInputError);
    expect(db.seen).toHaveLength(0);
  });

  it("refuses an item carrying machine_grade with 403", async () => {
    const db = fakeTxDb(batchResponder);
    let status: number | undefined;
    try {
      await submitGradeBatch(db, {
        namespace: "rico",
        gradedBy: "rico",
        grades: [
          {
            candidateId: CANDIDATE_ROW.id,
            action: "promoted",
            machine_grade: "rejected",
          },
        ],
      });
    } catch (e) {
      status = (e as ReviewInputError).status;
    }
    expect(status).toBe(403);
  });

  it("writes no machine_grade on any statement it issues", async () => {
    const db = fakeTxDb(batchResponder);
    await submitGradeBatch(db, {
      namespace: "rico",
      gradedBy: "rico",
      grades,
    });
    for (const q of db.seen) {
      if (!/\bUPDATE\b|\bINSERT\b/.test(q.text)) continue;
      expect(q.text).not.toContain("machine_grade =");
      expect(q.text).not.toContain("machine_grade,");
    }
  });

  it("scopes every statement to the namespace", async () => {
    const db = fakeTxDb(batchResponder);
    await submitGradeBatch(db, {
      namespace: "rico",
      gradedBy: "rico",
      grades,
    });
    for (const q of db.seen) {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(q.text)) continue;
      if (q.text.includes("gen_random_uuid() AS batch_id")) continue;
      expect(q.text).toContain("$1");
      expect(q.values[0]).toBe("rico");
    }
  });

  it("supersedes the previous live grade rather than overwriting it", async () => {
    // 040's partial unique index permits exactly one live grade per candidate,
    // so a regrade MUST mark the old row superseded. The old row survives: that
    // history is the point of the table.
    const db = fakeTxDb((sql) => {
      if (sql.includes("UPDATE candidate_grade")) {
        return [{ id: "77777777-7777-4777-8777-777777777777" }];
      }
      return batchResponder(sql);
    });
    const res = await submitGradeBatch(db, {
      namespace: "rico",
      gradedBy: "rico",
      grades: [{ candidateId: CANDIDATE_ROW.id, action: "rejected" }],
    });
    expect(res.results[0]!.superseded_grade_id).toBe(
      "77777777-7777-4777-8777-777777777777",
    );
    const supersede = db.committed.find((q) =>
      q.text.includes("SET superseded_at = now()"),
    )!;
    expect(supersede.text).toContain("superseded_at IS NULL");
    // No DELETE of the old judgement anywhere on the regrade path.
    expect(db.seen.some((q) => /\bDELETE\b/.test(q.text))).toBe(false);
  });

  it("reports agreement against REM's guess per item", async () => {
    const db = fakeTxDb(batchResponder);
    const res = await submitGradeBatch(db, {
      namespace: "rico",
      gradedBy: "rico",
      grades: [
        { candidateId: CANDIDATE_ROW.id, action: "inconclusive" },
        { candidateId: OTHER_ID, action: "promoted" },
      ],
    });
    // The fake reports machine_grade = 'inconclusive' for both.
    expect(res.results[0]!.agreed).toBe(true);
    expect(res.results[1]!.agreed).toBe(false);
  });

  it("reports whether a note existed without echoing it back", async () => {
    // Operator prose about real dialogue must not ride in a response body that
    // anything downstream might log.
    const db = fakeTxDb(batchResponder);
    const res = await submitGradeBatch(db, {
      namespace: "rico",
      gradedBy: "rico",
      grades,
    });
    expect(res.results[0]!.has_note).toBe(true);
    expect(res.results[1]!.has_note).toBe(false);
    expect(JSON.stringify(res)).not.toContain("clear call");
  });

  it("treats a whitespace-only note as no note at all", async () => {
    const db = fakeTxDb(batchResponder);
    await submitGradeBatch(db, {
      namespace: "rico",
      gradedBy: "rico",
      grades: [
        { candidateId: CANDIDATE_ROW.id, action: "promoted", note: "   " },
      ],
    });
    const insert = db.committed.find((q) =>
      q.text.includes("INSERT INTO candidate_grade"),
    )!;
    expect(insert.values[3]).toBeNull();
  });
});

describe("undoBatch", () => {
  function undoResponder(sql: string): unknown[] {
    if (sql.includes("DELETE FROM candidate_grade")) {
      return [
        {
          id: "99999999-9999-4999-8999-999999999999",
          candidate_id: CANDIDATE_ROW.id,
          created_at: new Date("2026-07-28T06:00:00Z"),
        },
      ];
    }
    if (sql.includes("SET superseded_at = NULL")) return [];
    if (sql.includes("UPDATE candidate_memory"))
      return [{ id: CANDIDATE_ROW.id }];
    return [];
  }

  it("removes the batch's grades and reconciles the candidates in one transaction", async () => {
    const db = fakeTxDb(undoResponder);
    const res = await undoBatch(db, { namespace: "rico", batchId: BATCH_ID });
    expect(res).toEqual({
      batch_id: BATCH_ID,
      removed: 1,
      restored: 0,
      candidates: 1,
    });
    expect(db.seen.some((q) => q.text === "COMMIT")).toBe(true);
    const del = db.committed.find((q) => q.text.includes("DELETE FROM"))!;
    expect(del.text).toContain("namespace = $1");
    expect(del.values).toEqual(["rico", BATCH_ID]);
  });

  it("restores what the batch superseded, so an undone regrade returns the old answer", async () => {
    // Deleting the regrade without un-superseding would leave the candidate with
    // a grade history and NO live grade -- a state no other path can produce.
    const db = fakeTxDb((sql) =>
      sql.includes("SET superseded_at = NULL")
        ? [{ id: "77777777-7777-4777-8777-777777777777" }]
        : undoResponder(sql),
    );
    const res = await undoBatch(db, { namespace: "rico", batchId: BATCH_ID });
    expect(res!.restored).toBe(1);
    const restore = db.committed.find((q) =>
      q.text.includes("SET superseded_at = NULL"),
    )!;
    // DISTINCT ON: several regrades leave several superseded rows and restoring
    // more than one violates idx_candidate_grade_current.
    expect(restore.text).toContain("DISTINCT ON (candidate_id)");
  });

  it("returns null and writes nothing for an unknown or cross-namespace batch", async () => {
    const db = fakeTxDb(() => []);
    const res = await undoBatch(db, { namespace: "rico", batchId: BATCH_ID });
    expect(res).toBeNull();
    expect(db.committed).toHaveLength(0);
    expect(db.seen.some((q) => q.text === "ROLLBACK")).toBe(true);
  });

  it("rejects a non-uuid batch id before touching the database", async () => {
    const db = fakeTxDb(undoResponder);
    await expect(
      undoBatch(db, { namespace: "rico", batchId: "not-a-uuid" }),
    ).rejects.toThrow(ReviewInputError);
    expect(db.seen).toHaveLength(0);
  });

  it("refuses a machine identity -- a model may not retract human labels either", async () => {
    const db = fakeTxDb(undoResponder);
    await expect(
      undoBatch(db, {
        namespace: "rico",
        batchId: BATCH_ID,
        gradedBy: "gpt-4o",
      }),
    ).rejects.toThrow(ReviewInputError);
    expect(db.seen).toHaveLength(0);
  });

  it("never touches machine_grade", async () => {
    const db = fakeTxDb(undoResponder);
    await undoBatch(db, { namespace: "rico", batchId: BATCH_ID });
    for (const q of db.seen) expect(q.text).not.toContain("machine_grade");
  });

  it("releases the connection even when the database fails", async () => {
    const db = fakeTxDb((sql) => {
      if (sql.includes("DELETE FROM")) throw new Error("connection reset");
      return undoResponder(sql);
    });
    await expect(
      undoBatch(db, { namespace: "rico", batchId: BATCH_ID }),
    ).rejects.toThrow("connection reset");
    expect(db.released()).toBe(1);
  });
});

describe("fetchGradeHistory", () => {
  const GRADE_ROW = {
    grade_id: "99999999-9999-4999-8999-999999999999",
    candidate_id: CANDIDATE_ROW.id,
    action: "promoted",
    note: "clear call",
    graded_by: "rico",
    batch_id: BATCH_ID,
    created_at: new Date("2026-07-28T06:00:00Z"),
    superseded_at: null,
    candidate_type: "decision",
    content: "switched both",
    uncertain: true,
    uncertainty_reason: "bare ack",
    machine_grade: "inconclusive",
  };

  function historyResponder(sql: string): unknown[] {
    if (sql.includes("count(*) AS total FROM candidate_grade")) {
      return [{ total: "12" }];
    }
    if (sql.includes("GROUP BY batch_id")) {
      return [
        {
          batch_id: BATCH_ID,
          size: "2",
          created_at: new Date("2026-07-28T06:00:00Z"),
          live_rows: "2",
        },
      ];
    }
    if (sql.includes("FROM candidate_grade g")) return [GRADE_ROW];
    return [];
  }

  it("returns grades newest-first with the candidate content beside them", async () => {
    // Finding an item to change by uuid is not something an operator can do;
    // finding it by reading the claim they graded ten minutes ago is.
    const db = fakeDb(historyResponder);
    const res = await fetchGradeHistory(db, { namespace: "rico" });
    expect(res.total).toBe(12);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      action: "promoted",
      note: "clear call",
      content: "switched both",
      machine_grade: "inconclusive",
      superseded_at: null,
    });
    const page = db.seen.find((q) =>
      q.text.includes("FROM candidate_grade g"),
    )!;
    expect(page.text).toContain("ORDER BY g.created_at DESC");
  });

  it("scopes the join on BOTH sides so content cannot cross a namespace", async () => {
    const db = fakeDb(historyResponder);
    await fetchGradeHistory(db, { namespace: "rico" });
    const page = db.seen.find((q) =>
      q.text.includes("FROM candidate_grade g"),
    )!;
    expect(page.text).toContain("c.namespace = $1");
    expect(page.text).toContain("g.namespace = $1");
    for (const q of db.seen) expect(q.values[0]).toBe("rico");
  });

  it("lists batches newest-first so the page can offer undo", async () => {
    const db = fakeDb(historyResponder);
    const res = await fetchGradeHistory(db, { namespace: "rico" });
    expect(res.batches).toEqual([
      {
        batch_id: BATCH_ID,
        size: 2,
        created_at: "2026-07-28T06:00:00.000Z",
        live: true,
      },
    ]);
  });

  it("marks a batch not-live once part of it has been superseded", async () => {
    const db = fakeDb((sql) =>
      sql.includes("GROUP BY batch_id")
        ? [
            {
              batch_id: BATCH_ID,
              size: "2",
              created_at: new Date("2026-07-28T06:00:00Z"),
              live_rows: "1",
            },
          ]
        : historyResponder(sql),
    );
    const res = await fetchGradeHistory(db, { namespace: "rico" });
    expect(res.batches[0]!.live).toBe(false);
  });

  it("keeps superseded rows visible -- a changed mind is evidence", async () => {
    const db = fakeDb((sql) =>
      sql.includes("FROM candidate_grade g")
        ? [{ ...GRADE_ROW, superseded_at: new Date("2026-07-28T07:00:00Z") }]
        : historyResponder(sql),
    );
    const res = await fetchGradeHistory(db, { namespace: "rico" });
    expect(res.items[0]!.superseded_at).toBe("2026-07-28T07:00:00.000Z");
    const page = db.seen.find((q) =>
      q.text.includes("FROM candidate_grade g"),
    )!;
    expect(page.text).not.toContain("superseded_at IS NULL");
  });

  it("obeys the same attention cap as the queue", async () => {
    const db = fakeDb(historyResponder);
    await fetchGradeHistory(db, { namespace: "rico", limit: 999 });
    const page = db.seen.find((q) =>
      q.text.includes("FROM candidate_grade g"),
    )!;
    expect(page.values[1]).toBe(MAX_QUEUE_LIMIT);
  });
});

describe("HTTP boundary", () => {
  const handlerFor = (
    responder: (sql: string, values: unknown[]) => unknown[],
  ) =>
    makeGradingHandler({
      pool: fakeDb(responder),
      namespace: "rico",
      gradedBy: "rico",
    });

  it("serves the page as HTML at /", async () => {
    const res = await handlerFor(queueResponder)(
      new Request("http://127.0.0.1/"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Candidate grading");
    // The four keys the operator asked for, bound in the page itself.
    expect(body).toContain(
      '"1": "promoted", "2": "rejected", "3": "inconclusive", "4": "duplicate"',
    );
  });

  it("refuses to construct with a machine grader identity", () => {
    // Fails at startup, not on the first grade -- discovering it after the
    // operator has already made a judgement wastes the scarce resource.
    expect(() =>
      makeGradingHandler({
        pool: fakeDb(() => []),
        namespace: "rico",
        gradedBy: "claude-opus-5",
      }),
    ).toThrow(ReviewInputError);
  });

  it("rejects a grade body carrying machine_grade with 403", async () => {
    const res = await handlerFor(() => [])(
      new Request("http://127.0.0.1/api/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: CANDIDATE_ROW.id,
          action: "promoted",
          machine_grade: "rejected",
        }),
      }),
    );
    expect(res.status).toBe(403);
    const err = (await res.json()) as { error: string };
    expect(err.error).toContain("machine_grade is not writable");
  });

  it("rejects a non-uuid id before it reaches the database", async () => {
    const db = fakeDb(() => []);
    const handler = makeGradingHandler({
      pool: db,
      namespace: "rico",
      gradedBy: "rico",
    });
    const res = await handler(
      new Request("http://127.0.0.1/api/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "not-a-uuid", action: "promoted" }),
      }),
    );
    expect(res.status).toBe(400);
    // A bad uuid would raise Postgres 22P02 and surface as a 500 for what is a
    // client mistake, so it must never reach the pool.
    expect(db.seen).toHaveLength(0);
  });

  it("returns 404 for an id that matches no row in this namespace", async () => {
    const res = await handlerFor(() => [])(
      new Request("http://127.0.0.1/api/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: CANDIDATE_ROW.id, action: "promoted" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("rejects malformed JSON with 400, not 500", async () => {
    const res = await handlerFor(() => [])(
      new Request("http://127.0.0.1/api/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("serves the queue as JSON with no-store", async () => {
    const res = await handlerFor(queueResponder)(
      new Request("http://127.0.0.1/api/queue?limit=5"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { items: Array<{ context: unknown[] }> };
    expect(body.items[0]!.context).toHaveLength(2);
  });

  it("404s an unknown route", async () => {
    const res = await handlerFor(() => [])(
      new Request("http://127.0.0.1/api/nope"),
    );
    expect(res.status).toBe(404);
  });
});
