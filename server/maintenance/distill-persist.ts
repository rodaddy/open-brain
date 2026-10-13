/**
 * DISTILL side effects: embedding resolution and the transactional write.
 *
 * Split out of distill-handler.ts so that module keeps only sweep
 * orchestration. The division is by responsibility: every function here either
 * calls the embedding provider or writes to the database, and none of them
 * decides what a sweep does next.
 *
 * ORDER OF OPERATIONS is why the two live together but stay separate
 * functions -- embeddings are resolved OUTSIDE any transaction (the provider is
 * a multi-second network call) and the write is one short transaction that
 * inserts candidates and stamps their turns atomically.
 */

import type pg from "pg";
import type { BackgroundTraceRecorder } from "../observability/background-tracing.ts";
import {
  createDistillPersistRepository,
  type DistillPersistRepository,
  type InsertedCandidateRow,
} from "../db/distill-persist-repository.ts";
import { withTransaction } from "../db/transaction.ts";
import { embeddingModel } from "../embedding/provider.ts";
import type { PreparedCandidate } from "../domain/distiller.ts";
import type { MaintenanceQueueLogger } from "./maintenance-queue-runner.ts";
import type { DistillEmbedFn, DistillSweepSummary } from "./distill-handler.ts";

/**
 * Resolve embeddings for a batch of candidates, outside any transaction.
 *
 * Sequential rather than parallel on purpose: the provider is a single local
 * MLX daemon (127.0.0.1:8791) and the embedding client already carries a
 * watchdog that restarts it after repeated failures (the embedding provider client).
 * Fanning out concurrent requests at it would trip that watchdog on load rather
 * than on a real fault.
 *
 * Deduplicated by content_hash within the batch: the ack candidates in
 * particular repeat, and paying for the same vector twice is pure waste.
 */
export async function resolveEmbeddings(
  candidates: readonly PreparedCandidate[],
  embedFn: DistillEmbedFn,
  logger: MaintenanceQueueLogger,
  trace?: BackgroundTraceRecorder,
): Promise<Map<string, number[] | null>> {
  const byHash = new Map<string, number[] | null>();
  let failures = 0;
  let firstFailureCode = "";

  for (const candidate of candidates) {
    if (byHash.has(candidate.content_hash)) continue;
    const call = () => embedFn(candidate.content);
    const result = trace
      ? await trace.embedding("embedding.provider", call, {
          model: embeddingModel(),
          input: {
            row_id: candidate.source_turn_ids[0] ?? null,
            char_count: candidate.content.length,
            content_hash: candidate.content_hash,
          },
          metadata: { namespace: candidate.namespace },
          output: (value) => ({
            embedded: value.embedding !== null,
            error: value.error ?? null,
          }),
          usageDetails: (value) => value.usageDetails,
        })
      : await call();
    if (result.embedding) {
      byHash.set(candidate.content_hash, result.embedding);
      continue;
    }
    // Degraded path -- logged, never silent. A NULL embedding is a real
    // outcome the row records, not an error to swallow; embedding.repair (#345)
    // is the backfill path for it.
    byHash.set(candidate.content_hash, null);
    failures++;
    if (firstFailureCode === "") firstFailureCode = result.error?.code ?? "unknown";
  }

  if (failures > 0) {
    logger.warn("distill_embeddings_degraded", {
      failed: failures,
      distinct_texts: byHash.size,
      first_failure_code: firstFailureCode,
    });
  }
  return byHash;
}

/** Everything the transactional write needs, as one parameter. */
export interface DistillPersistInput {
  repository: DistillPersistRepository;
  candidates: readonly PreparedCandidate[];
  embeddings: ReadonlyMap<string, number[] | null>;
  consumedTurnIds: readonly string[];
  distillJobId: string | null;
  summary: DistillSweepSummary;
}

/** Record the outcome of one candidate insert against the sweep summary. */
function recordInsertOutcome(
  inserted: InsertedCandidateRow[],
  candidate: PreparedCandidate,
  summary: DistillSweepSummary,
  writtenRowIds: string[],
): void {
  if (inserted.length === 0) {
    // The dedupe fired. Not an error: the distiller is re-runnable by design
    // (033:124-127) and the same claim made twice is one claim.
    summary.candidates_duplicate++;
    return;
  }
  summary.candidates_written++;
  const insertedId = inserted[0]?.id;
  if (typeof insertedId === "string") writtenRowIds.push(insertedId);
  if (candidate.uncertain) summary.candidates_uncertain++;
}

/**
 * Insert every prepared candidate, returning the ids that became new rows.
 *
 * The statement, and the note on which columns must stay ABSENT, live with it
 * in server/db/distill-persist-repository.ts.
 */
