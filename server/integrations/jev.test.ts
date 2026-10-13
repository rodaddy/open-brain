import { describe, expect, it, vi } from "vitest";
import {
  askJev,
  buildJevBatchPlan,
  executeJevBatchPlan,
  JevBatchTooLargeError,
  RELEVANCE_CLASSIFIER_SET,
  rerankWithJev,
  type ClassifierSet,
  type JevConfig,
} from "./jev.ts";

const enabled: JevConfig = {
  enabled: true,
  apiKey: "test-key",
  baseUrl: "https://api.typesafe.ai/v1/systemone",
  model: "jev-1.13.0",
  timeoutMs: 100,
  maxRequestBytes: 64_000,
  maxStateQuestionBytes: 32_000,
};

function response(body: unknown): Response {
  return new Response(JSON.stringify({ ...(body as object), usage }), { status: 200 });
}

const usage = { input_tokens: 12, output_tokens: 4 };

function choiceAnswer(choice: string, choices: readonly string[]) {
  return {
    type: "choice" as const,
    choice,
    probabilities: Object.fromEntries(
      choices.map((candidate) => [candidate, candidate === choice ? 1 : 0]),
    ),
    confidence: 1,
  };
}

function noulAnswers(ids: string[]): Record<string, { type: "noul"; noul: number }> {
  return Object.fromEntries(
    ids.map((id) => [id, { type: "noul" as const, noul: 0.8 }]),
  );
}

function choiceAnswers(ids: string[]): Record<string, ReturnType<typeof choiceAnswer>> {
  return Object.fromEntries(
    ids.map((id) => [id, choiceAnswer("calm", ["calm", "urgent"])]),
  );
}

function plannedKeys(plan: ReturnType<typeof buildJevBatchPlan>): string[][] {
  return plan.batches.map((batch) => batch.records.map(({ key }) => key));
}

describe("Jev HTTP boundary", () => {
  it("sends the pinned model and meaningful question contract", async () => {
    const fetchFn = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      response({
        model: "jev-1.13.0",
        answers: { relevance: { type: "noul", noul: 0.8 } },
      }),
    );
    await askJev(
      enabled,
      { question: "q" },
      {
        label: {
          type: "choice",
          instructions: "Choose a label",
          criteria: { DECISION: "a choice", QUESTION: "a question" },
        },
      },
      fetchFn,
    );
    const init = fetchFn.mock.calls[0]?.[1] as RequestInit;
    expect(typeof init.body).toBe("string");
    expect(JSON.parse(init.body as string)).toEqual({
      state: { question: "q" },
      model: "jev-1.13.0",
      questions: {
        label: {
          type: "choice",
          instructions: "Choose a label",
          criteria: { DECISION: "a choice", QUESTION: "a question" },
        },
      },
    });
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer test-key",
    );
  });

  it("rejects an out-of-range Noul response", async () => {
    await expect(
      askJev(
        enabled,
        {},
        { relevance: { type: "noul", instructions: "Judge relevance" } },
        async () =>
          response({
            model: "jev-1.13.0",
            answers: { relevance: { type: "noul", noul: 2 } },
          }),
      ),
    ).rejects.toThrow();
  });

  it("rejects a non-HTTPS endpoint before fetch", async () => {
    const fetchFn = vi.fn();
    await expect(
      askJev(
        { ...enabled, baseUrl: "http://example.test/systemone" },
        {},
        { relevance: { type: "noul", instructions: "Judge relevance" } },
        fetchFn,
      ),
    ).rejects.toThrow("HTTPS");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

const RERANK_ROWS = [
  { id: "thoughts:a", content: "a" },
  { id: "sessions:b", content: "b" },
];

describe("Jev reranking", () => {
  it("forwards the optional batch observer", async () => {
    const observeBatch = vi.fn(async (_batch, work) => work());
    const fetchFn = vi.fn(async () =>
      response({
        model: "jev-served",
        answers: {
          r0_c0: { type: "noul", noul: 0.1 },
          r1_c0: { type: "noul", noul: 0.9 },
        },
      }),
    );

    const result = await rerankWithJev(enabled, "q", RERANK_ROWS, {
      fetchFn,
      observeBatch,
    });

    expect(observeBatch).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result).toEqual([RERANK_ROWS[1], RERANK_ROWS[0]]);
  });

  it("does no network work while disabled", async () => {
    const fetchFn = vi.fn();
    expect(
      await rerankWithJev({ ...enabled, enabled: false }, "q", RERANK_ROWS, {
        fetchFn,
      }),
    ).toEqual(RERANK_ROWS);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reranks successful answers and keeps original objects", async () => {
    const expectedCandidates = RERANK_ROWS.map(({ id: key, content }) => ({
      key,
      content,
    }));
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("expected JSON request body");
      const body = JSON.parse(init.body);
      expect(body.state).toMatchObject({
        query: "q",
        records: expectedCandidates,
        classifier_set: {
          name: "retrieval-relevance",
          version: "direct-answer-relevance-v1",
        },
      });
      expect(body.questions.r0_c0.instructions).toContain("thoughts:a");
      expect(body.questions.r1_c0.instructions).toContain("sessions:b");
      return response({
        model: "jev-1.13.0",
        answers: {
          r0_c0: { type: "noul", noul: 0.1 },
          r1_c0: { type: "noul", noul: 0.9 },
        },
      });
    });
    const result = await rerankWithJev(enabled, "q", RERANK_ROWS, { fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result).toEqual([RERANK_ROWS[1], RERANK_ROWS[0]]);
    expect(result[0]).toBe(RERANK_ROWS[1]);
  });

  it("falls back to the complete stable input when any answer is invalid", async () => {
    const fetchFn = vi.fn(async () =>
      response({
        model: "jev-1.13.0",
        answers: { r0_c0: { type: "noul", noul: 0.5 } },
      }),
    );
    expect(await rerankWithJev(enabled, "q", RERANK_ROWS, { fetchFn })).toEqual(
      RERANK_ROWS,
    );
  });
});

