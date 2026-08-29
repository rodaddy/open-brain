/**
 * DISTILL persistence and maintenance-queue integration. Issue #382.
 *
 * The sweep: claim undistilled turns, window them (src/distill-window.ts),
 * extract (src/distiller.ts), embed, write candidates, stamp the turns. This
 * module owns the parts that touch the database and the job queue; the
 * extraction rules live next door and never see a connection.
 *
 * IDEMPOTENCY, on three independent levels, because the maintenance queue is
 * at-least-once (src/maintenance-queue.ts) and a re-run must be a no-op:
 *
 *  1. Selection is `distilled_at IS NULL`, so a completed batch is not
 *     re-selected.
 *  2. The candidate write is `ON CONFLICT (namespace, content_hash) DO
 *     NOTHING` against idx_candidate_memory_dedupe
 *     (033_candidate_memory.sql:126-127), so identical content re-extracted
 *     from anywhere collapses.
 *  3. The stamp and the writes commit in ONE transaction, so a crash mid-batch
 *     leaves the turns unstamped and the batch is simply redone.
 *
 * ORDER OF OPERATIONS -- deliberately embed BEFORE the transaction opens. The
 * embedding provider is an 8-second-per-attempt network call with up to 3
 * attempts (src/embedding.ts:5-12). Holding a database transaction open across
 * that is how a maintenance job becomes an outage. So embeddings are resolved
 * first, outside any lock, and the transaction is short.
 *
 * A MISSING EMBEDDING NEVER LOSES A CANDIDATE. If the provider is down the
 * candidate is written with a NULL embedding, which is exactly what the
 * existing embedding-repair job kind (#345) exists to backfill. Refusing the
 * write on a provider outage would discard real content over a transient
 * infrastructure failure -- the same trade the governing decision of 2026-07-28
 * settles everywhere else: recall over precision at ingest.
 */

import type pg from "pg";
import {
  BackgroundTraceRecorder,
  backgroundSessionId,
  type BackgroundTraceEmitter,
} from "../application/background-tracing.ts";
import {
  generateEmbeddingWithMetadata,
  type EmbeddingResult,
} from "../../src/embedding.ts";
import { type DistillUnit } from "../domain/distill-window.ts";
import {
  runDistillUnit,
  ruleBasedDistiller,
  type NamedDistillModel,
  type PreparedCandidate,
} from "../domain/distiller.ts";
import {
  MaintenanceTerminalError,
  type MaintenanceJob,
  type MaintenanceJobHandler,
  type MaintenanceQueueLogger,
} from "../../src/maintenance-queue.ts";
import { persistBatch, resolveEmbeddingBatch } from "./distill-persist.ts";
import { reportEmptyClaim } from "./distill-backlog.ts";
import { claimBatch } from "./distill-claim.ts";

/** The job kind this stage registers under. Matches the queue's kind regex. */
export const MEMORY_DISTILL_JOB_KIND = "memory.distill" as const;
/** Payload contract version. Bump only on an incompatible payload change. */
export const MEMORY_DISTILL_JOB_VERSION = 1 as const;

/**
 * The embed function shape. Identical to the one the bootstrap already threads
 * to the embedding-repair handlers (src/embedding-repair.ts EmbedWithMetaFn),
 * restated structurally so this module does not depend on the repair module.
 *
 * The METADATA variant, not the bare one: a distiller must be able to tell a
 * retryable provider outage from an input that will never embed, and
 * `generateEmbedding` collapses both into null (src/embedding.ts:473-480).
 */
export type DistillEmbedFn = (
  text: string,
  embeddingUrl?: string,
) => Promise<EmbeddingResult>;

export interface DistillSweepSummary {
  /** Extraction units built from the claimed batch. */
  units: number;
  /** Turns stamped distilled_at this sweep, speech and non-speech alike. */
  turns_stamped: number;
  /** Candidates the extractor produced. */
  candidates_extracted: number;
  /** Candidates that became a new row. */
  candidates_written: number;
  /** Candidates that collided on (namespace, content_hash) and were skipped. */
  candidates_duplicate: number;
  /** Candidates flagged uncertain by the producer. */
  candidates_uncertain: number;
  /** Candidates written with a NULL embedding because the provider failed. */
  embeddings_missing: number;
  /** Turns whose session_seq was NULL -- a 036 backfill gap, surfaced not hidden. */
  missing_session_seq: number;
  /**
   * Undistilled turns still outstanding when the claim came back empty.
   *
   * Present ONLY on the pathological case: the sweep had nothing to consume
   * while work remained, which is the shape that starved this pipeline for 27
   * days while every job reported `succeeded`. Absent on a normal drained
   * queue, so a caller can treat its presence as the signal rather than
   * comparing counts.
   */
  claim_empty_with_backlog?: number;
}

