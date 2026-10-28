/**
 * DREAM Stage 2 -- REM. Issues #391 (trigger/scheduler), #392 (re-warming),
 * #398 (near-dupe merge, in ../domain/candidate-dedupe.ts).
 *
 * REM grades but never reviews: it may write machine_grade and
 * machine_grade_model, and must NEVER write review_action, reviewed_at, or
 * graded_by. The rationale, the injected-grader shape, and the rule that
 * re-warming is tier flips only:
 *
 * See docs/decisions/dream-rem-is-prep-never-a-judge.md
 */

import type pg from "pg";
import {
  BackgroundTraceRecorder,
  backgroundSessionId,
  type BackgroundTraceEmitter,
} from "../observability/background-tracing.ts";
import type { MaintenanceQueueLogger } from "./maintenance-queue-runner.ts";
import { MaintenanceTerminalError, type MaintenanceJob } from "./maintenance-job.ts";
import { type MaintenanceJobHandler } from "./maintenance-queue-runner.ts";
import {
  runCandidateDedupe,
  type CandidateDedupeSummary,
} from "../domain/candidate-dedupe.ts";
import {
  gradeOneCandidate,
  storeMachineGrade,
  toRemCandidate,
} from "./dream-rem-grading.ts";
import {
  createDreamRemRepository,
  type DreamRemRepository,
} from "../db/dream-rem-repository.ts";
import {
  createDreamRemGradingRepository,
  type DreamRemGradingRepository,
} from "../db/dream-rem-grading-repository.ts";

/** The job kind this stage registers under. Matches the queue's kind regex. */
export const DREAM_REM_JOB_KIND = "dream.rem" as const;
/** Payload contract version. Bump only on an incompatible payload change. */
export const DREAM_REM_JOB_VERSION = 1 as const;

/** Candidates graded per pass. Bounded, like every other sweep in this epic. */
export const DEFAULT_REM_BATCH = 300;

/**
 * The review vocabulary, shared by review_action and machine_grade so the two
 * are directly comparable (037:107-123). A disagreement rate is only meaningful
 * if both sides speak the same language.
 */
export const GRADE_VALUES = [
  "promoted",
  "rejected",
  "duplicate",
  "inconclusive",
] as const;
export type GradeValue = (typeof GRADE_VALUES)[number];

/** A candidate as REM sees it. No embedding: grading reads text and provenance. */
export interface RemCandidate {
  id: string;
  namespace: string;
  candidate_type: string;
  content: string;
  content_hash: string;
  uncertain: boolean;
  uncertainty_reason: string | null;
  model: string | null;
  /** Distinct sessions that said this content, from Light. 0 when uncounted. */
  session_count: number;
  /** Total observations of this content, from Light. */
  occurrence_count: number;
  /** Absorbed near-duplicates (#398). Computed live, never cached. */
  reinforcement_count: number;
}

/** REM's guess about one candidate. */
export interface RemGrade {
  grade: GradeValue;
  /** Free text; stored on the candidate as uncertainty_reason when doubtful. */
  reason?: string;
  /** Provider-reported usage for an LLM-backed grader. */
  usageDetails?: Record<string, number>;
  /** Per-verdict attribution, required when a batch grader falls back. */
  graderName?: string;
  /** Classification-only REM evidence; it is not a full Terra judgement. */
  decision?: {
    label: string;
    score: number;
    decisionSource: string;
    rubricVersion: string;
  };
}

/**
 * A grader. Named so the name lands in machine_grade_model and the guess stays
 * attributable across a model swap.
 */
export interface NamedRemGrader {
  readonly name: string;
  /** Set only when grade() itself calls an LLM provider. */
  readonly observationType?: "generation";
  /** Prime one already-bounded selected slice before per-row guarded writes. */
  prime?(candidates: readonly RemCandidate[]): Promise<void>;
  grade(candidate: RemCandidate): Promise<RemGrade> | RemGrade;
}

/**
 * The deterministic default grader. NO MODEL. Uses no weights and no
 * arithmetic, and never emits 'rejected'.
 *
 * See docs/decisions/dream-rem-heuristic-grader-refuses-to-reject.md
 */
