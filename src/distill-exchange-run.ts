/**
 * Persistence for EXCHANGE distillation. Migration 041, companion to
 * src/distill-exchange.ts.
 *
 * WHY THIS IS SEPARATE FROM distill-handler.ts RATHER THAN A FLAG ON IT.
 * The fragment sweep claims work with `distilled_at IS NULL` and STAMPS the
 * turns it consumed (distill-handler.ts:233-243). All 3,887 turns are already
 * stamped by the fragment run, so a flag on that path would claim zero turns and
 * do nothing. More importantly, the two units must be able to coexist over the
 * SAME turns -- that is the whole point of 041 keeping both populations: the
 * operator's 8 fragment grades are a measurement of the old unit, and comparing
 * them against exchange grades is how we learn whether the re-cut helped.
 *
 * So this reads turns WITHOUT claiming them and never touches distilled_at. Its
 * idempotency comes from one place instead: `ON CONFLICT (namespace,
 * content_hash) DO NOTHING` against idx_candidate_memory_dedupe
 * (033:137-138). Re-running is a no-op, which is the property that matters --
 * and it is the property a stamp would have bought at the cost of making the run
 * unrepeatable after a schema change.
 *
 * NOTHING HERE WRITES A JUDGEMENT. review_action, reviewed_at, graded_by, and
 * machine_grade are absent from every statement, per 037:43-57: a machine
 * writing review_action sets reviewed_at by constraint and silently removes the
 * item from the operator's queue. Nothing here deletes or updates an existing
 * candidate_memory row either -- the 1,104 fragments are read-only to this
 * module.
 */

import type pg from "pg";
import { toSql } from "pgvector/pg";
import {
  extractExchanges,
  type PreparedExchangeCandidate,
} from "./distill-exchange.ts";
import { DISTILL_ORDER_BY, type DistillTurn } from "./distill-window.ts";
import type { DistillEmbedFn } from "./distill-handler.ts";
import type { MaintenanceQueueLogger } from "./maintenance-queue.ts";

export interface ExchangeSweepSummary {
  /** Turns read. */
  turns_read: number;
  /** Sessions the turns spanned. */
  sessions: number;
  /** Exchanges cut, anchored and orphan together. */
  exchanges: number;
  /** Exchanges headed by a real operator turn. */
  operator_anchored: number;
  /**
   * Of those, the ones headed by an AskUserQuestion answer (043) -- the operator
   * choosing from options the agent wrote. Reported separately because before
   * 043 all six of these headed NOTHING, so a run that produces zero of them
   * against a corpus that contains them is the regression to catch.
   */
  auq_anchored: number;
  /** Exchanges with no operator turn ahead of them. */
  orphans: number;
  /** Rows newly written. */
  written: number;
  /** Rows that collided on (namespace, content_hash) -- a re-run, not an error. */
  duplicate: number;
  /** Rows flagged uncertain by the extractor. */
  uncertain: number;
  /** Rows written with a NULL embedding because the provider was unavailable. */
  embeddings_missing: number;
  /** Turns carrying NULL session_seq -- a 036 backfill gap, surfaced not hidden. */
  missing_session_seq: number;
}

export interface ExchangeSweepDeps {
  pool: pg.Pool;
  logger: MaintenanceQueueLogger;
  /** Restrict to one namespace. Omit to sweep every namespace. */
  namespace?: string;
  embedFn?: DistillEmbedFn;
  /** Skip the embedding provider entirely. */
  skipEmbeddings?: boolean;
  /** Bound on turns read in one sweep. */
  maxTurns?: number;
}

function emptySummary(): ExchangeSweepSummary {
  return {
    turns_read: 0,
    sessions: 0,
    exchanges: 0,
    operator_anchored: 0,
    auq_anchored: 0,
    orphans: 0,
    written: 0,
    duplicate: 0,
    uncertain: 0,
    embeddings_missing: 0,
    missing_session_seq: 0,
  };
}

/**
 * Read live turns in canonical order.
 *
 * WHOLE SESSIONS, NOT A ROW LIMIT. An exchange is defined by where the NEXT
 * operator turn falls, so a cut mid-session would end the last exchange at the
 * page boundary instead of at the operator's next turn -- producing a candidate
 * whose body is arbitrarily truncated by pagination. Reading whole sessions
 * costs a larger read and buys a correct cut, the same trade
 * claimDistillBatch makes for its context window (distill-window.ts:180-190).
 *
 * retention_tier = 'live' excludes archived turns, matching the fragment sweep.
 */