describe("Jev reranking fallback", () => {
  it("falls back to the complete stable input when a later packed batch is invalid", async () => {
    const three = [...RERANK_ROWS, { id: "events:c", content: "c" }];
    const single = buildJevBatchPlan({
      sharedState: { query: "q" },
      records: three.slice(0, 1).map(({ id: key, content }) => ({ key, content })),
      classifierSet: RELEVANCE_CLASSIFIER_SET,
      limits: enabled,
    });
    const ceiling = single.batches[0]?.estimatedRequestBytes;
    if (!ceiling) throw new Error("expected one-record estimate");
    let call = 0;
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      call++;
      if (typeof init?.body !== "string") throw new Error("expected JSON body");
      const ids = Object.keys(JSON.parse(init.body).questions);
      const answers = call === 1 ? noulAnswers(ids) : {};
      return response({ model: "jev-1.13.0", answers });
    });
    const result = await rerankWithJev(
      { ...enabled, maxRequestBytes: ceiling },
      "q",
      three,
      { fetchFn },
    );
    expect(fetchFn.mock.calls.length).toBeGreaterThan(1);
    expect(result).toEqual(three);
  });

  it("makes no HTTP request when a later record cannot fit any complete batch", async () => {
    const candidates = [
      { id: "fits", content: "small" },
      { id: "oversized", content: "🧠".repeat(500) },
    ];
    const one = buildJevBatchPlan({
      sharedState: { query: "q" },
      records: [{ key: "fits", content: "small" }],
      classifierSet: RELEVANCE_CLASSIFIER_SET,
      limits: enabled,
    });
    const first = one.batches[0];
    if (!first) throw new Error("expected one batch");
    const fetchFn = vi.fn();
    const result = await rerankWithJev(
      {
        ...enabled,
        maxRequestBytes: first.estimatedRequestBytes + 10,
        maxStateQuestionBytes: first.estimatedStateQuestionBytes + 10,
      },
      "q",
      candidates,
      { fetchFn },
    );
    expect(fetchFn).not.toHaveBeenCalled();
    expect(result).toEqual(candidates);
  });
});

