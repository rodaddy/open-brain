import { z } from "zod";
import {
  classifyJevFailure,
  describeJevFailure,
  type JevFailureDescriptor,
} from "./jev-failure.ts";
export { describeJevFailure, observeJevFailureSafely } from "./jev-failure.ts";
export type { JevFailureDescriptor, JevFailureReason } from "./jev-failure.ts";

export const DEFAULT_JEV_BASE_URL = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_JEV_MODEL = "jev-1.13.0";
/**
 * The provider documents 64k tokens per request and 32k tokens for state
 * plus the longest question (docs.typesafe.ai/models.md, read 2026-09-21).
 * These are UTF-8 byte estimates at 3 bytes per token; the repository has no
 * provider-exact tokenizer. The earlier 64_000 and 32_000 assumed 1 byte per
 * token, which can never exceed the provider figures but refused real records
 * of 33 to 62 KB and abandoned their whole rerank (issue 1417). Measured on
 * that data: 41 of 41 requests accepted, about 3.5 request bytes per token
 * overall, biggest single call 33,084 input tokens. Text that tokenizes below
 * 3 bytes per token can still be refused by the provider; callers then get
 * the same fallback the old values produced locally.
 */
export const DEFAULT_JEV_MAX_REQUEST_BYTES = 192_000;
export const DEFAULT_JEV_MAX_STATE_QUESTION_BYTES = 96_000;

export interface JevConfig {
  readonly enabled: boolean;
  readonly apiKey?: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  /** Conservative UTF-8 serialized-byte estimate, not provider token count. */
  readonly maxRequestBytes: number;
  /** Conservative state plus longest-question byte estimate. */
  readonly maxStateQuestionBytes: number;
}

/**
 * Structured instructions or Choice criteria, one level deep. Design source:
 * `_plans/1469-jev-matrix.md` section 4 (structured instructions/criteria per
 * `primitives_choice.md:601`, named state fields per `concepts_state.md:29`).
 */
export type JevStructuredText = Readonly<Record<string, string | readonly string[]>>;

export type JevQuestion =
  | {
      readonly type: "choice";
      readonly instructions: string | JevStructuredText;
      readonly criteria: Readonly<Record<string, string | null | JevStructuredText>>;
    }
  | {
      readonly type: "noul";
      readonly instructions: string | JevStructuredText;
      readonly criteria?: Readonly<{ true: string; false: string }>;
    }
  | {
      readonly type: "score";
      readonly instructions: string | JevStructuredText;
      readonly criteria: readonly string[];
    };

import { RELEVANCE_CLASSIFIER_SET } from "./jev-question-sets.ts";
export {
  JEV_REM_RUBRIC_VERSION,
  JEV_REM_QUESTIONS,
  REM_CLASSIFIER_SET,
  JEV_RELEVANCE_QUESTION,
  JEV_RELEVANCE_RUBRIC_VERSION,
  RELEVANCE_CLASSIFIER_SET,
} from "./jev-question-sets.ts";

const probabilitySchema = z.record(z.string(), z.number().min(0).max(1));
const answerSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("choice"),
      choice: z.string(),
      probabilities: probabilitySchema,
      confidence: z.number().min(0).max(1),
    })
    .passthrough(),
  z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }).passthrough(),
  z
    .object({
      type: z.literal("score"),
      score: z.number(),
      legend: z.record(z.string(), z.string()),
      probabilities: probabilitySchema,
      confidence: z.number().min(0).max(1),
    })
    .passthrough(),
]);
const responseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), answerSchema),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});
const JEV_QUESTION_TYPES = new Set(["choice", "noul", "score"]);

export type JevAnswer = z.infer<typeof answerSchema>;
export type JevResponse = z.infer<typeof responseSchema>;
export type JevFetch = typeof fetch;

export interface ClassifierSet {
  readonly name: string;
  readonly version: string;
  readonly classifiers: Readonly<Record<string, JevQuestion>>;
}

export interface JevClassifierRecord {
  readonly key: string;
  readonly content: string;
  /** Named state fields (`_plans/1469-jev-matrix.md` section 4). */
  readonly fields?: Readonly<Record<string, string | null>>;
}

interface JevQuestionMapping {
  readonly questionId: string;
  readonly recordKey: string;
  readonly classifierName: string;
}

export interface JevBatch {
  readonly records: readonly JevClassifierRecord[];
  readonly state: Record<string, unknown>;
  readonly questions: Record<string, JevQuestion>;
  readonly mappings: readonly JevQuestionMapping[];
  readonly estimatedRequestBytes: number;
  readonly estimatedStateQuestionBytes: number;
}