async function readTurns(
  db: Pick<pg.Pool, "query">,
  options: { namespace?: string; maxTurns: number },
): Promise<DistillTurn[]> {
  const params: unknown[] = [];
  let nsPredicate = "";
  if (options.namespace !== undefined) {
    params.push(options.namespace);
    nsPredicate = ` AND namespace = $${params.length}`;
  }
  params.push(options.maxTurns);
  const turnLimit = `$${params.length}`;

  const { rows } = await db.query(
    `SELECT id, namespace, session_ref, session_seq, role, content, repo,
            occurred_at, is_human_prompt
       FROM ob_raw_turns
      WHERE retention_tier = 'live'${nsPredicate}
      ORDER BY ${DISTILL_ORDER_BY}
      LIMIT ${turnLimit}`,
    params,
  );

  return rows.map((r) => ({
    id: r.id as string,
    namespace: r.namespace as string,
    session_ref: (r.session_ref as string | null) ?? null,
    session_seq: (r.session_seq as number | null) ?? null,
    role: r.role as string,
    content: r.content as string,
    repo: (r.repo as string | null) ?? null,
    occurred_at: (r.occurred_at as Date | null) ?? null,
    is_human_prompt: Boolean(r.is_human_prompt),
  }));
}

/**
 * Resolve embeddings outside any transaction.
 *
 * Sequential and deduplicated by content_hash, for the reason
 * distill-handler.ts:128-139 measured: the provider is one local MLX daemon
 * carrying a watchdog that restarts it after repeated failures, so fanning out
 * concurrent requests trips that watchdog on load rather than on a real fault.
 */
async function resolveEmbeddings(
  candidates: readonly PreparedExchangeCandidate[],
  embedFn: DistillEmbedFn,
  logger: MaintenanceQueueLogger,
): Promise<Map<string, number[] | null>> {
  const byHash = new Map<string, number[] | null>();
  let failures = 0;
  let firstFailureCode = "";

  for (const candidate of candidates) {
    if (byHash.has(candidate.content_hash)) continue;
    const result = await embedFn(candidate.content);
    if (result.embedding) {
      byHash.set(candidate.content_hash, result.embedding);
      continue;
    }
    // A NULL embedding is a real, repairable state (embedding.repair, #345), not
    // a reason to refuse the write. Refusing would discard real content over a
    // transient infrastructure failure.
    byHash.set(candidate.content_hash, null);
    failures++;
    if (firstFailureCode === "")
      firstFailureCode = result.error?.code ?? "unknown";
  }

  if (failures > 0) {
    logger.warn("exchange_embeddings_degraded", {
      failed: failures,
      distinct_texts: byHash.size,
      first_failure_code: firstFailureCode,
    });
  }
  return byHash;
}

/**
 * Write exchange candidates.
 *
 * The INSERT names 041's three new columns alongside the existing ones. It does
 * NOT name review_action, reviewed_at, graded_by, machine_grade, or
 * authority_tier: the first four are the operator's and REM's (037:43-57), and
 * authority_tier stays NULL because 033:94-98 says NULL means unclassified and
 * defaulting an unknown to 'observed' is a silent downgrade.
 */
