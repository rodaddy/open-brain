/**
 * Functional tests for DREAM Stage 3 -- Deep (#394).
 *
 * DEEP HAS NO WRITE PATH, AND THAT IS THE FEATURE. dream-design.md:773-781 has
 * Deep committing above a 0.5 confidence band silently; that table is
 * SUPERSEDED for this build by the 2026-07-28 operator decision encoded in
 * 037_candidate_memory_uncertainty.sql:59-63 and recorded as a delta in
 * docs/decisions/let-everything-pass-grading.md. So the queue predicate is
 * `reviewed_at IS NULL` and nothing else, and the module is read-only.
 *
 * The first block asserts exactly that, on the statement text, because a
 * suppression path is invisible from the return value: a page that silently
 * excluded 1,100 candidates would return 20 well-formed bundles and look
 * healthy.
 *
 * The rest is ordinary input/output over a bundle builder: the attention cap,
 * the receipts, and -- the subtle one -- that one candidate's context turns
 * never leak into another candidate's bundle, which would make the reviewer
 * judge a claim against the wrong conversation.
 */

import { describe, expect, it } from "bun:test";
import type pg from "pg";
import {
  buildReviewBundles,
  DEFAULT_BUNDLE_LIMIT,
  DEFAULT_CONTEXT_TURNS,
} from "./dream-deep.ts";
import type { MaintenanceQueueLogger } from "./maintenance-queue.ts";

const silentLogger: MaintenanceQueueLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface Recorded {
  text: string;
  values: unknown[];
}

const T = (n: number) =>
  `77777777-7777-4777-8777-${String(n).padStart(12, "0")}`;
const C = (n: number) =>
  `88888888-8888-4888-8888-${String(n).padStart(12, "0")}`;

function candidateRow(over: Record<string, unknown> = {}) {
  return {
    id: C(1),
    namespace: "rico",
    candidate_type: "decision",
    content: "we are going with pgvector",
    uncertain: true,
    uncertainty_reason: "bare ack",
    model: "rule-based-distiller/v1",
    authority_tier: null,
    created_at: new Date("2026-07-28T00:00:00Z"),
    first_said_at: new Date("2026-07-25T00:00:00Z"),
    last_said_at: new Date("2026-07-27T00:00:00Z"),
    machine_grade: null,
    machine_grade_model: null,
    source_turn_ids: [T(5)],
    session_count: null,
    occurrence_count: null,
    occ_first_seen_at: null,
    occ_last_seen_at: null,
    ...over,
  };
}

function turnRow(seq: number, over: Record<string, unknown> = {}) {
  return {
    id: T(seq),
    role: "user",
    content: `turn ${seq}`,
    occurred_at: new Date(Date.UTC(2026, 6, 28, 0, seq)),
    session_ref: "s1",
    session_seq: seq,
    repo: "open-brain",
    ...over,
  };
}

function fakePool(opts: {
  depth?: string;
  candidates?: Record<string, unknown>[];
  sourceTurns?: Record<string, unknown>[];
  contextTurns?: Record<string, unknown>[];
  reinforcement?: Record<string, unknown>[];
}) {
  const seen: Recorded[] = [];
  const run = async (text: string, values: unknown[] = []) => {
    seen.push({ text, values });
    let rows: unknown[] = [];
    if (
      text.includes("count(*)::text AS n") &&
      text.includes("candidate_memory")
    ) {
      rows = [{ n: opts.depth ?? "0" }];
    } else if (text.includes("FROM candidate_memory c")) {
      rows = opts.candidates ?? [];
    } else if (text.includes("FROM candidate_reinforcement")) {
      rows = opts.reinforcement ?? [];
    } else if (text.includes("WHERE id = ANY($1::uuid[])")) {
      rows = opts.sourceTurns ?? [];
    } else if (text.includes("JOIN unnest(")) {
      rows = opts.contextTurns ?? [];
    }
    return { rows, rowCount: rows.length };
  };
  const pool = {
    query: run,
    connect: async () => ({ query: run, release: () => undefined }),
  } as unknown as pg.Pool;
  return { pool, seen };
}

