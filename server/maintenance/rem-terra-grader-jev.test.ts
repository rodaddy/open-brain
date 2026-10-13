import { describe, expect, it, vi } from "vitest";
import { createTerraGrader, type TerraJudgement } from "./rem-terra-grader.ts";
import type { RemCandidate } from "./dream-rem.ts";
import {
  buildJevBatchPlan,
  REM_CLASSIFIER_SET,
  type JevConfig,
} from "../integrations/jev.ts";
import {
  BackgroundTraceRecorder,
  type BackgroundTraceBody,
} from "../observability/background-tracing.ts";

const candidate: RemCandidate = {
  id: "candidate-1",
  namespace: "tenant-a",
  candidate_type: "decision",
  content: "OPERATOR: keep this rule\nagent: recorded it",
  content_hash: "hash",
  uncertain: false,
  uncertainty_reason: null,
  model: null,
  session_count: 1,
  occurrence_count: 1,
  reinforcement_count: 0,
};
const terra: TerraJudgement = {
  id: candidate.id,
  score: 2,
  label: "NARRATION",
  quote: "keep this rule",
  synopsis: "recorded it",
  agent_behavior: "good",
  reasons: ["durable rule"],
};
const candidate2 = { ...candidate, id: "candidate-2", content_hash: "hash-2" };
const terra2 = { ...terra, id: candidate2.id };
const config: JevConfig = {
  enabled: true,
  apiKey: "test-key",
  baseUrl: "https://example.test/systemone",
  model: "jev-1.13.0",
  timeoutMs: 100,
  maxRequestBytes: 64_000,
  maxStateQuestionBytes: 32_000,
};

function choiceAnswer(
  body: { questions: Record<string, unknown> },
  id: string,
  choice: string,
) {
  const criteria = (body.questions[id] as { criteria: Record<string, unknown> })
    .criteria;
  return {
    type: "choice",
    choice,
    probabilities: Object.fromEntries(
      Object.keys(criteria).map((key) => [key, key === choice ? 1 : 0]),
    ),
    confidence: 1,
  };
}

function jevResponse(init: RequestInit | undefined): Response {
  if (typeof init?.body !== "string") throw new Error("expected body");
  const body = JSON.parse(init.body);
  const answers = Object.fromEntries(
    Object.keys(body.questions).map((id) => [
      id,
      choiceAnswer(body, id, id.endsWith("_c0") ? "DECISION" : "9"),
    ]),
  );
  return new Response(
    JSON.stringify({
      model: "jev-served-alias",
      answers,
      usage: { input_tokens: 20, output_tokens: 8 },
    }),
  );
}

describe("REM provider tracing", () => {
  it("traces only the real Jev and model batch calls, with requested and served routes", async () => {
    const bodies: BackgroundTraceBody[] = [];
    const trace = new BackgroundTraceRecorder(
      { emitBackground: (body) => bodies.push(body) },
      { name: "dream.rem.ethereal", tags: ["rem"], sessionId: "dream_run_001" },
    );
    const grader = createTerraGrader({
      trace,
      transport: async (request) => [
        { ...terra, id: request.items[0]?.id ?? candidate.id },
      ],
      jev: {
        config,
        fetchFn: async (_url, init) => jevResponse(init),
      },
    });

    await grader.prime([candidate]);
    await grader.grade(candidate);
    trace.finish({ judged: 1, fell_back: 0 });

    expect(bodies[0]?.observations).toMatchObject([
      {
        name: "rem.jev.batch",
        type: "generation",
        model: "jev-1.13.0",
        output: { model: "jev-served-alias" },
        usageDetails: { input: 20, output: 8 },
      },
      {
        name: "rem.model.batch",
        type: "generation",
        model: "gpt-5.6-terra",
        metadata: { batch_index: 0, candidate_ids: [candidate.id] },
      },
    ]);
    expect(bodies[0]?.observations).toHaveLength(2);
  });

  it("correlates each split Jev request with only its own candidate ids", async () => {
    const bodies: BackgroundTraceBody[] = [];
    const trace = new BackgroundTraceRecorder(
      { emitBackground: (body) => bodies.push(body) },
      { name: "dream.rem.ethereal", tags: ["rem"] },
    );
    const firstPlan = buildJevBatchPlan({
      sharedState: {},
      records: [{ key: candidate.id, content: candidate.content }],
      classifierSet: REM_CLASSIFIER_SET,
      limits: config,
    });
    const first = firstPlan.batches[0];
    if (!first) throw new Error("expected first Jev batch");
    const splitConfig = { ...config, maxRequestBytes: first.estimatedRequestBytes };
    const grader = createTerraGrader({
      trace,
      transport: async () => [terra, terra2],
      jev: {
        config: splitConfig,
        fetchFn: async (_url, init) => jevResponse(init),
      },
    });

    await grader.prime([candidate, candidate2]);
    trace.finish({ outcome: "complete" });

    const jev = bodies[0]?.observations.filter(({ name }) => name === "rem.jev.batch");
    expect(jev?.map(({ metadata }) => metadata.candidate_ids)).toEqual([
      [candidate.id],
      [candidate2.id],
    ]);
  });
});