async function persist(
  client: pg.PoolClient,
  candidates: readonly PreparedExchangeCandidate[],
  embeddings: ReadonlyMap<string, number[] | null>,
  summary: ExchangeSweepSummary,
): Promise<void> {
  // THE HEAD OF THE SPLIT CURRENTLY BEING WRITTEN.
  //
  // extractExchanges emits the parts of one exchange adjacent and in order, so
  // the head is simply the last row written with chunk_index === null. Tracking
  // it here is what makes parent_id REAL rather than declared-and-null -- the
  // 011_chunking.sql failure this whole change exists downstream of, where a
  // perfectly good FK sat unpopulated for months because nothing bound a value
  // to it. 044's candidate_memory_chunk_pair now rejects the half-written row,
  // so that specific mistake cannot recur silently, but the link still has to be
  // written on purpose.
  //
  // Reset to null on a head, so a part can never attach to a PREVIOUS
  // exchange's head if its own head was deduped away.
  let headId: string | null = null;

  for (const candidate of candidates) {
    const vector = embeddings.get(candidate.content_hash) ?? null;
    const isPart = candidate.chunk_index !== null;

    // A part whose head was not written this run (deduped, or failed) has no
    // parent to point at. Writing it with a null parent_id would violate
    // chunk_pair; writing it as a head would put a mid-conversation fragment in
    // the review queue as though the operator had asked for it. Skip it: the
    // head that owns it already exists from the earlier run, and this run's
    // ON CONFLICT is about to skip its content anyway.
    if (isPart && headId === null) {
      summary.duplicate++;
      continue;
    }

    // Annotated because headId is assigned FROM this result and read back on the
    // next iteration, which is a circular inference TypeScript cannot resolve.
    const inserted: pg.QueryResult<{ id: string }> = await client.query(
      `INSERT INTO candidate_memory (
         namespace, candidate_type, content, content_hash, source_turn_ids,
         model, embedding, uncertain, uncertainty_reason,
         unit_kind, anchor_turn_id, operator_text, anchor_kind,
         parent_id, chunk_index
       ) VALUES ($1, $2, $3, $4, $5::uuid[], $6, $7, $8, $9, $10, $11::uuid, $12, $13, $14::uuid, $15)
       ON CONFLICT (namespace, content_hash) DO NOTHING
       RETURNING id`,
      [
        candidate.namespace,
        candidate.candidate_type,
        candidate.content,
        candidate.content_hash,
        candidate.source_turn_ids,
        candidate.model,
        vector ? toSql(vector) : null,
        candidate.uncertain,
        candidate.uncertainty_reason ?? null,
        candidate.unit_kind,
        candidate.anchor_turn_id,
        candidate.operator_text,
        // 043. DO NOTHING on conflict means an existing row keeps whatever
        // anchor_kind it already has, which is correct: the row the operator may
        // have graded must not be silently relabelled underneath him.
        candidate.anchor_kind,
        // 044. Both null for a whole exchange or for the head of a split; both
        // set for a part. chunk_pair enforces they move together.
        isPart ? headId : null,
        candidate.chunk_index,
      ],
    );

    if (inserted.rowCount && inserted.rowCount > 0) {
      // Remember the head so the parts that follow can point at it. A part never
      // becomes the head for the NEXT exchange -- only a chunk_index === null row
      // reassigns this.
      if (!isPart) {
        headId = inserted.rows[0]?.id ?? null;
      }
      summary.written++;
      if (vector === null) summary.embeddings_missing++;
      if (candidate.uncertain) summary.uncertain++;
    } else {
      // A head that deduped leaves its parts with nothing to attach to. Clearing
      // it is what makes the skip above fire, instead of silently hanging this
      // exchange's parts off whatever head happened to be written last.
      if (!isPart) headId = null;
      // The dedupe fired. Not an error: this run is idempotent by design and the
      // same exchange re-extracted is one exchange.
      summary.duplicate++;
    }
  }
}

export interface EmbeddingBackfillSummary {
  /** Rows found with a NULL embedding. */
  candidates: number;
  /** Rows given an embedding. */
  filled: number;
  /** Rows the provider could not embed -- still NULL, still retryable. */
  failed: number;
}

/**
 * Fill NULL embeddings on exchange rows.
 *
 * WHY THIS IS HERE AND NOT IN THE embedding.repair REGISTRY. The right long-term
 * home is src/embedding-targets.ts -- docs/embedding-repair.md states the rule
 * outright: "when a new embedding column lands on any table, add one entry to
 * EMBEDDING_TARGETS". candidate_memory is NOT registered there, verified
 * 2026-07-28, so nothing repairs this table for fragments either. That is a real
 * pre-existing gap and it is filed as such rather than fixed here, because
 * registering a target is a change to shared repair machinery across every
 * namespace and every table, and the registry's own contract needs columns
 * candidate_memory does not have (`embedded_at`, `embedding_model`, which
 * FULL_PROVENANCE requires and 033/037 never added).
 *
 * So this is deliberately the NARROW version: exchange rows only, one column,
 * inside the feature that created them. It exists because `--no-embed` is the
 * normal way to run the sweep when the local MLX daemon is down, and a row left
 * NULL by that flag would otherwise never become searchable.
 *
 * The UPDATE touches ONLY the embedding column, so it cannot alter content,
 * provenance, or any judgement column -- safe against an already-graded row. It
 * writes only where `embedding IS NULL`, which makes it idempotent and stops it
 * overwriting a good vector.
 */