describe("the queue predicate is reviewed_at IS NULL and nothing else", () => {
  it("does not filter on a confidence band, machine_grade, or uncertainty", async () => {
    // 037:59-63. A suppression path here is invisible from the return value:
    // 20 well-formed bundles look identical whether 1,100 were excluded or not.
    const { pool, seen } = fakePool({});
    await buildReviewBundles({ pool, logger: silentLogger });
    const page = seen.find((s) => s.text.includes("FROM candidate_memory c"))!;
    expect(page.text).toContain("c.reviewed_at IS NULL");
    expect(page.text).not.toContain("confidence");
    expect(page.text).not.toContain("machine_grade =");
    expect(page.text).not.toContain("WHERE c.uncertain");
    expect(page.text).not.toContain("AND c.uncertain");
  });

  it("lets uncertain reach ORDER BY only -- it sorts, it never filters", async () => {
    const { pool, seen } = fakePool({});
    await buildReviewBundles({ pool, logger: silentLogger });
    const page = seen.find((s) => s.text.includes("FROM candidate_memory c"))!;
    expect(page.text).toContain("ORDER BY c.uncertain DESC, c.created_at ASC");
  });

  it("issues no INSERT, UPDATE, or DELETE anywhere", async () => {
    // A stage with no write path cannot autonomously commit by accident, which
    // is why dream-design.md:116's ALWAYS-ASK rule is safe here.
    const { pool, seen } = fakePool({
      depth: "1104",
      candidates: [candidateRow()],
      sourceTurns: [turnRow(5)],
      contextTurns: [turnRow(4), turnRow(6)],
    });
    await buildReviewBundles({ pool, logger: silentLogger });
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s.text).not.toMatch(/\bINSERT\b/);
      expect(s.text).not.toMatch(/\bUPDATE\b/);
      expect(s.text).not.toMatch(/\bDELETE\b/);
    }
  });

  it("does not order by turn_index or thread on parent_turn_uuid", async () => {
    // turn_index is per-hook-batch and parent_turn_uuid dangles on 24% of rows.
    const { pool, seen } = fakePool({
      candidates: [candidateRow()],
      sourceTurns: [turnRow(5)],
      contextTurns: [turnRow(4)],
    });
    await buildReviewBundles({ pool, logger: silentLogger });
    for (const s of seen) {
      expect(s.text).not.toContain("turn_index");
      expect(s.text).not.toContain("parent_turn_uuid");
    }
  });
});

describe("the attention budget is a hard constraint", () => {
  it("defaults to the doc's reviewable figure", async () => {
    // dream-design.md:825 -- "20 is reviewable, 200 gets skipped."
    expect(DEFAULT_BUNDLE_LIMIT).toBe(20);
    const { pool, seen } = fakePool({});
    await buildReviewBundles({ pool, logger: silentLogger });
    const page = seen.find((s) => s.text.includes("FROM candidate_memory c"))!;
    expect(page.values[1]).toBe(20);
  });

  it("reports the queue depth behind the page so the cap is visible, not hidden", async () => {
    // The cap is on what a person is asked to look at, not on what exists. A
    // page that showed 20 of 1,104 without saying so reads as "almost done".
    const { pool } = fakePool({ depth: "1104" });
    const { summary } = await buildReviewBundles({
      pool,
      logger: silentLogger,
    });
    expect(summary.queue_depth).toBe(1104);
    expect(summary.bundles).toBe(0);
  });

  it("issues a bounded number of queries regardless of page size", async () => {
    // Two queries per page, not two per bundle: the cap is a policy dial and a
    // 2N builder degrades the moment someone raises it.
    const many = Array.from({ length: 20 }, (_, i) =>
      candidateRow({ id: C(i + 1), source_turn_ids: [T(i + 1)] }),
    );
    const { pool, seen } = fakePool({
      candidates: many,
      sourceTurns: many.map((_, i) => turnRow(i + 1)),
      contextTurns: [],
    });
    const { bundles } = await buildReviewBundles({
      pool,
      logger: silentLogger,
    });
    expect(bundles).toHaveLength(20);
    // depth + page + reinforcement + source turns + context = 5, not 40+.
    expect(seen.length).toBeLessThanOrEqual(6);
  });
});

