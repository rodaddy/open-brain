/**
 * DREAM Stage 2 -- REM. Issues #391 (trigger/scheduler), #392 (re-warming),
 * #398 (near-dupe merge, in src/candidate-dedupe.ts).
 *
 * REM IS A PREP STAGE, NOT A JUDGE (docs/dream-design.md:274-280): it finds,
 * groups, and packages work so Deep does not have to go looking, "doing the
 * easy 90% itself and handing deep only the hard 10%, pre-bundled. It
 * deliberately over-prescribes at first: better a too-big bundle than a clean
 * one missing the key item, because deep can ignore extra context but cannot
 * recover what was never sent."
 *
 * THE ONE HARD RULE. REM MAY write machine_grade + machine_grade_model. It MUST
 * NEVER write review_action, reviewed_at, or graded_by. This is structural, not
 * stylistic -- 037:43-57, verbatim:
 *
 *     reviewed_at IS NULL is the operator's queue. Anything that sets
 *     review_action also sets reviewed_at (candidate_memory_review_paired), so
 *     a machine writing there silently removes the item from human review. The
 *     model would be grading its own training data and marking it done.
 *
 * The two columns exist so their DISAGREEMENT RATE is measurable. That number
 * is the only evidence that will ever tell us whether the machine can be
 * trusted with this, and it only exists while the two stay independent. Every
 * UPDATE in this module names its columns explicitly for that reason.
 *
 * EVERYTHING PASSES. Under the 2026-07-28 operator decision, a machine grade of
 * 'rejected' does not remove anything, hide anything, or reorder anything out
 * of reach. It is advisory: the review queue is `WHERE reviewed_at IS NULL`,
 * full stop, and machine_grade only sorts within it. REM has no suppression
 * path and must not grow one.
 *
 * THE MODEL IS INJECTED, WITH A DETERMINISTIC DEFAULT. Same shape as the
 * distiller (src/distiller.ts): {@link heuristicRemGrader} needs no model
 * access, so REM runs tonight against the real corpus. A real model slots in
 * without touching the persistence path. That also keeps the module testable
 * without a provider, and keeps the grade attributable -- machine_grade_model
 * records which grader produced the guess, because grades from different
 * models are not comparable (037 comment on machine_grade_model).
 *
 * RE-WARMING (#392) IS TIER FLIPS ONLY. dream-design.md:400-419: "Both
 * directions are just a tier flip: no model, cheap, reversible. That is what
 * licenses aggression here. A wrong guess costs a tier update and drifts cold
 * again on its own." Nothing in this module deletes, archives, or demotes
 * anything -- dream-design.md:116 makes delete/hard-discard ALWAYS ASK, and a
 * stage with no delete path cannot violate that by accident.
 */

import type pg from "pg";
import {
  BackgroundTraceRecorder,
  backgroundSessionId,
  type BackgroundTraceEmitter,
} from "./background-tracing.ts";
import type { MaintenanceQueueLogger } from "./maintenance-queue.ts";
import {
  MaintenanceTerminalError,
  type MaintenanceJob,
  type MaintenanceJobHandler,
} from "./maintenance-queue.ts";
import {
  runCandidateDedupe,
  type CandidateDedupeSummary,
} from "./candidate-dedupe.ts";

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
}

/**
 * A grader. Named so the name lands in machine_grade_model and the guess stays
 * attributable across a model swap.
 */
export interface NamedRemGrader {
  readonly name: string;
  /** Set only when grade() itself calls an LLM provider. */
  readonly observationType?: "generation";
  grade(candidate: RemCandidate): Promise<RemGrade> | RemGrade;
}

