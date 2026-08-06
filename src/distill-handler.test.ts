/**
 * Functional tests for DISTILL persistence and its maintenance-queue handler
 * (#382).
 *
 * THREE THINGS ARE PROVEN HERE, and each one is silent when it breaks:
 *
 *  1. IDEMPOTENCE. The maintenance queue is at-least-once
 *     (src/maintenance-queue.ts), so a replayed sweep MUST be a no-op. The
 *     failure mode is not an error -- it is a table that doubles every night
 *     and a distilled_at stamp that keeps moving, which makes provenance lie
 *     about when a turn was consumed.
 *
 *  2. THE OPERATOR QUEUE IS UNTOUCHABLE. `reviewed_at IS NULL` is the queue
 *     (037_candidate_memory_uncertainty.sql:43-57). review_action is paired to
 *     reviewed_at by constraint, so a producer writing either one silently
 *     removes the item from human review -- the model grading its own training
 *     data. The INSERT must never name those columns.
 *
 *  3. A PROVIDER OUTAGE NEVER LOSES A CANDIDATE. Refusing the write when the
 *     embedding endpoint is down would discard real content over a transient
 *     infrastructure failure, which inverts the governing decision.
 *
 * The pg fake models the two statements the sweep issues (the claim SELECT and
 * the INSERT ... ON CONFLICT) plus the stamp UPDATE, with a real row store
 * behind them, so "run it twice" is a genuine second pass over the same state
 * rather than a replayed script.
 */

import { describe, expect, it } from "bun:test";
import type pg from "pg";
import {
  buildMemoryDistillEnqueue,
  makeMemoryDistillHandler,
  MEMORY_DISTILL_JOB_KIND,
  MEMORY_DISTILL_JOB_VERSION,
  runDistillSweep,
  type DistillEmbedFn,
} from "./distill-handler.ts";
import {
  MaintenanceTerminalError,
  type MaintenanceJob,
  type MaintenanceQueueLogger,
} from "./maintenance-queue.ts";
import { ruleBasedDistiller } from "./distiller.ts";
import type {
  BackgroundTraceBody,
  BackgroundTraceEmitter,
} from "./background-tracing.ts";

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
  const records: Array<{ level: string; msg: string; fields: unknown }> = [];
  return {
    records,
    logger: {
      info: (msg: string, fields: Record<string, unknown>) =>
        records.push({ level: "info", msg, fields }),
      warn: (msg: string, fields: Record<string, unknown>) =>
        records.push({ level: "warn", msg, fields }),
      error: (msg: string, fields: Record<string, unknown>) =>
        records.push({ level: "error", msg, fields }),
    } as unknown as MaintenanceQueueLogger,
  };
}

interface RawTurnRow {
  id: string;
  namespace: string;
  session_ref: string;
  session_seq: number;
  role: string;
  content: string;
  repo: string;
  occurred_at: Date;
  is_human_prompt: boolean;
  distilled_at: Date | null;
}

interface CandidateRow {
  namespace: string;
  content: string;
  content_hash: string;
  candidate_type: string;
  source_turn_ids: string[];
  embedding: string | null;
  uncertain: boolean;
  distill_job_id: string | null;
  model: string;
}

/**
 * A pg-shaped fake with a real row store.
 *
 * The point is not to emulate Postgres -- it is to make a SECOND sweep see the
 * state the FIRST one left, so idempotence is exercised rather than asserted.
 * The unique index on (namespace, content_hash) and the `distilled_at IS NULL`
 * predicate are both enforced here, because they are the two mechanisms the
 * idempotence claim rests on.
 */
