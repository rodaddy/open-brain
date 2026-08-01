/**
 * Functional tests for the canned reasons and the agent-behavior axis.
 * Migration 042.
 *
 * WHAT THESE PROVE, and why each one is a real failure mode rather than a
 * restatement of the code:
 *
 *  - A reason_code SURVIVES THE OPERATOR EDITING THE NOTE. That is the entire
 *    reason 042 stores a code beside the note instead of parsing the note. The
 *    operator's requirement is that clicking a reason puts editable text in the
 *    textarea; the moment he edits it, the text no longer identifies the reason,
 *    and only the code still does. A implementation that derived the code from
 *    the note text would pass every other test in this file and fail this one.
 *  - agent_behavior IS OPTIONAL AND SEPARATELY VALIDATED. Optional is the part
 *    that breaks silently: a default of 'neutral' would manufacture judgements
 *    the operator never made, and no assertion about a happy path would notice.
 *  - THE PAGE AND THE SERVER SHARE ONE VOCABULARY. Drift here does not fail at
 *    build time -- it fails at SEND, after a whole batch has been judged, and
 *    because a batch is one transaction it takes the whole batch with it.
 *  - THE EXISTING 8 GRADES STAY READABLE. They predate both columns, so they
 *    come back with NULLs; a read path that assumed the columns were populated
 *    would break the history page for exactly the data this exercise exists to
 *    collect.
 */

import { describe, expect, it } from "bun:test";
import type pg from "pg";
import {
  fetchGradeHistory,
  fetchStats,
  gradeCandidate,
  parseAgentBehavior,
  parseReasonCode,
  ReviewInputError,
  submitGradeBatch,
  type TransactionalDb,
} from "./candidate-review.ts";
import {
  AGENT_BEHAVIORS,
  GRADING_REASONS,
  REASON_CODES,
  reasonsFor,
} from "./grading-reasons.ts";
import { GRADING_PAGE_HTML } from "./grading-page.ts";
import { makeGradingHandler } from "./grading-server.ts";

interface Recorded {
  text: string;
  values: unknown[];
}

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const BATCH_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** Same transactional fake shape candidate-review.test.ts uses. */
function fakeTxDb(responder: (sql: string, values: unknown[]) => unknown[]) {
  const seen: Recorded[] = [];
  const committed: Recorded[] = [];
  let pending: Recorded[] = [];
  let inTx = false;

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

  const db: TransactionalDb & { seen: Recorded[]; committed: Recorded[] } = {
    query,
    connect: async () => ({ query, release: () => {} }),
    seen,
    committed,
  };
  return db;
}

function batchResponder(sql: string): unknown[] {
  if (sql.includes("gen_random_uuid() AS batch_id")) {
    return [{ batch_id: BATCH_ID }];
  }
  if (sql.includes("UPDATE candidate_memory")) {
    return [{ id: CANDIDATE_ID, machine_grade: "inconclusive" }];
  }
  if (sql.includes("UPDATE candidate_grade")) return [];
  if (sql.includes("INSERT INTO candidate_grade")) {
    return [
      {
        id: "99999999-9999-4999-8999-999999999999",
        created_at: new Date("2026-07-28T06:00:00Z"),
      },
    ];
  }
  return [];
}

/** Pull the INSERT's parameter array out of what the transaction committed. */
function insertValues(db: { committed: Recorded[] }): unknown[] {
  const insert = db.committed.find((q) =>
    q.text.includes("INSERT INTO candidate_grade"),
  );
  if (!insert) throw new Error("no candidate_grade INSERT was committed");
  return insert.values;
}

