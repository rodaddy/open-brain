/**
 * Functional tests for DREAM Stage 2 -- REM (#391, #392, #398).
 *
 * REM IS THE ONLY STAGE ALLOWED TO WRITE A GRADE, and that is precisely why it
 * is the most dangerous one. 037_candidate_memory_uncertainty.sql:43-57,
 * verbatim: "reviewed_at IS NULL is the operator's queue. Anything that sets
 * review_action also sets reviewed_at (candidate_memory_review_paired), so a
 * machine writing there silently removes the item from human review."
 *
 * The failure is silent by construction. A REM pass that wrote review_action
 * would emit no error, log the same counts, and simply produce an empty
 * grading page -- the model having graded its own training data and marked it
 * done. So the first block below asserts on the SQL text: there is no return
 * value that distinguishes "graded machine_grade" from "graded review_action",
 * and inspecting the statement is the only place the distinction is visible.
 *
 * Everything else is ordinary input/output: the grader's verdicts against
 * corroboration signals, the re-warm graduation table, and the pass ordering.
 */

import { describe, expect, it } from "bun:test";
import type pg from "pg";
import {
  BackgroundTraceRecorder,
  type BackgroundTraceBody,
  type BackgroundTraceEmitter,
} from "./background-tracing.ts";
import {
  buildDreamRemEnqueue,
  DREAM_REM_JOB_KIND,
  DREAM_REM_JOB_VERSION,
  GRADE_VALUES,
  heuristicRemGrader,
  makeDreamRemHandler,
  REWARM_BEGIN_LIMIT,
  REWARM_FULL_LIMIT,
  REWARM_FULL_SESSIONS,
  REWARM_MAX_PER_PASS,
  REWARM_MIN_SESSIONS,
  runRemGrading,
  runRemPass,
  runRemRewarm,
  type NamedRemGrader,
  type RemCandidate,
} from "./dream-rem.ts";
import {
  MaintenanceTerminalError,
  type MaintenanceJob,
  type MaintenanceQueueLogger,
} from "./maintenance-queue.ts";

const silentLogger: MaintenanceQueueLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function recordingTracing(): BackgroundTraceEmitter & {
  bodies: BackgroundTraceBody[];
} {
  const bodies: BackgroundTraceBody[] = [];
  return {
    bodies,
    emitBackground(body) {
      bodies.push(body);
    },
  };
}

function collectingLogger() {
  const records: Array<{ msg: string; fields: Record<string, unknown> }> = [];
  return {
    records,
    logger: {
      info: (msg: string, fields: Record<string, unknown>) =>
        records.push({ msg, fields }),
      warn: (msg: string, fields: Record<string, unknown>) =>
        records.push({ msg, fields }),
      error: (msg: string, fields: Record<string, unknown>) =>
        records.push({ msg, fields }),
    } as unknown as MaintenanceQueueLogger,
  };
}

interface Recorded {
  text: string;
  values: unknown[];
}

/** A pg fake that dispatches on statement shape and records everything. */
function fakePool(
  responder: (sql: string, values: unknown[]) => { rows: unknown[] } | void,
) {
  const seen: Recorded[] = [];
  const run = async (text: string, values: unknown[] = []) => {
    seen.push({ text, values });
    const res = responder(text, values);
    return {
      rows: res?.rows ?? [],
      rowCount: res?.rows?.length ?? 0,
    };
  };
  const pool = {
    query: run,
    connect: async () => ({ query: run, release: () => undefined }),
  } as unknown as pg.Pool;
  return { pool, seen };
}

function candidateRow(over: Record<string, unknown> = {}) {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    namespace: "rico",
    candidate_type: "decision",
    content: "we are going with pgvector",
    content_hash: "hash-a",
    uncertain: false,
    uncertainty_reason: null,
    model: "rule-based-distiller/v1",
    session_count: null,
    occurrence_count: null,
    reinforcement_count: "0",
    ...over,
  };
}