export interface DistillSweepDeps {
  pool: pg.Pool;
  logger: MaintenanceQueueLogger;
  /** The extractor. Defaults to the deterministic rule-based one. */
  model?: NamedDistillModel;
  /** Injectable embed fn; defaults to the configured provider. */
  embedFn?: DistillEmbedFn;
  /** Bind the sweep to one namespace. Omit to sweep every namespace. */
  namespace?: string;
  /** Bind a queued batch to one owning lane. */
  laneId?: string | null;
  maxSessions?: number;
  maxTurns?: number;
  contextWindow?: number;
  /** Job id to stamp on produced candidates, for ethereal-run comparison. */
  distillJobId?: string | null;
  /** Skip the embedding call entirely. For runs where the provider is known down. */
  skipEmbeddings?: boolean;
  /** Recorder for the containing maintenance job trace. */
  trace?: BackgroundTraceRecorder;
}

function emptySummary(): DistillSweepSummary {
  return {
    units: 0,
    turns_stamped: 0,
    candidates_extracted: 0,
    candidates_written: 0,
    candidates_duplicate: 0,
    candidates_uncertain: 0,
    embeddings_missing: 0,
    missing_session_seq: 0,
  };
}
/**
 * Run one bounded distill sweep. Returns a content-free summary.
 *
 * Bounded by design: the caller loops. An unbounded sweep over a growing corpus
 * is the shape that turns a maintenance job into an outage, which is the same
 * constraint Light works under (src/dream-light.ts:62-66).
 */
export async function runDistillSweep(
  deps: DistillSweepDeps,
): Promise<DistillSweepSummary> {
  const model = deps.model ?? ruleBasedDistiller;
  const embedFn = deps.embedFn ?? generateEmbeddingWithMetadata;
  const summary = emptySummary();

  const batch = await claimBatch(deps, deps.trace);

  summary.units = batch.units.length;
  summary.missing_session_seq = batch.missingSessionSeq;

  if (batch.consumedTurnIds.length === 0) {
    await reportEmptyClaim({
      pool: deps.pool,
      logger: deps.logger,
      namespace: deps.namespace,
      laneId: deps.laneId,
      summary,
    });
    return summary;
  }

  const candidates: PreparedCandidate[] = [];
  for (const unit of batch.units) {
    candidates.push(...(await runDistillUnit(model, unit, deps.trace)));
  }
  summary.candidates_extracted = candidates.length;

  const embeddings = await resolveEmbeddingBatch({
    candidates,
    embedFn,
    logger: deps.logger,
    ...(deps.skipEmbeddings !== undefined
      ? { skipEmbeddings: deps.skipEmbeddings }
      : {}),
    ...(deps.trace !== undefined ? { trace: deps.trace } : {}),
  });
  await persistBatch({
    pool: deps.pool,
    logger: deps.logger,
    candidates,
    embeddings,
    consumedTurnIds: batch.consumedTurnIds,
    distillJobId: deps.distillJobId ?? null,
    summary,
    ...(deps.trace !== undefined ? { trace: deps.trace } : {}),
  });

  // Content-free telemetry: counts and a model name, never content or hashes.
  deps.logger.info("distill_sweep_complete", {
    model: model.name,
    units: summary.units,
    turns_stamped: summary.turns_stamped,
    candidates_extracted: summary.candidates_extracted,
    candidates_written: summary.candidates_written,
    candidates_duplicate: summary.candidates_duplicate,
    candidates_uncertain: summary.candidates_uncertain,
    embeddings_missing: summary.embeddings_missing,
    missing_session_seq: summary.missing_session_seq,
  });

  return summary;
}