async function insertCandidates(input: DistillPersistInput): Promise<string[]> {
  const writtenRowIds: string[] = [];
  for (const candidate of input.candidates) {
    const vector = input.embeddings.get(candidate.content_hash) ?? null;
    if (vector === null) input.summary.embeddings_missing++;
    const inserted = await input.repository.insertCandidate({
      namespace: candidate.namespace,
      candidateType: candidate.candidate_type,
      content: candidate.content,
      contentHash: candidate.content_hash,
      sourceTurnIds: candidate.source_turn_ids,
      distillJobId: input.distillJobId,
      model: candidate.model,
      embedding: vector,
      uncertain: candidate.uncertain,
      uncertaintyReason: candidate.uncertainty_reason ?? null,
    });
    recordInsertOutcome(inserted, candidate, input.summary, writtenRowIds);
  }
  return writtenRowIds;
}

/** Stamp the consumed turns as distilled, in the same transaction. */
async function stampConsumedTurns(input: DistillPersistInput): Promise<void> {
  if (input.consumedTurnIds.length === 0) return;
  input.summary.turns_stamped = await input.repository.stampConsumedTurns({
    consumedTurnIds: input.consumedTurnIds,
    distillJobId: input.distillJobId,
  });
}

/**
 * Write candidates and stamp their turns, atomically.
 *
 * Both halves in one transaction so the pipeline cannot reach the state that
 * would silently lose content: turns marked distilled with no candidates
 * behind them. If the write fails, the turns stay unclaimed and the next sweep
 * redoes them.
 */
export async function persist(input: DistillPersistInput): Promise<string[]> {
  const writtenRowIds = await insertCandidates(input);
  await stampConsumedTurns(input);
  return writtenRowIds;
}

/** What the traced embedding batch needs, as one parameter. */
export interface EmbeddingBatchInput {
  candidates: readonly PreparedCandidate[];
  embedFn: DistillEmbedFn;
  logger: MaintenanceQueueLogger;
  skipEmbeddings?: boolean;
  trace?: BackgroundTraceRecorder;
}

/**
 * Resolve the batch's embeddings, wrapped in a trace span when tracing is on.
 *
 * Runs OUTSIDE the transaction -- see the module note on why. Returns an empty
 * map when the caller asked to skip embeddings, which is the documented path
 * for a run where the provider is known down.
 */
export async function resolveEmbeddingBatch(
  input: EmbeddingBatchInput,
): Promise<Map<string, number[] | null>> {
  const resolve = (): Promise<Map<string, number[] | null>> =>
    input.skipEmbeddings
      ? Promise.resolve(new Map<string, number[] | null>())
      : resolveEmbeddings(input.candidates, input.embedFn, input.logger, input.trace);
  if (!input.trace) return resolve();
  return input.trace.span("distill.embedding_batch", resolve, {
    metadata: {
      namespaces: [
        ...new Set(input.candidates.map((candidate) => candidate.namespace)),
      ],
    },
    input: {
      model: embeddingModel(),
      item_count: input.candidates.length,
      row_ids: [
        ...new Set(input.candidates.flatMap((candidate) => candidate.source_turn_ids)),
      ],
      skipped: input.skipEmbeddings === true,
    },
    output: (result) => ({
      model: embeddingModel(),
      item_count: result.size,
      provider_errors: [...result.entries()]
        .filter(([, vector]) => vector === null)
        .map(([contentHash]) => contentHash),
    }),
  });
}

/** What the traced transactional write needs, as one parameter. */
export interface PersistBatchInput extends Omit<DistillPersistInput, "repository"> {
  pool: pg.Pool;
  logger: MaintenanceQueueLogger;
  trace?: BackgroundTraceRecorder;
}

/** Run the write in its own transaction, rolling back and logging on failure. */
async function persistInTransaction(input: PersistBatchInput): Promise<string[]> {
  try {
    return await withTransaction({
      pool: input.pool,
      run: (tx) =>
        persist({ ...input, repository: createDistillPersistRepository(tx) }),
      onRollbackFailure: (rollbackErr: unknown) => {
        // The rollback itself failed. The original error still propagates below;
        // name the degraded path so it is not invisible.
        input.logger.warn("distill_persist_rollback_failed", {
          reason: rollbackErr instanceof Error ? rollbackErr.name : "non_error",
        });
      },
    });
  } catch (err: unknown) {
    input.logger.error("distill_sweep_failed", {
      units: input.summary.units,
      candidates_extracted: input.summary.candidates_extracted,
      reason: err instanceof Error ? err.name : "non_error",
    });
    throw err;
  }
}

/** Persist the batch, wrapped in a trace span when tracing is on. */
export async function persistBatch(input: PersistBatchInput): Promise<void> {
  const work = (): Promise<string[]> => persistInTransaction(input);
  if (!input.trace) {
    await work();
    return;
  }
  await input.trace.span("distill.persist", work, {
    metadata: {
      namespaces: [
        ...new Set(input.candidates.map((candidate) => candidate.namespace)),
      ],
    },
    input: {
      source_turn_ids: input.consumedTurnIds,
      candidate_hashes: input.candidates.map((candidate) => candidate.content_hash),
    },
    output: (writtenRowIds) => ({
      written_candidate_ids: writtenRowIds,
      stamped_turn_ids: input.consumedTurnIds,
    }),
  });
}