describe("bundles carry the evidence a reviewer needs", () => {
  const built = () =>
    fakePool({
      depth: "3",
      candidates: [
        candidateRow({
          session_count: "4",
          occurrence_count: "9",
          occ_first_seen_at: new Date("2026-07-20T00:00:00Z"),
          occ_last_seen_at: new Date("2026-07-27T00:00:00Z"),
          machine_grade: "promoted",
          machine_grade_model: "rem-heuristic-v1",
        }),
      ],
      sourceTurns: [turnRow(5, { role: "user", content: "go for it" })],
      contextTurns: [
        turnRow(4, { role: "assistant", content: "I can switch both hooks." }),
        turnRow(6, { role: "assistant", content: "Both hooks switched." }),
      ],
      reinforcement: [
        {
          candidate_id: C(1),
          n: "2",
          first_at: new Date("2026-06-12T00:00:00Z"),
          last_at: new Date("2026-07-19T00:00:00Z"),
        },
      ],
    });

  it("never returns a candidate without its source turns when they exist", async () => {
    // A bare claim like "Operator approved: 'ok'" is not gradeable; judging it
    // without seeing what was approved is guessing, not grading.
    const { pool } = built();
    const { bundles } = await buildReviewBundles({
      pool,
      logger: silentLogger,
    });
    const b = bundles[0]!;
    const sources = b.turns.filter((t) => t.is_source);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.content).toBe("go for it");
  });

  it("shows the turns AROUND the source, both before and after", async () => {
    // Symmetric on purpose: the reviewer judges after the fact, and what
    // happened NEXT is often what shows whether the decision was real.
    expect(DEFAULT_CONTEXT_TURNS).toBe(3);
    const { pool } = built();
    const { bundles } = await buildReviewBundles({
      pool,
      logger: silentLogger,
    });
    const contents = bundles[0]!.turns.map((t) => t.content);
    expect(contents).toContain("I can switch both hooks.");
    expect(contents).toContain("Both hooks switched.");
  });

  it("orders turns as the conversation happened, by session_seq", async () => {
    const { pool } = built();
    const { bundles } = await buildReviewBundles({
      pool,
      logger: silentLogger,
    });
    const seqs = bundles[0]!.turns.map((t) => t.session_seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => (a ?? 0) - (b ?? 0)));
    expect(seqs).toEqual([4, 5, 6]);
  });

  it("carries corroboration and reinforcement as dated receipts, not a score", async () => {
    // gbrain's "receipts on recall" (dream-design.md:709-712).
    const { pool } = built();
    const { bundles, summary } = await buildReviewBundles({
      pool,
      logger: silentLogger,
    });
    expect(bundles[0]!.corroboration).toEqual({
      session_count: 4,
      occurrence_count: 9,
      first_seen_at: "2026-07-20T00:00:00.000Z",
      last_seen_at: "2026-07-27T00:00:00.000Z",
    });
    expect(bundles[0]!.reinforcement).toEqual({
      count: 2,
      first_at: "2026-06-12T00:00:00.000Z",
      last_at: "2026-07-19T00:00:00.000Z",
    });
    expect(summary.corroborated).toBe(1);
    expect(summary.reinforced).toBe(1);
  });

  it("computes reinforcement live from the history table, never from the candidate row", async () => {
    const { pool, seen } = built();
    await buildReviewBundles({ pool, logger: silentLogger });
    const receipt = seen.find((s) =>
      s.text.includes("FROM candidate_reinforcement"),
    )!;
    expect(receipt.text).toContain("count(*)");
    const page = seen.find((s) => s.text.includes("FROM candidate_memory c"))!;
    expect(page.text).not.toContain("reinforcement_count");
  });

  it("shows REM's guess as advisory, alongside the candidate rather than instead of it", async () => {
    const { pool } = built();
    const { bundles, summary } = await buildReviewBundles({
      pool,
      logger: silentLogger,
    });
    expect(bundles[0]!.machine).toEqual({
      grade: "promoted",
      model: "rem-heuristic-v1",
    });
    expect(summary.machine_graded).toBe(1);
    // And the candidate is still on the page, which is the point: the guess
    // does not remove anything.
    expect(bundles[0]!.candidate.content).toBe("we are going with pgvector");
  });

  it("carries said-at timestamps rather than only the distiller's run time", async () => {
    // created_at is when the distiller ran -- on this corpus, one afternoon for
    // three days of history (039's header).
    const { pool } = built();
    const { bundles } = await buildReviewBundles({
      pool,
      logger: silentLogger,
    });
    expect(bundles[0]!.candidate.first_said_at).toBe(
      "2026-07-25T00:00:00.000Z",
    );
    expect(bundles[0]!.candidate.last_said_at).toBe("2026-07-27T00:00:00.000Z");
    expect(bundles[0]!.candidate.created_at).toBe("2026-07-28T00:00:00.000Z");
  });
});

