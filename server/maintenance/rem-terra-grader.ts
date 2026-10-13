/**
 * The Terra grader — REM's real judgement. Issue #435.
 *
 * This is the grader `dream-rem.ts` was built to accept. Until now the only
 * implementation was `heuristicRemGrader`, which its own docstring calls a
 * floor and not a claim that its rules are good: no model, no arithmetic, and
 * it refuses to ever emit 'rejected'. This one sends the round-three prompt
 * (`server/maintenance/rem-prompt.ts`) to Terra at low effort and writes what
 * comes back.
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
  buildJevBatchPlan,
  executeJevBatchPlan,
  JEV_REM_RUBRIC_VERSION,
  observeJevFailureSafely,
  REM_CLASSIFIER_SET,
  type JevConfig,
  type JevFetch,
  type JevBatchObserver,
} from "../integrations/jev.ts";
import {
  REM_EFFORT,
  REM_GRADING_PROMPT,
  REM_GRADING_SCHEMA,
  REM_MODEL,
} from "./rem-prompt.ts";
import { BackgroundTraceRecorder } from "../observability/background-tracing.ts";

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
  /**
   * Terra's own angles on why it scored this way. RAW MATERIAL: a separate
   * distillation pass reads every judgement in a run and composes the
   * operator's click-options from these. Terra cannot see across items, so it
   * cannot write the options itself.
   */
  reasons: string[];
  decision_source?: string;
}

/**
 * The interaction's shape, passed as DATA rather than left to be inferred.
 *
 * Terra receives one exchange and cannot count what it cannot see. The
 * operator's priors depend on exactly this: "if it comes from me it probably
 * should be saved. That's especially if it's a long interaction, or what I say
 * is long, and your response is long, and there's more than one back and
 * forth." `source_turn_ids` already carries the turn count, so supplying it is
 * a cardinality() rather than a guess.
 */
export interface InteractionShape {
  turn_count: number;
  operator_chars: number;
  agent_chars: number;
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
  items: Array<
    {
      id: string;
      content: string;
      jev_decision?: { label: string; score: number };
    } & InteractionShape
  >;
}) => Promise<TerraJudgement[]>;

export interface TerraGraderOptions {
  transport: TerraTransport;
  /** Requested Codex route. Production callers retain the REM defaults. */
  model?: string;
  effort?: string;
  /**
   * Items per Terra request. Round two sent 50 and the full 310-exchange
   * corpus fit in one call, so this is well inside measured limits; it is
   * bounded anyway because an unbounded request is the shape that turns a
   * maintenance job into an outage (the same argument as Light's batch cap).
   */
  batchSize?: number;
  logger?: { warn: (event: string, data?: unknown) => void };
  jev?: { config: JevConfig; fetchFn?: JevFetch };
  trace?: BackgroundTraceRecorder;
}

export const DEFAULT_TERRA_BATCH = 50;
const REM_LABELS = ["DECISION", "CORRECTION", "PREFERENCE", "QUESTION", "NARRATION"];
const REM_SCORES = new Set(Array.from({ length: 11 }, (_, i) => String(i)));

interface JevRemDecision {
  label: string;
  score: number;
  servedModel: string;
}