export const heuristicRemGrader: NamedRemGrader = {
  name: "rem-heuristic-v1",
  grade(candidate: RemCandidate): RemGrade {
    if (candidate.session_count > 1) {
      return {
        grade: "promoted",
        reason: `corroborated across ${candidate.session_count} sessions`,
      };
    }
    if (candidate.reinforcement_count > 0) {
      return {
        grade: "promoted",
        reason: `restated ${candidate.reinforcement_count} time(s) in near-duplicate form`,
      };
    }
    if (candidate.uncertain) {
      return {
        grade: "inconclusive",
        reason: candidate.uncertainty_reason ?? "producer flagged uncertain",
      };
    }
    // Single-statement, unflagged. dream-design.md:817-821 names this as an
    // OPEN HOLE -- "corroboration cannot promote a genuine one-off, and some of
    // the most important entries are exactly that. A companion rule is needed
    // and is not yet designed." The doc says do not invent one, so this does
    // not: it says "cannot tell" and leaves the item on the operator's queue,
    // which is exactly where an undesigned case belongs.
    return {
      grade: "inconclusive",
      reason: "single uncorroborated statement; no rule designed for one-offs",
    };
  },
};

export interface RemGradeSummary {
  /** Candidates read for grading. */
  examined: number;
  /** Candidates that received a machine_grade this pass. */
  graded: number;
  /** Breakdown of what the grader guessed. */
  by_grade: Record<GradeValue, number>;
  /** Candidates whose content Light had counted across >1 session. */
  corroborated: number;
}

export interface RemRewarmSummary {
  /** Distinct projects (source_ref prefixes) seen re-engaged. */
  projects_seen: number;
  /** Entries flipped cold/warm -> hot. */
  warmed: number;
  /** Projects noticed but below the action threshold. */
  noticed_only: number;
}

export interface RemSummary {
  grading: RemGradeSummary;
  dedupe: CandidateDedupeSummary;
  rewarm: RemRewarmSummary;
}

interface RemDeps {
  pool: pg.Pool;
  /** Owns REM's three statements; see ../db/dream-rem-repository.ts. */
  rem: DreamRemRepository;
  /** Owns the machine-grade write-back; see ../db/dream-rem-grading-repository.ts. */
  grading: DreamRemGradingRepository;
  logger: MaintenanceQueueLogger;
  grader?: NamedRemGrader;
  namespace?: string;
  batchSize?: number;
  /** Skip the #398 merge pass (e.g. when embeddings are known missing). */
  skipDedupe?: boolean;
  /** Skip the #392 re-warming pass. */
  skipRewarm?: boolean;
  /** Re-engagement lookback. Defaults to {@link REWARM_WINDOW_DAYS}. */
  rewarmWindowDays?: number;
  /** Recorder for the containing REM maintenance job. */
  trace?: BackgroundTraceRecorder;
}

function emptyGradeSummary(): RemGradeSummary {
  return {
    examined: 0,
    graded: 0,
    by_grade: {
      promoted: 0,
      rejected: 0,
      duplicate: 0,
      inconclusive: 0,
    },
    corroborated: 0,
  };
}

/**
 * Grade the ungraded.
 *
 * SELECTION IS `machine_grade IS NULL AND reviewed_at IS NULL`. Both halves are
 * load-bearing. The first makes the pass idempotent -- a replayed job re-selects
 * and finds nothing, which the at-least-once queue requires. The second is the
 * guard that keeps REM off ground truth: once the operator has graded an item,
 * a later machine guess would be written with hindsight and would poison the
 * disagreement measurement.
 *
 * The corroboration join is a LEFT JOIN on content_occurrences by
 * (namespace, content_hash). That works because normalizedContentHash is
 * the SAME function on both sides -- ingest applies it to the turn
 * (../capture/ingest-raw-turn.ts:125) and the distiller applies it to the
 * candidate -- so a candidate whose text is verbatim a turn's text lands on that
 * turn's occurrence row. When it does not match, the LEFT JOIN yields 0 and the
 * grader treats the candidate as uncorroborated, which is the correct reading:
 * absence of a count is absence of evidence, not evidence of absence.
 */