describe("context never leaks between bundles", () => {
  it("keeps one candidate's conversation out of another's bundle", async () => {
    // Worse than no context: it makes the reviewer judge the claim against the
    // wrong conversation.
    const { pool } = fakePool({
      depth: "2",
      candidates: [
        candidateRow({ id: C(1), source_turn_ids: [T(5)] }),
        candidateRow({
          id: C(2),
          content: "unrelated claim",
          source_turn_ids: [T(50)],
        }),
      ],
      sourceTurns: [
        turnRow(5, { session_ref: "sA" }),
        turnRow(50, { session_ref: "sB" }),
      ],
      contextTurns: [
        turnRow(4, { session_ref: "sA", content: "A-context" }),
        turnRow(49, { session_ref: "sB", content: "B-context" }),
      ],
    });
    const { bundles } = await buildReviewBundles({
      pool,
      logger: silentLogger,
    });
    const a = bundles.find((b) => b.candidate.id === C(1))!;
    const b = bundles.find((b) => b.candidate.id === C(2))!;
    expect(a.turns.map((t) => t.content)).toContain("A-context");
    expect(a.turns.map((t) => t.content)).not.toContain("B-context");
    expect(b.turns.map((t) => t.content)).toContain("B-context");
    expect(b.turns.map((t) => t.content)).not.toContain("A-context");
  });

  it("does not duplicate a source turn that also appears in the context query", async () => {
    const { pool } = fakePool({
      candidates: [candidateRow()],
      sourceTurns: [turnRow(5)],
      contextTurns: [turnRow(4), turnRow(5), turnRow(6)],
    });
    const { bundles } = await buildReviewBundles({
      pool,
      logger: silentLogger,
    });
    const ids = bundles[0]!.turns.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(bundles[0]!.turns.filter((t) => t.is_source)).toHaveLength(1);
  });
});

describe("degradation is surfaced, not hidden", () => {
  it("still builds a bundle when provenance does not resolve, and counts the gap", async () => {
    // The candidate is real and the operator can still grade its text; the gap
    // must not hide behind a healthy-looking page.
    const { pool } = fakePool({
      depth: "1",
      candidates: [candidateRow({ source_turn_ids: [T(999)] })],
      sourceTurns: [],
      contextTurns: [],
    });
    const { bundles, summary } = await buildReviewBundles({
      pool,
      logger: silentLogger,
    });
    expect(bundles).toHaveLength(1);
    expect(bundles[0]!.turns).toEqual([]);
    expect(summary.missing_turns).toBe(1);
  });

  it("gives a NULL-session_seq source no context rather than the wrong context", async () => {
    const { pool } = fakePool({
      candidates: [candidateRow()],
      sourceTurns: [turnRow(5, { session_seq: null })],
      contextTurns: [turnRow(4), turnRow(6)],
    });
    const { bundles } = await buildReviewBundles({
      pool,
      logger: silentLogger,
    });
    expect(bundles[0]!.turns).toHaveLength(1);
    expect(bundles[0]!.turns[0]!.is_source).toBe(true);
  });

  it("renders an empty queue as an empty page -- the day-one state", async () => {
    const { pool } = fakePool({ depth: "0", candidates: [] });
    const { bundles, summary } = await buildReviewBundles({
      pool,
      logger: silentLogger,
    });
    expect(bundles).toEqual([]);
    expect(summary).toEqual({
      bundles: 0,
      queue_depth: 0,
      machine_graded: 0,
      corroborated: 0,
      reinforced: 0,
      missing_turns: 0,
    });
  });

  it("logs counts only, never candidate or turn content", async () => {
    const records: Array<{ msg: string; fields: Record<string, unknown> }> = [];
    const logger = {
      info: (msg: string, fields: Record<string, unknown>) =>
        records.push({ msg, fields }),
      warn: () => {},
      error: () => {},
    } as unknown as MaintenanceQueueLogger;
    const { pool } = fakePool({
      depth: "1",
      candidates: [candidateRow({ content: "a very identifiable secret" })],
      sourceTurns: [turnRow(5, { content: "another identifiable string" })],
    });
    await buildReviewBundles({ pool, logger });
    const done = records.find((r) => r.msg === "dream_deep_bundles_built")!;
    const s = JSON.stringify(done.fields);
    expect(s).not.toContain("identifiable");
    expect(done.fields).toMatchObject({ bundles: 1, queue_depth: 1 });
  });
});
