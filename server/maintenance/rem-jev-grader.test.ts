import { expect, test, vi } from "vitest";

import {
  askJev,
  observeJevFailureSafely,
  type JevConfig,
} from "../integrations/jev.ts";
import {
  BackgroundTraceRecorder,
  type BackgroundTraceBody,
} from "../observability/background-tracing.ts";
import { createScheduledJevRemGrader } from "./rem-jev-grader.ts";
import type { RemCandidate } from "./dream-rem.ts";

const config: JevConfig = {
  enabled: true,
  apiKey: "test-key",
  baseUrl: "https://jev.example.test/v1/systemone",
  model: "jev-1.13.0",
  timeoutMs: 1_000,
  maxRequestBytes: 64_000,
  maxStateQuestionBytes: 32_000,
};

function candidate(id: string): RemCandidate {
  return {
    id,
    namespace: "owner",
    candidate_type: "fact",
    content: `OPERATOR: durable statement ${id}`,
    content_hash: id,
    uncertain: false,
    uncertainty_reason: null,
    model: null,
    session_count: 1,
    occurrence_count: 1,
    reinforcement_count: 0,
  };
}

function prime(
  grader: ReturnType<typeof createScheduledJevRemGrader>,
  candidates: readonly RemCandidate[],
) {
  if (!grader.prime) throw new Error("scheduled Jev grader must expose prime");
  return grader.prime(candidates);
}

function requestBody(init?: RequestInit): { questions: Record<string, unknown> } {
  if (typeof init?.body !== "string") throw new Error("expected a string request body");
  return JSON.parse(init.body) as { questions: Record<string, unknown> };
}