export async function runRemGrading(deps: RemDeps): Promise<RemGradeSummary> {
  const grader = deps.grader ?? heuristicRemGrader;
  const batchSize = deps.batchSize ?? DEFAULT_REM_BATCH;
  const summary = emptyGradeSummary();

  const rows = await deps.rem.selectUngradedCandidates({
    namespace: deps.namespace ?? null,
    batchSize,
  });

  summary.examined = rows.length;
  if (rows.length === 0) {
    deps.logger.info("dream_rem_grading_complete", {
      grader: grader.name,
      examined: 0,
      graded: 0,
    });
    return summary;
  }

  if (grader.prime) {
    await grader.prime(rows.map(toRemCandidate));
  }

  for (const row of rows) {
    const candidate = toRemCandidate(row);
    if (candidate.session_count > 1) summary.corroborated++;

    const verdict = await gradeOneCandidate(deps, grader, candidate);

    // A grader returning an out-of-vocabulary value is a bug in the grader, and
    // the check-constraint would reject the row anyway -- catching it here
    // turns a failed transaction into one skipped candidate plus a warning,
    // so one bad grader does not stall the whole pass.
    if (!GRADE_VALUES.includes(verdict.grade)) {
      deps.logger.warn("dream_rem_grade_out_of_vocabulary", {
        grader: grader.name,
        candidate_type: candidate.candidate_type,
      });
      continue;
    }

    await storeMachineGrade(deps, {
      candidateId: row.id,
      namespace: row.namespace,
      graderName: verdict.graderName ?? grader.name,
      verdict,
    });

    summary.graded++;
    summary.by_grade[verdict.grade]++;
  }

  // Content-free telemetry: counts and a grader name, never content.
  deps.logger.info("dream_rem_grading_complete", {
    grader: grader.name,
    examined: summary.examined,
    graded: summary.graded,
    corroborated: summary.corroborated,
    promoted: summary.by_grade.promoted,
    rejected: summary.by_grade.rejected,
    duplicate: summary.by_grade.duplicate,
    inconclusive: summary.by_grade.inconclusive,
  });

  return summary;
}

/**
 * Sessions of sustained re-engagement before a project's cold entries warm.
 *
 * dream-design.md:387-392 -- 1 session is "notice, no action"; 2-3 begins
 * warming. This is the low end of that table because the doc's own guidance on
 * every dial in this epic is to set it low and measure (dream-design.md:350-357
 * -- "the thresholds are unknown"). Warming is a tier flip and drifts back cold
 * on its own, so an over-eager warm costs one UPDATE.
 */
export const REWARM_MIN_SESSIONS = 2;

/**
 * Sessions at which the whole project cluster is restored, not just begun.
 * dream-design.md:392 -- the "5-10 sessions" row of the re-warming table.
 */
export const REWARM_FULL_SESSIONS = 5;

/**
 * Entries warmed per project per pass, by engagement level. This is the
 * doc's table (dream-design.md:388-392) rather than a flat cap:
 *
 *   | 1 session   | notice, no action        |  -> 0, counted as noticed_only
 *   | 2-4         | BEGIN warming            |  -> BEGIN
 *   | 5-10        | cluster restored to hot  |  -> FULL
 *
 * A flat cap would collapse "begin warming" and "restore the cluster" into the
 * same act, which loses the graduation the doc is explicit about -- and,
 * measured on this clone 2026-07-28, would warm the entire 3,019-entry tagged
 * backlog over ~23 passes. Warming everything is the same as warming nothing:
 * `tier` stops discriminating and the re-warm signal becomes noise.
 */
export const REWARM_BEGIN_LIMIT = 10;
export const REWARM_FULL_LIMIT = 100;

/**
 * Ceiling across ALL projects in one pass.
 *
 * The per-project limits bound one project; this bounds the pass. Without it,
 * 16 re-engaged projects at the FULL limit would flip 1,600 entries hot in a
 * single run -- which is not "restoring a cluster", it is disabling the tier.
 */
export const REWARM_MAX_PER_PASS = 250;

/**
 * How far back "recent re-engagement" reaches. A dial, not a design decision --
 * dream-design.md:350-357 says the thresholds are unknown and must be set low
 * and measured. 7 days is the width at which "2-3 sessions" reads as sustained
 * rather than coincidental on this corpus, whose entire capture history is
 * 3 days wide (2026-07-25 to 2026-07-28, measured).
 */
export const REWARM_WINDOW_DAYS = 7;