function fakeCorpus(turns: RawTurnRow[]) {
  const candidates: CandidateRow[] = [];
  const statements: Array<{ text: string; values: unknown[] }> = [];

  const run = async (text: string, values: unknown[] = []) => {
    statements.push({ text, values });

    if (text.includes("FROM ob_raw_turns t") && text.includes("due_sessions")) {
      const due = turns.some((t) => t.distilled_at === null);
      if (!due) return { rows: [], rowCount: 0 };
      const rows = [...turns]
        .sort(
          (a, b) =>
            a.session_ref.localeCompare(b.session_ref) ||
            a.occurred_at.getTime() - b.occurred_at.getTime() ||
            a.id.localeCompare(b.id),
        )
        .map((t) => ({ ...t, is_due: t.distilled_at === null }));
      return { rows, rowCount: rows.length };
    }

    if (text.includes("INSERT INTO candidate_memory")) {
      const [
        namespace,
        candidate_type,
        content,
        content_hash,
        source_turn_ids,
        distill_job_id,
        model,
        embedding,
        uncertain,
      ] = values as [
        string,
        string,
        string,
        string,
        string[],
        string | null,
        string,
        string | null,
        boolean,
      ];
      // idx_candidate_memory_dedupe (033:117-118), modelled faithfully: with
      // ON CONFLICT the insert is a no-op, and WITHOUT it real Postgres raises
      // 23505. Emulating the raise rather than always no-opping is what makes
      // the idempotence tests fail if the conflict clause is ever dropped --
      // otherwise the fake would be silently stricter than the code.
      const clash = candidates.some(
        (c) => c.namespace === namespace && c.content_hash === content_hash,
      );
      if (clash) {
        if (!text.includes("ON CONFLICT")) {
          throw new Error(
            "duplicate key value violates unique constraint idx_candidate_memory_dedupe",
          );
        }
        return { rows: [], rowCount: 0 };
      }
      candidates.push({
        namespace,
        candidate_type,
        content,
        content_hash,
        source_turn_ids,
        distill_job_id,
        model,
        embedding,
        uncertain,
      });
      return { rows: [{ id: `cand-${candidates.length}` }], rowCount: 1 };
    }

    if (text.includes("UPDATE ob_raw_turns")) {
      const ids = new Set(values[0] as string[]);
      let stamped = 0;
      for (const t of turns) {
        if (ids.has(t.id) && t.distilled_at === null) {
          t.distilled_at = new Date("2026-07-28T12:00:00Z");
          stamped++;
        }
      }
      return { rows: [], rowCount: stamped };
    }

    return { rows: [], rowCount: 0 };
  };

  const client = { query: run, release: () => undefined };
  const pool = {
    query: run,
    connect: async () => client,
  } as unknown as pg.Pool;

  return { pool, candidates, statements, turns };
}

let seq = 0;
function rawTurn(over: Partial<RawTurnRow> = {}): RawTurnRow {
  seq++;
  return {
    id: `44444444-4444-4444-8444-${String(seq).padStart(12, "0")}`,
    namespace: "rico",
    session_ref: "s1",
    session_seq: seq,
    role: "user",
    content: `turn ${seq}`,
    repo: "open-brain",
    occurred_at: new Date(Date.UTC(2026, 6, 28, 0, seq)),
    is_human_prompt: true,
    distilled_at: null,
    ...over,
  };
}

const okEmbed: DistillEmbedFn = async () => ({
  embedding: Array(768).fill(0.01),
});

