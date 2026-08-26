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
import { toSql } from "pgvector/pg";
import {
  BackgroundTraceRecorder,
  backgroundSessionId,
  type BackgroundTraceEmitter,
} from "./background-tracing.ts";
import {
  EMBEDDING_MODEL,
  generateEmbeddingWithMetadata,
  type EmbeddingResult,
} from "./embedding.ts";
import {
  claimDistillBatch,
  DEFAULT_CONTEXT_WINDOW,
  type DistillUnit,
} from "./distill-window.ts";
import {
  runDistillUnit,
  ruleBasedDistiller,
  type NamedDistillModel,
  type PreparedCandidate,
} from "./distiller.ts";
import {
  MaintenanceTerminalError,
  type MaintenanceJob,
  type MaintenanceJobHandler,
  type MaintenanceQueueLogger,
} from "./maintenance-queue.ts";

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
 * Resolve embeddings for a batch of candidates, outside any transaction.
 *
 * Sequential rather than parallel on purpose: the provider is a single local
 * MLX daemon (127.0.0.1:8791) and the embedding client already carries a
 * watchdog that restarts it after repeated failures (src/embedding.ts:113-202).
 * Fanning out concurrent requests at it would trip that watchdog on load rather
 * than on a real fault.
 *
 * Deduplicated by content_hash within the batch: the ack candidates in
 * particular repeat, and paying for the same vector twice is pure waste.
 */
