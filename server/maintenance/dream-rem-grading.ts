import type pg from "pg";

import type { MaintenanceQueueLogger } from "../../src/maintenance-queue.ts";
import type { BackgroundTraceRecorder } from "../application/background-tracing.ts";
import type { NamedRemGrader, RemCandidate, RemGrade } from "./dream-rem.ts";

/** One ungraded candidate row, joined to its Light occurrence counts. */
export interface RemCandidateRow {
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
}

/** What grading one candidate needs from the pass. */
export interface RemGradingContext {
  pool: pg.Pool;
  logger: MaintenanceQueueLogger;
  trace?: BackgroundTraceRecorder;
}

/** Widen a database row into the grader's candidate shape. */
export function toRemCandidate(row: RemCandidateRow): RemCandidate {
  return {
    id: row.id,
    namespace: row.namespace,
    candidate_type: row.candidate_type,
    content: row.content,
    content_hash: row.content_hash,
    uncertain: row.uncertain,
    uncertainty_reason: row.uncertainty_reason,
    model: row.model,
    session_count: Number(row.session_count ?? 0),
    occurrence_count: Number(row.occurrence_count ?? 0),
    reinforcement_count: Number(row.reinforcement_count),
  };
}

/**
 * Run the grader over one candidate, under whichever observation the grader
 * warrants: a generation span for an LLM-backed grader, a plain span for a
 * deterministic one, and no observation at all when the pass is untraced.
 */
export async function gradeOneCandidate(
  ctx: RemGradingContext,
  grader: NamedRemGrader,
  candidate: RemCandidate,
): Promise<RemGrade> {
  const grade = () => Promise.resolve(grader.grade(candidate));
  const output = (result: RemGrade) => ({
    grade: result.grade,
    has_reason: Boolean(result.reason),
  });

  if (ctx.trace === undefined) return grade();

  if (grader.observationType === "generation") {
    return ctx.trace.generation("dream.rem.grade", grade, {
      model: grader.name,
      input: { candidate_id: candidate.id },
      output,
      metadata: { namespace: candidate.namespace },
      usageDetails: (result) => result.usageDetails,
    });
  }

  return ctx.trace.span("dream.rem.grade", grade, {
    input: { candidate_id: candidate.id },
    output,
    metadata: { namespace: candidate.namespace },
  });
}

/**
 * Persist one machine grade.
 *
 * ONLY machine_grade and machine_grade_model. review_action, reviewed_at, and
 * graded_by are absent by design -- see the module note in dream-rem.ts. The
 * `reviewed_at IS NULL` predicate is restated here rather than trusted from the
 * SELECT: the operator may have graded the item in the interval, and their
 * grade must win.
 */
export async function storeMachineGrade(
  ctx: RemGradingContext,
  candidateId: string,
  graderName: string,
  verdict: RemGrade,
): Promise<void> {
  await ctx.pool.query(
    `UPDATE candidate_memory
        SET machine_grade = $2,
            machine_grade_model = $3,
            uncertainty_reason = COALESCE(uncertainty_reason, $4)
      WHERE id = $1
        AND reviewed_at IS NULL
        AND machine_grade IS NULL`,
    [candidateId, verdict.grade, graderName, verdict.reason ?? null],
  );
}
