import { describe, expect, it } from "vitest";
import {
  askJev,
  buildJevBatchPlan,
  executeJevBatchPlan,
  type ClassifierSet,
  type JevConfig,
} from "./jev.ts";

const config: JevConfig = {
  enabled: true,
  apiKey: "test",
  baseUrl: "https://example.test/systemone",
  model: "jev-1.13.0",
  timeoutMs: 100,
  maxRequestBytes: 64_000,
  maxStateQuestionBytes: 32_000,
};
const choiceSet: ClassifierSet = {
  name: "tone",
  version: "v1",
  classifiers: {
    tone: {
      type: "choice",
      instructions: "Choose.",
      criteria: { calm: "calm", urgent: "urgent" },
    },
  },
};
const response = (answers: object) =>
  new Response(
    JSON.stringify({
      model: "jev-served",
      answers,
      usage: { input_tokens: 12, output_tokens: 4 },
    }),
  );
const plan = (set: ClassifierSet) =>
  buildJevBatchPlan({
    sharedState: {},
    records: [{ key: "r", content: "c" }],
    classifierSet: set,
    limits: config,
  });

describe("Jev provider contract", () => {
  it("rejects an unsupported question type before planning", () => {
    const malformed = {
      name: "unknown",
      version: "v1",
      classifiers: { verdict: { type: "other", instructions: "Judge." } },
    } as unknown as ClassifierSet;
    expect(() => plan(malformed)).toThrow("invalid type");
  });

  it("rejects omitted usage", async () => {
    await expect(
      askJev(
        config,
        {},
        { relevance: { type: "noul", instructions: "Judge." } },
        async () =>
          new Response(
            JSON.stringify({
              model: "jev-served",
              answers: { relevance: { type: "noul", noul: 0.5 } },
            }),
          ),
      ),
    ).rejects.toThrow();
  });

  it.each([
    { choice: "calm", probabilities: { calm: 1 }, confidence: 0.9 },
    { choice: "other", probabilities: { calm: 0.5, urgent: 0.5 }, confidence: 0.5 },
    { choice: "calm", probabilities: { calm: 1.1, urgent: -0.1 }, confidence: 0.5 },
  ])("rejects malformed Choice metadata", async (answer) => {
    await expect(
      executeJevBatchPlan(config, plan(choiceSet), async () =>
        response({ r0_c0: { type: "choice", ...answer } }),
      ),
    ).rejects.toThrow();
  });

  it("rejects a Choice that is not among the highest probabilities", async () => {
    await expect(
      executeJevBatchPlan(config, plan(choiceSet), async () =>
        response({
          r0_c0: {
            type: "choice",
            choice: "calm",
            probabilities: { calm: 0.2, urgent: 0.8 },
            confidence: 0.6,
          },
        }),
      ),
    ).rejects.toThrow("invalid classifier answer");
  });

  it("preflights invalid Score criteria before HTTP", () => {
    const malformed = {
      name: "score",
      version: "v1",
      classifiers: {
        quality: { type: "score", instructions: "Score.", criteria: ["only"] },
      },
    } as unknown as ClassifierSet;
    expect(() => plan(malformed)).toThrow("Score");
  });

  it("preserves Score metadata, provider extras, and usage", async () => {
    const scoreSet: ClassifierSet = {
      name: "quality",
      version: "v1",
      classifiers: {
        quality: {
          type: "score",
          instructions: "Score.",
          criteria: ["poor", "good", "excellent"],
        },
      },
    };
    const answer = {
      type: "score",
      score: 1.7,
      legend: { "0": "poor", "1": "good", "2": "excellent" },
      probabilities: { "0": 0.1, "1": 0.1, "2": 0.8 },
      confidence: 0.82,
      provider_detail: "retained",
    };
    const result = await executeJevBatchPlan(config, plan(scoreSet), async () =>
      response({ r0_c0: answer }),
    );
    expect(result.answers.get("r")?.quality).toMatchObject(answer);
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 4 });
  });
});

describe("Jev Choice probability-sum tolerance", () => {
  const rounded = {
    type: "choice",
    choice: "urgent",
    probabilities: { calm: 0.37, urgent: 0.62 },
    confidence: 0.62,
  };

  it("accepts a Choice whose 2-decimal probabilities sum to 0.99", async () => {
    await expect(
      executeJevBatchPlan(config, plan(choiceSet), async () =>
        response({ r0_c0: rounded }),
      ),
    ).resolves.toBeDefined();
  });

  it("rejects a Choice whose probabilities sum to 0.95", async () => {
    await expect(
      executeJevBatchPlan(config, plan(choiceSet), async () =>
        response({
          r0_c0: {
            type: "choice",
            choice: "urgent",
            probabilities: { calm: 0.35, urgent: 0.6 },
            confidence: 0.6,
          },
        }),
      ),
    ).rejects.toThrow("invalid classifier answer");
  });

  it("names the question id and probabilities in the rejection message", async () => {
    await expect(
      executeJevBatchPlan(config, plan(choiceSet), async () =>
        response({
          r0_c0: {
            type: "choice",
            choice: "urgent",
            probabilities: { calm: 0.35, urgent: 0.6 },
            confidence: 0.6,
          },
        }),
      ),
    ).rejects.toThrow(/r0_c0.*choice.*0\.35/s);
  });
});