describe("runDistillSweep — idempotence", () => {
  it("a second sweep over the same turns writes zero new rows", async () => {
    const corpus = fakeCorpus([
      rawTurn({ content: "we are going with pgvector" }),
      rawTurn({ content: "and halfvec(768) for storage" }),
      rawTurn({ role: "tool", content: "CREATE INDEX" }),
    ]);

    const first = await runDistillSweep({
      pool: corpus.pool,
      logger: silentLogger,
      embedFn: okEmbed,
    });
    expect(first.candidates_written).toBe(2);
    expect(first.turns_stamped).toBe(3);

    const second = await runDistillSweep({
      pool: corpus.pool,
      logger: silentLogger,
      embedFn: okEmbed,
    });
    // Nothing is due, so the batch is empty and nothing is written or stamped.
    expect(second.candidates_written).toBe(0);
    expect(second.turns_stamped).toBe(0);
    expect(corpus.candidates).toHaveLength(2);
  });

  it("does not double-stamp distilled_at on a re-run", async () => {
    // A moving stamp makes provenance lie about when a turn was consumed.
    const corpus = fakeCorpus([rawTurn({ content: "switch to session_seq" })]);
    await runDistillSweep({
      pool: corpus.pool,
      logger: silentLogger,
      embedFn: okEmbed,
    });
    const firstStamp = corpus.turns[0]!.distilled_at;
    expect(firstStamp).not.toBeNull();

    await runDistillSweep({
      pool: corpus.pool,
      logger: silentLogger,
      embedFn: okEmbed,
    });
    expect(corpus.turns[0]!.distilled_at).toBe(firstStamp!);
    // And the stamp UPDATE itself carries the guard, so even a forced re-claim
    // could not move it.
    const stamp = corpus.statements.find((s) =>
      s.text.includes("UPDATE ob_raw_turns"),
    )!;
    expect(stamp.text).toContain("distilled_at IS NULL");
  });

  it("collapses identical content re-extracted from a different turn", async () => {
    // ON CONFLICT (namespace, content_hash) DO NOTHING. The same claim made
    // twice is one claim (033:124-127).
    const corpus = fakeCorpus([
      rawTurn({ content: "use halfvec(768)" }),
      rawTurn({ content: "use halfvec(768)" }),
    ]);
    const summary = await runDistillSweep({
      pool: corpus.pool,
      logger: silentLogger,
      embedFn: okEmbed,
    });
    expect(summary.candidates_extracted).toBe(2);
    expect(summary.candidates_written).toBe(1);
    expect(summary.candidates_duplicate).toBe(1);
    expect(corpus.candidates).toHaveLength(1);
  });

  it("uses the dedupe clause rather than a read-then-write race", async () => {
    const corpus = fakeCorpus([rawTurn({ content: "x" })]);
    await runDistillSweep({
      pool: corpus.pool,
      logger: silentLogger,
      embedFn: okEmbed,
    });
    const insert = corpus.statements.find((s) =>
      s.text.includes("INSERT INTO candidate_memory"),
    )!;
    expect(insert.text).toContain(
      "ON CONFLICT (namespace, content_hash) DO NOTHING",
    );
  });
});

describe("runDistillSweep — the operator queue is never written", () => {
  it("the INSERT names no review, grading, or authority column", async () => {
    // THE SINGLE MOST IMPORTANT INVARIANT IN THIS BUILD. 037:43-57 --
    // review_action is paired to reviewed_at by constraint, so a machine
    // writing either removes the item from human review. authority_tier is
    // also absent: 033:70-73 says defaulting an unknown to 'observed' is a
    // silent downgrade.
    const corpus = fakeCorpus([rawTurn({ content: "we are going with bun" })]);
    await runDistillSweep({
      pool: corpus.pool,
      logger: silentLogger,
      embedFn: okEmbed,
    });
    const insert = corpus.statements.find((s) =>
      s.text.includes("INSERT INTO candidate_memory"),
    )!;
    for (const forbidden of [
      "review_action",
      "reviewed_at",
      "graded_by",
      "machine_grade",
      "machine_grade_model",
      "authority_tier",
    ]) {
      expect(insert.text).not.toContain(forbidden);
    }
  });

  it("no statement anywhere in a sweep mentions review_action or graded_by", async () => {
    // Broader than the INSERT: a future "helpful" UPDATE would be caught here.
    const corpus = fakeCorpus([
      rawTurn({ content: "one" }),
      rawTurn({ content: "two" }),
    ]);
    await runDistillSweep({
      pool: corpus.pool,
      logger: silentLogger,
      embedFn: okEmbed,
    });
    for (const s of corpus.statements) {
      expect(s.text).not.toContain("review_action");
      expect(s.text).not.toContain("reviewed_at");
      expect(s.text).not.toContain("graded_by");
      expect(s.text).not.toContain("machine_grade");
    }
  });

  it("does not order or select on turn_index or parent_turn_uuid", async () => {
    // turn_index is per-hook-batch and parent_turn_uuid dangles on 24% of rows
    // (036:5-16, :41-44). Either one would reorder the corpus silently.
    const corpus = fakeCorpus([rawTurn({ content: "one" })]);
    await runDistillSweep({
      pool: corpus.pool,
      logger: silentLogger,
      embedFn: okEmbed,
    });
    for (const s of corpus.statements) {
      expect(s.text).not.toContain("turn_index");
      expect(s.text).not.toContain("parent_turn_uuid");
    }
  });

  it("logs counts only -- never candidate content or a hash", async () => {
    const { records, logger } = collectingLogger();
    const corpus = fakeCorpus([
      rawTurn({ content: "a secret-looking decision about the token" }),
    ]);
    await runDistillSweep({ pool: corpus.pool, logger, embedFn: okEmbed });
    const complete = records.find((r) => r.msg === "distill_sweep_complete")!;
    const serialized = JSON.stringify(complete.fields);
    expect(serialized).not.toContain("secret-looking");
    expect(complete.fields).toMatchObject({ candidates_written: 1 });
  });
});

