import { describe, expect, it } from "vitest";
import { buildJevBatchPlan, type ClassifierSet, type JevConfig } from "./jev.ts";

const enabled: JevConfig = {
  enabled: true,
  apiKey: "test-key",
  baseUrl: "https://api.typesafe.ai/v1/systemone",
  model: "jev-1.13.0",
  timeoutMs: 100,
  maxRequestBytes: 64_000,
  maxStateQuestionBytes: 32_000,
};

describe("Jev structured question contract", () => {
  const limits = enabled;
  function structuredSet(question: unknown): ClassifierSet {
    return {
      name: "structured",
      version: "v1",
      classifiers: { pick: question as ClassifierSet["classifiers"][string] },
    };
  }

  it("accepts structured instructions and structured Choice criteria and appends judge_only", () => {
    const criteria = {
      a: { what: "aa", not_for: "bb", examples: ["e1"] },
      none: { what: "nothing" },
    };
    const plan = buildJevBatchPlan({
      sharedState: {},
      records: [{ key: "r", content: "c" }],
      classifierSet: structuredSet({
        type: "choice",
        instructions: { question: "Which?", focus: "x" },
        criteria,
      }),
      limits,
    });
    const question = plan.batches[0]?.questions.r0_c0;
    expect(question?.instructions).toEqual({
      question: "Which?",
      focus: "x",
      judge_only: "record key r at records[0]",
    });
    expect(question?.criteria).toEqual(criteria);
  });

  it("rejects a structured instructions object with an empty value before HTTP", () => {
    expect(() =>
      buildJevBatchPlan({
        sharedState: {},
        records: [{ key: "r", content: "c" }],
        classifierSet: structuredSet({
          type: "choice",
          instructions: { question: "" },
          criteria: { a: null },
        }),
        limits,
      }),
    ).toThrow(/instructions/);
  });

  it("rejects a structured Choice criterion with a non-string value", () => {
    expect(() =>
      buildJevBatchPlan({
        sharedState: {},
        records: [{ key: "r", content: "c" }],
        classifierSet: structuredSet({
          type: "choice",
          instructions: "Which?",
          criteria: { a: { what: 42 } },
        }),
        limits,
      }),
    ).toThrow(/criteria/);
  });

  it("carries record fields into state unchanged", () => {
    const record = {
      key: "r",
      content: "c",
      fields: { operator_said: "go", anchor_kind: null },
    };
    const plan = buildJevBatchPlan({
      sharedState: {},
      records: [record],
      classifierSet: structuredSet({
        type: "choice",
        instructions: "Which?",
        criteria: { a: null },
      }),
      limits,
    });
    const records = plan.batches[0]?.state.records as { fields?: unknown }[];
    expect(records[0]?.fields).toEqual(record.fields);
  });
});