describe("REM Jev decision overlay", () => {
  it("uses the production route by default and accepts an attributable evaluation route", async () => {
    const defaults = vi.fn(async () => [terra]);
    const defaultGrader = createTerraGrader({ transport: defaults });
    await defaultGrader.prime([candidate]);
    expect(defaults).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5.6-terra", effort: "low" }),
    );
    expect(defaultGrader.name).toBe("rem-terra-low/round3");

    const selected = vi.fn(async () => [terra]);
    const selectedGrader = createTerraGrader({
      transport: selected,
      model: "gpt-5.6-luna",
      effort: "max",
    });
    await selectedGrader.prime([candidate]);
    expect(selected).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5.6-luna", effort: "max" }),
    );
    expect(selectedGrader.name).toBe("rem-gpt-5.6-luna-max/round3");
  });

  it("replaces only label and score after Terra supplies the full judgement", async () => {
    const order: string[] = [];
    const grader = createTerraGrader({
      transport: async (request) => {
        order.push("terra");
        expect(request.items.map((item) => item.jev_decision)).toEqual([
          { label: "DECISION", score: 9 },
          { label: "QUESTION", score: 3 },
        ]);
        return [terra, terra2];
      },
      jev: {
        config,
        fetchFn: async (_url, init) => {
          order.push("jev");
          if (typeof init?.body !== "string") throw new Error("expected JSON body");
          const body = JSON.parse(init.body);
          expect(body.state.records).toHaveLength(2);
          expect(body.questions.r0_c0.instructions).toContain(candidate.id);
          expect(body.questions.r1_c1.instructions).toContain(candidate2.id);
          return new Response(
            JSON.stringify({
              model: "jev-served-alias",
              answers: {
                r0_c0: choiceAnswer(body, "r0_c0", "DECISION"),
                r0_c1: choiceAnswer(body, "r0_c1", "9"),
                r1_c0: choiceAnswer(body, "r1_c0", "QUESTION"),
                r1_c1: choiceAnswer(body, "r1_c1", "3"),
              },
              usage: { input_tokens: 20, output_tokens: 8 },
            }),
          );
        },
      },
    });
    await grader.prime([candidate, candidate2]);
    expect(order).toEqual(["jev", "terra"]);
    expect(grader.judgementFor(candidate.id)).toEqual({
      ...terra,
      label: "DECISION",
      score: 9,
      decision_source: "jev-served-alias/rem-label-score-v2",
    });
    expect(await grader.grade(candidate)).toEqual({
      grade: "promoted",
      reason: "recorded it",
    });
  });
});

describe("REM Jev failure tracing", () => {
  it("preserves Terra output when Jev returns an invalid Score level", async () => {
    const warn = vi.fn();
    const bodies: BackgroundTraceBody[] = [];
    const trace = new BackgroundTraceRecorder(
      { emitBackground: (body) => bodies.push(body) },
      { name: "dream.rem.ethereal", tags: ["rem"] },
    );
    const grader = createTerraGrader({
      trace,
      transport: async () => [terra],
      logger: { warn },
      jev: {
        config,
        fetchFn: async () =>
          new Response(
            JSON.stringify({
              model: config.model,
              answers: {
                r0_c0: { type: "choice", choice: "DECISION" },
                r0_c1: { type: "choice", choice: "1e1" },
              },
            }),
          ),
      },
    });
    await grader.prime([candidate]);
    trace.finish({ outcome: "fallback" });
    expect(grader.judgementFor(candidate.id)).toEqual(terra);
    expect(warn).toHaveBeenCalledWith(
      "rem_jev_decision_failed",
      expect.objectContaining({ candidate_count: 1 }),
    );
    expect(bodies[0]?.observations[0]).toMatchObject({
      name: "rem.jev.batch",
      level: "ERROR",
      statusMessage: "ZodError",
    });
  });
});