async function getJevDecisions(
  options: TerraGraderOptions,
  candidates: readonly RemCandidate[],
): Promise<Map<string, JevRemDecision>> {
  const decisions = new Map<string, JevRemDecision>();
  const jev = options.jev;
  if (!jev?.config.enabled || candidates.length === 0) return decisions;
  try {
    const plan = buildJevBatchPlan({
      sharedState: {},
      records: candidates.map(({ id: key, content }) => ({ key, content })),
      classifierSet: REM_CLASSIFIER_SET,
      limits: jev.config,
    });
    const trace = options.trace;
    const observeBatch: JevBatchObserver | undefined = trace
      ? (batch, work) =>
          observeJevFailureSafely(
            work,
            {
              candidate_count: batch.records.length,
              candidate_ids: batch.records.map(({ key }) => key),
            },
            (safeWork, failureMetadata) =>
              trace.generation("rem.jev.batch", safeWork, {
                model: jev.config.model,
                input: {
                  state: batch.state,
                  model: jev.config.model,
                  questions: batch.questions,
                },
                output: (response) => response,
                usageDetails: (response) => ({
                  input: response.usage.input_tokens,
                  output: response.usage.output_tokens,
                }),
                metadata: failureMetadata,
              }),
          )
      : undefined;
    const result = await executeJevBatchPlan(
      jev.config,
      plan,
      jev.fetchFn,
      observeBatch,
    );
    const parsed = candidates.map((candidate) => {
      const label = result.answers.get(candidate.id)?.label;
      const score = result.answers.get(candidate.id)?.score;
      const scoreChoice = score?.type === "choice" ? score.choice : "";
      if (
        label?.type !== "choice" ||
        !REM_LABELS.includes(label.choice) ||
        !REM_SCORES.has(scoreChoice)
      )
        throw new Error("Jev returned invalid REM label or score");
      const servedModel = result.servedModels.get(candidate.id);
      if (!servedModel) throw new Error("Jev returned no served model");
      return [
        candidate.id,
        { label: label.choice, score: Number(scoreChoice), servedModel },
      ] as const;
    });
    for (const [id, decision] of parsed) decisions.set(id, decision);
  } catch (error) {
    options.logger?.warn("rem_jev_decision_failed", {
      candidate_count: candidates.length,
      error_category: error instanceof Error ? error.name : typeof error,
    });
  }
  return decisions;
}

function enforceJevDecisions(
  cache: Map<string, TerraJudgement>,
  decisions: Map<string, JevRemDecision>,
): void {
  for (const [id, decision] of decisions) {
    const current = cache.get(id);
    if (current) {
      cache.set(id, {
        ...current,
        label: decision.label,
        score: decision.score,
        decision_source: `${decision.servedModel}/${JEV_REM_RUBRIC_VERSION}`,
      });
    }
  }
}

/**
 * Derive the interaction's shape from the stored exchange text.
 *
 * Read off `content` rather than `source_turn_ids` deliberately: RemCandidate
 * does not carry the id array, and widening that shared interface to reach one
 * count would touch every grader. The text already holds the structure the
 * distiller wrote into it -- `feat(041)` heads each exchange with the operator
 * turn and prefixes every following turn with "agent:" or "tool:" -- so the
 * count is a property of the unit, not a second query.
 *
 * turn_count counts CONVERSATIONAL turns: the operator's, plus each agent
 * reply. Tool lines are excluded because "more than one back and forth" is
 * about exchange, and an agent that ran six greps in one reply has not gone
 * back and forth six times.
 */
export function interactionShape(content: string): InteractionShape {
  const agentSplit = content.split(/^agent:/m);
  const operatorPart = agentSplit[0] ?? "";
  const agentParts = agentSplit.slice(1);

  const agentChars = agentParts
    .join("")
    .split("\n")
    .filter((line) => !line.startsWith("tool:"))
    .join("\n").length;

  return {
    // Operator turn plus each agent reply. Never below 1: an exchange with no
    // agent response is still one operator turn.
    turn_count: 1 + agentParts.length,
    operator_chars: operatorPart.replace(/^OPERATOR:\s*/, "").trim().length,
    agent_chars: agentChars,
  };
}

/**
 * Cache the judgements whose ids belong to the batch that was sent.
 *
 * An id Terra invented is not a candidate. Round two measured exactly this:
 * sonnet-low "returned 51 on p3, meaning it invented an id"
 * (_plans/435-436-dream-hosted-rem.md:232-234). Writing a judgement against a
 * fabricated id would attach it to nothing, or worse, to something real by
 * collision.
 *
 * Hoisted out of `prime()` so the per-judgement filter is a flat function
 * rather than a fourth nested block inside the batch loop's try.
 */