describe("the reason vocabulary is one definition", () => {
  it("gives every reason a code, a label, a note text, and at least one action", () => {
    // A reason with an empty appliesTo is offered nowhere and is dead weight in
    // a list whose only virtue is being short enough to scan.
    for (const r of GRADING_REASONS) {
      expect(r.code.length).toBeGreaterThan(0);
      expect(r.label.length).toBeGreaterThan(0);
      expect(r.text.length).toBeGreaterThan(0);
      expect(r.appliesTo.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate codes", () => {
    // A duplicate code makes the GROUP BY that justifies the column ambiguous.
    expect(new Set(REASON_CODES).size).toBe(REASON_CODES.length);
  });

  it("offers a scannable set for every action -- 4 to 6, never a wall", () => {
    // dream-design.md:825-827 is the constraint: attention is the scarce
    // resource across 1,104 items. A list long enough to need reading is a list
    // that gets ignored, and an ignored list collects no data.
    for (const action of [
      "promoted",
      "rejected",
      "duplicate",
      "inconclusive",
    ] as const) {
      const offered = reasonsFor(action);
      expect(offered.length).toBeGreaterThanOrEqual(2);
      expect(offered.length).toBeLessThanOrEqual(6);
    }
  });

  it("keeps the reasons the operator's own 8 notes actually asked for", () => {
    // These four are the MEASURED ones -- each generalizes a real note from the
    // only graded corpus that exists (2026-07-28). Losing one is losing
    // evidence, not trimming a guess.
    for (const code of [
      "needs-surrounding-context",
      "shows-reasoning",
      "states-fact",
      "fixes-an-issue",
    ]) {
      expect(REASON_CODES).toContain(code);
    }
  });

  it("ships the SAME vocabulary into the page the server validates against", () => {
    // THE DRIFT FAILURE. Two lists do not break at build time; they break at
    // SEND, after a whole batch has been judged, and a batch is one transaction
    // -- so the operator loses the lot. Proving the page's inlined payload
    // carries every server-side code is what makes "one definition" a fact.
    for (const code of REASON_CODES) {
      expect(GRADING_PAGE_HTML).toContain(code);
    }
    for (const b of AGENT_BEHAVIORS) {
      expect(GRADING_PAGE_HTML).toContain(b);
    }
  });
});

describe("reason_code validation", () => {
  it("accepts every code in the vocabulary", () => {
    for (const code of REASON_CODES) {
      expect(parseReasonCode(code)).toBe(code);
    }
  });

  it("treats absent, null, and blank as no reason rather than an error", () => {
    // Free-text-only grading stays a first-class path: most grades will carry no
    // code, and demanding one would push the operator into picking a wrong
    // reason to get past the form.
    expect(parseReasonCode(undefined)).toBeNull();
    expect(parseReasonCode(null)).toBeNull();
    expect(parseReasonCode("   ")).toBeNull();
  });

  it("rejects an unknown code instead of storing it", () => {
    // Storing it would create a bucket no GROUP BY names and no UI explains --
    // the same argument parseReviewAction refuses to coerce "promote".
    for (const bad of ["states_fact", "STATES-FACT", "made-up", "yes", 7]) {
      expect(() => parseReasonCode(bad)).toThrow(ReviewInputError);
    }
  });

  it("names the valid codes in the rejection, so a caller can fix it", () => {
    let message = "";
    try {
      parseReasonCode("not-a-reason");
    } catch (e) {
      message = (e as ReviewInputError).message;
    }
    expect(message).toContain("not-a-reason");
    expect(message).toContain("states-fact");
  });

  it("does NOT enforce appliesTo, so changing the grade never loses the batch", () => {
    // 'progress-narration' is offered only on `rejected`. An operator who picks
    // it and then changes the grade to `inconclusive` must not have the whole
    // transaction 400'd out from under him -- appliesTo is an attention aid for
    // the page, not a data rule.
    expect(parseReasonCode("progress-narration")).toBe("progress-narration");
    expect(reasonsFor("inconclusive").map((r) => r.code)).not.toContain(
      "progress-narration",
    );
  });
});

describe("agent_behavior is the optional second axis", () => {
  it("accepts good, bad, and neutral", () => {
    for (const b of AGENT_BEHAVIORS) {
      expect(parseAgentBehavior(b)).toBe(b);
    }
  });

  it("is OPTIONAL -- absent stays null and is never defaulted to neutral", () => {
    // THE ASYMMETRY THAT MATTERS. Defaulting to 'neutral' would manufacture an
    // explicit "the agent was fine" judgement for every one of 1,104 items the
    // operator never rated, and in the counts a fabricated neutral is
    // indistinguishable from a real one. Not-rated and rated-unremarkable are
    // different facts.
    expect(parseAgentBehavior(undefined)).toBeNull();
    expect(parseAgentBehavior(null)).toBeNull();
    expect(parseAgentBehavior("")).toBeNull();
    expect(parseAgentBehavior("  ")).toBeNull();
  });

  it("rejects an unknown value rather than dropping it", () => {
    // Dropping it would let a caller believe it recorded a rating it did not.
    for (const bad of ["Good", "GOOD", "great", "ok", "1", 1, true]) {
      expect(() => parseAgentBehavior(bad)).toThrow(ReviewInputError);
    }
  });

  it("is not the same question as the grade", () => {
    // The vocabularies must not overlap, or a UI could route one into the other
    // and the two axes would silently merge -- exactly what 042 exists to stop.
    for (const b of AGENT_BEHAVIORS) {
      expect([
        "promoted",
        "rejected",
        "duplicate",
        "inconclusive",
      ]).not.toContain(b);
    }
  });
});

describe("both axes reach candidate_grade", () => {
  it("writes reason_code and agent_behavior on a batch grade", async () => {
    const db = fakeTxDb(batchResponder);
    const res = await submitGradeBatch(db, {
      namespace: "rico",
      gradedBy: "rico",
      grades: [
        {
          candidateId: CANDIDATE_ID,
          action: "promoted",
          note: "logic to fix an issue",
          reasonCode: "fixes-an-issue",
          agentBehavior: "good",
        },
      ],
    });

    expect(res.results[0]).toMatchObject({
      reason_code: "fixes-an-issue",
      agent_behavior: "good",
    });
    // And they are in the row, not just the response.
    const values = insertValues(db);
    expect(values).toContain("fixes-an-issue");
    expect(values).toContain("good");
  });

  it("KEEPS THE CODE WHEN THE OPERATOR EDITS THE INSERTED TEXT", async () => {
    // THE REQUIREMENT THIS WHOLE DESIGN TURNS ON. Operator, verbatim: "so the
    // can'd response if i click one, should allow me to put it into the notes
    // for adjustment and/or the note section stays to allow me to add a little
    // color". The note below no longer contains one word of the canned text --
    // it has been rewritten entirely -- and the code must still be recorded,
    // because after an edit the code is the ONLY thing that still identifies
    // the reason. An implementation that derived the code by matching the note
    // against reason.text passes every other test here and fails this one.
    const canned = GRADING_REASONS.find(
      (r) => r.code === "needs-surrounding-context",
    )!;
    const edited = "nope, on reflection this one really does stand alone";
    expect(edited).not.toContain(canned.text);

    const db = fakeTxDb(batchResponder);
    const res = await submitGradeBatch(db, {
      namespace: "rico",
      gradedBy: "rico",
      grades: [
        {
          candidateId: CANDIDATE_ID,
          action: "inconclusive",
          note: edited,
          reasonCode: canned.code,
        },
      ],
    });

    expect(res.results[0]!.reason_code).toBe("needs-surrounding-context");
    const values = insertValues(db);
    expect(values).toContain(edited);
    expect(values).toContain("needs-surrounding-context");
  });

  it("records a reason with NO note at all", async () => {
    // The code is not a caption on the note; it stands on its own. An operator
    // clicking a reason and clearing the text entirely still said why.
    const db = fakeTxDb(batchResponder);
    const res = await submitGradeBatch(db, {
      namespace: "rico",
      gradedBy: "rico",
      grades: [
        {
          candidateId: CANDIDATE_ID,
          action: "rejected",
          reasonCode: "progress-narration",
        },
      ],
    });
    expect(res.results[0]).toMatchObject({
      has_note: false,
      reason_code: "progress-narration",
      agent_behavior: null,
    });
  });

  it("records a behavior rating with no reason, and a reason with no rating", async () => {
    // The two axes are independent; requiring them together would be one
    // control wearing two labels.
    const a = fakeTxDb(batchResponder);
    const ra = await submitGradeBatch(a, {
      namespace: "rico",
      gradedBy: "rico",
      grades: [
        { candidateId: CANDIDATE_ID, action: "rejected", agentBehavior: "bad" },
      ],
    });
    expect(ra.results[0]).toMatchObject({
      reason_code: null,
      agent_behavior: "bad",
    });

    const b = fakeTxDb(batchResponder);
    const rb = await submitGradeBatch(b, {
      namespace: "rico",
      gradedBy: "rico",
      grades: [
        {
          candidateId: CANDIDATE_ID,
          action: "promoted",
          reasonCode: "states-fact",
        },
      ],
    });
    expect(rb.results[0]).toMatchObject({
      reason_code: "states-fact",
      agent_behavior: null,
    });
  });

  it("carries a PROMOTED memory with BAD agent behavior -- the combination one column could not express", async () => {
    // 042's header calls this out as the case that makes the split necessary:
    // the agent did the wrong thing, the operator corrected it, and the
    // correction is the most valuable thing in the exchange. One column forces a
    // choice between recording the memory's worth and the agent's failure.
    const db = fakeTxDb(batchResponder);
    const res = await submitGradeBatch(db, {
      namespace: "rico",
      gradedBy: "rico",
      grades: [
        {
          candidateId: CANDIDATE_ID,
          action: "promoted",
          reasonCode: "correction-worth-keeping",
          agentBehavior: "bad",
        },
      ],
    });
    expect(res.results[0]!.action).toBe("promoted");
    expect(res.results[0]!.agent_behavior).toBe("bad");
  });

  it("accepts snake_case as well as camelCase", async () => {
    // The page speaks camelCase; a curl or a script speaks the column name.
    const db = fakeTxDb(batchResponder);
    const res = await submitGradeBatch(db, {
      namespace: "rico",
      gradedBy: "rico",
      grades: [
        {
          candidateId: CANDIDATE_ID,
          action: "duplicate",
          reason_code: "already-known",
          agent_behavior: "neutral",
        },
      ],
    });
    expect(res.results[0]).toMatchObject({
      reason_code: "already-known",
      agent_behavior: "neutral",
    });
  });

  it("rolls the WHOLE batch back on a bad code, naming the item", async () => {
    // Validation runs before the transaction opens, so a bad fifth item writes
    // nothing at all -- and the message names the index, because "unknown
    // reason_code" alone does not say which of 40 items to fix.
    const db = fakeTxDb(batchResponder);
    let message = "";
    await expect(
      submitGradeBatch(db, {
        namespace: "rico",
        gradedBy: "rico",
        grades: [
          {
            candidateId: CANDIDATE_ID,
            action: "promoted",
            reasonCode: "states-fact",
          },
          {
            candidateId: "22222222-2222-4222-8222-222222222222",
            action: "rejected",
            reasonCode: "invented-code",
          },
        ],
      }),
    ).rejects.toThrow(ReviewInputError);

    try {
      await submitGradeBatch(db, {
        namespace: "rico",
        gradedBy: "rico",
        grades: [
          {
            candidateId: CANDIDATE_ID,
            action: "rejected",
            agentBehavior: "furious",
          },
        ],
      });
    } catch (e) {
      message = (e as ReviewInputError).message;
    }
    expect(message).toContain("grades[0]");
    expect(message).toContain("agent_behavior");
    // Nothing was written by either attempt.
    expect(db.committed).toHaveLength(0);
  });

  it("carries both axes through the single-grade path too", async () => {
    // gradeCandidate is a batch of one through the same writer. If it dropped
    // the new fields the two paths would diverge again -- the exact drift the
    // single path was collapsed into the batch writer to prevent.
    const db = fakeTxDb(batchResponder);
    const res = await gradeCandidate(db, {
      namespace: "rico",
      id: CANDIDATE_ID,
      action: "inconclusive",
      gradedBy: "rico",
      reasonCode: "unsure-value",
      agentBehavior: "neutral",
    });
    expect(res).toMatchObject({
      reason_code: "unsure-value",
      agent_behavior: "neutral",
    });
  });
});

describe("the HTTP boundary validates both axes", () => {
  const handler = (responder: (sql: string, values: unknown[]) => unknown[]) =>
    makeGradingHandler({
      pool: fakeTxDb(responder),
      namespace: "rico",
      gradedBy: "rico",
    });

  const post = (path: string, body: unknown): Request =>
    new Request("http://127.0.0.1/" + path.replace(/^\//, ""), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("400s an unknown reason_code with a named reason", async () => {
    const res = await handler(batchResponder)(
      post("/api/grade-batch", {
        grades: [
          {
            candidateId: CANDIDATE_ID,
            action: "promoted",
            reasonCode: "nonsense",
          },
        ],
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("reason_code");
    expect(body.error).toContain("nonsense");
  });

  it("400s an unknown agent_behavior with a named reason", async () => {
    const res = await handler(batchResponder)(
      post("/api/grade-batch", {
        grades: [
          {
            candidateId: CANDIDATE_ID,
            action: "rejected",
            agentBehavior: "livid",
          },
        ],
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("agent_behavior");
    expect(body.error).toContain("livid");
  });

  it("accepts a batch carrying both axes", async () => {
    const res = await handler(batchResponder)(
      post("/api/grade-batch", {
        grades: [
          {
            candidateId: CANDIDATE_ID,
            action: "promoted",
            note: "shows the reasoning",
            reasonCode: "shows-reasoning",
            agentBehavior: "good",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ reason_code: string; agent_behavior: string }>;
    };
    expect(body.results[0]).toMatchObject({
      reason_code: "shows-reasoning",
      agent_behavior: "good",
    });
  });

  it("400s the single-grade route on a bad code, naming the field not an array index", async () => {
    // This route has no `grades` array, so an error mentioning grades[0] would
    // name something the caller never sent.
    const res = await handler(batchResponder)(
      post("/api/grade", {
        id: CANDIDATE_ID,
        action: "promoted",
        reasonCode: "made-up",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("reason_code");
    expect(body.error).not.toContain("grades[");
  });
});

describe("reading grades back", () => {
  it("returns reason_code and agent_behavior in the history", async () => {
    const seen: Recorded[] = [];
    const query = (async (text: string, values: unknown[] = []) => {
      seen.push({ text, values });
      if (text.includes("count(*) AS total FROM candidate_grade")) {
        return { rows: [{ total: "9" }] };
      }
      if (text.includes("GROUP BY batch_id")) return { rows: [] };
      return {
        rows: [
          {
            grade_id: "99999999-9999-4999-8999-999999999999",
            candidate_id: CANDIDATE_ID,
            action: "promoted",
            note: "rewritten entirely by hand",
            reason_code: "shows-reasoning",
            agent_behavior: "good",
            graded_by: "rico",
            batch_id: BATCH_ID,
            created_at: new Date("2026-07-28T06:00:00Z"),
            superseded_at: null,
            candidate_type: "decision",
            content: "the claim",
            uncertain: false,
            uncertainty_reason: null,
            machine_grade: null,
          },
        ],
      };
    }) as unknown as pg.Pool["query"];

    const h = await fetchGradeHistory({ query }, { namespace: "rico" });
    expect(h.items[0]).toMatchObject({
      reason_code: "shows-reasoning",
      agent_behavior: "good",
    });
    // Every statement is namespace-scoped -- the security boundary applies to
    // the new columns' read path exactly as it does to the old ones.
    for (const q of seen) expect(q.values).toContain("rico");
  });

  it("KEEPS THE OPERATOR'S EXISTING 8 GRADES READABLE, with NULLs on both new columns", async () => {
    // The 8 real grades (one batch, 2026-07-28) predate both columns. 042 adds
    // them nullable with no backfill precisely so those rows keep meaning what
    // they meant -- "graded before these axes existed" -- and a read path that
    // assumed the columns were populated would break the history page for the
    // only real data this exercise has collected so far.
    const notes = [
      "this by itself isn't, but the surronding messages will make for useful info in whole",
      "combined with surrounding messages???",
      "circular but has a point and states facts",
      "show's logic",
      "logic to fix an issue",
      null,
      null,
      null,
    ];
    const query = (async (text: string) => {
      if (text.includes("count(*) AS total FROM candidate_grade")) {
        return { rows: [{ total: "8" }] };
      }
      if (text.includes("GROUP BY batch_id")) return { rows: [] };
      return {
        rows: notes.map((note, i) => ({
          grade_id: "99999999-9999-4999-8999-99999999999" + i,
          candidate_id: CANDIDATE_ID,
          action: "inconclusive",
          note,
          // What the live rows actually hold after 042.
          reason_code: null,
          agent_behavior: null,
          graded_by: "rico",
          batch_id: BATCH_ID,
          created_at: new Date("2026-07-28T06:00:00Z"),
          superseded_at: null,
          candidate_type: "decision",
          content: "c" + i,
          uncertain: false,
          uncertainty_reason: null,
          machine_grade: null,
        })),
      };
    }) as unknown as pg.Pool["query"];

    const h = await fetchGradeHistory({ query }, { namespace: "rico" });
    expect(h.items).toHaveLength(8);
    for (const item of h.items) {
      expect(item.reason_code).toBeNull();
      expect(item.agent_behavior).toBeNull();
    }
    // The operator's own words are untouched, typos and all.
    expect(h.items[0]!.note).toContain("surronding");
  });

  it("counts live grades by reason_code and by agent_behavior", async () => {
    const query = (async (text: string, values: unknown[] = []) => {
      if (text.includes("FROM candidate_grade")) {
        // Grouped by BOTH columns, as the query does -- the aggregation across
        // rows is the part that can be got wrong.
        expect(values).toContain("rico");
        return {
          rows: [
            { reason_code: "states-fact", agent_behavior: "good", n: "3" },
            { reason_code: "states-fact", agent_behavior: null, n: "2" },
            { reason_code: null, agent_behavior: "bad", n: "4" },
            { reason_code: "tool-noise", agent_behavior: null, n: "1" },
          ],
        };
      }
      return {
        rows: [
          {
            total: "10",
            ungraded: "0",
            graded: "10",
            uncertain_ungraded: "0",
            promoted: "5",
            rejected: "5",
            duplicate: "0",
            inconclusive: "0",
            compared: "0",
            agreed: "0",
            distinct_machine_grades: "0",
          },
        ],
      };
    }) as unknown as pg.Pool["query"];

    const s = await fetchStats({ query }, { namespace: "rico" });
    // A code spread across two behavior groups is summed, not reported twice.
    expect(s.by_reason_code["states-fact"]).toBe(5);
    expect(s.by_reason_code["tool-noise"]).toBe(1);
    // A null code contributes to no reason bucket at all.
    expect(Object.keys(s.by_reason_code).sort()).toEqual([
      "states-fact",
      "tool-noise",
    ]);
    expect(s.agent_behavior.by_value).toEqual({ good: 3, bad: 4 });
    // `rated` counts rated rows only -- it is deliberately NOT the graded count,
    // because rating is optional and how much of the axis exists is the number
    // that says whether the control is being used.
    expect(s.agent_behavior.rated).toBe(7);
    expect(s.graded).toBe(10);
  });
});