describe("heuristicRemGrader — signals, not weights", () => {
  function candidate(over: Partial<RemCandidate> = {}): RemCandidate {
    return {
      id: "c1",
      namespace: "rico",
      candidate_type: "decision",
      content: "we are going with pgvector",
      content_hash: "h",
      uncertain: false,
      uncertainty_reason: null,
      model: "rule-based-distiller/v1",
      session_count: 0,
      occurrence_count: 0,
      reinforcement_count: 0,
      ...over,
    };
  }

  it("promotes on cross-session corroboration -- measured evidence, not opinion", async () => {
    const v = await heuristicRemGrader.grade(candidate({ session_count: 3 }));
    expect(v.grade).toBe("promoted");
    expect(v.reason).toContain("3 sessions");
  });

  it("does not treat a single session as corroboration", async () => {
    expect(
      (await heuristicRemGrader.grade(candidate({ session_count: 1 }))).grade,
    ).toBe("inconclusive");
  });

  it("promotes on absorbed near-duplicate restatements", async () => {
    const v = await heuristicRemGrader.grade(
      candidate({ reinforcement_count: 2 }),
    );
    expect(v.grade).toBe("promoted");
  });

  it("maps the producer's own doubt to inconclusive, never to rejected", async () => {
    // 037:35-37 -- 'inconclusive' exists so "I cannot tell" does not collapse
    // into "rejected", which is silent data loss.
    const v = await heuristicRemGrader.grade(
      candidate({ uncertain: true, uncertainty_reason: "bare ack" }),
    );
    expect(v.grade).toBe("inconclusive");
    expect(v.reason).toBe("bare ack");
  });

  it("NEVER emits 'rejected' for any input shape", async () => {
    // A model measured mislabelling 112 of 214 candidates
    // (dream-design.md:238) has no business asserting a negative -- and under
    // "everything passes" a negative guess buys nothing anyway.
    const shapes: Array<Partial<RemCandidate>> = [
      {},
      { uncertain: true },
      { session_count: 0, occurrence_count: 0 },
      { session_count: 99, reinforcement_count: 99 },
      { content: "" },
      { candidate_type: "correction" },
      { candidate_type: "preference", uncertain: true },
    ];
    for (const shape of shapes) {
      expect((await heuristicRemGrader.grade(candidate(shape))).grade).not.toBe(
        "rejected",
      );
    }
  });

  it("says 'cannot tell' for an uncorroborated one-off rather than inventing a rule", async () => {
    // dream-design.md:817-821 names this an open hole and says do not invent a
    // companion rule. Leaving it on the operator's queue is the honest answer.
    const v = await heuristicRemGrader.grade(candidate());
    expect(v.grade).toBe("inconclusive");
    expect(v.reason).toContain("no rule designed for one-offs");
  });

  it("names itself, so a grade stays attributable across a model swap", () => {
    expect(heuristicRemGrader.name).toBe("rem-heuristic-v1");
  });

  it("shares the review vocabulary exactly, so disagreement is measurable", () => {
    // A disagreement rate is only meaningful if both sides speak the same
    // language (037:107-123).
    expect([...GRADE_VALUES]).toEqual([
      "promoted",
      "rejected",
      "duplicate",
      "inconclusive",
    ]);
  });
});