describe("runDistillSweep — degradation never loses content", () => {
  it("writes the candidate with a NULL embedding when the provider is down", async () => {
    // embedding.repair (#345) is the backfill path. Refusing the write would
    // discard real content over a transient infrastructure failure.
    const down: DistillEmbedFn = async () => ({
      embedding: null,
      error: { code: "network", message: "ECONNREFUSED", attempts: 3 },
    });
    const corpus = fakeCorpus([rawTurn({ content: "we are going with nats" })]);
    const summary = await runDistillSweep({
      pool: corpus.pool,
      logger: silentLogger,
      embedFn: down,
    });
    expect(summary.candidates_written).toBe(1);
    expect(summary.embeddings_missing).toBe(1);
    expect(corpus.candidates[0]!.embedding).toBeNull();
  });

  it("warns on a degraded embedding run rather than failing silently", async () => {
    const { records, logger } = collectingLogger();
    const down: DistillEmbedFn = async () => ({
      embedding: null,
      error: { code: "timeout", message: "slow", attempts: 3 },
    });
    const corpus = fakeCorpus([rawTurn({ content: "use pgvector" })]);
    await runDistillSweep({ pool: corpus.pool, logger, embedFn: down });
    const warn = records.find((r) => r.msg === "distill_embeddings_degraded");
    expect(warn).toBeDefined();
    expect(warn!.fields).toMatchObject({ first_failure_code: "timeout" });
  });

  it("pays for one embedding per distinct content, not per candidate", async () => {
    // The ack candidates in particular repeat; the provider is a single local
    // MLX daemon and paying twice is pure waste.
    let calls = 0;
    const counting: DistillEmbedFn = async () => {
      calls++;
      return { embedding: Array(768).fill(0.01) };
    };
    const corpus = fakeCorpus([
      rawTurn({ content: "use halfvec(768)" }),
      rawTurn({ content: "use halfvec(768)" }),
      rawTurn({ content: "use pgvector" }),
    ]);
    await runDistillSweep({
      pool: corpus.pool,
      logger: silentLogger,
      embedFn: counting,
    });
    expect(calls).toBe(2);
  });

  it("skipEmbeddings still writes every candidate", async () => {
    let calls = 0;
    const counting: DistillEmbedFn = async () => {
      calls++;
      return { embedding: Array(768).fill(0.01) };
    };
    const corpus = fakeCorpus([rawTurn({ content: "we are going with bun" })]);
    const summary = await runDistillSweep({
      pool: corpus.pool,
      logger: silentLogger,
      embedFn: counting,
      skipEmbeddings: true,
    });
    expect(calls).toBe(0);
    expect(summary.candidates_written).toBe(1);
    expect(corpus.candidates[0]!.embedding).toBeNull();
  });

  it("reports the session_seq backfill gap in the summary", async () => {
    const corpus = fakeCorpus([
      rawTurn({ content: "one", session_seq: null as unknown as number }),
      rawTurn({ content: "two" }),
    ]);
    const summary = await runDistillSweep({
      pool: corpus.pool,
      logger: silentLogger,
      embedFn: okEmbed,
    });
    expect(summary.missing_session_seq).toBe(1);
  });

  it("rolls back and rethrows when the write fails, leaving turns unclaimed", async () => {
    // A crash mid-batch must leave the turns undistilled so the next sweep
    // redoes them -- the alternative is turns marked done with no candidates.
    const corpus = fakeCorpus([rawTurn({ content: "we are going with bun" })]);
    const exploding = {
      query: async (text: string, values?: unknown[]) => {
        if (text.includes("INSERT INTO candidate_memory")) {
          throw new Error("connection reset");
        }
        return (corpus.pool as unknown as { query: Function }).query(
          text,
          values,
        );
      },
      connect: async () => ({
        query: async (text: string, values?: unknown[]) => {
          if (text.includes("INSERT INTO candidate_memory")) {
            throw new Error("connection reset");
          }
          return (corpus.pool as unknown as { query: Function }).query(
            text,
            values,
          );
        },
        release: () => undefined,
      }),
    } as unknown as pg.Pool;

    const { records, logger } = collectingLogger();
    await expect(
      runDistillSweep({ pool: exploding, logger, embedFn: okEmbed }),
    ).rejects.toThrow("connection reset");
    expect(corpus.turns[0]!.distilled_at).toBeNull();
    expect(records.some((r) => r.msg === "distill_sweep_failed")).toBe(true);
  });

  it("returns an empty summary for an empty corpus", async () => {
    const summary = await runDistillSweep({
      pool: fakeCorpus([]).pool,
      logger: silentLogger,
      embedFn: okEmbed,
    });
    expect(summary.candidates_written).toBe(0);
    expect(summary.turns_stamped).toBe(0);
  });
});