/**
 * Re-warm dormant project clusters. #392. The unit is the project, not the
 * entry; this warms and never cools; projects join on `thoughts.tags`.
 *
 * See docs/decisions/dream-rem-rewarm-is-project-scoped-and-one-way.md
 */
export async function runRemRewarm(deps: RemDeps): Promise<RemRewarmSummary> {
  const summary: RemRewarmSummary = {
    projects_seen: 0,
    warmed: 0,
    noticed_only: 0,
  };

  // Recent activity by project. Sessions are the unit of "re-engagement" per
  // the doc, so this counts DISTINCT sessions, not turns -- one long session is
  // one engagement, however many turns it produced.
  const projects = await deps.rem.selectRecentProjectActivity({
    namespace: deps.namespace ?? null,
    windowDays: String(deps.rewarmWindowDays ?? REWARM_WINDOW_DAYS),
  });

  summary.projects_seen = projects.length;

  // "Notice, no action" -- the 1-session row of the doc's table. Counted up
  // front, separately from the warming loop: the loop can exit early on the
  // pass ceiling, and a noticed project that went uncounted because the budget
  // ran out would under-report the signal rather than the action.
  const actionable = projects.filter((p) => Number(p.sessions) >= REWARM_MIN_SESSIONS);
  summary.noticed_only = projects.length - actionable.length;

  // Strongest engagement first, so when the pass ceiling binds it spends the
  // budget on the projects the operator is most active in rather than on
  // whichever repo sorted first.
  const ranked = actionable.sort((a, b) => Number(b.sessions) - Number(a.sessions));

  for (const project of ranked) {
    const sessions = Number(project.sessions);
    const remaining = REWARM_MAX_PER_PASS - summary.warmed;
    if (remaining <= 0) break;
    const limit = Math.min(
      remaining,
      sessions >= REWARM_FULL_SESSIONS ? REWARM_FULL_LIMIT : REWARM_BEGIN_LIMIT,
    );

    // Warm the project's cold cluster. NOT namespace-scoped to the turn's
    // namespace: raw turns all land in `dana` while the durable memory they
    // refer to lives in `collab` (measured on the clone -- 1 distinct turn
    // namespace, 10,624 warm collab thoughts). The project tag IS the scope
    // here, which is what #392 asks for ("the unit is the PROJECT").
    const warmed = await deps.rem.warmProjectCluster({
      repo: project.repo,
      rowLimit: limit,
    });
    summary.warmed += warmed;
  }

  deps.logger.info("dream_rem_rewarm_complete", {
    projects_seen: summary.projects_seen,
    warmed: summary.warmed,
    noticed_only: summary.noticed_only,
    min_sessions: REWARM_MIN_SESSIONS,
  });

  return summary;
}

/**
 * Run one full REM pass: merge near-dupes, grade the ungraded, re-warm.
 *
 * ORDER MATTERS. Dedupe runs FIRST so grading sees the reinforcement it
 * produced -- a candidate that just absorbed three restatements should be
 * graded as reinforced, not as a lone statement. Running them the other way
 * round would grade every candidate on the evidence available before the
 * evidence was gathered, once, permanently, since grading is idempotent on
 * machine_grade IS NULL.
 */
export async function runRemPass(deps: RemDeps): Promise<RemSummary> {
  const dedupeWork = () =>
    deps.skipDedupe
      ? Promise.resolve({
          examined: 0,
          merged: 0,
          reinforced: 0,
          skipped_no_embedding: 0,
        })
      : runCandidateDedupe({
          pool: deps.pool,
          logger: deps.logger,
          ...(deps.namespace !== undefined ? { namespace: deps.namespace } : {}),
        });
  const dedupe = deps.trace
    ? await deps.trace.span("dream.rem.dedupe", dedupeWork, {
        input: { namespace: deps.namespace ?? null, skipped: deps.skipDedupe === true },
        output: (result) => result,
      })
    : await dedupeWork();

  const grading = deps.trace
    ? await deps.trace.span("dream.rem.grading", () => runRemGrading(deps), {
        input: { namespace: deps.namespace ?? null },
        output: (result) => result,
      })
    : await runRemGrading(deps);

  const rewarmWork = () =>
    deps.skipRewarm
      ? Promise.resolve({ projects_seen: 0, warmed: 0, noticed_only: 0 })
      : runRemRewarm(deps);
  const rewarm = deps.trace
    ? await deps.trace.span("dream.rem.rewarm", rewarmWork, {
        input: { namespace: deps.namespace ?? null, skipped: deps.skipRewarm === true },
        output: (result) => result,
      })
    : await rewarmWork();

  return { grading, dedupe, rewarm };
}