/** Dependencies the maintenance bootstrap hands the handler factory. */
export interface MemoryDistillHandlerDeps {
  pool: pg.Pool;
  logger: MaintenanceQueueLogger;
  embedFn: DistillEmbedFn;
  /** Present for signature parity with the other registered handlers. */
  auth?: unknown;
  model?: NamedDistillModel;
  tracing?: BackgroundTraceEmitter;
}

/**
 * Build the handler for {@link MEMORY_DISTILL_JOB_KIND}.
 *
 * The version gate runs BEFORE any payload read, copying the shape established
 * at src/graph-derivation-handler.ts:406-409: a job stamped with a different
 * version carries a payload under a different contract, and no retry can change
 * a stamped version, so it is terminal rather than retryable.
 *
 * A sweep failure is transient by nature (lock contention, connection loss,
 * provider outage) so everything else THROWS plainly and takes the queue's
 * bounded backoff retry.
 */
/** Selection fields a distill job payload may carry, normalised. */
interface DistillJobSelection {
  laneId?: string | null;
  maxSessions?: number;
  maxTurns?: number;
}

/** Read the optional selection fields off a job payload. */
function readJobSelection(job: MaintenanceJob): DistillJobSelection {
  const payload = job.payload ?? {};
  const selection: DistillJobSelection = {};
  if (payload.lane_id === null || typeof payload.lane_id === "string") {
    selection.laneId = payload.lane_id;
  }
  if (typeof payload.max_sessions === "number") {
    selection.maxSessions = payload.max_sessions;
  }
  if (typeof payload.max_turns === "number") {
    selection.maxTurns = payload.max_turns;
  }
  return selection;
}

export function makeMemoryDistillHandler(
  deps: MemoryDistillHandlerDeps,
): MaintenanceJobHandler {
  return async (job: MaintenanceJob): Promise<void> => {
    const trace = new BackgroundTraceRecorder(deps.tracing, {
      name: "memory.distill",
      input: { job_id: job.id, namespace: job.namespace },
      tags: ["open-brain-server", "background-job", "dream", "distill"],
      metadata: { job_kind: job.kind, attempt: job.attempts },
      sessionId: job.namespace === null ? undefined : backgroundSessionId(job),
    });
    try {
      if (job.version !== MEMORY_DISTILL_JOB_VERSION) {
        throw new MaintenanceTerminalError(
          "memory distill job version is not supported by this handler",
        );
      }

      const summary = await runDistillSweep({
        pool: deps.pool,
        logger: deps.logger,
        embedFn: deps.embedFn,
        trace,
        ...(deps.model ? { model: deps.model } : {}),
        ...(job.namespace !== null ? { namespace: job.namespace } : {}),
        ...readJobSelection(job),
        distillJobId: job.id,
      });
      trace.finish(summary);
    } catch (error: unknown) {
      trace.fail(error);
      throw error;
    }
  };
}

/**
 * Build a bounded enqueue request for one distill sweep.
 *
 * The idempotency key must be derived from the exact unit of work: re-enqueuing
 * the same (kind, key) with a DIFFERENT payload throws
 * "maintenance queue idempotency key reused with divergent job semantics"
 * (src/maintenance-queue.ts:403-407). A distill sweep's unit of work is "the
 * due backlog at time T", which has no stable identity -- so the key carries
 * the caller's own sweep label. A caller wanting one sweep per night passes the
 * date; a caller wanting a one-off passes a unique label.
 */
export function buildMemoryDistillEnqueue(input: {
  sweepLabel: string;
  namespace?: string;
  laneId?: string | null;
  maxSessions?: number;
  maxTurns?: number;
}) {
  const payload: Record<string, unknown> = {};
  if (input.laneId !== undefined) payload.lane_id = input.laneId;
  if (input.maxSessions !== undefined) payload.max_sessions = input.maxSessions;
  if (input.maxTurns !== undefined) payload.max_turns = input.maxTurns;

  return {
    kind: MEMORY_DISTILL_JOB_KIND,
    version: MEMORY_DISTILL_JOB_VERSION,
    payload,
    // Bounded well under the queue's 256-char cap (src/maintenance-queue.ts:272).
    idempotencyKey: `${MEMORY_DISTILL_JOB_KIND}:${input.sweepLabel}`.slice(0, 200),
    ...(input.namespace !== undefined ? { scope: { namespace: input.namespace } } : {}),
  };
}

export type { DistillUnit };