export interface JevBatchPlan {
  readonly classifierSet: ClassifierSet;
  readonly batches: readonly JevBatch[];
}

export type JevBatchObserver = (
  batch: JevBatch,
  work: () => Promise<JevResponse>,
) => Promise<JevResponse>;

function validateJevBatchResponse(batch: JevBatch, response: JevResponse): JevResponse {
  if (Object.keys(response.answers).length !== batch.mappings.length) {
    const error = new Error("Jev returned incomplete classifier answers");
    throw classifyJevFailure(error, {
      failure_stage: "decision",
      failure_code: "incomplete_classifier_answers",
    });
  }
  for (const mapping of batch.mappings) {
    const answer = response.answers[mapping.questionId];
    const question = batch.questions[mapping.questionId];
    if (!answer || !question || !validateClassifierAnswer(question, answer)) {
      // Classifier output is model-derived judgement, never a secret, so the
      // offending answer is safe to name; it is what makes the failure
      // diagnosable without re-running a paid batch.
      const detail = JSON.stringify(answer ?? null).slice(0, 600);
      const error = new Error(
        `Jev returned invalid classifier answer for question ${mapping.questionId} ` +
          `(type ${question?.type ?? "unknown"}): ${detail}`,
      );
      throw classifyJevFailure(error, {
        failure_stage: "decision",
        failure_code: "invalid_classifier_answer",
      });
    }
  }
  return response;
}

export class JevBatchTooLargeError extends Error {
  constructor(recordKey: string) {
    super(`Jev classifier record ${recordKey} exceeds configured byte ceilings`);
    this.name = "JevBatchTooLargeError";
  }
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isStructuredText(value: unknown): value is JevStructuredText {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length > 0 &&
    entries.every(
      ([, entry]) =>
        isNonEmptyString(entry) ||
        (Array.isArray(entry) && entry.length > 0 && entry.every(isNonEmptyString)),
    )
  );
}

function validateChoiceCriteria(name: string, criteria: unknown): void {
  if (!criteria || typeof criteria !== "object" || Object.keys(criteria).length === 0) {
    throw new Error(`Jev Choice classifier ${name} requires nonempty criteria`);
  }
  const invalid = Object.entries(criteria).some(
    ([key, value]) =>
      key.trim() === "" ||
      (value !== null && typeof value !== "string" && !isStructuredText(value)),
  );
  if (invalid) throw new Error(`Jev Choice classifier ${name} has invalid criteria`);
}

function validateNoulCriteria(name: string, criteria: unknown): void {
  if (criteria === undefined) return;
  if (!criteria || typeof criteria !== "object")
    throw new Error(`Jev Noul classifier ${name} has invalid criteria`);
  const value = criteria as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const exactKeys = keys.length === 2 && keys[0] === "false" && keys[1] === "true";
  const stringValues =
    typeof value.true === "string" && typeof value.false === "string";
  if (!exactKeys || !stringValues)
    throw new Error(`Jev Noul classifier ${name} has invalid criteria`);
}

function validateScoreCriteria(name: string, criteria: unknown): void {
  const valid =
    Array.isArray(criteria) &&
    criteria.length >= 2 &&
    criteria.length <= 10 &&
    criteria.every((entry) => typeof entry === "string" && entry.trim() !== "");
  if (!valid) throw new Error(`Jev Score classifier ${name} has invalid criteria`);
}

function validateQuestion(name: string, question: unknown): void {
  if (!question || typeof question !== "object")
    throw new Error(`Jev classifier ${name} has an invalid type`);
  const value = question as Partial<JevQuestion>;
  if (!isNonEmptyString(value.instructions) && !isStructuredText(value.instructions))
    throw new Error(`Jev classifier ${name} has empty instructions`);
  if (!JEV_QUESTION_TYPES.has(value.type ?? ""))
    throw new Error(`Jev classifier ${name} has an invalid type`);
  if (value.type === "choice") validateChoiceCriteria(name, value.criteria);
  if (value.type === "noul") validateNoulCriteria(name, value.criteria);
  if (value.type === "score") validateScoreCriteria(name, value.criteria);
}

function validateClassifierSet(classifierSet: ClassifierSet): void {
  const entries = Object.entries(classifierSet.classifiers);
  if (entries.length === 0) throw new Error("Jev classifier set is empty");
  for (const [name, question] of entries) validateQuestion(name, question);
}