export async function backfillExchangeEmbeddings(deps: {
  pool: pg.Pool;
  logger: MaintenanceQueueLogger;
  namespace?: string;
  embedFn?: DistillEmbedFn;
  limit?: number;
}): Promise<EmbeddingBackfillSummary> {
  const limit = Math.min(Math.max(deps.limit ?? 1000, 1), 10_000);
  const params: unknown[] = [];
  let nsPredicate = "";
  if (deps.namespace !== undefined) {
    params.push(deps.namespace);
    nsPredicate = ` AND namespace = $${params.length}`;
  }
  params.push(limit);

  const { rows } = await deps.pool.query<{
    id: string;
    namespace: string;
    content: string;
  }>(
    `SELECT id, namespace, content
       FROM candidate_memory
      WHERE unit_kind = 'exchange' AND embedding IS NULL${nsPredicate}
      ORDER BY created_at
      LIMIT $${params.length}`,
    params,
  );

  const embedFn =
    deps.embedFn ??
    (await import("./embedding.ts")).generateEmbeddingWithMetadata;

  const summary: EmbeddingBackfillSummary = {
    candidates: rows.length,
    filled: 0,
    failed: 0,
  };

  for (const row of rows) {
    const result = await embedFn(row.content);
    if (!result.embedding) {
      summary.failed++;
      continue;
    }
    // Namespace is carried into the predicate even though the id alone would
    // match: namespace is a security boundary here, and a predicate that relies
    // on the id being trusted is one refactor away from being wrong.
    await deps.pool.query(
      `UPDATE candidate_memory
          SET embedding = $3
        WHERE id = $1 AND namespace = $2 AND embedding IS NULL`,
      [row.id, row.namespace, toSql(result.embedding)],
    );
    summary.filled++;
  }

  deps.logger.info("exchange_embedding_backfill_complete", { ...summary });
  return summary;
}

/**
 * Run one exchange sweep. Returns a content-free summary.
 *
 * Does not stamp ob_raw_turns -- see the module header on why the fragment
 * sweep's claim/stamp mechanism does not apply and dedupe carries idempotency
 * instead.
 */
export async function runExchangeSweep(
  deps: ExchangeSweepDeps,
): Promise<ExchangeSweepSummary> {
  const summary = emptySummary();
  const maxTurns = Math.min(Math.max(deps.maxTurns ?? 20_000, 1), 200_000);

  const turns = await readTurns(deps.pool, {
    ...(deps.namespace !== undefined ? { namespace: deps.namespace } : {}),
    maxTurns,
  });

  summary.turns_read = turns.length;
  summary.sessions = new Set(turns.map((t) => t.session_ref)).size;
  summary.missing_session_seq = turns.filter(
    (t) => t.session_seq === null,
  ).length;

  if (turns.length === 0) return summary;

  const candidates = extractExchanges(turns);
  summary.exchanges = candidates.length;
  summary.operator_anchored = candidates.filter(
    (c) => c.anchor_turn_id !== null,
  ).length;
  summary.auq_anchored = candidates.filter(
    (c) => c.anchor_kind === "askuserquestion",
  ).length;
  summary.orphans = summary.exchanges - summary.operator_anchored;

  // Outside the transaction: the provider is an 8s-per-attempt network call and
  // holding a transaction across it is how a maintenance job becomes an outage.
  const embeddings = deps.skipEmbeddings
    ? new Map<string, number[] | null>()
    : await resolveEmbeddings(
        candidates,
        deps.embedFn ??
          (await import("./embedding.ts")).generateEmbeddingWithMetadata,
        deps.logger,
      );

  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    await persist(client, candidates, embeddings, summary);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    deps.logger.error("exchange_sweep_failed", {
      exchanges: summary.exchanges,
      written: summary.written,
      reason: err instanceof Error ? err.name : "non_error",
    });
    throw err;
  } finally {
    client.release();
  }

  // Content-free telemetry: counts only, never content or hashes.
  deps.logger.info("exchange_sweep_complete", {
    turns_read: summary.turns_read,
    sessions: summary.sessions,
    exchanges: summary.exchanges,
    operator_anchored: summary.operator_anchored,
    auq_anchored: summary.auq_anchored,
    orphans: summary.orphans,
    written: summary.written,
    duplicate: summary.duplicate,
    uncertain: summary.uncertain,
    embeddings_missing: summary.embeddings_missing,
    missing_session_seq: summary.missing_session_seq,
  });

  return summary;
}