/** Dependencies the maintenance bootstrap hands the handler factory. */
export interface DreamRemHandlerDeps {
  pool: pg.Pool;
  logger: MaintenanceQueueLogger;
  grader?: NamedRemGrader;
  /** Creates stateful batch graders per job so caches never cross passes. */
  graderFactory?: (trace: BackgroundTraceRecorder) => NamedRemGrader;
  tracing?: BackgroundTraceEmitter;
}

/**
 * Build the handler for {@link DREAM_REM_JOB_KIND}.
 *
 * The version gate runs BEFORE any payload read, matching
 * the graph-derivation handler and ./distill-handler.ts:353-357: a
 * job stamped with a different version carries a payload under a different
 * contract, and no retry can change a stamped version, so it is terminal rather
 * than retryable.
 */
/**
 * Translate a queue job plus handler deps into one runRemPass argument.
 *
 * Hoisted out of the handler body so the handler stays a version check plus a
 * traced call; the optional-field spreads are unchanged.
 */
export function buildRemPassDeps(
  deps: DreamRemHandlerDeps,
  job: MaintenanceJob,
  trace: BackgroundTraceRecorder,
): RemDeps {
  const payload = job.payload ?? {};
  const batchSize =
    typeof payload.batch_size === "number" ? payload.batch_size : undefined;
  return {
    pool: deps.pool,
    rem: createDreamRemRepository(deps.pool),
    grading: createDreamRemGradingRepository(deps.pool),
    logger: deps.logger,
    trace,
    ...(deps.grader ? { grader: deps.grader } : {}),
    ...(!deps.grader && deps.graderFactory
      ? { grader: deps.graderFactory(trace) }
      : {}),
    ...(job.namespace !== null ? { namespace: job.namespace } : {}),
    ...(batchSize !== undefined ? { batchSize } : {}),
    ...(payload.skip_dedupe === true ? { skipDedupe: true } : {}),
    ...(payload.skip_rewarm === true ? { skipRewarm: true } : {}),
  };
}

export function makeDreamRemHandler(deps: DreamRemHandlerDeps): MaintenanceJobHandler {
  return async (job: MaintenanceJob): Promise<void> => {
    const trace = new BackgroundTraceRecorder(deps.tracing, {
      name: "dream.rem",
      input: { job_id: job.id, namespace: job.namespace },
      tags: ["open-brain-server", "background-job", "dream", "rem"],
      metadata: { job_kind: job.kind, attempt: job.attempts },
      sessionId: job.namespace === null ? undefined : backgroundSessionId(job),
    });
    try {
      if (job.version !== DREAM_REM_JOB_VERSION) {
        throw new MaintenanceTerminalError(
          "dream rem job version is not supported by this handler",
        );
      }

      const summary = await runRemPass(buildRemPassDeps(deps, job, trace));
      trace.finish(summary);
    } catch (error: unknown) {
      trace.fail(error);
      throw error;
    }
  };
}

/**
 * Build a bounded enqueue request for one REM pass.
 *
 * The idempotency key carries the caller's sweep label for the same reason the
 * distiller's does: a REM pass's unit of work is "whatever is ungraded at time
 * T", which has no stable identity, and re-enqueuing the same key with a
 * different payload throws (./maintenance-queue.ts:403-407).
 */
export function buildDreamRemEnqueue(input: {
  sweepLabel: string;
  namespace?: string;
  batchSize?: number;
}) {
  const payload: Record<string, unknown> = {};
  if (input.batchSize !== undefined) payload.batch_size = input.batchSize;

  return {
    kind: DREAM_REM_JOB_KIND,
    version: DREAM_REM_JOB_VERSION,
    payload,
    idempotencyKey: `${DREAM_REM_JOB_KIND}:${input.sweepLabel}`.slice(0, 200),
    ...(input.namespace !== undefined ? { scope: { namespace: input.namespace } } : {}),
  };
}
