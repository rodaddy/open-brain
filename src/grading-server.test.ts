/**
 * Functional tests for the grading HTTP boundary (#394), complementing
 * src/candidate-review.test.ts.
 *
 * That file covers the vocabulary, the identity guard, the clamps, and the
 * happy-path queue read. This one covers the routes it did not: the
 * inconclusive "come back to these" queue, ungrade, stats, and the round-trip
 * of every action value through the real handler.
 *
 * IT ALSO STATES THE INVARIANT AS A ROUTE-LEVEL FACT, not just a function-level
 * one: no request to ANY endpoint on this server can produce a statement that
 * writes machine_grade. 037:43-57 makes that REM's column, and the grading
 * surface is the one place a well-meant "let the UI record the model's opinion
 * too" would be added. Asserting it once per function leaves the composition
 * untested; asserting it across every route closes that.
 *
 * The handler is driven with real `Request` objects rather than a socket: same
 * code path, no port allocation, no teardown race -- the pattern
 * candidate-review.test.ts established.
 */

import { describe, expect, it } from "bun:test";
import type pg from "pg";
import {
  DEFAULT_GRADING_PORT,
  GRADING_BIND_HOST,
  makeGradingHandler,
} from "./grading-server.ts";
import {
  fetchInconclusive,
  MAX_QUEUE_LIMIT,
  REVIEW_ACTIONS,
} from "./candidate-review.ts";

const ID = "11111111-1111-4111-8111-111111111111";
const SOURCE = "22222222-2222-4222-8222-222222222222";

interface Recorded {
  text: string;
  values: unknown[];
}

function fakeDb(responder: (sql: string, values: unknown[]) => unknown[]) {
  const seen: Recorded[] = [];
  const query = (async (text: string, values: unknown[] = []) => {
    seen.push({ text, values });
    return { rows: responder(text, values) };
  }) as unknown as pg.Pool["query"];
  return { seen, query };
}

const CANDIDATE = {
  id: ID,
  namespace: "rico",
  candidate_type: "decision",
  content: "switched both",
  content_hash: "hash-a",
  uncertain: true,
  uncertainty_reason: "bare ack",
  authority_tier: null,
  model: "rule-based-distiller/v1",
  machine_grade: "inconclusive",
  machine_grade_model: "rem-heuristic-v1",
  created_at: new Date("2026-07-28T00:00:00Z"),
  source_turn_ids: [SOURCE],
};