describe("runRemGrading — the operator queue is untouchable", () => {
  it("writes ONLY machine_grade and machine_grade_model", async () => {
    // The single most important invariant. There is no return value that
    // distinguishes this from writing review_action, so the statement text is
    // the only place it is visible.
    const { pool, seen } = fakePool((sql) =>
      sql.includes("FROM candidate_memory c")
        ? { rows: [candidateRow()] }
        : undefined,
    );
    await runRemGrading({ pool, logger: silentLogger });

    const update = seen.find((s) =>
      s.text.includes("UPDATE candidate_memory"),
    )!;
    expect(update.text).toContain("machine_grade = $2");
    expect(update.text).toContain("machine_grade_model = $3");
    expect(update.text).not.toContain("review_action");
    expect(update.text).not.toContain("reviewed_at =");
    expect(update.text).not.toContain("graded_by");
  });

  it("guards every write on reviewed_at IS NULL so the operator's grade wins", async () => {
    // Restated at the UPDATE rather than trusted from the SELECT: the operator
    // may have graded the item in the interval.
    const { pool, seen } = fakePool((sql) =>
      sql.includes("FROM candidate_memory c")
        ? { rows: [candidateRow()] }
        : undefined,
    );
    await runRemGrading({ pool, logger: silentLogger });
    const update = seen.find((s) =>
      s.text.includes("UPDATE candidate_memory"),
    )!;
    expect(update.text).toContain("reviewed_at IS NULL");
    expect(update.text).toContain("machine_grade IS NULL");
  });

  it("selects only ungraded, unreviewed rows -- idempotent on replay", async () => {
    const { pool, seen } = fakePool(() => undefined);
    await runRemGrading({ pool, logger: silentLogger });
    const select = seen.find((s) =>
      s.text.includes("FROM candidate_memory c"),
    )!;
    expect(select.text).toContain("c.machine_grade IS NULL");
    expect(select.text).toContain("c.reviewed_at IS NULL");
  });

  it("never orders by turn_index or joins on parent_turn_uuid", async () => {
    const { pool, seen } = fakePool((sql) =>
      sql.includes("FROM candidate_memory c")
        ? { rows: [candidateRow()] }
        : undefined,
    );
    await runRemGrading({ pool, logger: silentLogger });
    for (const s of seen) {
      expect(s.text).not.toContain("turn_index");
      expect(s.text).not.toContain("parent_turn_uuid");
    }
  });

  it("does not filter the queue on the machine's own opinion", async () => {
    // Under "everything passes", a machine grade sorts; it never suppresses.
    const { pool, seen } = fakePool(() => undefined);
    await runRemGrading({ pool, logger: silentLogger });
    const select = seen.find((s) =>
      s.text.includes("FROM candidate_memory c"),
    )!;
    expect(select.text).toContain("ORDER BY c.uncertain DESC");
    expect(select.text).not.toContain("WHERE c.uncertain =");
  });

  it("reads corroboration by LEFT JOIN, so a miss means zero and not exclusion", async () => {
    // Absence of a count is absence of evidence, not evidence of absence -- an
    // INNER JOIN here would silently drop every uncounted candidate.
    const { pool, seen } = fakePool((sql) =>
      sql.includes("FROM candidate_memory c")
        ? { rows: [candidateRow()] }
        : undefined,
    );
    const summary = await runRemGrading({ pool, logger: silentLogger });
    const select = seen.find((s) =>
      s.text.includes("FROM candidate_memory c"),
    )!;
    expect(select.text).toContain("LEFT JOIN content_occurrences");
    expect(summary.graded).toBe(1);
  });

  it("grades a corroborated candidate as promoted and counts it", async () => {
    const { pool } = fakePool((sql) =>
      sql.includes("FROM candidate_memory c")
        ? {
            rows: [candidateRow({ session_count: "4", occurrence_count: "9" })],
          }
        : undefined,
    );
    const summary = await runRemGrading({ pool, logger: silentLogger });
    expect(summary.corroborated).toBe(1);
    expect(summary.by_grade.promoted).toBe(1);
  });

  it("records generation grading by candidate id without candidate content", async () => {
    const candidate = candidateRow({
      id: "candidate-trace-id",
      content: "tenant candidate content must not be traced",
    });
    const { pool } = fakePool((sql) =>
      sql.includes("FROM candidate_memory c") ? { rows: [candidate] } : undefined,
    );
    const emitter = recordingTracing();
    const trace = new BackgroundTraceRecorder(emitter, {
      name: "dream.rem",
      tags: ["background-job", "dream"],
    });
    const grader: NamedRemGrader = {
      name: "fixture-grader",
      observationType: "generation",
      grade: () => ({
        grade: "promoted",
        reason: "tenant candidate content must not be traced",
      }),
    };

    await runRemGrading({ pool, logger: silentLogger, grader, trace });
    trace.finish({ outcome: "succeeded" });

    const observation = emitter.bodies[0]!.observations[0]!;
    expect(observation.input).toEqual({ candidate_id: "candidate-trace-id" });
    expect(observation.output).toEqual({ grade: "promoted", has_reason: true });
    expect(JSON.stringify(observation)).not.toContain(candidate.content);
  });

  it("skips one bad grader verdict instead of stalling the whole pass", async () => {
    // The check-constraint would reject the row anyway; catching it here turns
    // a failed transaction into one skipped candidate plus a warning.
    const rogue: NamedRemGrader = {
      name: "rogue-v1",
      grade: () => ({ grade: "maybe" as never }),
    };
    const { records, logger } = collectingLogger();
    const { pool, seen } = fakePool((sql) =>
      sql.includes("FROM candidate_memory c")
        ? { rows: [candidateRow()] }
        : undefined,
    );
    const summary = await runRemGrading({ pool, logger, grader: rogue });
    expect(summary.examined).toBe(1);
    expect(summary.graded).toBe(0);
    expect(seen.some((s) => s.text.includes("UPDATE candidate_memory"))).toBe(
      false,
    );
    expect(
      records.some((r) => r.msg === "dream_rem_grade_out_of_vocabulary"),
    ).toBe(true);
  });

  it("handles an empty candidate table -- the day-one state", async () => {
    const { pool } = fakePool(() => undefined);
    const summary = await runRemGrading({ pool, logger: silentLogger });
    expect(summary).toMatchObject({ examined: 0, graded: 0 });
  });

  it("logs counts and a grader name, never content", async () => {
    const { records, logger } = collectingLogger();
    const { pool } = fakePool((sql) =>
      sql.includes("FROM candidate_memory c")
        ? {
            rows: [
              candidateRow({ content: "a very identifiable secret decision" }),
            ],
          }
        : undefined,
    );
    await runRemGrading({ pool, logger });
    const done = records.find((r) => r.msg === "dream_rem_grading_complete")!;
    expect(JSON.stringify(done.fields)).not.toContain("identifiable");
    expect(done.fields).toMatchObject({ grader: "rem-heuristic-v1" });
  });
});

