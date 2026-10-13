/**
 * DREAM Stage 1 — Light. Issue #390.
 *
 * The always-on, MODEL-FREE stage: no model call, no embedding call, no
 * inference — SQL over facts the ingest path already established. It maintains
 * the corroboration count that promotion (#394) and supersession (#396) read.
 *
 * Why the count rather than a model's confidence, why cross-session rather than
 * repetition, why counts live in `content_occurrences` rather than on
 * `ob_raw_turns`, why harness noise is excluded with the ingest predicate
 * itself, and why every timestamp comes from `occurred_at` and never `now()`:
 * See docs/decisions/dream-light-corroboration-is-counted-not-inferred.md
 */

import type { Pool } from "pg";
import { createDreamLightRepository } from "../db/dream-light-repository.ts";
import { withTransaction } from "../db/transaction.ts";
import {
  BackgroundTraceRecorder,
  backgroundSessionId,
  type BackgroundTraceEmitter,
} from "../observability/background-tracing.ts";
import { MaintenanceTerminalError, type MaintenanceJob } from "./maintenance-job.ts";
import { NON_SPEECH_ROLES } from "../domain/raw-turn-roles.ts";
import { recordTurnOccurrence } from "./dream-light-occurrences.ts";

/** Job kind this stage registers under in the maintenance queue. */
export const DREAM_LIGHT_JOB_KIND = "dream.light";
export const DREAM_LIGHT_JOB_VERSION = 1;

/**
 * Turns processed per sweep. Bounded because an unbounded sweep over a growing
 * corpus is the shape that turns a maintenance job into an outage. #390 requires
 * light to be incapable of overwhelming anything.
 */
export const DEFAULT_LIGHT_BATCH_SIZE = 500;

/** Build the single bounded global Light queue request. */
export function buildDreamLightEnqueue() {
  return {
    kind: DREAM_LIGHT_JOB_KIND,
    version: DREAM_LIGHT_JOB_VERSION,
    payload: {},
    idempotencyKey: DREAM_LIGHT_JOB_KIND,
  };
}

/**
 * Cap on retained session refs per occurrence row. The count is authoritative;
 * this is an audit sample. Unbounded, it would turn one row into a log.
 */
export const MAX_SESSION_REFS = 20;

/**
 * Content that is real (so ingest correctly stores it) but carries no claim, so
 * counting it as corroboration is meaningless — the `[tool_use: ...]` and
 * `[tool_result ...]` stubs transcript flattening leaves behind.
 *
 * Deliberately SEPARATE from `isHarnessNoise`: that predicate decides what
 * ingest refuses to STORE, and these must stay stored. This one decides what
 * Light refuses to COUNT. Same shape, different question.
 *
 * See docs/decisions/dream-light-corroboration-is-counted-not-inferred.md
 */
const UNCOUNTABLE: readonly RegExp[] = [
  // Tool-call stubs left by transcript flattening.
  /^\[tool_use:\s*[^\]]*\]$/i,
  /^\[tool_result[^\]]*\]$/i,
  // Bare structural markers with no claim in them.
  /^\[(?:image|attachment|file)[^\]]*\]$/i,
];

/**
 * Should Light count this content toward corroboration?
 *
 * Exported so the boundary is testable directly rather than only through a
 * database sweep.
 */