describe("makeMemoryDistillHandler", () => {
  function job(over: Partial<MaintenanceJob> = {}): MaintenanceJob {
    const now = new Date("2026-07-28T00:00:00Z");
    return {
      id: "job-distill-1",
      kind: MEMORY_DISTILL_JOB_KIND,
      version: MEMORY_DISTILL_JOB_VERSION,
      payload: {},
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

  it("dead-letters a version mismatch instead of burning retries", async () => {
    // A stamped version cannot change, so no retry can help
    // (graph-derivation-handler.ts:406-409 precedent).
    const corpus = fakeCorpus([]);
    const handler = makeMemoryDistillHandler({
      pool: corpus.pool,
      logger: silentLogger,
      embedFn: okEmbed,
    });
    await expect(handler(job({ version: 99 }))).rejects.toBeInstanceOf(
      MaintenanceTerminalError,
    );
  });

  it("stamps the job id onto the candidates it produces", async () => {
    // Required for ethereal-run comparison: which run made this row.
    const corpus = fakeCorpus([rawTurn({ content: "we are going with bun" })]);
    const handler = makeMemoryDistillHandler({
      pool: corpus.pool,
      logger: silentLogger,
      embedFn: okEmbed,
      model: ruleBasedDistiller,
    });
    await handler(job());
    expect(corpus.candidates[0]!.distill_job_id).toBe("job-distill-1");
  });

  it("emits a trace with stage spans and row ids read and written", async () => {
    const source = rawTurn({ content: "we are going with traced distillation" });
    const corpus = fakeCorpus([source]);
    const tracing = recordingTracing();
    const handler = makeMemoryDistillHandler({
      pool: corpus.pool,
      logger: silentLogger,
      tracing,
      embedFn: async () => ({
        embedding: Array(768).fill(0.1),
        usageDetails: { promptTokens: 6, totalTokens: 6 },
      }),
    });

    await handler(
      job({ payload: { session_key: "session-distill" } }),
    );

    expect(tracing.bodies[0]).toMatchObject({
      name: "memory.distill",
      sessionId: "session-distill",
      metadata: { status: "success" },
      observations: [
        {
          name: "distill.claim",
          output: { row_ids: [source.id], units: 1 },
        },
        { name: "distill.extract", type: "span" },
        {
          name: "embedding.provider",
          type: "embedding",
          usageDetails: { promptTokens: 6, totalTokens: 6 },
        },
        { name: "distill.embedding_batch", type: "span" },
        {
          name: "distill.persist",
          output: {
            written_candidate_ids: ["cand-1"],
            stamped_turn_ids: [source.id],
          },
        },
      ],
    });
  });

  it("a global (null-namespace) job sweeps every namespace", async () => {
    const corpus = fakeCorpus([
      rawTurn({ namespace: "rico", content: "we are going with bun" }),
    ]);
    const handler = makeMemoryDistillHandler({
      pool: corpus.pool,
      logger: silentLogger,
      embedFn: okEmbed,
    });
    await handler(job({ namespace: null }));
    const claim = corpus.statements.find((s) =>
      s.text.includes("due_sessions"),
    )!;
    // No namespace parameter was bound: the sweep is deliberately global.
    expect(claim.values).toHaveLength(2);
  });

  it("a scoped job binds its namespace on the claim", async () => {
    const corpus = fakeCorpus([rawTurn({ content: "we are going with bun" })]);
    const handler = makeMemoryDistillHandler({
      pool: corpus.pool,
      logger: silentLogger,
      embedFn: okEmbed,
    });
    await handler(job({ namespace: "rico" }));
    const claim = corpus.statements.find((s) =>
      s.text.includes("due_sessions"),
    )!;
    expect(claim.values[0]).toBe("rico");
  });

  it("running the handler twice over the same corpus is a no-op the second time", async () => {
    const corpus = fakeCorpus([
      rawTurn({ content: "we are going with bun" }),
      rawTurn({ content: "and pgvector for search" }),
    ]);
    const handler = makeMemoryDistillHandler({
      pool: corpus.pool,
      logger: silentLogger,
      embedFn: okEmbed,
    });
    await handler(job());
    const after = corpus.candidates.length;
    await handler(job());
    expect(corpus.candidates).toHaveLength(after);
  });
});

describe("buildMemoryDistillEnqueue", () => {
  it("derives the idempotency key from the caller's sweep label", () => {
    // Re-enqueuing the same (kind, key) with a DIFFERENT payload throws
    // (maintenance-queue.ts:403-407), so the key must name the unit of work.
    const a = buildMemoryDistillEnqueue({ sweepLabel: "2026-07-28" });
    const b = buildMemoryDistillEnqueue({ sweepLabel: "2026-07-29" });
    expect(a.idempotencyKey).toBe("memory.distill:2026-07-28");
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
  });

  it("keeps the key under the queue's 256-character cap", () => {
    const e = buildMemoryDistillEnqueue({ sweepLabel: "x".repeat(500) });
    expect(e.idempotencyKey.length).toBeLessThanOrEqual(200);
  });

  it("uses a kind the queue's regex accepts", () => {
    // /^[a-z][a-z0-9_.-]{0,127}$/ (maintenance-queue.ts:269).
    expect(MEMORY_DISTILL_JOB_KIND).toMatch(/^[a-z][a-z0-9_.-]{0,127}$/);
  });

  it("omits the scope entirely for a global sweep rather than inventing one", () => {
    const global = buildMemoryDistillEnqueue({ sweepLabel: "nightly" });
    expect(global).not.toHaveProperty("scope");
    const scoped = buildMemoryDistillEnqueue({
      sweepLabel: "nightly",
      namespace: "rico",
    });
    expect(scoped.scope).toEqual({ namespace: "rico" });
  });
});