describe("runRemRewarm — tier flips, one direction only", () => {
  function rewarmPool(projects: Array<{ repo: string; sessions: string }>) {
    return fakePool((sql) => {
      if (sql.includes("FROM ob_raw_turns")) {
        return {
          rows: projects.map((p) => ({ namespace: "rico", ...p })),
        };
      }
      if (sql.includes("UPDATE thoughts")) return { rows: [] };
      return undefined;
    });
  }

  it("notices a single-session project without acting on it", async () => {
    // dream-design.md:387-392 -- 1 session is "notice, no action".
    const { pool, seen } = rewarmPool([{ repo: "open-brain", sessions: "1" }]);
    const summary = await runRemRewarm({ pool, logger: silentLogger });
    expect(summary.noticed_only).toBe(1);
    expect(seen.some((s) => s.text.includes("UPDATE thoughts"))).toBe(false);
  });

  it("begins warming at the minimum-session threshold, with the BEGIN limit", async () => {
    const { pool, seen } = rewarmPool([
      { repo: "open-brain", sessions: String(REWARM_MIN_SESSIONS) },
    ]);
    await runRemRewarm({ pool, logger: silentLogger });
    const update = seen.find((s) => s.text.includes("UPDATE thoughts"))!;
    expect(update.values).toEqual(["open-brain", REWARM_BEGIN_LIMIT]);
  });

  it("restores the whole cluster at the FULL threshold", async () => {
    const { pool, seen } = rewarmPool([
      { repo: "king-capital", sessions: String(REWARM_FULL_SESSIONS) },
    ]);
    await runRemRewarm({ pool, logger: silentLogger });
    const update = seen.find((s) => s.text.includes("UPDATE thoughts"))!;
    expect(update.values[1]).toBe(REWARM_FULL_LIMIT);
  });

  it("only ever warms -- it never cools, demotes, archives, or deletes", async () => {
    // Cooling on silence is a decay process, not a sweep. A nightly job that
    // demotes memory is a destructive act on a cadence nobody asked for.
    const { pool, seen } = rewarmPool([
      { repo: "open-brain", sessions: "9" },
      { repo: "king-capital", sessions: "3" },
    ]);
    await runRemRewarm({ pool, logger: silentLogger });
    for (const s of seen) {
      expect(s.text).not.toContain("DELETE");
      expect(s.text).not.toContain("archived_at = ");
      // Only the SET clause is a mutation. `(tier = 'cold')` appears in the
      // ORDER BY as a coldest-first predicate, which is a read.
      const setClause = s.text.slice(
        s.text.indexOf("SET "),
        s.text.indexOf("WHERE"),
      );
      expect(setClause).not.toContain("'cold'");
      expect(setClause).not.toContain("'warm'");
      expect(setClause).not.toContain("archived_at");
    }
    const updates = seen.filter((s) => s.text.includes("UPDATE thoughts"));
    expect(updates).toHaveLength(2);
    for (const u of updates) expect(u.text).toContain("tier = 'hot'");
  });

  it("spends the pass budget on the most-engaged projects first", async () => {
    const { pool, seen } = rewarmPool([
      { repo: "quiet", sessions: "2" },
      { repo: "busiest", sessions: "20" },
      { repo: "middling", sessions: "6" },
    ]);
    await runRemRewarm({ pool, logger: silentLogger });
    const order = seen
      .filter((s) => s.text.includes("UPDATE thoughts"))
      .map((s) => s.values[0]);
    expect(order).toEqual(["busiest", "middling", "quiet"]);
  });

  it("keeps the whole pass under the ceiling", async () => {
    // 16 re-engaged projects at the FULL limit would flip 1,600 entries hot in
    // one run, which is not "restoring a cluster", it is disabling the tier.
    const many = Array.from({ length: 20 }, (_, i) => ({
      repo: `repo-${i}`,
      sessions: "9",
    }));
    const { pool, seen } = fakePool((sql, values) => {
      if (sql.includes("FROM ob_raw_turns")) {
        return { rows: many.map((p) => ({ namespace: "rico", ...p })) };
      }
      // Every project has more cold entries than any limit, so the UPDATE
      // returns exactly as many rows as its LIMIT allows -- the same thing real
      // Postgres does, and what makes the per-statement clamp observable.
      if (sql.includes("UPDATE thoughts")) {
        return { rows: Array(Number(values[1])).fill({}) };
      }
      return undefined;
    });
    const summary = await runRemRewarm({ pool, logger: silentLogger });
    expect(summary.warmed).toBe(REWARM_MAX_PER_PASS);
    const updates = seen.filter((s) => s.text.includes("UPDATE thoughts"));
    expect(updates.length).toBeLessThan(many.length);
    // The last statement is clamped to the remaining budget rather than
    // overshooting it, which is what keeps the ceiling exact rather than
    // approximate.
    const lastLimit = Number(updates.at(-1)!.values[1]);
    expect(lastLimit).toBeLessThanOrEqual(REWARM_FULL_LIMIT);
  });

  it("converges: an already-hot entry is not rewritten", async () => {
    const { pool, seen } = rewarmPool([{ repo: "open-brain", sessions: "3" }]);
    await runRemRewarm({ pool, logger: silentLogger });
    const update = seen.find((s) => s.text.includes("UPDATE thoughts"))!;
    expect(update.text).toContain("tier IS DISTINCT FROM 'hot'");
    expect(update.text).toContain("archived_at IS NULL");
  });

  it("counts noticed projects up front so a budget exhaustion does not hide them", async () => {
    const { pool } = rewarmPool([
      { repo: "a", sessions: "1" },
      { repo: "b", sessions: "1" },
      { repo: "c", sessions: "5" },
    ]);
    const summary = await runRemRewarm({ pool, logger: silentLogger });
    expect(summary.projects_seen).toBe(3);
    expect(summary.noticed_only).toBe(2);
  });
});