function answer(
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

test("tracing receives only safe failure metadata and callers retain error identity", async () => {
  const providerError = new Error("provider transport secret");
  providerError.name = "secret-provider-error-name";
  const observedMetadata: Record<string, unknown> = {};
  const fetchFn = vi.fn(async () => {
    throw providerError;
  });

  const promise = observeJevFailureSafely(
    () => askJev(config, {}, {}, fetchFn),
    { candidate_count: 1 },
    async (safeWork, failureMetadata) => {
      try {
        return await safeWork();
      } catch (error: unknown) {
        Object.assign(observedMetadata, failureMetadata);
        expect(error).toEqual(new Error("Jev provider operation failed"));
        expect((error as Error).name).toBe("Error");
        throw error;
      }
    },
  );

  await expect(promise).rejects.toBe(providerError);
  expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(observedMetadata).toEqual({
    candidate_count: 1,
    failure_stage: "http",
    failure_code: "request_failed",
  });
  expect(JSON.stringify(observedMetadata)).not.toContain("provider transport secret");
  expect(JSON.stringify(observedMetadata)).not.toContain("secret-provider-error-name");
});

test("a timed-out fetch keeps safe TimeoutError attribution and original identity", async () => {
  const timeoutError = new DOMException("provider timeout detail", "TimeoutError");
  const fetchFn = vi.fn(async () => {
    throw timeoutError;
  });

  const promise = observeJevFailureSafely(
    () => askJev(config, {}, {}, fetchFn),
    {},
    async (safeWork, failureMetadata) => {
      try {
        return await safeWork();
      } catch (error: unknown) {
        expect(error).toMatchObject({
          name: "TimeoutError",
          message: "Jev provider operation failed",
        });
        expect(failureMetadata).toEqual({
          failure_stage: "http",
          failure_code: "request_failed",
        });
        expect(JSON.stringify(error)).not.toContain("provider timeout detail");
        throw error;
      }
    },
  );

  await expect(promise).rejects.toBe(timeoutError);
  expect(fetchFn).toHaveBeenCalledTimes(1);
});

test("primes the selected REM slice in one request and returns classification-only provenance", async () => {
  const traces: BackgroundTraceBody[] = [];
  const trace = new BackgroundTraceRecorder(
    { emitBackground: (body) => traces.push(body) },
    { name: "dream.rem", tags: ["rem"] },
  );
  const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = requestBody(init);
    expect(Object.keys(body.questions)).toHaveLength(4);
    return new Response(
      JSON.stringify({
        model: "jev-served-alias",
        answers: {
          r0_c0: answer(body, "r0_c0", "DECISION"),
          r0_c1: answer(body, "r0_c1", "9"),
          r1_c0: answer(body, "r1_c0", "PREFERENCE"),
          r1_c1: answer(body, "r1_c1", "3"),
        },
        usage: { input_tokens: 20, output_tokens: 8 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  const grader = createScheduledJevRemGrader({ config, fetchFn, trace });
  const candidates = [candidate("a"), candidate("b")];

  await prime(grader, candidates);

  expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(await grader.grade(candidate("a"))).toMatchObject({
    grade: "promoted",
    graderName: "jev-served-alias/rem-label-score-v2",
    decision: {
      label: "DECISION",
      score: 9,
      decisionSource: "jev-served-alias/rem-label-score-v2",
    },
  });
  expect(await grader.grade(candidate("b"))).toMatchObject({
    grade: "inconclusive",
    decision: { label: "PREFERENCE", score: 3 },
  });
  trace.finish({ outcome: "complete" });
  expect(traces[0]?.observations).toMatchObject([
    {
      name: "rem.jev.batch",
      type: "generation",
      model: config.model,
      metadata: { candidate_ids: ["a", "b"], candidate_count: 2 },
      output: { model: "jev-served-alias" },
      usageDetails: { input: 20, output: 8 },
    },
  ]);
});

test("a failed batch falls back without claiming Jev attribution", async () => {
  const traces: BackgroundTraceBody[] = [];
  const trace = new BackgroundTraceRecorder(
    { emitBackground: (body) => traces.push(body) },
    { name: "dream.rem", tags: ["rem"] },
  );
  const warnings: Array<{ event: string; fields?: unknown }> = [];
  const fetchFn = vi.fn(
    async () => new Response("provider body must stay private", { status: 503 }),
  );
  const grader = createScheduledJevRemGrader({
    config,
    fetchFn,
    logger: { warn: (event, fields) => warnings.push({ event, fields }) },
    trace,
  });
  const input = candidate("fallback");

  await expect(prime(grader, [input])).resolves.toBeUndefined();
  expect(await grader.grade(input)).toMatchObject({
    grade: "inconclusive",
    graderName: "rem-heuristic-v1",
  });
  expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(warnings).toEqual([
    {
      event: "rem_jev_batch_failed",
      fields: { candidate_count: 1, error_category: "Error" },
    },
  ]);
  trace.finish({ outcome: "fallback" });
  const observation = traces[0]?.observations[0];
  expect(observation).toMatchObject({
    name: "rem.jev.batch",
    level: "ERROR",
    statusMessage: "Error",
    metadata: {
      failure_stage: "http",
      failure_code: "http_status",
      http_status: 503,
    },
  });
  expect(JSON.stringify(observation)).not.toContain("provider body must stay private");
});

test("a validation failure is traced as ERROR before heuristic fallback", async () => {
  const traces: BackgroundTraceBody[] = [];
  const trace = new BackgroundTraceRecorder(
    { emitBackground: (body) => traces.push(body) },
    { name: "dream.rem", tags: ["rem"] },
  );
  const grader = createScheduledJevRemGrader({
    config,
    trace,
    fetchFn: async (_url, init) => {
      const body = requestBody(init);
      return new Response(
        JSON.stringify({
          model: "jev-served-alias",
          answers: {
            r0_c0: {
              ...answer(body, "r0_c0", "DECISION"),
              probabilities: {
                DECISION: 0,
                CORRECTION: 1,
                PREFERENCE: 0,
                QUESTION: 0,
                NARRATION: 0,
              },
            },
            r0_c1: answer(body, "r0_c1", "9"),
          },
          usage: { input_tokens: 10, output_tokens: 4 },
        }),
      );
    },
  });
  const input = candidate("invalid");

  await prime(grader, [input]);
  trace.finish({ outcome: "fallback" });

  expect(await grader.grade(input)).toMatchObject({ graderName: "rem-heuristic-v1" });
  expect(traces[0]?.observations[0]).toMatchObject({
    name: "rem.jev.batch",
    level: "ERROR",
    statusMessage: "Error",
    metadata: {
      failure_stage: "decision",
      failure_code: "invalid_classifier_answer",
    },
  });
  expect(JSON.stringify(traces[0]?.observations[0])).not.toContain(
    "Jev returned invalid classifier answer",
  );
});

test("a throwing trace exporter cannot defeat heuristic fallback", async () => {
  const trace = new BackgroundTraceRecorder(
    {
      emitBackground: () => {
        throw new Error("export failed");
      },
    },
    { name: "dream.rem", tags: ["rem"] },
  );
  const grader = createScheduledJevRemGrader({
    config,
    trace,
    fetchFn: async () => new Response("unavailable", { status: 503 }),
  });
  const input = candidate("fallback");

  await prime(grader, [input]);
  trace.finish({ outcome: "fallback" });

  await expect(grader.grade(input)).resolves.toMatchObject({
    grade: "inconclusive",
    graderName: "rem-heuristic-v1",
  });
});