function materializeBatch(args: {
  sharedState: Record<string, unknown>;
  records: readonly JevClassifierRecord[];
  classifierSet: ClassifierSet;
  startIndex: number;
  model: string;
}): JevBatch {
  const mappings: JevQuestionMapping[] = [];
  const questions: Record<string, JevQuestion> = Object.create(null) as Record<
    string,
    JevQuestion
  >;
  args.records.forEach((record, localIndex) => {
    Object.entries(args.classifierSet.classifiers).forEach(
      ([classifierName, question], classifierIndex) => {
        const questionId = `r${args.startIndex + localIndex}_c${classifierIndex}`;
        questions[questionId] = {
          ...question,
          instructions:
            typeof question.instructions === "string"
              ? `${question.instructions} Judge only record key ${record.key} at records[${localIndex}].`
              : {
                  ...question.instructions,
                  judge_only: `record key ${record.key} at records[${localIndex}]`,
                },
        };
        mappings.push({ questionId, recordKey: record.key, classifierName });
      },
    );
  });
  const state = {
    ...args.sharedState,
    classifier_set: {
      name: args.classifierSet.name,
      version: args.classifierSet.version,
    },
    records: args.records,
  };
  const stateBytes = serializedBytes(state);
  const longestQuestionBytes = Math.max(
    ...Object.values(questions).map(serializedBytes),
  );
  return {
    records: args.records,
    state,
    questions,
    mappings,
    estimatedRequestBytes: serializedBytes({ state, model: args.model, questions }),
    estimatedStateQuestionBytes: stateBytes + longestQuestionBytes,
  };
}

export function buildJevBatchPlan(args: {
  sharedState: Record<string, unknown>;
  records: readonly JevClassifierRecord[];
  classifierSet: ClassifierSet;
  limits: Pick<JevConfig, "model" | "maxRequestBytes" | "maxStateQuestionBytes">;
}): JevBatchPlan {
  validateClassifierSet(args.classifierSet);
  if (new Set(args.records.map(({ key }) => key)).size !== args.records.length) {
    throw new Error("Jev classifier records contain duplicate keys");
  }
  const batches: JevBatch[] = [];
  let start = 0;
  while (start < args.records.length) {
    let accepted: JevBatch | undefined;
    for (let end = start + 1; end <= args.records.length; end++) {
      const candidate = materializeBatch({
        ...args,
        records: args.records.slice(start, end),
        startIndex: start,
        model: args.limits.model,
      });
      const fits =
        candidate.estimatedRequestBytes <= args.limits.maxRequestBytes &&
        candidate.estimatedStateQuestionBytes <= args.limits.maxStateQuestionBytes;
      if (!fits) break;
      accepted = candidate;
    }
    if (!accepted)
      throw new JevBatchTooLargeError(args.records[start]?.key ?? "unknown");
    batches.push(accepted);
    start += accepted.records.length;
  }
  return { classifierSet: args.classifierSet, batches };
}

/**
 * Jev rounds choice probabilities to 2 decimals, so a legitimate distribution
 * need not sum to exactly 1: of the 22 recorded distributions in
 * `_DOCS/jev/trials/2026-09-19-classifiers-round2.json`, one
 * (`sets/holdout/doc_kind/misses/2`) sums to 0.99. The production Choice
 * validator is documented as accepting a sum "within 0.02 of 1"
 * (`_DOCS/jev/06-sdks-and-integration.md:933`), so match it here; the previous
 * 1e-6 guard rejected real answers. Key-set equality and the Zod 0..1 bounds
 * are unchanged.
 */
const PROBABILITY_SUM_TOLERANCE = 0.02;

function hasValidProbabilities(
  probabilities: Readonly<Record<string, number>>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(probabilities);
  if (
    actualKeys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(probabilities, key)) ||
    Math.abs(Object.values(probabilities).reduce((sum, value) => sum + value, 0) - 1) >
      PROBABILITY_SUM_TOLERANCE
  )
    return false;
  return true;
}

function validateScoreAnswer(
  question: Extract<JevQuestion, { type: "score" }>,
  answer: Extract<JevAnswer, { type: "score" }>,
): boolean {
  const expectedKeys = question.criteria.map((_, index) => String(index));
  if (!hasValidProbabilities(answer.probabilities, expectedKeys)) return false;
  const expectedScore = Object.entries(answer.probabilities).reduce(
    (sum, [level, probability]) => sum + Number(level) * probability,
    0,
  );
  return (
    Object.keys(answer.legend).length === expectedKeys.length &&
    expectedKeys.every(
      (key) => answer.legend[key] === question.criteria[Number(key)],
    ) &&
    answer.score >= 0 &&
    answer.score <= question.criteria.length - 1 &&
    Math.abs(answer.score - expectedScore) <= 1e-6
  );
}

