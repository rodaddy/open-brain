/**
 * REM Jev confidence floor (issue 1618 B5): optional, default off. Below the
 * floor a grade is `inconclusive` whatever the score; the row's source says why.
 */
import type pg from "pg";
import { expect, test, vi } from "vitest";

import type { JevConfig } from "../integrations/jev.ts";
import { parseServerConfig } from "../config.ts";
import { BackgroundTraceRecorder } from "../observability/background-tracing.ts";
import type { NamedRemGrader, RemCandidate } from "./dream-rem.ts";
import { createScheduledJevRemGrader } from "./rem-jev-grader.ts";

const captured = vi.hoisted(() => ({
  factory: undefined as
    undefined | ((trace: BackgroundTraceRecorder) => NamedRemGrader),
}));

vi.mock("./dream-rem.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./dream-rem.ts")>();
  return {
    ...original,
    makeDreamRemHandler: (deps: Parameters<typeof original.makeDreamRemHandler>[0]) => {
      captured.factory = deps.graderFactory;
      return original.makeDreamRemHandler(deps);
    },
  };
});

const { MAINTENANCE_GRAPH_AUTH, composeMaintenanceHandlers } =
  await import("./maintenance-bootstrap.ts");

const baseConfig: JevConfig = {
  enabled: true,
  apiKey: "test-key",
  baseUrl: "https://jev.example.test/v1/systemone",
  model: "jev-1.13.0",
  timeoutMs: 1_000,
  maxRequestBytes: 64_000,
  maxStateQuestionBytes: 32_000,
};

const candidate: RemCandidate = {
  id: "a",
  namespace: "owner",
  candidate_type: "fact",
  content: "OPERATOR: durable statement a",
  content_hash: "a",
  uncertain: false,
  uncertainty_reason: null,
  model: null,
  session_count: 1,
  occurrence_count: 1,
  reinforcement_count: 0,
};

function fakeFetch(labelConfidence: number, scoreConfidence: number) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body !== "string") throw new Error("expected a string body");
    const body = JSON.parse(init.body) as {
      questions: Record<string, { criteria: Record<string, unknown> }>;
    };
    const choice = (id: string, value: string, confidence: number) => ({
      type: "choice",
      choice: value,
      probabilities: Object.fromEntries(
        Object.keys(body.questions[id]?.criteria ?? {}).map((key) => [
          key,
          key === value ? 1 : 0,
        ]),
      ),
      confidence,
    });
    return new Response(
      JSON.stringify({
        model: "jev-served",
        answers: {
          r0_c0: choice("r0_c0", "DECISION", labelConfidence),
          r0_c1: choice("r0_c1", "9", scoreConfidence),
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

async function gradeWith(
  grader: NamedRemGrader,
): Promise<Awaited<ReturnType<NamedRemGrader["grade"]>>> {
  if (!grader.prime) throw new Error("scheduled Jev grader must expose prime");
  await grader.prime([candidate]);
  return grader.grade(candidate);
}

function graderWith(floor: number | undefined, label: number, score: number) {
  return createScheduledJevRemGrader({
    config: {
      ...baseConfig,
      ...(floor === undefined ? {} : { confidenceFloor: floor }),
    },
    fetchFn: fakeFetch(label, score),
  });
}

test("a: below the floor a score of 9 is inconclusive and the source names conf and floor", async () => {
  const result = await gradeWith(graderWith(0.5, 0.3, 0.3));
  expect(result.grade).toBe("inconclusive");
  expect(result.graderName).toContain("conf=0.3<floor=0.5");
  expect(result.decision?.decisionSource).toContain("conf=0.3<floor=0.5");
});

test("b: at confidence above the floor a score of 9 is promoted", async () => {
  expect((await gradeWith(graderWith(0.5, 0.8, 0.8))).grade).toBe("promoted");
});

test("c: with no floor a low-confidence score of 9 is promoted, as today", async () => {
  const result = await gradeWith(graderWith(undefined, 0.3, 0.3));
  expect(result.grade).toBe("promoted");
  expect(result.graderName).toBe("jev-served/rem-label-score-v2");
});

test("d: the confidence used is the minimum of the label and score answers", async () => {
  const result = await gradeWith(graderWith(0.5, 0.9, 0.4));
  expect(result.grade).toBe("inconclusive");
  expect(result.graderName).toContain("conf=0.4<floor=0.5");
});

test("f: the floor parsed from env arrives at the grader the maintenance runtime composes", async () => {
  const parsed = parseServerConfig({
    DB_HOST: "db.internal",
    DB_NAME: "open_brain_test",
    DB_USER: "open_brain",
    LOG_FILE: "logs/open-brain.log",
    OPENBRAIN_JEV_REM_ENABLED: "1",
    OPENBRAIN_JEV_API_KEY: "test-key",
    OPENBRAIN_JEV_REM_CONFIDENCE_FLOOR: "0.5",
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  captured.factory = undefined;
  composeMaintenanceHandlers({
    pool: {} as pg.Pool,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    embedFn: async () => {
      throw new Error("not called");
    },
    graphAuth: MAINTENANCE_GRAPH_AUTH,
    jevRem: { config: parsed.config.search.jevRem, fetchFn: fakeFetch(0.3, 0.3) },
  });
  const factory = captured.factory as
    undefined | ((trace: BackgroundTraceRecorder) => NamedRemGrader);
  if (!factory) throw new Error("REM grader factory was not wired");
  const trace = new BackgroundTraceRecorder(
    { emitBackground: () => undefined },
    { name: "dream.rem", tags: ["rem"] },
  );
  const result = await gradeWith(factory(trace));
  expect(result.grade).toBe("inconclusive");
  expect(result.graderName).toContain("floor=0.5");
});
