/**
 * The Terra grader — REM's real judgement. Issue #435.
 *
 * This is the grader `dream-rem.ts` was built to accept. Until now the only
 * implementation was `heuristicRemGrader`, which its own docstring calls a
 * floor and not a claim that its rules are good: no model, no arithmetic, and
 * it refuses to ever emit 'rejected'. This one sends the round-three prompt
 * (`src/rem-prompt.ts`) to Terra at low effort and writes what comes back.
 *
 * BATCHING, AND WHY THE INTERFACE IS UNCHANGED.
 *
 * `NamedRemGrader.grade()` is per-candidate, and `runRemGrading` loops over it
 * one row at a time with a careful guard on each (out-of-vocabulary check, the
 * `reviewed_at IS NULL` predicate restated so an operator grade in the interval
 * still wins). Widening that interface to take a batch would mean rewriting
 * that loop and its guarantees.
 *
 * So this grader does not widen it. `prime()` sends the whole batch in ONE
 * request and caches the result; `grade()` then serves from cache. The loop is
 * untouched, and 1,827 candidates cost one Terra call per batch instead of
 * 1,827 round trips. Round two established the corpus fits: 586,251 chars
 * (~147k tokens) for all 310 exchanges, one call on every model tested
 * (`_plans/435-436-dream-hosted-rem.md:27-42`).
 *
 * A candidate that was never primed, or that Terra omitted from its return,
 * falls back to `heuristicRemGrader` rather than failing the pass. That is the
 * same reasoning as the out-of-vocabulary guard upstream: one bad item should
 * cost one item, not the batch.
 *
 * SCORE -> GRADE, AND WHY THE MAPPING IS DELIBERATELY BLUNT.
 *
 * The database needs `machine_grade` in review_action's four-value vocabulary
 * (037:116-123) and separately keeps the 0-10 `machine_score` (045). Mapping
 * one to the other is a threshold, and thresholds are a fitting problem that
 * `dream-design.md:958-968` says must NOT be invented during implementation.
 *
 * So this does not invent one. It emits exactly two values:
 *
 *   'promoted'      when Terra scored it at or above PROMOTE_AT
 *   'inconclusive'  otherwise
 *
 * and never 'rejected' — the same refusal `heuristicRemGrader` makes and for
 * the same reason: under "let everything pass" a negative guess cannot
 * suppress anything, so it buys nothing and risks being wrong. The real
 * ordering lives in `machine_score`, which is unthresholded and is what the
 * queue sorts by. PROMOTE_AT exists only because the column requires a value,
 * and it is set at the scale's own midpoint rather than fitted to anything.
 */

import type { NamedRemGrader, RemCandidate, RemGrade } from "./dream-rem.ts";
import { heuristicRemGrader } from "./dream-rem.ts";
import {
  REM_EFFORT,
  REM_GRADING_PROMPT,
  REM_GRADING_SCHEMA,
  REM_MODEL,
} from "./rem-prompt.ts";

/**
 * The score at or above which `machine_grade` reads 'promoted'.
 *
 * NOT FITTED, and must not be presented as if it were. The anchored scale puts
 * 3 at "transient and re-derivable" and 7 at "pins down an architectural
 * fact", so the midpoint is the honest place to cut when no labelled data
 * exists yet. Once the operator has graded a batch, the disagreement between
 * machine_grade and review_action is what should move this — that measurement
 * is the entire reason 037 keeps the two columns comparable.
 */
export const PROMOTE_AT = 5;

/** What Terra returns per item, mirroring REM_GRADING_SCHEMA. */
export interface TerraJudgement {
  id: string;
  score: number;
  label: string;
  quote: string;
  synopsis: string;
  agent_behavior: "good" | "bad" | "neutral";
  canned_replies: string[];
}

/**
 * Sends a batch of candidates to Terra and returns the parsed judgements.
 *
 * Injected rather than imported so the grader is testable without a model:
 * a fake transport proves the mapping, the fallback, and the cache without
 * spending a Terra call, which is the same pattern the Python client tests use
 * for headers and session lifecycle.
 */
