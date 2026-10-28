/**
 * The whole DREAM route pipe, end to end, with no network and no database.
 *
 * The real matrix, the real question builder, the real batch planner, the real
 * executor, and the real decision code, joined by `fakeJevFetch`. It proves the
 * plumbing, never the judgement: the fake judges nothing.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_JEV_MAX_REQUEST_BYTES,
  DEFAULT_JEV_MAX_STATE_QUESTION_BYTES,
  DEFAULT_JEV_MODEL,
  type JevAnswer,
  type JevConfig,
  buildJevBatchPlan,
  executeJevBatchPlan,
} from "../server/integrations/jev.ts";
import {
  DEFAULT_THRESHOLDS,
  decideRoute,
} from "../server/domain/dream-route/decide.ts";
import {
  DEFAULT_MATRIX_PATH,
  loadMatrix,
} from "../server/domain/dream-route/matrix.ts";
import { buildRouteClassifierSet } from "../server/domain/dream-route/questions.ts";
import type { RouteCandidate } from "../server/domain/dream-route/types.ts";
import {
  fakeJevFetch,
  projectCost,
  recordOf,
  splitPlan,
} from "../server/domain/dream-route/run-core.ts";

const CONFIG: JevConfig = {
  enabled: true,
  apiKey: "placeholder-key-the-fake-never-sends",
  baseUrl: "https://placeholder.invalid/v1/systemone",
  model: DEFAULT_JEV_MODEL,
  timeoutMs: 5_000,
  maxRequestBytes: DEFAULT_JEV_MAX_REQUEST_BYTES,
  maxStateQuestionBytes: DEFAULT_JEV_MAX_STATE_QUESTION_BYTES,
};

const CONTENTS = [
  "always branch before editing, never commit on main",
  "the operator approved moving every repository to Forge",
  "the service runs two Open Brain workers behind one port",
  "the agent recorded the wrong port and was corrected",
  "go ahead",
  "prefer the smallest correct change at the owning boundary",
  "the embedding model is a 768-dimension dense model",
  "the operator chose Node 24 over bun for new code",
  "that path was wrong, it lives under the temp workspace",
  "sounds good, carry on",
  "the route matrix lives in a committed tsv file",
  "the operator decided agreement, not one answer, commits",
];

const TYPES = ["decision", "correction", "fact", "preference"] as const;

function candidates(): RouteCandidate[] {
  return CONTENTS.map((content, index) => ({
    id: `cand-${String(index).padStart(2, "0")}`,
    namespace: "dana",
    candidateType: TYPES[index % 4] as RouteCandidate["candidateType"],
    content,
    operatorText: index % 2 === 0 ? content : null,
    unitKind: index % 3 === 0 ? ("exchange" as const) : ("fragment" as const),
    anchorKind: index % 3 === 0 ? ("typed" as const) : ("orphan" as const),
  }));
}

describe("the DREAM route pipe, offline", () => {
  it("routes twelve records through split batches to real decisions", async () => {
    const matrix = loadMatrix(DEFAULT_MATRIX_PATH);
    const classifierSet = buildRouteClassifierSet(matrix);
    const all = candidates();
    const records = all.map(recordOf);

    const plan = buildJevBatchPlan({
      sharedState: { task: "dream-route" },
      records,
      classifierSet,
      limits: {
        model: CONFIG.model,
        maxRequestBytes: CONFIG.maxRequestBytes,
        maxStateQuestionBytes: CONFIG.maxStateQuestionBytes,
      },
    });
    expect(plan.batches.length).toBeGreaterThan(0);

    const cost = projectCost(plan);
    expect(cost.requests).toBe(plan.batches.length);
    expect(cost.estimatedUsd).toBeGreaterThan(0);

    const fetchFn = fakeJevFetch();
    const results = await Promise.all(
      splitPlan(plan, 3).map((part) => executeJevBatchPlan(CONFIG, part, fetchFn)),
    );

    const answers = new Map<string, Record<string, JevAnswer>>();
    for (const result of results) {
      for (const [key, value] of result.answers) answers.set(key, value);
      for (const model of result.servedModels.values()) {
        expect(model).toBe("local-fake");
      }
    }
    expect(answers.size).toBe(records.length);

    for (const candidate of all) {
      const forRecord = answers.get(candidate.id);
      expect(forRecord, candidate.id).toBeDefined();
      const decision = decideRoute(
        candidate,
        forRecord as Record<string, JevAnswer>,
        matrix,
        DEFAULT_THRESHOLDS,
      );
      expect(decision.candidateId).toBe(candidate.id);
      for (const reason of decision.reasons) {
        expect(reason).not.toContain("no signal:");
      }
    }
  });
});