const THIRD_SET: ClassifierSet = {
  name: "sentiment",
  version: "v1",
  classifiers: {
    tone: {
      type: "choice",
      instructions: "Classify tone.",
      criteria: { calm: "calm", urgent: "urgent" },
    },
  },
};

describe("reusable Jev classifier execution", () => {
  it("executes a third classifier set without executor changes", async () => {
    const plan = buildJevBatchPlan({
      sharedState: { source: "test" },
      records: [{ key: "r1", content: "please hurry" }],
      classifierSet: THIRD_SET,
      limits: enabled,
    });
    const fetchFn = vi.fn(async () =>
      response({
        model: "jev-served",
        answers: { r0_c0: choiceAnswer("urgent", ["calm", "urgent"]) },
      }),
    );
    const result = await executeJevBatchPlan(enabled, plan, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result.answers.get("r1")?.tone).toMatchObject({
      type: "choice",
      choice: "urgent",
    });
  });

  it("packs 30 records and 30 questions into one request when the byte estimate fits", () => {
    const records = Array.from({ length: 30 }, (_, index) => ({
      key: `r${index}`,
      content: `content ${index}`,
    }));
    const plan = buildJevBatchPlan({
      sharedState: { query: "q" },
      records,
      classifierSet: THIRD_SET,
      limits: enabled,
    });
    expect(plan.batches).toHaveLength(1);
    expect(Object.keys(plan.batches[0]?.questions ?? {})).toHaveLength(30);
  });

  it("executes 30 fitted records in one request with all results mapped", async () => {
    const records = Array.from({ length: 30 }, (_, index) => ({
      key: `r${index}`,
      content: `content ${index}`,
    }));
    const plan = buildJevBatchPlan({
      sharedState: { query: "q" },
      records,
      classifierSet: THIRD_SET,
      limits: enabled,
    });
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("expected JSON body");
      const ids = Object.keys(JSON.parse(init.body).questions);
      return response({ model: "jev-served", answers: choiceAnswers(ids) });
    });
    const result = await executeJevBatchPlan(enabled, plan, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result.answers.size).toBe(30);
    expect(
      records.every(({ key }) => result.answers.get(key)?.tone?.type === "choice"),
    ).toBe(true);
  });
});

describe("reusable Jev classifier byte ceilings", () => {
  it("splits deterministically at total and state-plus-longest byte ceilings", () => {
    const records = [
      { key: "a", content: "x".repeat(80) },
      { key: "b", content: "y".repeat(80) },
    ];
    const one = buildJevBatchPlan({
      sharedState: { query: "q" },
      records: records.slice(0, 1),
      classifierSet: THIRD_SET,
      limits: enabled,
    });
    const first = one.batches[0];
    if (!first) throw new Error("expected one batch");
    const totalSplit = buildJevBatchPlan({
      sharedState: { query: "q" },
      records,
      classifierSet: THIRD_SET,
      limits: {
        ...enabled,
        maxRequestBytes: first.estimatedRequestBytes,
        maxStateQuestionBytes: 32_000,
      },
    });
    const longestSplit = buildJevBatchPlan({
      sharedState: { query: "q" },
      records,
      classifierSet: THIRD_SET,
      limits: {
        ...enabled,
        maxRequestBytes: 64_000,
        maxStateQuestionBytes: first.estimatedStateQuestionBytes,
      },
    });
    expect(plannedKeys(totalSplit)).toEqual([["a"], ["b"]]);
    expect(plannedKeys(longestSplit)).toEqual([["a"], ["b"]]);
  });

  it("counts serialized UTF-8 bytes including Unicode and escaping", () => {
    const plan = buildJevBatchPlan({
      sharedState: { context: '雪"\\\n' },
      records: [{ key: "unicode", content: '🧠"\\\n' }],
      classifierSet: THIRD_SET,
      limits: enabled,
    });
    const batch = plan.batches[0];
    if (!batch) throw new Error("expected one batch");
    const exact = new TextEncoder().encode(
      JSON.stringify({
        state: batch.state,
        model: enabled.model,
        questions: batch.questions,
      }),
    ).byteLength;
    expect(batch.estimatedRequestBytes).toBe(exact);
  });

  it("rejects an oversized Unicode record before HTTP", () => {
    const limits = { ...enabled, maxRequestBytes: 120, maxStateQuestionBytes: 100 };
    expect(() =>
      buildJevBatchPlan({
        sharedState: { query: "雪" },
        records: [{ key: "unicode", content: "🧠".repeat(100) }],
        classifierSet: THIRD_SET,
        limits,
      }),
    ).toThrow(JevBatchTooLargeError);
  });

  it("rejects oversized shared state before HTTP", () => {
    const limits = { ...enabled, maxRequestBytes: 400, maxStateQuestionBytes: 300 };
    expect(() =>
      buildJevBatchPlan({
        sharedState: { context: "shared".repeat(100) },
        records: [{ key: "r", content: "small" }],
        classifierSet: THIRD_SET,
        limits,
      }),
    ).toThrow(JevBatchTooLargeError);
  });
});