describe("runRemPass — ordering and composition", () => {
  it("runs dedupe BEFORE grading so grading sees the reinforcement", async () => {
    // Grading is idempotent on machine_grade IS NULL, so the other order would
    // grade every candidate on the evidence available before the evidence was
    // gathered -- once, permanently.
    const order: string[] = [];
    const { pool } = fakePool((sql) => {
      if (sql.includes("candidate_reinforcement") && sql.includes("count(*)")) {
        order.push("dedupe");
      }
      if (
        sql.includes("FROM candidate_memory c") &&
        sql.includes("LEFT JOIN")
      ) {
        order.push("grade");
      }
      if (sql.includes("FROM ob_raw_turns")) order.push("rewarm");
      return undefined;
    });
    await runRemPass({ pool, logger: silentLogger });
    expect(order.indexOf("dedupe")).toBeLessThan(order.indexOf("grade"));
    expect(order.indexOf("grade")).toBeLessThan(order.indexOf("rewarm"));
  });

  it("honours skip flags without skipping grading", async () => {
    const { pool, seen } = fakePool(() => undefined);
    const res = await runRemPass({
      pool,
      logger: silentLogger,
      skipDedupe: true,
      skipRewarm: true,
    });
    expect(res.dedupe).toEqual({
      examined: 0,
      merged: 0,
      reinforced: 0,
      skipped_no_embedding: 0,
    });
    expect(res.rewarm).toEqual({
      projects_seen: 0,
      warmed: 0,
      noticed_only: 0,
    });
    // Grading still ran.
    expect(seen.some((s) => s.text.includes("FROM candidate_memory c"))).toBe(
      true,
    );
  });
});

