/**
 * Persistence for EXCHANGE distillation. Migration 041, companion to
 * distill-exchange.ts in this directory.
 *
 * Separate from distill-handler.ts so both units can cover the same turns: this
 * reads without claiming, never touches distilled_at, and writes no judgement.
 *
 * See docs/decisions/distill-exchange-run-coexists-without-claiming.md
 */

import type pg from "pg";
import {
  extractExchanges,
  type PreparedExchangeCandidate,
} from "./distill-exchange.ts";
import {
  createDistillExchangeRepository,
  type DistillExchangeRepository,
} from "../db/distill-exchange-repository.ts";
import { withTransaction } from "../db/transaction.ts";
import type { DistillTurn } from "../domain/distill-window.ts";
import type { DistillEmbedFn } from "./distill-handler.ts";
import type { MaintenanceQueueLogger } from "./maintenance-queue-runner.ts";

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
 * The statement, and why the window is whole sessions rather than a row limit,
 * live in server/db/distill-exchange-repository.ts.
 */
async function readTurns(
  repository: DistillExchangeRepository,
  options: { namespace?: string; maxTurns: number },
): Promise<DistillTurn[]> {
  return await repository.readTurnWindow(options);
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
    if (firstFailureCode === "") firstFailureCode = result.error?.code ?? "unknown";
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
 * Insert one candidate row, or skip it on the (namespace, content_hash) dedupe.
 *
 * The return type is annotated because the caller assigns its id to the tracked
 * head and reads that back on the next iteration, which is a circular inference
 * TypeScript cannot resolve.
 *
 * The statement, and the reasoning about which columns it names, live in
 * server/db/distill-exchange-repository.ts.
 */
async function insertCandidate(
  repository: DistillExchangeRepository,
  candidate: PreparedExchangeCandidate,
  vector: number[] | null,
  parentId: string | null,
): Promise<{ id: string }[]> {
  return await repository.insertCandidate({ candidate, vector, parentId });
}

/** Record one written row against the sweep summary. */
function countWritten(
  summary: ExchangeSweepSummary,
  candidate: PreparedExchangeCandidate,
  vector: number[] | null,
): void {
  summary.written++;
  if (vector === null) summary.embeddings_missing++;
  if (candidate.uncertain) summary.uncertain++;
}

interface PersistOneInput {
  repository: DistillExchangeRepository;
  candidate: PreparedExchangeCandidate;
  vector: number[] | null;
  /** The head this exchange's parts attach to, or null when there is none. */
  headId: string | null;
  summary: ExchangeSweepSummary;
}

/**
 * Write one candidate row and return the head the NEXT row should attach to.
 *
 * A part whose head was not written this run (deduped, or failed) has no parent
 * to point at. Writing it with a null parent_id would violate chunk_pair;
 * writing it as a head would put a mid-conversation fragment in the review queue
 * as though the operator had asked for it. Skip it: the head that owns it
 * already exists from the earlier run, and this run's ON CONFLICT is about to
 * skip its content anyway.
 */
async function persistOne({
  repository,
  candidate,
  vector,
  headId,
  summary,
}: PersistOneInput): Promise<string | null> {
  const isPart = candidate.chunk_index !== null;
  if (isPart && headId === null) {
    summary.duplicate++;
    return headId;
  }

  const inserted = await insertCandidate(
    repository,
    candidate,
    vector,
    isPart ? headId : null,
  );
  const written = inserted.length > 0;

  if (written) countWritten(summary, candidate, vector);
  // The dedupe fired. Not an error: this run is idempotent by design and the
  // same exchange re-extracted is one exchange.
  else summary.duplicate++;

  // A head that deduped leaves its parts with nothing to attach to. Clearing it
  // is what makes the skip above fire, instead of silently hanging this
  // exchange's parts off whatever head happened to be written last. A part never
  // becomes the head for the NEXT exchange -- only a chunk_index === null row
  // reassigns this.
  if (!isPart) return written ? (inserted[0]?.id ?? null) : null;
  return headId;
}

async function persist(
  repository: DistillExchangeRepository,
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
    headId = await persistOne({
      repository,
      candidate,
      vector: embeddings.get(candidate.content_hash) ?? null,
      headId,
      summary,
    });
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
 * Deliberately narrow -- exchange rows, one column -- rather than an
 * embedding.repair registry target, and idempotent against a graded row.
 *
 * See docs/decisions/distill-exchange-run-narrow-embedding-backfill.md
 */
export async function backfillExchangeEmbeddings(deps: {
  pool: pg.Pool;
  logger: MaintenanceQueueLogger;
  namespace?: string;
  embedFn?: DistillEmbedFn;
  limit?: number;
}): Promise<EmbeddingBackfillSummary> {
  const limit = Math.min(Math.max(deps.limit ?? 1000, 1), 10_000);
  const repository = createDistillExchangeRepository(deps.pool);
  const rows = await repository.readUnembeddedCandidates({
    ...(deps.namespace !== undefined ? { namespace: deps.namespace } : {}),
    limit,
  });

  const embedFn =
    deps.embedFn ??
    (await import("../embedding/provider.ts")).generateEmbeddingWithMetadata;

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
    await repository.setCandidateEmbedding({
      id: row.id,
      namespace: row.namespace,
      embedding: result.embedding,
    });
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

  const turns = await readTurns(createDistillExchangeRepository(deps.pool), {
    ...(deps.namespace !== undefined ? { namespace: deps.namespace } : {}),
    maxTurns,
  });

  summary.turns_read = turns.length;
  summary.sessions = new Set(turns.map((t) => t.session_ref)).size;
  summary.missing_session_seq = turns.filter((t) => t.session_seq === null).length;

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
          (await import("../embedding/provider.ts")).generateEmbeddingWithMetadata,
        deps.logger,
      );

  try {
    await withTransaction({
      pool: deps.pool,
      run: async (tx) => {
        await persist(
          createDistillExchangeRepository(tx),
          candidates,
          embeddings,
          summary,
        );
      },
      onRollbackFailure: (rollbackErr: unknown) => {
        // The rollback itself failed. The connection is released either way, so
        // the original error still propagates; name the degraded path first.
        deps.logger.warn("exchange_sweep_rollback_failed", {
          reason: rollbackErr instanceof Error ? rollbackErr.name : "non_error",
        });
      },
    });
  } catch (err) {
    deps.logger.error("exchange_sweep_failed", {
      exchanges: summary.exchanges,
      written: summary.written,
      reason: err instanceof Error ? err.name : "non_error",
    });
    throw err;
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