function validateClassifierAnswer(question: JevQuestion, answer: JevAnswer): boolean {
  if (question.type !== answer.type) return false;
  if (question.type === "noul" && answer.type === "noul") return true;
  if (question.type === "choice" && answer.type === "choice") {
    const selectedProbability = answer.probabilities[answer.choice];
    return (
      Object.hasOwn(question.criteria, answer.choice) &&
      hasValidProbabilities(answer.probabilities, Object.keys(question.criteria)) &&
      selectedProbability === Math.max(...Object.values(answer.probabilities))
    );
  }
  return (
    question.type === "score" &&
    answer.type === "score" &&
    validateScoreAnswer(question, answer)
  );
}

export async function executeJevBatchPlan(
  config: JevConfig,
  plan: JevBatchPlan,
  fetchFn?: JevFetch,
  observeBatch?: JevBatchObserver,
): Promise<{
  answers: Map<string, Record<string, JevAnswer>>;
  servedModels: Map<string, string>;
  usage: { inputTokens: number; outputTokens: number };
}> {
  const staged = new Map<string, Record<string, JevAnswer>>();
  const servedModels = new Map<string, string>();
  const usage = { inputTokens: 0, outputTokens: 0 };
  for (const batch of plan.batches) {
    const work = async () =>
      validateJevBatchResponse(
        batch,
        await askJev(config, batch.state, batch.questions, fetchFn),
      );
    const response = observeBatch ? await observeBatch(batch, work) : await work();
    usage.inputTokens += response.usage.input_tokens;
    usage.outputTokens += response.usage.output_tokens;
    for (const mapping of batch.mappings) {
      const answer = response.answers[mapping.questionId];
      if (!answer) throw new Error("validated Jev answer missing");
      const recordAnswers =
        staged.get(mapping.recordKey) ??
        (Object.create(null) as Record<string, JevAnswer>);
      recordAnswers[mapping.classifierName] = answer;
      staged.set(mapping.recordKey, recordAnswers);
      servedModels.set(mapping.recordKey, response.model);
    }
  }
  return { answers: staged, servedModels, usage };
}

export async function askJev(
  config: JevConfig,
  state: unknown,
  questions: Record<string, JevQuestion>,
  fetchFn: JevFetch = fetch,
): Promise<JevResponse> {
  if (!config.enabled || !config.apiKey) throw new Error("Jev is not configured");
  if (new URL(config.baseUrl).protocol !== "https:") {
    throw new Error("Jev endpoint must use HTTPS");
  }
  let response: Response;
  try {
    response = await fetchFn(config.baseUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ state, model: config.model, questions }),
      signal: AbortSignal.timeout(config.timeoutMs),
      redirect: "error",
    });
  } catch (error: unknown) {
    throw classifyJevFailure(error, {
      failure_stage: "http",
      failure_code: "request_failed",
    });
  }
  if (!response.ok) {
    const error = new Error(`Jev request failed with status ${response.status}`);
    throw classifyJevFailure(error, {
      failure_stage: "http",
      failure_code: "http_status",
      http_status: response.status,
    });
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error: unknown) {
    throw classifyJevFailure(error, {
      failure_stage: "response",
      failure_code: "invalid_json",
    });
  }
  try {
    return responseSchema.parse(body);
  } catch (error: unknown) {
    throw classifyJevFailure(error, {
      failure_stage: "response",
      failure_code: "invalid_schema",
    });
  }
}

export interface JevRerankCandidate {
  readonly id: string;
  readonly content: string;
}

export async function rerankWithJev<T extends JevRerankCandidate>(
  config: JevConfig,
  query: string,
  candidates: readonly T[],
  options: {
    fetchFn?: JevFetch;
    onFailure?: (failure: JevFailureDescriptor) => void;
    observeBatch?: JevBatchObserver;
  } = {},
): Promise<T[]> {
  if (!config.enabled || candidates.length < 2) return [...candidates];
  try {
    const plan = buildJevBatchPlan({
      sharedState: { query },
      records: candidates.map(({ id: key, content }) => ({ key, content })),
      classifierSet: RELEVANCE_CLASSIFIER_SET,
      limits: config,
    });
    const result = await executeJevBatchPlan(
      config,
      plan,
      options.fetchFn,
      options.observeBatch,
    );
    const scored = candidates.map((candidate, index) => {
      const answer = result.answers.get(candidate.id)?.relevance;
      if (answer?.type !== "noul")
        throw classifyJevFailure(new Error("Jev returned invalid relevance answer"), {
          failure_stage: "decision",
          failure_code: "invalid_relevance_answer",
        });
      return { candidate, score: answer.noul, index };
    });
    return scored
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .map(({ candidate }) => candidate);
  } catch (error: unknown) {
    options.onFailure?.(describeJevFailure(error));
    return [...candidates];
  }
}