describe("reusable Jev classifier validation", () => {
  it("rejects duplicate record keys before planning", () => {
    expect(() =>
      buildJevBatchPlan({
        sharedState: {},
        records: [
          { key: "same", content: "a" },
          { key: "same", content: "b" },
        ],
        classifierSet: THIRD_SET,
        limits: enabled,
      }),
    ).toThrow("duplicate");
  });

  it("rejects a malformed Choice definition before HTTP", () => {
    const fetchFn = vi.fn();
    const malformed = {
      name: "bad",
      version: "v1",
      classifiers: { verdict: { type: "choice", instructions: "Choose." } },
    } as unknown as ClassifierSet;
    expect(() =>
      buildJevBatchPlan({
        sharedState: {},
        records: [{ key: "r", content: "c" }],
        classifierSet: malformed,
        limits: enabled,
      }),
    ).toThrow("criteria");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("maps arbitrary classifier names without mutating result prototypes", async () => {
    const classifierSet: ClassifierSet = {
      name: "arbitrary-name",
      version: "v1",
      classifiers: Object.fromEntries([
        ["__proto__", { type: "noul", instructions: "Classify safely." }],
      ]),
    };
    const plan = buildJevBatchPlan({
      sharedState: {},
      records: [{ key: "r", content: "content" }],
      classifierSet,
      limits: enabled,
    });
    const result = await executeJevBatchPlan(enabled, plan, async () =>
      response({
        model: "jev-served",
        answers: { r0_c0: { type: "noul", noul: 0.4 } },
      }),
    );
    const answers = result.answers.get("r");
    expect(Object.getPrototypeOf(answers)).toBeNull();
    expect(answers?.["__proto__"]).toMatchObject({ type: "noul", noul: 0.4 });
  });
});

describe("Noul classifier criteria", () => {
  it("preserves optional true/false criteria through a batched request", async () => {
    const classifierSet: ClassifierSet = {
      name: "approval",
      version: "v1",
      classifiers: {
        approved: {
          type: "noul",
          instructions: "Is this approved?",
          criteria: { true: "explicitly approved", false: "not approved" },
        },
      },
    };
    const plan = buildJevBatchPlan({
      sharedState: {},
      records: [{ key: "r", content: "approved" }],
      classifierSet,
      limits: enabled,
    });
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("expected JSON body");
      expect(JSON.parse(init.body).questions.r0_c0.criteria).toEqual({
        true: "explicitly approved",
        false: "not approved",
      });
      return response({
        model: "jev-served",
        answers: { r0_c0: { type: "noul", noul: 0.9 } },
      });
    });
    const result = await executeJevBatchPlan(enabled, plan, fetchFn);
    expect(result.answers.get("r")?.approved).toMatchObject({
      type: "noul",
      noul: 0.9,
    });
  });
});
