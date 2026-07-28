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
  fetchQueue,
  fetchStats,
  gradeCandidate,
  MAX_QUEUE_LIMIT,
  parseGradedBy,
  parseReviewAction,
  ReviewInputError,
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