describe("makeDreamRemHandler", () => {
  function job(over: Partial<MaintenanceJob> = {}): MaintenanceJob {
    const now = new Date("2026-07-28T00:00:00Z");
    return {
      id: "job-rem-1",
      kind: DREAM_REM_JOB_KIND,
      version: DREAM_REM_JOB_VERSION,
      payload: { skip_dedupe: true, skip_rewarm: true },
      idempotencyKey: "k",
      state: "running",
      runAfter: now,
      leaseToken: "00000000-0000-4000-8000-000000000001",
      leaseUntil: now,
      attempts: 1,
      maxAttempts: 3,
      backoffBaseMs: 1_000,
      backoffMaxMs: 4_000,
      lastErrorCategory: null,
      terminalAt: null,
      deadLetteredAt: null,
      namespace: null,
      provenance: null,
      createdAt: now,
      updatedAt: now,
      ...over,
    } as MaintenanceJob;
  }

  it("dead-letters a version mismatch before reading the payload", async () => {
    const { pool } = fakePool(() => undefined);
    const handler = makeDreamRemHandler({ pool, logger: silentLogger });
    await expect(handler(job({ version: 7 }))).rejects.toBeInstanceOf(
      MaintenanceTerminalError,
    );
  });

  it("scopes to the job's namespace when one is set", async () => {
    const { pool, seen } = fakePool(() => undefined);
    const handler = makeDreamRemHandler({ pool, logger: silentLogger });
    await handler(job({ namespace: "rico" }));
    const select = seen.find((s) =>
      s.text.includes("FROM candidate_memory c"),
    )!;
    expect(select.values[0]).toBe("rico");
  });

  it("treats a null namespace as a deliberate global pass, not an error", async () => {
    const { pool, seen } = fakePool(() => undefined);
    const handler = makeDreamRemHandler({ pool, logger: silentLogger });
    await handler(job({ namespace: null }));
    const select = seen.find((s) =>
      s.text.includes("FROM candidate_memory c"),
    )!;
    expect(select.values[0]).toBeNull();
  });

  it("keeps a global REM sweep off tenant sessions and attributes candidate namespaces", async () => {
    const { pool } = fakePool((sql) =>
      sql.includes("FROM candidate_memory c")
        ? {
            rows: [
              candidateRow({ id: "candidate-rico", namespace: "rico" }),
              candidateRow({ id: "candidate-other", namespace: "other" }),
            ],
          }
        : undefined,
    );
    const tracing = recordingTracing();
    const handler = makeDreamRemHandler({ pool, logger: silentLogger, tracing });

    await handler(
      job({
        namespace: null,
        payload: {
          skip_dedupe: true,
          skip_rewarm: true,
          session_key: "tenant-session-must-not-bind",
        },
      }),
    );

    expect(tracing.bodies).toHaveLength(1);
    expect(tracing.bodies[0]?.sessionId).toBeUndefined();
    const grades = tracing.bodies[0]!.observations.filter(
      (observation) => observation.name === "dream.rem.grade",
    );
    expect(grades.map((observation) => observation.metadata.namespace)).toEqual([
      "rico",
      "other",
    ]);
  });

  it("emits one REM run trace with stage spans and session binding", async () => {
    const { pool } = fakePool(() => undefined);
    const tracing = recordingTracing();
    const handler = makeDreamRemHandler({
      pool,
      logger: silentLogger,
      tracing,
    });

    await handler(
      job({
        namespace: "rico",
        payload: {
          skip_dedupe: true,
          skip_rewarm: true,
          session_key: "session-rem",
        },
      }),
    );

    expect(tracing.bodies[0]).toMatchObject({
      name: "dream.rem",
      sessionId: "session-rem",
      metadata: { status: "success" },
      observations: [
        { name: "dream.rem.dedupe", type: "span" },
        { name: "dream.rem.grading", type: "span" },
        { name: "dream.rem.rewarm", type: "span" },
      ],
    });
  });
});

describe("buildDreamRemEnqueue", () => {
  it("uses a kind the queue's regex accepts", () => {
    expect(DREAM_REM_JOB_KIND).toMatch(/^[a-z][a-z0-9_.-]{0,127}$/);
  });

  it("derives distinct keys from distinct sweep labels", () => {
    expect(buildDreamRemEnqueue({ sweepLabel: "a" }).idempotencyKey).not.toBe(
      buildDreamRemEnqueue({ sweepLabel: "b" }).idempotencyKey,
    );
  });

  it("bounds the key under the queue's cap", () => {
    expect(
      buildDreamRemEnqueue({ sweepLabel: "y".repeat(400) }).idempotencyKey
        .length,
    ).toBeLessThanOrEqual(200);
  });
});
