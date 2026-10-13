/**
 * DREAM route run execution: batch planning with oversize drops, concurrent
 * lane execution, and the no-signal decision.
 *
 * Moved verbatim from `scripts/dream-route-run.ts` (issue 1525) so the
 * scheduled route handler under `server/` can share them without importing
 * from `scripts/`. Environment reading stays with the callers.
 */

import {
  DEFAULT_JEV_MAX_REQUEST_BYTES,
  DEFAULT_JEV_MAX_STATE_QUESTION_BYTES,
  DEFAULT_JEV_MODEL,
  JevBatchTooLargeError,
  buildJevBatchPlan,
  executeJevBatchPlan,
  type JevAnswer,
  type JevBatchPlan,
  type JevClassifierRecord,
  type JevConfig,
  type JevFetch,
} from "../../integrations/jev.ts";
import type { buildRouteClassifierSet } from "./questions.ts";
import type { RouteCandidate, RouteDecision } from "./types.ts";

/** What Jev is told the whole batch is for. */
export const SHARED_TASK =
  "Sort each record into where it belongs in long-term memory. " +
  "Records that sit next to each other may say the same thing.";

/** The placeholder endpoint the fake backend is pointed at; nothing is sent. */
export const FAKE_BASE_URL = "https://placeholder.invalid/v1/systemone";
export const FAKE_API_KEY = "placeholder-key-the-fake-never-sends";
export const JEV_TIMEOUT_MS = 30_000;

/** The free fake config: a placeholder key and an endpoint nothing reaches. */
export function fakeConfig(): JevConfig {
  return {
    enabled: true,
    apiKey: FAKE_API_KEY,
    baseUrl: FAKE_BASE_URL,
    model: DEFAULT_JEV_MODEL,
    timeoutMs: JEV_TIMEOUT_MS,
    maxRequestBytes: DEFAULT_JEV_MAX_REQUEST_BYTES,
    maxStateQuestionBytes: DEFAULT_JEV_MAX_STATE_QUESTION_BYTES,
  };
}

/** A record the planner refused, and the reason it carries into the results. */
export interface DroppedRecord {
  readonly key: string;
  readonly reason: string;
}

const TOO_LARGE_REASON = "no signal: record too large for one request";

/**
 * Plans the batches, dropping any single record the planner cannot fit.
 *
 * Content is NEVER truncated: a record that cannot fit in one request is left
 * out of the plan entirely and recorded as no signal, because a shortened item
 * is a different item and routing it would be routing something the operator
 * never said.
 *
 * @param records - The records, already in batch order.
 * @param classifierSet - The question set built from the matrix.
 * @param config - The config whose byte limits the planner honours.
 * @param log - Where the ADJUSTED lines go.
 * @returns The plan and every record that was left out of it.
 */
export function planWithDrops(
  records: readonly JevClassifierRecord[],
  classifierSet: ReturnType<typeof buildRouteClassifierSet>,
  config: JevConfig,
  log: (line: string) => void,
): { plan: JevBatchPlan; dropped: DroppedRecord[] } {
  const dropped: DroppedRecord[] = [];
  let remaining = [...records];
  for (;;) {
    try {
      const plan = buildJevBatchPlan({
        sharedState: { task: SHARED_TASK },
        records: remaining,
        classifierSet,
        limits: {
          model: config.model,
          maxRequestBytes: config.maxRequestBytes,
          maxStateQuestionBytes: config.maxStateQuestionBytes,
        },
      });
      return { plan, dropped };
    } catch (error) {
      if (!(error instanceof JevBatchTooLargeError)) throw error;
      const key = tooLargeKey(error, remaining);
      log(`ADJUSTED: ${key} left out of the plan; why: too large for one request`);
      dropped.push({ key, reason: TOO_LARGE_REASON });
      remaining = remaining.filter((record) => record.key !== key);
      if (remaining.length === 0) {
        return { plan: { classifierSet, batches: [] }, dropped };
      }
    }
  }
}

/**
 * The record key a `JevBatchTooLargeError` names.
 *
 * The error carries the key only inside its message, so it is read back from
 * there and checked against the records still in hand rather than trusted: an
 * unrecognised key would otherwise drop nothing and loop forever.
 */
function tooLargeKey(
  error: JevBatchTooLargeError,
  remaining: readonly JevClassifierRecord[],
): string {
  const named = /Jev classifier record (.+) exceeds/.exec(error.message)?.[1];
  const known = remaining.find((record) => record.key === named);
  if (known !== undefined) return known.key;
  const first = remaining[0];
  if (first === undefined) throw error;
  return first.key;
}

/** What one sub-plan produced, or the failure that stands in for it. */
export interface LaneOutcome {
  readonly answers: Map<string, Record<string, JevAnswer>>;
  readonly servedModels: Map<string, string>;
  readonly inputTokens: number;
  readonly failures: Map<string, string>;
}

function laneKeys(plan: JevBatchPlan): string[] {
  return plan.batches.flatMap((batch) => batch.records.map((record) => record.key));
}

/**
 * Runs every sub-plan concurrently; a rejected one costs its records, not the run.
 *
 * A failed request is a missing reading, not a reason to throw away every
 * reading that DID arrive, so each record in a rejected sub-plan becomes a
 * no-signal row and the run completes.
 *
 * @param config - The Jev config.
 * @param plans - The sub-plans from `splitPlan`.
 * @param fetchFn - The fetch to execute with.
 * @returns Merged answers, served models, token usage, and per-record failures.
 */
export async function runLanes(
  config: JevConfig,
  plans: readonly JevBatchPlan[],
  fetchFn: JevFetch,
): Promise<LaneOutcome> {
  const settled = await Promise.allSettled(
    plans.map((plan) => executeJevBatchPlan(config, plan, fetchFn)),
  );
  const answers = new Map<string, Record<string, JevAnswer>>();
  const servedModels = new Map<string, string>();
  const failures = new Map<string, string>();
  let inputTokens = 0;
  settled.forEach((outcome, index) => {
    const plan = plans[index] as JevBatchPlan;
    if (outcome.status === "rejected") {
      const message =
        outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason);
      for (const key of laneKeys(plan)) {
        failures.set(key, `no signal: request failed: ${message}`);
      }
      return;
    }
    inputTokens += outcome.value.usage.inputTokens;
    for (const [key, value] of outcome.value.answers) answers.set(key, value);
    for (const [key, model] of outcome.value.servedModels) servedModels.set(key, model);
  });
  return { answers, servedModels, inputTokens, failures };
}

export function noSignalDecision(
  candidate: RouteCandidate,
  reason: string,
  authorityTier: RouteDecision["authorityTier"],
): RouteDecision {
  return {
    candidateId: candidate.id,
    destination: null,
    agreement: "none",
    authorityTier,
    restates: false,
    droveDecision: false,
    reasons: [reason],
    raw: {},
  };
}
