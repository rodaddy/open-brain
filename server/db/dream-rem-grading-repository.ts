/**
 * Owns the one statement REM grading used to execute from the maintenance
 * tier: the machine-grade write-back.
 *
 * It exists so the maintenance tier holds no SQL text: server/maintenance/
 * dream-rem-grading.ts takes this port instead of running the statement on its
 * own Pool (issue 1209). Design authority: `_plans/463-server-rewrite-charter.md`
 * reserves raw SQL for server/db repositories.
 */
import type { QuerySurface } from "./transaction.ts";

export interface DreamRemGradingRepository {
  /**
   * Persist one machine grade.
   *
   * Persist machine grade/model and optional classification-only advisory
   * score, timestamp, and judgement. Human review columns are absent by
   * design -- see the module note in ../maintenance/dream-rem.ts. The
   * `reviewed_at IS NULL` predicate is
   * restated here rather than trusted from the SELECT that produced the
   * candidate: the operator may have graded the item in the interval, and their
   * grade must win.
   */
  storeMachineGrade(values: {
    candidateId: string;
    namespace: string;
    grade: string;
    graderName: string;
    reason: string | null;
    decision: {
      label: string;
      score: number;
      decisionSource: string;
      rubricVersion: string;
    } | null;
  }): Promise<void>;
}

export function createDreamRemGradingRepository(
  db: QuerySurface,
): DreamRemGradingRepository {
  return {
    async storeMachineGrade(values) {
      await db.query(
        `UPDATE candidate_memory
        SET machine_grade = $3,
            machine_grade_model = $4,
            uncertainty_reason = COALESCE(uncertainty_reason, $5),
            machine_score = CASE WHEN $6::jsonb IS NULL THEN machine_score ELSE ($6::jsonb->>'score')::integer END,
            machine_graded_at = CASE WHEN $6::jsonb IS NULL THEN machine_graded_at ELSE now() END,
            machine_judgement = CASE WHEN $6::jsonb IS NULL THEN machine_judgement ELSE jsonb_build_object(
              'kind', 'classification_only',
              'label', $6::jsonb->>'label',
              'decision_source', $6::jsonb->>'decisionSource',
              'rubric_version', $6::jsonb->>'rubricVersion'
            ) END
      WHERE id = $1
        AND namespace = $2
        AND reviewed_at IS NULL
        AND machine_grade IS NULL`,
        [
          values.candidateId,
          values.namespace,
          values.grade,
          values.graderName,
          values.reason,
          values.decision === null ? null : JSON.stringify(values.decision),
        ],
      );
    },
  };
}