export function isCountable(content: string, role?: string): boolean {
  // Only speech corroborates, but this rejects only roles KNOWN not to be
  // speech. An unrecognised role is counted, so a new runtime cannot silently
  // drop real content -- see NON_SPEECH_ROLES for why the denylist direction is
  // load-bearing rather than incidental.
  if (role !== undefined && NON_SPEECH_ROLES.has(role)) return false;
  const trimmed = content.trim();
  if (trimmed.length === 0) return false;
  // NO LENGTH FLOOR, AND NO SHORT-WORD LIST. An earlier version dropped
  // anything under 16 characters to cheaply exclude "ok"/"yes"/"done". That is
  // wrong twice over.
  //
  // First, length is a proxy for "meaningful in isolation", which is the wrong
  // question: nothing here is meaningful in isolation. A few characters can be
  // the whole decision -- they convert a proposal into an authorization, so
  // they carry MORE weight than the paragraphs around them. Dropping them does
  // not lose a row, it decapitates the record: a proposal survives with no
  // evidence anyone approved it.
  //
  // Second, and this is the part a list of "obviously worthless" short strings
  // gets wrong: the SAME short string is not always the same act. "okay" is
  // assent after one turn and doubt after another; only the surrounding turns
  // distinguish them. Any rule keyed on the string alone must therefore guess,
  // and guessing wrong 5-20% of the time is 5-20% of real decisions silently
  // deleted before anything can look at them.
  //
  // So the standing trade is RECALL OVER PRECISION, and the reason is
  // structural rather than a preference: THE TIER SYSTEM IS ALREADY THE
  // PRECISION FILTER. Something inaccurate that gets in is referenced rarely,
  // drifts cold on its own access record, and ages out at the ~6-month tier
  // (`code-brain-design.md` §4). That is a reversible judgement made with
  // evidence, months of it. A write-path filter makes the opposite kind of
  // judgement: permanent, immediate, and with no information beyond the
  // characters in front of it. Content that never entered has no usage history
  // to be judged by and no path back.
  //
  // Judging what a turn meant belongs to a stage that can read its neighbours,
  // or to the tiers that watch whether anyone ever uses it -- never to a
  // model-free character count in the write path.
  return !UNCOUNTABLE.some((p) => p.test(trimmed));
}

export interface DreamLightSummary {
  /** Turns examined this sweep. */
  scanned: number;
  /** Turns skipped as harness noise — counted, never stored. */
  skipped_noise: number;
  /** Occurrence rows created (content seen for the first time). */
  created: number;
  /** Occurrence rows updated (content seen again). */
  updated: number;
  /** Updates that raised session_count — i.e. genuine cross-session corroboration. */
  corroborated: number;
}

export interface DreamLightDeps {
  pool: Pool;
  /**
   * Content-free logger. `meta` is REQUIRED rather than optional so a
   * MaintenanceQueueLogger (./maintenance-queue.ts) satisfies this shape --
   * that logger's `fields` parameter is non-optional, and an optional parameter
   * here would make it structurally incompatible, which is what kept Light from
   * being registrable in composeMaintenanceHandlers. Every call site in this
   * module already passes meta.
   */
  logger: {
    info: (msg: string, meta: Record<string, string | number>) => void;
    warn: (msg: string, meta: Record<string, string | number>) => void;
  };
  batchSize?: number;
  tracing?: BackgroundTraceEmitter;
}

// SweepRow and the per-turn upsert live in ./dream-light-occurrences.ts.

/**
 * Run one bounded Light sweep.
 *
 * Selects unswept turns, maintains `content_occurrences`, and stamps each turn
 * so it is never counted twice. Returns a content-free summary.
 */
export async function runLightSweep(deps: DreamLightDeps): Promise<DreamLightSummary> {
  const batchSize = deps.batchSize ?? DEFAULT_LIGHT_BATCH_SIZE;
  const summary: DreamLightSummary = {
    scanned: 0,
    skipped_noise: 0,
    created: 0,
    updated: 0,
    corroborated: 0,
  };

  const swept = await withTransaction({
    pool: deps.pool,
    run: async (tx) => {
      const repository = createDreamLightRepository(tx);

      const claimed = await repository.claimUnsweptTurns({ batchSize });

      summary.scanned = claimed.length;
      if (claimed.length === 0) {
        return summary;
      }

      const sweptIds: string[] = [];

      for (const row of claimed) {
        sweptIds.push(row.id);

        const outcome = await recordTurnOccurrence(repository, row);
        if (outcome === "skipped_noise") summary.skipped_noise++;
        else if (outcome === "created") summary.created++;
        else if (outcome === "updated") summary.updated++;
        else {
          summary.updated++;
          summary.corroborated++;
        }
      }

      await repository.markSwept({ ids: sweptIds });

      return undefined;
    },
    onRollbackFailure: (rollbackErr: unknown) => {
      // The rollback itself failed. The original error still propagates; name
      // the degraded path so a failed rollback is not silent.
      deps.logger.warn("dream_light_rollback_failed", {
        reason: rollbackErr instanceof Error ? rollbackErr.name : "non_error",
      });
    },
  });
  // The empty-batch path returned early inside the old transaction, before the
  // telemetry below. Preserved: run returns the summary in exactly that case
  // and undefined otherwise.
  if (swept !== undefined) return swept;

  // Content-free telemetry: counts only, no content, no hashes.
  deps.logger.info("dream light sweep complete", {
    scanned: summary.scanned,
    skipped_noise: summary.skipped_noise,
    created: summary.created,
    updated: summary.updated,
    corroborated: summary.corroborated,
  });

  return summary;
}