export type TerraTransport = (request: {
  model: string;
  effort: string;
  prompt: string;
  schema: unknown;
  items: Array<{ id: string; content: string }>;
}) => Promise<TerraJudgement[]>;

export interface TerraGraderOptions {
  transport: TerraTransport;
  /**
   * Items per Terra request. Round two sent 50 and the full 310-exchange
   * corpus fit in one call, so this is well inside measured limits; it is
   * bounded anyway because an unbounded request is the shape that turns a
   * maintenance job into an outage (the same argument as Light's batch cap).
   */
  batchSize?: number;
  logger?: { warn: (event: string, data?: unknown) => void };
}

export const DEFAULT_TERRA_BATCH = 50;

/**
 * The grader itself.
 *
 * Stateful by construction — `prime()` fills the cache that `grade()` reads —
 * so it is created per pass rather than shared. A stale cache across passes
 * would serve a previous batch's judgement for a new candidate id, which is
 * exactly the class of bug that looks like data and is not.
 */
export function createTerraGrader(
  options: TerraGraderOptions,
): NamedRemGrader & {
  prime(candidates: RemCandidate[]): Promise<void>;
  judgementFor(id: string): TerraJudgement | undefined;
} {
  const batchSize = options.batchSize ?? DEFAULT_TERRA_BATCH;
  const cache = new Map<string, TerraJudgement>();

  return {
    /**
     * Lands in `machine_grade_model`, which 037's comment requires: grades from
     * different models are not comparable, so the guess stays attributable
     * across a model swap. Versioned because the PROMPT is part of the grader —
     * a round-four prompt on the same model produces different grades and must
     * not silently pool with these.
     */
    name: `rem-terra-low/round3`,

    async prime(candidates: RemCandidate[]): Promise<void> {
      cache.clear();
      for (let i = 0; i < candidates.length; i += batchSize) {
        const slice = candidates.slice(i, i + batchSize);
        try {
          const judgements = await options.transport({
            model: REM_MODEL,
            effort: REM_EFFORT,
            prompt: REM_GRADING_PROMPT,
            schema: REM_GRADING_SCHEMA,
            items: slice.map((c) => ({ id: c.id, content: c.content })),
          });
          for (const j of judgements) {
            // An id Terra invented is not a candidate. Round two measured
            // exactly this: sonnet-low "returned 51 on p3, meaning it invented
            // an id" (_plans/435-436-dream-hosted-rem.md:232-234). Writing a
            // judgement against a fabricated id would attach it to nothing, or
            // worse, to something real by collision.
            if (!slice.some((c) => c.id === j.id)) {
              options.logger?.warn("rem_terra_unknown_id", {
                batch_index: i / batchSize,
              });
              continue;
            }
            cache.set(j.id, j);
          }
        } catch (error) {
          // A failed batch leaves its candidates uncached, so grade() falls
          // back to the heuristic for them. The pass continues: losing one
          // batch to a transport error must not cost the other thirty-six.
          options.logger?.warn("rem_terra_batch_failed", {
            batch_index: i / batchSize,
            size: slice.length,
            error: String(error).slice(0, 200),
          });
        }
      }
    },

    judgementFor(id: string): TerraJudgement | undefined {
      return cache.get(id);
    },

    grade(candidate: RemCandidate): RemGrade | Promise<RemGrade> {
      const judgement = cache.get(candidate.id);
      if (!judgement) return heuristicRemGrader.grade(candidate);

      return {
        grade: judgement.score >= PROMOTE_AT ? "promoted" : "inconclusive",
        // The synopsis is the most useful thing to surface when the operator
        // asks why an item sits where it does, so it is what rides in the
        // reason field. The full judgement goes to machine_judgement.
        reason: judgement.synopsis || undefined,
      };
    },
  };
}