/**
 * The deterministic default grader. NO MODEL.
 *
 * WHAT IT IS FOR, and what it is emphatically not: it is a floor that lets REM
 * run end to end tonight and produces a machine_grade column with real values
 * in it, so the disagreement measurement can begin the moment the operator
 * grades anything. It is NOT a claim that these rules are good. The doc is
 * explicit that weights are a fitting problem and must not be invented during
 * implementation (dream-design.md:958-968), so this grader deliberately uses no
 * weights and no arithmetic -- only signals that are already measured facts.
 *
 * THE SIGNALS IT USES, and why each is defensible without fitting:
 *
 *  - CORROBORATION (session_count > 1). Light's cross-session count is measured
 *    evidence, not an opinion (dream-design.md:230-243). When it fires it is
 *    the strongest thing available.
 *  - REINFORCEMENT (absorbed near-dupes, #398). Same argument, semantic rather
 *    than exact.
 *  - THE PRODUCER'S OWN DOUBT (uncertain). Not trusted as truth -- it maps to
 *    'inconclusive', which is precisely the value 037:35-37 added so "I cannot
 *    tell" does not collapse into "rejected".
 *
 * AND THE ONE IT REFUSES TO USE: it never emits 'rejected'. A model measured
 * mislabelling 112 of 214 candidates (dream-design.md:238) has no business
 * asserting a negative, and under "everything passes" a negative guess buys
 * nothing anyway -- it cannot suppress. 'inconclusive' is the honest floor and
 * it is what an ungrounded candidate gets.
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

export interface RemDeps {
  pool: pg.Pool;
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
 * (namespace, content_hash). That works because src/embedding.ts contentHash is
 * the SAME function on both sides -- ingest applies it to the turn
 * (src/tools/ingest-raw-turn.ts:125) and the distiller applies it to the
 * candidate -- so a candidate whose text is verbatim a turn's text lands on that
 * turn's occurrence row. When it does not match, the LEFT JOIN yields 0 and the
 * grader treats the candidate as uncorroborated, which is the correct reading:
 * absence of a count is absence of evidence, not evidence of absence.
 */