/**
 * Build the maintenance-queue handler for `dream.light`.
 *
 * Runner contract: resolving marks the job succeeded; throwing records a
 * failure and re-queues with backoff. A sweep failure here is transient by
 * nature (lock contention, connection loss), so it THROWS and lets the durable
 * retry policy re-deliver.
 */
export function makeDreamLightHandler(deps: DreamLightDeps) {
  return async function dreamLightHandler(job: MaintenanceJob): Promise<void> {
    let trace: BackgroundTraceRecorder | undefined;
    try {
      trace = new BackgroundTraceRecorder(deps.tracing, {
        name: "dream.light",
        input: { job_id: job.id, namespace: job.namespace },
        tags: ["open-brain-server", "background-job", "dream", "light"],
        metadata: { job_kind: job.kind, attempt: job.attempts },
        sessionId: backgroundSessionId(job),
      });
      if (job.version !== DREAM_LIGHT_JOB_VERSION) {
        throw new MaintenanceTerminalError(
          "dream light job version is not supported by this handler",
        );
      }
      const summary = await trace.span("dream.light.sweep", () => runLightSweep(deps), {
        input: { namespace: job.namespace },
        output: (result) => result,
      });
      trace.finish(summary);
    } catch (error: unknown) {
      trace?.fail(error);
      throw error;
    }
  };
}

/**
 * MEASURED DELTA AGAINST docs/dream-design.md:230-239 -- Light counts, it does
 * NOT gate. The doc's premise that corroborated content is common was measured
 * false on this corpus, so nothing anywhere filters on the count.
 *
 * This function is the queue Light publishes downstream, and its predicate is
 * deliberately blind to occurrence data -- if a future change adds an
 * occurrence predicate here, it is reintroducing the gate that delta removed.
 *
 * See docs/decisions/dream-light-counts-never-gate.md
 */
export interface LightQueueDepth {
  /** All turns Light has not yet counted, including deferred undated turns. */
  unswept: number;
  /** Unswept turns awaiting a real source timestamp; not eligible for Light. */
  deferred_missing_timestamp: number;
  /** Turns not yet distilled -- the backlog REM's trigger actually watches. */
  undistilled: number;
  /** Distinct content rows Light has counted. */
  occurrence_rows: number;
  /** Occurrence rows with cross-session support. The rare, real signal. */
  corroborated_rows: number;
}

/**
 * Report what Light has produced and what is still owed downstream.
 *
 * Read-only. `undistilled` is the number #391's trigger watches -- per the #390
 * correction (dream-design.md:244-255), "light backlog" means the
 * `WHERE distilled_at IS NULL` count on ob_raw_turns, not a counter Light
 * maintains. Both numbers are returned together so an operator can see that
 * they move independently.
 */
export async function readLightQueueDepth(
  pool: Pool,
  namespace?: string,
): Promise<LightQueueDepth> {
  const rows = await createDreamLightRepository(pool).readQueueDepth({ namespace });
  // Five scalar sub-selects: Postgres always returns exactly one row. The
  // guard replaces a non-null assertion and cannot fire in practice.
  const r = rows[0];
  if (r === undefined) {
    throw new Error("light queue depth query returned no row");
  }
  return {
    unswept: Number(r.unswept),
    deferred_missing_timestamp: Number(r.deferred_missing_timestamp),
    undistilled: Number(r.undistilled),
    occurrence_rows: Number(r.occurrence_rows),
    corroborated_rows: Number(r.corroborated_rows),
  };
}