async function resolveEmbeddings(
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
          model: EMBEDDING_MODEL,
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
    if (firstFailureCode === "")
      firstFailureCode = result.error?.code ?? "unknown";
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

/**
 * Write candidates and stamp their turns, atomically.
 *
 * Both halves in one transaction so the pipeline cannot reach the state that
 * would silently lose content: turns marked distilled with no candidates
 * behind them. If the write fails, the turns stay unclaimed and the next sweep
 * redoes them.
 */
async function persist(
  client: pg.PoolClient,
  candidates: readonly PreparedCandidate[],
  embeddings: ReadonlyMap<string, number[] | null>,
  consumedTurnIds: readonly string[],
  distillJobId: string | null,
  summary: DistillSweepSummary,
): Promise<string[]> {
  const writtenRowIds: string[] = [];
  for (const candidate of candidates) {
    const vector = embeddings.get(candidate.content_hash) ?? null;
    if (vector === null) summary.embeddings_missing++;

    // NOTE the columns that are ABSENT and must stay absent: review_action,
    // reviewed_at, graded_by, machine_grade. 037:43-57 -- a machine writing
    // review_action sets reviewed_at by constraint and silently removes the
    // item from the operator's queue. authority_tier is also left NULL:
    // 033:70-73 says NULL means unclassified and must never be defaulted to
    // 'observed', because defaulting an unknown to the weakest tier is a
    // silent downgrade. Resolving it is a provenance lookup for a later stage.
    const inserted = await client.query(
      `INSERT INTO candidate_memory (
         namespace, candidate_type, content, content_hash, source_turn_ids,
         distill_job_id, model, embedding, uncertain, uncertainty_reason
       ) VALUES ($1, $2, $3, $4, $5::uuid[], $6, $7, $8, $9, $10)
       ON CONFLICT (namespace, content_hash) DO NOTHING
       RETURNING id`,
      [
        candidate.namespace,
        candidate.candidate_type,
        candidate.content,
        candidate.content_hash,
        candidate.source_turn_ids,
        distillJobId,
        candidate.model,
        vector ? toSql(vector) : null,
        candidate.uncertain,
        candidate.uncertainty_reason ?? null,
      ],
    );

    if (inserted.rowCount && inserted.rowCount > 0) {
      summary.candidates_written++;
      const insertedId = (inserted.rows[0] as { id?: unknown } | undefined)?.id;
      if (typeof insertedId === "string") writtenRowIds.push(insertedId);
      if (candidate.uncertain) summary.candidates_uncertain++;
    } else {
      // The dedupe fired. Not an error: the distiller is re-runnable by design
      // (033:124-127) and the same claim made twice is one claim.
      summary.candidates_duplicate++;
    }
  }

  if (consumedTurnIds.length > 0) {
    const stamped = await client.query(
      `UPDATE ob_raw_turns
          SET distilled_at = now(),
              distill_job_id = COALESCE($2::uuid, distill_job_id)
        WHERE id = ANY($1::uuid[])
          AND distilled_at IS NULL`,
      [consumedTurnIds, distillJobId],
    );
    summary.turns_stamped = stamped.rowCount ?? 0;
  }
  return writtenRowIds;
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

  const claim = () =>
    claimDistillBatch(deps.pool, {
      ...(deps.namespace !== undefined ? { namespace: deps.namespace } : {}),
      ...(deps.laneId !== undefined ? { laneId: deps.laneId } : {}),
      ...(deps.maxSessions !== undefined
        ? { maxSessions: deps.maxSessions }
        : {}),
      ...(deps.maxTurns !== undefined ? { maxTurns: deps.maxTurns } : {}),
      contextWindow: deps.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    });
  const batch = deps.trace
    ? await deps.trace.span("distill.claim", claim, {
        input: { namespace: deps.namespace ?? null, lane_id: deps.laneId ?? null },
        output: (result) => ({
          row_ids: result.consumedTurnIds,
          units: result.units.length,
          missing_session_seq: result.missingSessionSeq,
        }),
      })
    : await claim();

  summary.units = batch.units.length;
  summary.missing_session_seq = batch.missingSessionSeq;

  if (batch.consumedTurnIds.length === 0) {
    // An empty claim is the normal terminal state -- the queue is drained and
    // there is nothing to stamp. It is ALSO exactly what a broken claim looks
    // like, and that ambiguity is what let this pipeline starve for 27 days in
    // silence: 392 `memory.distill` jobs completed as `succeeded` having
    // stamped zero turns, because a claim returning no due work throws nothing
    // and the handler returned here without a word.
    //
    // So the two cases are separated before returning. Asking the database
    // whether due work still exists costs one indexed count on the terminal
    // path only, and turns a silent no-op into a named condition an operator
    // can see. Still not an error: the sweep did not fail, and throwing here
    // would fail a job whose own behaviour was correct. It is a loud INFO with
    // the number that makes it unmistakable.
    let outstanding: number | null = null;
    try {
      const params: unknown[] = [];
      let nsPredicate = "";
      if (deps.namespace !== undefined) {
        params.push(deps.namespace);
        nsPredicate = ` AND namespace = $${params.length}`;
      }
      const { rows } = await deps.pool.query(
        `SELECT count(*)::bigint AS due
           FROM ob_raw_turns
          WHERE distilled_at IS NULL
            AND retention_tier = 'live'${nsPredicate}`,
        params,
      );
      outstanding = Number((rows[0] as { due?: unknown } | undefined)?.due ?? 0);
    } catch (error: unknown) {
      // DOCUMENTED FAIL-OPEN. The probe is observability, never a gate: if it
      // fails, the sweep still returns its summary rather than turning a
      // diagnostic into an outage.
      //
      // Logged rather than swallowed, because a silent fallback here would
      // recreate in the detector the exact defect the detector exists to
      // catch. If this probe is failing, the operator is blind to an empty
      // claim and must know that -- an unreported `outstanding = null` makes
      // the pathological case indistinguishable from a drained queue all over
      // again.
      outstanding = null;
      deps.logger.warn("distill_backlog_probe_failed", {
        namespace: deps.namespace ?? "(all)",
        lane_id:
          deps.laneId === null || deps.laneId === undefined
            ? "(none)"
            : deps.laneId,
        reason: error instanceof Error ? error.name : "non_error",
        detail:
          "could not count outstanding turns; an empty claim this sweep is unclassified, not proven drained",
      });
    }

    if (outstanding !== null && outstanding > 0) {
      deps.logger.warn("distill_claim_empty_with_backlog", {
        namespace: deps.namespace ?? "(all)",
        lane_id: deps.laneId === null || deps.laneId === undefined ? "(none)" : deps.laneId,
        turns_outstanding: outstanding,
        detail:
          "claim returned no due turns while undistilled turns remain; the sweep did nothing and would otherwise have reported success",
      });
      summary.claim_empty_with_backlog = outstanding;
    } else {
      deps.logger.info("distill_queue_drained", {
        namespace: deps.namespace ?? "(all)",
        lane_id: deps.laneId === null || deps.laneId === undefined ? "(none)" : deps.laneId,
      });
    }
    return summary;
  }

  const candidates: PreparedCandidate[] = [];
  for (const unit of batch.units) {
    candidates.push(...(await runDistillUnit(model, unit, deps.trace)));
  }
  summary.candidates_extracted = candidates.length;

  // Outside the transaction -- see the module note on why.
  const resolve = () =>
    deps.skipEmbeddings
      ? Promise.resolve(new Map<string, number[] | null>())
      : resolveEmbeddings(candidates, embedFn, deps.logger, deps.trace);
  const embeddings = deps.trace
    ? await deps.trace.span("distill.embedding_batch", resolve, {
        metadata: {
          namespaces: [...new Set(candidates.map((candidate) => candidate.namespace))],
        },
        input: {
          model: EMBEDDING_MODEL,
          item_count: candidates.length,
          row_ids: [
            ...new Set(candidates.flatMap((candidate) => candidate.source_turn_ids)),
          ],
          skipped: deps.skipEmbeddings === true,
        },
        output: (result) => ({
          model: EMBEDDING_MODEL,
          item_count: result.size,
          provider_errors: [...result.entries()]
            .filter(([, vector]) => vector === null)
            .map(([contentHash]) => contentHash),
        }),
      })
    : await resolve();

  const persistWork = async (): Promise<string[]> => {
    const client = await deps.pool.connect();
    try {
      await client.query("BEGIN");
      const written = await persist(
        client,
        candidates,
        embeddings,
        batch.consumedTurnIds,
        deps.distillJobId ?? null,
        summary,
      );
      await client.query("COMMIT");
      return written;
    } catch (err: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      deps.logger.error("distill_sweep_failed", {
        units: summary.units,
        candidates_extracted: summary.candidates_extracted,
        reason: err instanceof Error ? err.name : "non_error",
      });
      throw err;
    } finally {
      client.release();
    }
  };
  if (deps.trace) {
    await deps.trace.span("distill.persist", persistWork, {
      metadata: {
        namespaces: [...new Set(candidates.map((candidate) => candidate.namespace))],
      },
      input: {
        source_turn_ids: batch.consumedTurnIds,
        candidate_hashes: candidates.map((candidate) => candidate.content_hash),
      },
      output: (writtenRowIds) => ({
        written_candidate_ids: writtenRowIds,
        stamped_turn_ids: batch.consumedTurnIds,
      }),
    });
  } else {
    await persistWork();
  }

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

      const payload = job.payload ?? {};
      const laneId =
        payload.lane_id === null || typeof payload.lane_id === "string"
          ? payload.lane_id
          : undefined;
      const maxSessions =
        typeof payload.max_sessions === "number"
          ? payload.max_sessions
          : undefined;
      const maxTurns =
        typeof payload.max_turns === "number" ? payload.max_turns : undefined;

      const summary = await runDistillSweep({
        pool: deps.pool,
        logger: deps.logger,
        embedFn: deps.embedFn,
        trace,
        ...(deps.model ? { model: deps.model } : {}),
        ...(job.namespace !== null ? { namespace: job.namespace } : {}),
        ...(laneId !== undefined ? { laneId } : {}),
        ...(maxSessions !== undefined ? { maxSessions } : {}),
        ...(maxTurns !== undefined ? { maxTurns } : {}),
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
    idempotencyKey: `${MEMORY_DISTILL_JOB_KIND}:${input.sweepLabel}`.slice(
      0,
      200,
    ),
    ...(input.namespace !== undefined
      ? { scope: { namespace: input.namespace } }
      : {}),
  };
}

export type { DistillUnit };