/** Rows for a fully-populated queue read: candidate + context + occurrences. */
function fullResponder(sql: string): unknown[] {
  if (sql.includes("FILTER (WHERE reviewed_at IS NULL) AS total")) {
    return [{ total: "1104", graded: "0" }];
  }
  // The stats aggregate is matched before the inconclusive count: both start
  // with `count(*) AS total` and the stats query also names
  // review_action = 'inconclusive' inside a FILTER.
  if (sql.includes("AS uncertain_ungraded")) {
    return [
      {
        total: "1104",
        ungraded: "1100",
        graded: "4",
        uncertain_ungraded: "830",
        promoted: "2",
        rejected: "1",
        duplicate: "0",
        inconclusive: "1",
        compared: "4",
        agreed: "3",
      },
    ];
  }
  if (
    sql.includes("count(*) AS total") &&
    sql.includes("review_action = 'inconclusive'")
  ) {
    return [{ total: "4" }];
  }
  if (sql.includes("FROM candidate_memory c")) return [CANDIDATE];
  if (sql.includes("FROM ob_raw_turns")) {
    return [
      {
        source_id: SOURCE,
        id: "33333333-3333-4333-8333-333333333333",
        role: "assistant",
        content: "I can switch both hooks to the new host.",
        session_ref: "s1",
        session_seq: 4,
        repo: "open-brain",
        occurred_at: new Date("2026-07-27T23:59:00Z"),
        is_human_prompt: false,
      },
      {
        source_id: SOURCE,
        id: SOURCE,
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
  if (sql.includes("SET review_action = NULL")) return [{ id: ID }];
  if (sql.includes("UPDATE candidate_memory")) {
    return [
      {
        id: ID,
        review_action: "promoted",
        reviewed_at: new Date("2026-07-28T06:00:00Z"),
        graded_by: "rico",
        machine_grade: "inconclusive",
      },
    ];
  }
  // POST /api/grade is a batch of one since 2026-07-28, so the single-item
  // route needs the grade-row statements answered too. It no longer has an
  // UPDATE of its own that could overwrite the distiller's uncertainty_reason.
  if (sql.includes("gen_random_uuid() AS batch_id")) {
    return [{ batch_id: BATCH_ID }];
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

/**
 * Transactional by default.
 *
 * Every write route on this server now holds a transaction: the batch routes
 * always did, and POST /api/grade joined them when it became a batch of one so
 * that a note lands in candidate_grade.note instead of over the distiller's
 * column. A query-only fake would answer 501 on all of them.
 */
function serverFor(
  responder: (sql: string, values: unknown[]) => unknown[] = fullResponder,
) {
  const db = fakeTxDb(responder);
  return {
    db,
    handle: makeGradingHandler({
      pool: db,
      namespace: "rico",
      gradedBy: "rico",
    }),
  };
}

const post = (path: string, body: unknown) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("every action value round-trips through the API", () => {
  for (const action of REVIEW_ACTIONS) {
    it(`accepts ${action} and returns what was written`, async () => {
      const { handle } = serverFor((sql) => {
        if (sql.includes("UPDATE candidate_memory")) {
          return [
            {
              id: ID,
              review_action: action,
              reviewed_at: new Date("2026-07-28T06:00:00Z"),
              graded_by: "rico",
              machine_grade: null,
            },
          ];
        }
        return fullResponder(sql);
      });
      const res = await handle(post("/api/grade", { id: ID, action }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        review_action: string;
        graded_by: string;
      };
      expect(body.review_action).toBe(action);
      expect(body.graded_by).toBe("rico");
    });
  }

  it("reports agreement with REM's guess so disagreement is measurable", async () => {
    // 037:88-94 -- agreement between the two columns is the only evidence that
    // will ever say whether the machine can be trusted here.
    const { handle } = serverFor();
    const res = await handle(
      post("/api/grade", { id: ID, action: "promoted" }),
    );
    const body = (await res.json()) as {
      machine_grade: string;
      agreed: boolean;
    };
    expect(body.machine_grade).toBe("inconclusive");
    expect(body.agreed).toBe(false);
  });

  it("rejects every near-miss action rather than coercing it", async () => {
    const { handle, db } = serverFor();
    for (const bad of ["promote", "PROMOTED", "approve", "yes", "", "skip"]) {
      const res = await handle(post("/api/grade", { id: ID, action: bad }));
      expect(res.status).toBe(400);
    }
    // None of them reached the database.
    expect(db.seen).toHaveLength(0);
  });

  it("rejects a grade with no action at all", async () => {
    const { handle } = serverFor();
    expect((await handle(post("/api/grade", { id: ID }))).status).toBe(400);
  });
});

describe("no route can write machine_grade", () => {
  it("holds across every endpoint, not just the grade function", async () => {
    // The composition-level statement of invariant 2. Asserting it per-function
    // leaves the routing untested.
    const { handle, db } = serverFor();
    const requests: Request[] = [
      new Request("http://127.0.0.1/api/queue?limit=5"),
      new Request("http://127.0.0.1/api/inconclusive"),
      new Request("http://127.0.0.1/api/stats"),
      post("/api/grade", { id: ID, action: "promoted" }),
      post("/api/grade", {
        id: ID,
        action: "inconclusive",
        note: "come back to this",
      }),
      post("/api/ungrade", { id: ID }),
    ];
    for (const req of requests) await handle(req);

    expect(db.seen.length).toBeGreaterThan(5);
    for (const q of db.seen) {
      if (/\bUPDATE\b/.test(q.text)) {
        // Only a SET clause is a write. `machine_grade = review_action` appears
        // inside a count() FILTER on the stats query, which is the agreement
        // measurement reading both columns -- exactly what they exist for.
        const setClause = q.text.slice(
          q.text.indexOf("SET "),
          q.text.indexOf("WHERE"),
        );
        expect(setClause).not.toContain("machine_grade");
      }
      if (/\bINSERT\b/.test(q.text)) {
        // Since 040 the grading surface DOES insert -- one row per act of
        // judgement -- but only into candidate_grade, which has no
        // machine_grade column at all. It must never insert into
        // candidate_memory, which is the distiller's table.
        expect(q.text).toContain("INSERT INTO candidate_grade");
        expect(q.text).not.toContain("machine_grade");
      }
      // No path on this server may write the distiller's stated reason for
      // doubt. POST /api/grade used to overwrite it with the operator's note.
      expect(q.text).not.toContain("uncertainty_reason =");
    }
  });

  it("rejects a machine_grade in the body on grade, with 403", async () => {
    const { handle } = serverFor();
    const res = await handle(
      post("/api/grade", {
        id: ID,
        action: "promoted",
        machine_grade: "rejected",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects machine_grade_model too, not just machine_grade", async () => {
    const { handle } = serverFor();
    const res = await handle(
      post("/api/grade", {
        id: ID,
        action: "promoted",
        machine_grade_model: "rem-heuristic-v1",
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("grading is namespace-scoped on every statement", () => {
  it("binds the configured namespace as the first parameter everywhere", async () => {
    // Namespace is a security boundary in this repo, not a filter.
    const { handle, db } = serverFor();
    await handle(new Request("http://127.0.0.1/api/queue"));
    await handle(new Request("http://127.0.0.1/api/inconclusive"));
    await handle(new Request("http://127.0.0.1/api/stats"));
    await handle(post("/api/grade", { id: ID, action: "promoted" }));
    await handle(post("/api/ungrade", { id: ID }));

    expect(db.seen.length).toBeGreaterThan(0);
    // Transaction control and the batch-id generator address no table, so there
    // is nothing for a namespace predicate to scope. Every statement that
    // touches a row still carries one.
    const scoped = db.seen.filter(
      (q) =>
        !["BEGIN", "COMMIT", "ROLLBACK"].includes(q.text) &&
        !q.text.includes("gen_random_uuid() AS batch_id"),
    );
    expect(scoped.length).toBeGreaterThan(0);
    for (const q of scoped) {
      // The INSERT into candidate_grade carries the namespace as a written
      // COLUMN rather than a predicate -- 040 stores it on the row precisely so
      // later reads can scope without a join. Either way it is $1, which is the
      // property that matters: the namespace is never optional and never later
      // than the first parameter.
      const scopedByPredicate = q.text.includes("namespace = $1");
      const scopedByInsert =
        q.text.includes("INSERT INTO candidate_grade") &&
        q.text.includes("(namespace,");
      expect(scopedByPredicate || scopedByInsert).toBe(true);
      expect(q.values[0]).toBe("rico");
    }
  });

  it("reports a cross-namespace grade as not-found rather than confirming the row exists", async () => {
    const { handle } = serverFor((sql) =>
      sql.includes("UPDATE candidate_memory") ? [] : fullResponder(sql),
    );
    const res = await handle(
      post("/api/grade", { id: ID, action: "promoted" }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    // Says nothing about whether the id exists elsewhere.
    expect(body.error).toContain("not found");
  });
});

describe("a candidate is never served without its source turns", () => {
  it("marks the source turn and shows it alongside its conversation", async () => {
    // Judging "Operator approved: 'ok'" without seeing what was approved is
    // guessing, not grading.
    const { handle } = serverFor();
    const res = await handle(new Request("http://127.0.0.1/api/queue"));
    const body = (await res.json()) as {
      items: Array<{
        source_turn_ids: string[];
        context: Array<{ id: string; is_source: boolean; content: string }>;
      }>;
    };
    const item = body.items[0]!;
    expect(item.source_turn_ids).toEqual([SOURCE]);
    const sources = item.context.filter((t) => t.is_source);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.id).toBe(SOURCE);
    // And the proposal that makes it readable.
    expect(item.context.map((t) => t.content)).toContain(
      "I can switch both hooks to the new host.",
    );
  });

  it("serves the same shape on the inconclusive queue", async () => {
    const { handle } = serverFor();
    const res = await handle(new Request("http://127.0.0.1/api/inconclusive"));
    const body = (await res.json()) as {
      items: Array<{ context: unknown[] }>;
      total: number;
    };
    expect(body.total).toBe(4);
    expect(body.items[0]!.context).toHaveLength(2);
  });

  it("counts context-free items on every read so the gap is visible", async () => {
    // An item with no context cannot be judged; the operator must not discover
    // that one card at a time.
    const logged: Array<Record<string, unknown>> = [];
    const db = fakeDb((sql) =>
      sql.includes("FROM ob_raw_turns") ? [] : fullResponder(sql),
    );
    const handle = makeGradingHandler({
      pool: db,
      namespace: "rico",
      gradedBy: "rico",
      logger: {
        info: (_m, extra) => logged.push(extra ?? {}),
        warn: () => {},
        error: () => {},
      },
    });
    await handle(new Request("http://127.0.0.1/api/queue"));
    expect(logged[0]).toMatchObject({ without_context: 1 });
  });
});

describe("the inconclusive queue is the come-back-to-these list", () => {
  it("reads rows the operator already graded inconclusive, not the main queue", async () => {
    // 037:146-149. These have a reviewed_at, so they are NOT in the main queue
    // -- but the operator asked to be able to come back to them.
    const db = fakeDb(fullResponder);
    await fetchInconclusive(db, { namespace: "rico" });
    const page = db.seen.find((q) =>
      q.text.includes("FROM candidate_memory c"),
    )!;
    expect(page.text).toContain("c.review_action = 'inconclusive'");
    expect(page.text).not.toContain("reviewed_at IS NULL");
  });

  it("regrading one overwrites the first grade rather than being refused", async () => {
    // The grade UPDATE deliberately carries no `reviewed_at IS NULL` guard.
    const { handle, db } = serverFor();
    const res = await handle(
      post("/api/grade", { id: ID, action: "promoted" }),
    );
    expect(res.status).toBe(200);
    const update = db.seen.find((q) =>
      q.text.includes("SET review_action = $3"),
    )!;
    expect(update.text).not.toContain("AND reviewed_at IS NULL");
  });

  it("obeys the same attention cap as the main queue", async () => {
    const { handle, db } = serverFor();
    await handle(new Request("http://127.0.0.1/api/inconclusive?limit=999"));
    const page = db.seen.find((q) =>
      q.text.includes("FROM candidate_memory c"),
    )!;
    expect(page.values[1]).toBe(MAX_QUEUE_LIMIT);
  });
});

describe("undo", () => {
  it("puts a mis-graded row back on the queue", async () => {
    // A keyboard-driven grader WILL mis-hit a key; without undo the only
    // recovery is leaving a wrong label for a future promoter to train on.
    const { handle } = serverFor();
    const res = await handle(post("/api/ungrade", { id: ID }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: ID });
  });

  it("404s an ungrade of a row that was never graded", async () => {
    const { handle } = serverFor((sql) =>
      sql.includes("SET review_action = NULL") ? [] : fullResponder(sql),
    );
    expect((await handle(post("/api/ungrade", { id: ID }))).status).toBe(404);
  });

  it("validates the id before it reaches the database", async () => {
    const { handle, db } = serverFor();
    const res = await handle(post("/api/ungrade", { id: "nope" }));
    expect(res.status).toBe(400);
    expect(db.seen).toHaveLength(0);
  });
});

describe("stats", () => {
  it("serves the progress readout including the agreement rate", async () => {
    const { handle } = serverFor();
    const res = await handle(new Request("http://127.0.0.1/api/stats"));
    const body = (await res.json()) as {
      total: number;
      ungraded: number;
      machine_agreement: { rate: number };
    };
    expect(body.total).toBe(1104);
    expect(body.ungraded).toBe(1100);
    expect(body.machine_agreement.rate).toBeCloseTo(0.75, 5);
  });
});

describe("errors are surfaced as the client's fault or hidden, never leaked", () => {
  it("turns a database failure into a 500 that echoes no parameter value", async () => {
    // A pg error can echo parameter values, and those parameters are dialogue.
    const { handle } = serverFor(() => {
      throw new Error(
        "duplicate key value violates unique constraint: Key (content)=(a private decision)",
      );
    });
    const res = await handle(new Request("http://127.0.0.1/api/queue"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("internal error");
    expect(body.error).not.toContain("private decision");
  });

  it("serves no-store on every JSON response", async () => {
    // A cached /api/queue is how an operator re-grades an item they handled.
    const { handle } = serverFor();
    for (const path of ["/api/queue", "/api/inconclusive", "/api/stats"]) {
      const res = await handle(new Request(`http://127.0.0.1${path}`));
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("404s an unknown route and an unsupported method", async () => {
    const { handle } = serverFor();
    expect(
      (await handle(new Request("http://127.0.0.1/api/nope"))).status,
    ).toBe(404);
    // GET on a POST-only route is not a grade.
    expect(
      (await handle(new Request("http://127.0.0.1/api/grade"))).status,
    ).toBe(404);
  });
});

/**
 * A transactional fake for the batch routes.
 *
 * Mirrors the one in candidate-review.test.ts: statements after BEGIN are
 * provisional until COMMIT, so "the batch rolled back" is an observable outcome
 * rather than something inferred from SQL text.
 */
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

  return {
    seen,
    committed,
    query,
    connect: async () => ({ query, release: () => {} }),
  };
}

const BATCH_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND_ID = "55555555-5555-4555-8555-555555555555";

function batchResponder(sql: string): unknown[] {
  if (sql.includes("gen_random_uuid() AS batch_id")) {
    return [{ batch_id: BATCH_ID }];
  }
  if (sql.includes("UPDATE candidate_memory")) {
    return [{ id: ID, machine_grade: "inconclusive" }];
  }
  if (sql.includes("DELETE FROM candidate_grade")) {
    return [
      {
        id: "99999999-9999-4999-8999-999999999999",
        candidate_id: ID,
        created_at: new Date("2026-07-28T06:00:00Z"),
      },
    ];
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
  if (sql.includes("count(*) AS total FROM candidate_grade")) {
    return [{ total: "2" }];
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
  if (sql.includes("FROM candidate_grade g")) {
    return [
      {
        grade_id: "99999999-9999-4999-8999-999999999999",
        candidate_id: ID,
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
      },
    ];
  }
  return fullResponder(sql);
}

function batchServer(
  responder: (sql: string, values: unknown[]) => unknown[] = batchResponder,
) {
  const db = fakeTxDb(responder);
  return {
    db,
    handle: makeGradingHandler({
      pool: db,
      namespace: "rico",
      gradedBy: "rico",
    }),
  };
}

describe("POST /api/grade-batch -- form and send, not keystroke and write", () => {
  const grades = [
    { candidateId: ID, action: "promoted", note: "clear call" },
    { candidateId: SECOND_ID, action: "rejected" },
  ];

  it("commits a whole batch and returns the batch id", async () => {
    // The operator's model, verbatim: "i fill it out and hit send or something,
    // that takes the current page out with the info go'n to the server".
    const { handle, db } = batchServer();
    const res = await handle(post("/api/grade-batch", { grades }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      batch_id: string;
      results: Array<{ action: string }>;
    };
    expect(body.batch_id).toBe(BATCH_ID);
    expect(body.results.map((r) => r.action)).toEqual(["promoted", "rejected"]);
    expect(
      db.committed.filter((q) => q.text.includes("INSERT INTO")),
    ).toHaveLength(2);
  });

  it("rolls the whole batch back and answers 404 when one item is unknown", async () => {
    // A partial batch is the worst outcome: the operator cannot tell what landed.
    const { handle, db } = batchServer((sql, values) =>
      sql.includes("UPDATE candidate_memory") && values[1] === SECOND_ID
        ? []
        : batchResponder(sql),
    );
    const res = await handle(post("/api/grade-batch", { grades }));
    expect(res.status).toBe(404);
    expect(db.committed).toHaveLength(0);
    expect(db.seen.some((q) => q.text === "ROLLBACK")).toBe(true);
  });

  it("puts the note in candidate_grade and never in uncertainty_reason", async () => {
    const { handle, db } = batchServer();
    await handle(post("/api/grade-batch", { grades }));
    const insert = db.committed.find((q) => q.text.includes("INSERT INTO"))!;
    expect(insert.values[3]).toBe("clear call");
    for (const q of db.seen) expect(q.text).not.toContain("uncertainty_reason");
  });

  it("writes machine_grade on no statement, and rejects it in the body with 403", async () => {
    const { handle, db } = batchServer();
    await handle(post("/api/grade-batch", { grades }));
    for (const q of db.seen) {
      if (!/\bUPDATE\b|\bINSERT\b/.test(q.text)) continue;
      expect(q.text).not.toContain("machine_grade =");
      expect(q.text).not.toContain("machine_grade,");
    }
    expect(
      (
        await handle(
          post("/api/grade-batch", { grades, machine_grade: "rejected" }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handle(
          post("/api/grade-batch", {
            grades: [
              { candidateId: ID, action: "promoted", machine_grade: "x" },
            ],
          }),
        )
      ).status,
    ).toBe(403);
  });

  it("scopes every statement to the configured namespace", async () => {
    const { handle, db } = batchServer();
    await handle(post("/api/grade-batch", { grades }));
    for (const q of db.seen) {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(q.text)) continue;
      if (q.text.includes("gen_random_uuid() AS batch_id")) continue;
      expect(q.values[0]).toBe("rico");
    }
  });

  it("400s a malformed body with a named reason, never a 500", async () => {
    const { handle } = batchServer();
    const cases: Array<[unknown, string]> = [
      [{}, "grades must be an array"],
      [{ grades: [] }, "must not be empty"],
      [{ grades: "nope" }, "must be an array"],
      [{ grades: [{ candidateId: "not-a-uuid", action: "promoted" }] }, "uuid"],
      [{ grades: [{ candidateId: ID, action: "pass" }] }, "grades[0]"],
      [{ grades: [{ candidateId: ID }] }, "grades[0]"],
      [{ grades: [null] }, "must be an object"],
    ];
    for (const [body, fragment] of cases) {
      const res = await handle(post("/api/grade-batch", body));
      expect(res.status).toBe(400);
      const err = (await res.json()) as { error: string };
      expect(err.error).toContain(fragment);
    }
  });

  it("400s an over-long note rather than silently truncating the operator's words", async () => {
    const { handle } = batchServer();
    const res = await handle(
      post("/api/grade-batch", {
        grades: [
          { candidateId: ID, action: "promoted", note: "x".repeat(2001) },
        ],
      }),
    );
    expect(res.status).toBe(400);
  });

  it("501s rather than 500s when the pool cannot hold a transaction", async () => {
    // A bare TypeError would surface as "internal error", which reads to the
    // operator as "your grades might have landed".
    const handle = makeGradingHandler({
      pool: fakeDb(fullResponder),
      namespace: "rico",
      gradedBy: "rico",
    });
    const res = await handle(post("/api/grade-batch", { grades }));
    expect(res.status).toBe(501);
  });
});

describe("POST /api/undo-batch -- the operator's undo", () => {
  it("reverses a submitted batch and reports what moved", async () => {
    const { handle, db } = batchServer();
    const res = await handle(post("/api/undo-batch", { batchId: BATCH_ID }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      batch_id: BATCH_ID,
      removed: 1,
      candidates: 1,
    });
    expect(
      db.committed.some((q) => q.text.includes("DELETE FROM candidate_grade")),
    ).toBe(true);
  });

  it("404s an unknown or cross-namespace batch without writing", async () => {
    const { handle, db } = batchServer((sql) =>
      sql.includes("DELETE FROM candidate_grade") ? [] : batchResponder(sql),
    );
    const res = await handle(post("/api/undo-batch", { batchId: BATCH_ID }));
    expect(res.status).toBe(404);
    expect(db.committed).toHaveLength(0);
  });

  it("400s a missing or malformed batch id before reaching the database", async () => {
    const { handle, db } = batchServer();
    for (const body of [
      {},
      { batchId: "" },
      { batchId: 5 },
      { batchId: "nope" },
    ]) {
      expect((await handle(post("/api/undo-batch", body))).status).toBe(400);
    }
    expect(db.seen).toHaveLength(0);
  });

  it("touches no machine_grade on the way back out", async () => {
    const { handle, db } = batchServer();
    await handle(post("/api/undo-batch", { batchId: BATCH_ID }));
    for (const q of db.seen) expect(q.text).not.toContain("machine_grade");
  });
});

describe("GET /api/history -- find something to change", () => {
  it("serves recent grades with the candidate content beside them", async () => {
    const { handle } = batchServer();
    const res = await handle(new Request("http://127.0.0.1/api/history"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      total: number;
      items: Array<{ content: string; action: string }>;
      batches: Array<{ batch_id: string; live: boolean }>;
    };
    expect(body.total).toBe(2);
    expect(body.items[0]!.content).toBe("switched both");
    expect(body.batches[0]!.batch_id).toBe(BATCH_ID);
  });

  it("clamps the page to the same attention budget as the queue", async () => {
    const { handle, db } = batchServer();
    await handle(new Request("http://127.0.0.1/api/history?limit=999"));
    const page = db.seen.find((q) =>
      q.text.includes("FROM candidate_grade g"),
    )!;
    expect(page.values[1]).toBe(MAX_QUEUE_LIMIT);
  });
});

describe("the page is a form, not a keystroke writer", () => {
  it("stages locally and sends only on demand", async () => {
    // The rebuild's governing property. The previous page POSTed inside its
    // grade keyhandler; this one must not.
    const { handle } = serverFor();
    const html = await (await handle(new Request("http://127.0.0.1/"))).text();
    expect(html).toContain("Candidate grading");
    expect(html).toContain("SEND BATCH");
    expect(html).toContain("/api/grade-batch");
    expect(html).toContain("/api/undo-batch");
    expect(html).toContain("/api/history");
    // Keys select; they do not submit.
    expect(html).toContain(
      '"1": "promoted", "2": "rejected", "3": "inconclusive", "4": "duplicate"',
    );
    // The pending batch survives a reload, which is what makes staging safe
    // across 1,104 items.
    expect(html).toContain("localStorage");
  });
});

describe("the bind posture is loopback and not configurable", () => {
  it("pins the host so a debugging session cannot leave it on 0.0.0.0", () => {
    expect(GRADING_BIND_HOST).toBe("127.0.0.1");
    // Distinct from the app's 3100 so both can run at once.
    expect(DEFAULT_GRADING_PORT).not.toBe(3100);
  });
});