export async function runRemGrading(deps: RemDeps): Promise<RemGradeSummary> {
  const grader = deps.grader ?? heuristicRemGrader;
  const batchSize = deps.batchSize ?? DEFAULT_REM_BATCH;
  const summary = emptyGradeSummary();

  const rows = await deps.pool.query<{
    id: string;
    namespace: string;
    candidate_type: string;
    content: string;
    content_hash: string;
    uncertain: boolean;
    uncertainty_reason: string | null;
    model: string | null;
    session_count: string | null;
    occurrence_count: string | null;
    reinforcement_count: string;
  }>(
    `SELECT c.id, c.namespace, c.candidate_type, c.content, c.content_hash,
            c.uncertain, c.uncertainty_reason, c.model,
            o.session_count, o.occurrence_count,
            (SELECT count(*) FROM candidate_reinforcement r
              WHERE r.candidate_id = c.id)::text AS reinforcement_count
       FROM candidate_memory c
       LEFT JOIN content_occurrences o
              ON o.namespace = c.namespace
             AND o.content_hash = c.content_hash
      WHERE c.machine_grade IS NULL
        AND c.reviewed_at IS NULL
        AND ($1::text IS NULL OR c.namespace = $1)
      ORDER BY c.uncertain DESC, c.created_at ASC
      LIMIT $2`,
    [deps.namespace ?? null, batchSize],
  );

  summary.examined = rows.rows.length;
  if (rows.rows.length === 0) {
    deps.logger.info("dream_rem_grading_complete", {
      grader: grader.name,
      examined: 0,
      graded: 0,
    });
    return summary;
  }

  for (const row of rows.rows) {
    const sessionCount = Number(row.session_count ?? 0);
    if (sessionCount > 1) summary.corroborated++;

    const candidate: RemCandidate = {
      id: row.id,
      namespace: row.namespace,
      candidate_type: row.candidate_type,
      content: row.content,
      content_hash: row.content_hash,
      uncertain: row.uncertain,
      uncertainty_reason: row.uncertainty_reason,
      model: row.model,
      session_count: sessionCount,
      occurrence_count: Number(row.occurrence_count ?? 0),
      reinforcement_count: Number(row.reinforcement_count),
    };

    const grade = () => Promise.resolve(grader.grade(candidate));
    const verdict =
      deps.trace && grader.observationType === "generation"
        ? await deps.trace.generation("dream.rem.grade", grade, {
            model: grader.name,
            input: candidate,
            output: (result) => result,
            usageDetails: (result) => result.usageDetails,
          })
        : deps.trace
          ? await deps.trace.span("dream.rem.grade", grade, {
              input: { candidate_id: candidate.id },
              output: (result) => result,
            })
          : await grade();

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

    // ONLY machine_grade and machine_grade_model. review_action, reviewed_at,
    // and graded_by are absent by design -- see the module note. The
    // `reviewed_at IS NULL` predicate is restated here rather than trusted from
    // the SELECT: the operator may have graded the item in the interval, and
    // their grade must win.
    await deps.pool.query(
      `UPDATE candidate_memory
          SET machine_grade = $2,
              machine_grade_model = $3,
              uncertainty_reason = COALESCE(uncertainty_reason, $4)
        WHERE id = $1
          AND reviewed_at IS NULL
          AND machine_grade IS NULL`,
      [row.id, verdict.grade, grader.name, verdict.reason ?? null],
    );

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
 * Re-warm dormant project clusters. #392.
 *
 * THE UNIT IS THE PROJECT, NOT THE ENTRY (dream-design.md:381-386): "a single
 * search hit warming a single row is noise -- a stray match should not wake a
 * project. Waking one entry and leaving its siblings cold is worse than
 * useless: you get a fragment without its context." So the trigger is
 * project-level (N distinct recent sessions naming the project) and the action
 * is cluster-level (warm that project's cold entries together).
 *
 * TIER FLIPS ONLY, IN ONE DIRECTION. This warms; it never cools. Cooling on
 * silence is the slow half of the pair (dream-design.md:409-414, "fast to
 * remember, slow to forget") and it is a decay process, not a sweep -- putting
 * it here would make a nightly job the thing that demotes memory, which is a
 * destructive act on a cadence nobody asked for. Warming is additive and
 * self-correcting; that asymmetry is why only one direction lives here.
 *
 * HOW A PROJECT IS IDENTIFIED, and the join this rests on. Raw turns carry the
 * project as `ob_raw_turns.repo`; durable memory carries it as a TAG on
 * `thoughts.tags`. There is no shared foreign key -- verified against the live
 * clone 2026-07-28: `thoughts` has no source_ref column, and its `source_refs`
 * JSONB carries no repo field (5 rows populated, all with a NULL ->>'repo').
 * The tag join is the only linkage that exists, and it is real: joining the 16
 * distinct repos in ob_raw_turns against thoughts.tags matches 3,461 non-hot
 * entries across 12 repos (king-capital 2,314, open-brain 495, taxStrategy
 * 360...). A repo with no matching tag simply warms nothing, which is the
 * correct failure direction for a tier flip.
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
  const projects = await deps.pool.query<{
    namespace: string;
    repo: string;
    sessions: string;
  }>(
    `SELECT namespace, repo, count(DISTINCT session_ref)::text AS sessions
       FROM ob_raw_turns
      WHERE repo IS NOT NULL
        AND session_ref IS NOT NULL
        AND occurred_at >= now() - ($2 || ' days')::interval
        AND ($1::text IS NULL OR namespace = $1)
      GROUP BY namespace, repo`,
    [
      deps.namespace ?? null,
      String(deps.rewarmWindowDays ?? REWARM_WINDOW_DAYS),
    ],
  );

  summary.projects_seen = projects.rows.length;

  // "Notice, no action" -- the 1-session row of the doc's table. Counted up
  // front, separately from the warming loop: the loop can exit early on the
  // pass ceiling, and a noticed project that went uncounted because the budget
  // ran out would under-report the signal rather than the action.
  const actionable = projects.rows.filter(
    (p) => Number(p.sessions) >= REWARM_MIN_SESSIONS,
  );
  summary.noticed_only = projects.rows.length - actionable.length;

  // Strongest engagement first, so when the pass ceiling binds it spends the
  // budget on the projects the operator is most active in rather than on
  // whichever repo sorted first.
  const ranked = actionable.sort(
    (a, b) => Number(b.sessions) - Number(a.sessions),
  );

  for (const project of ranked) {
    const sessions = Number(project.sessions);
    const remaining = REWARM_MAX_PER_PASS - summary.warmed;
    if (remaining <= 0) break;
    const limit = Math.min(
      remaining,
      sessions >= REWARM_FULL_SESSIONS ? REWARM_FULL_LIMIT : REWARM_BEGIN_LIMIT,
    );

    // Warm the project's cold cluster. NOT namespace-scoped to the turn's
    // namespace: raw turns all land in `rico` while the durable memory they
    // refer to lives in `collab` (measured on the clone -- 1 distinct turn
    // namespace, 10,624 warm collab thoughts). The project tag IS the scope
    // here, which is what #392 asks for ("the unit is the PROJECT").
    //
    // COLDEST FIRST. A cold entry is the one the operator cannot currently
    // reach, so a flip buys the most there; a warm entry already ranks in
    // results. Ordering by recency alone would spend the budget on entries that
    // were already easy to find.
    //
    // `tier IS DISTINCT FROM 'hot'` means an already-hot entry is not
    // rewritten, so the pass converges: each run warms the next slice and a run
    // over a fully-warmed project writes nothing.
    const warmed = await deps.pool.query(
      `UPDATE thoughts
          SET tier = 'hot', updated_at = now()
        WHERE id IN (
          SELECT id FROM thoughts
           WHERE tags @> ARRAY[$1::text]
             AND tier IS DISTINCT FROM 'hot'
             AND archived_at IS NULL
           ORDER BY (tier = 'cold') DESC, updated_at DESC
           LIMIT $2
        )`,
      [project.repo, limit],
    );
    summary.warmed += warmed.rowCount ?? 0;
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
  tracing?: BackgroundTraceEmitter;
}

/**
 * Build the handler for {@link DREAM_REM_JOB_KIND}.
 *
 * The version gate runs BEFORE any payload read, matching
 * src/graph-derivation-handler.ts:406-409 and src/distill-handler.ts:353-357: a
 * job stamped with a different version carries a payload under a different
 * contract, and no retry can change a stamped version, so it is terminal rather
 * than retryable.
 */
export function makeDreamRemHandler(
  deps: DreamRemHandlerDeps,
): MaintenanceJobHandler {
  return async (job: MaintenanceJob): Promise<void> => {
    const trace = new BackgroundTraceRecorder(deps.tracing, {
      name: "dream.rem",
      input: { job_id: job.id, namespace: job.namespace },
      tags: ["open-brain-server", "background-job", "dream", "rem"],
      metadata: { job_kind: job.kind, attempt: job.attempts },
      sessionId: backgroundSessionId(job),
    });
    try {
      if (job.version !== DREAM_REM_JOB_VERSION) {
        throw new MaintenanceTerminalError(
          "dream rem job version is not supported by this handler",
        );
      }

      const payload = job.payload ?? {};
      const batchSize =
        typeof payload.batch_size === "number" ? payload.batch_size : undefined;

      const summary = await runRemPass({
        pool: deps.pool,
        logger: deps.logger,
        trace,
        ...(deps.grader ? { grader: deps.grader } : {}),
        ...(job.namespace !== null ? { namespace: job.namespace } : {}),
        ...(batchSize !== undefined ? { batchSize } : {}),
        ...(payload.skip_dedupe === true ? { skipDedupe: true } : {}),
        ...(payload.skip_rewarm === true ? { skipRewarm: true } : {}),
      });
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
 * different payload throws (src/maintenance-queue.ts:403-407).
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
    ...(input.namespace !== undefined
      ? { scope: { namespace: input.namespace } }
      : {}),
  };
}
