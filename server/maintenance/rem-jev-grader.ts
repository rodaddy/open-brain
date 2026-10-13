import {
  buildJevBatchPlan,
  executeJevBatchPlan,
  JEV_REM_RUBRIC_VERSION,
  observeJevFailureSafely,
  REM_CLASSIFIER_SET,
  type JevConfig,
  type JevFetch,
  type JevBatchObserver,
} from "../integrations/jev.ts";
import type { JevRemConfig } from "../config/env-groups.ts";
import { BackgroundTraceRecorder } from "../observability/background-tracing.ts";
import {
  heuristicRemGrader,
  type NamedRemGrader,
  type RemCandidate,
  type RemGrade,
} from "./dream-rem.ts";
import { PROMOTE_AT } from "./rem-terra-grader.ts";

const REM_LABELS = new Set([
  "DECISION",
  "CORRECTION",
  "PREFERENCE",
  "QUESTION",
  "NARRATION",
]);
const REM_SCORES = new Set(Array.from({ length: 11 }, (_, index) => String(index)));

function createJevObserver(
  config: JevConfig,
  trace: BackgroundTraceRecorder,
): JevBatchObserver {
  return (batch, work) =>
    observeJevFailureSafely(
      work,
      {
        candidate_count: batch.records.length,
        candidate_ids: batch.records.map(({ key }) => key),
      },
      (safeWork, failureMetadata) =>
        trace.generation("rem.jev.batch", safeWork, {
          model: config.model,
          input: {
            state: batch.state,
            model: config.model,
            questions: batch.questions,
          },
          output: (response) => response,
          usageDetails: (response) => ({
            input: response.usage.input_tokens,
            output: response.usage.output_tokens,
          }),
          metadata: failureMetadata,
        }),
    );
}

type StagedDecision = {
  decision: NonNullable<RemGrade["decision"]>;
  /** min(label.confidence, score.confidence) from the validated answers. */
  confidence: number;
};

export function createScheduledJevRemGrader(options: {
  config: JevRemConfig;
  fetchFn?: JevFetch;
  logger?: { warn(event: string, fields: Record<string, string | number>): void };
  trace?: BackgroundTraceRecorder;
}): NamedRemGrader {
  const decisions = new Map<string, StagedDecision>();
  const floor = options.config.confidenceFloor;

  return {
    name: `jev/${JEV_REM_RUBRIC_VERSION}`,
    async prime(candidates: readonly RemCandidate[]): Promise<void> {
      decisions.clear();
      if (candidates.length === 0) return;
      try {
        const plan = buildJevBatchPlan({
          sharedState: {},
          records: candidates.map(({ id: key, content }) => ({ key, content })),
          classifierSet: REM_CLASSIFIER_SET,
          limits: options.config,
        });
        const trace = options.trace;
        const observeBatch = trace
          ? createJevObserver(options.config, trace)
          : undefined;
        const result = await executeJevBatchPlan(
          options.config,
          plan,
          options.fetchFn,
          observeBatch,
        );
        const staged = candidates.map((candidate) => {
          const answers = result.answers.get(candidate.id);
          const label = answers?.label;
          const score = answers?.score;
          const servedModel = result.servedModels.get(candidate.id);
          if (
            label?.type !== "choice" ||
            !REM_LABELS.has(label.choice) ||
            score?.type !== "choice" ||
            !REM_SCORES.has(score.choice) ||
            !servedModel
          ) {
            throw new Error("Jev returned an invalid scheduled REM decision");
          }
          const decisionSource = `${servedModel}/${JEV_REM_RUBRIC_VERSION}`;
          return [
            candidate.id,
            {
              decision: {
                label: label.choice,
                score: Number(score.choice),
                decisionSource,
                rubricVersion: JEV_REM_RUBRIC_VERSION,
              },
              confidence: Math.min(label.confidence, score.confidence),
            },
          ] as const;
        });
        for (const [id, decision] of staged) decisions.set(id, decision);
      } catch (error) {
        decisions.clear();
        options.logger?.warn("rem_jev_batch_failed", {
          candidate_count: candidates.length,
          error_category: error instanceof Error ? error.name : typeof error,
        });
      }
    },
    grade(candidate): RemGrade | Promise<RemGrade> {
      const staged = decisions.get(candidate.id);
      if (!staged) {
        return Promise.resolve(heuristicRemGrader.grade(candidate)).then(
          (fallback) => ({
            ...fallback,
            graderName: heuristicRemGrader.name,
          }),
        );
      }
      // Issue 1618 B5: below the optional floor the grade is inconclusive
      // whatever the score, and the source records why. Absent floor = off.
      if (floor !== undefined && staged.confidence < floor) {
        const decisionSource = `${staged.decision.decisionSource} jev-rem conf=${staged.confidence}<floor=${floor}`;
        return {
          grade: "inconclusive",
          graderName: decisionSource,
          decision: { ...staged.decision, decisionSource },
        };
      }
      const { decision } = staged;
      return {
        grade: decision.score >= PROMOTE_AT ? "promoted" : "inconclusive",
        graderName: decision.decisionSource,
        decision,
      };
    },
  };
}