function cacheKnownJudgements(args: {
  judgements: TerraJudgement[];
  slice: RemCandidate[];
  cache: Map<string, TerraJudgement>;
  batchIndex: number;
  logger?: { warn: (event: string, data?: unknown) => void };
}): void {
  const known = new Set(args.slice.map((c) => c.id));
  for (const j of args.judgements) {
    if (known.has(j.id)) {
      args.cache.set(j.id, j);
    } else {
      args.logger?.warn("rem_terra_unknown_id", {
        batch_index: args.batchIndex,
      });
    }
  }
}

/**
 * The grader itself.
 *
 * Stateful by construction — `prime()` fills the cache that `grade()` reads —
 * so it is created per pass rather than shared. A stale cache across passes
 * would serve a previous batch's judgement for a new candidate id, which is
 * exactly the class of bug that looks like data and is not.
 */
export function createTerraGrader(options: TerraGraderOptions): NamedRemGrader & {
  prime(candidates: RemCandidate[]): Promise<void>;
  judgementFor(id: string): TerraJudgement | undefined;
} {
  const batchSize = options.batchSize ?? DEFAULT_TERRA_BATCH;
  const model = options.model ?? REM_MODEL;
  const effort = options.effort ?? REM_EFFORT;
  const cache = new Map<string, TerraJudgement>();

  return {
    /**
     * Lands in `machine_grade_model`, which 037's comment requires: grades from
     * different models are not comparable, so the guess stays attributable
     * across a model swap. Versioned because the PROMPT is part of the grader —
     * a round-four prompt on the same model produces different grades and must
     * not silently pool with these.
     */
    name:
      model === REM_MODEL && effort === REM_EFFORT
        ? "rem-terra-low/round3"
        : `rem-${model}-${effort}/round3`,

    async prime(candidates: RemCandidate[]): Promise<void> {
      cache.clear();
      const jevDecisions = await getJevDecisions(options, candidates);
      for (let i = 0; i < candidates.length; i += batchSize) {
        const slice = candidates.slice(i, i + batchSize);
        try {
          const request = {
            model,
            effort,
            prompt:
              jevDecisions.size > 0
                ? `${REM_GRADING_PROMPT}\n\nEach item may carry jev_decision. Reuse its validated label and score exactly; do not rethink them. Complete quote, synopsis, agent_behavior, and reasons.`
                : REM_GRADING_PROMPT,
            schema: REM_GRADING_SCHEMA,
            items: slice.map((c) => {
              const decision = jevDecisions.get(c.id);
              return {
                id: c.id,
                content: c.content,
                ...(decision
                  ? { jev_decision: { label: decision.label, score: decision.score } }
                  : {}),
                ...interactionShape(c.content),
              };
            }),
          };
          const judgements = options.trace
            ? await options.trace.generation(
                "rem.model.batch",
                () => options.transport(request),
                {
                  model,
                  input: request,
                  output: (result) => result,
                  metadata: {
                    batch_index: i / batchSize,
                    candidate_count: slice.length,
                    candidate_ids: slice.map(({ id }) => id),
                  },
                },
              )
            : await options.transport(request);
          cacheKnownJudgements({
            judgements,
            slice,
            cache,
            batchIndex: i / batchSize,
            logger: options.logger,
          });
        } catch (error) {
          // A failed batch leaves its candidates uncached, so grade() falls
          // back to the heuristic for them. The pass continues: losing one
          // batch to a transport error must not cost the other thirty-six.
          options.logger?.warn("rem_terra_batch_failed", {
            batch_index: i / batchSize,
            size: slice.length,
            error_category: error instanceof Error ? error.name : typeof error,
          });
        }
      }
      if (options.jev?.config.enabled) {
        enforceJevDecisions(cache, jevDecisions);
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
