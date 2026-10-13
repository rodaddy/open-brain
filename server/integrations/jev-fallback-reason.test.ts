import { describe, expect, it, vi } from "vitest";
import { rerankWithJev, type JevConfig, type JevFailureDescriptor } from "./jev.ts";

const config: JevConfig = {
  enabled: true,
  apiKey: "test-key",
  baseUrl: "https://api.typesafe.ai/v1/systemone",
  model: "jev-1.13.0",
  timeoutMs: 100,
  maxRequestBytes: 64_000,
  maxStateQuestionBytes: 32_000,
};

const ROWS = [
  { id: "thoughts:a", content: "a" },
  { id: "sessions:b", content: "b" },
];
const usage = { input_tokens: 1, output_tokens: 1 };

async function failureFor(
  fetchFn: typeof fetch,
  overrides: Partial<JevConfig> = {},
  rows: readonly { id: string; content: string }[] = ROWS,
): Promise<JevFailureDescriptor | undefined> {
  const onFailure = vi.fn();
  const result = await rerankWithJev({ ...config, ...overrides }, "q", rows, {
    fetchFn,
    onFailure,
  });
  expect(result).toEqual(rows);
  expect(onFailure).toHaveBeenCalledTimes(1);
  return onFailure.mock.calls[0]?.[0];
}

function named(name: string): Error {
  const error = new Error("boom");
  error.name = name;
  return error;
}

describe("rerankWithJev failure descriptor (issue 1461)", () => {
  it("reports a timeout", async () => {
    const fetchFn = vi.fn(async () => {
      throw named("TimeoutError");
    });
    expect(await failureFor(fetchFn)).toEqual({ reason: "timeout", status: null });
  });

  it("reports a network failure", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await failureFor(fetchFn)).toEqual({ reason: "network", status: null });
  });

  it("reports an HTTP status without the body", async () => {
    const fetchFn = vi.fn(
      async () => new Response("secret body text", { status: 429 }),
    );
    const failure = await failureFor(fetchFn);
    expect(failure).toEqual({ reason: "http", status: 429 });
    expect(JSON.stringify(failure)).not.toContain("secret body text");
  });

  it("reports a size refusal without calling the provider", async () => {
    const fetchFn = vi.fn();
    const failure = await failureFor(fetchFn, { maxRequestBytes: 10 });
    expect(failure).toEqual({ reason: "size", status: null });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reports invalid JSON, schema, and incomplete answers as invalid_answer", async () => {
    const bodies = [
      "not json",
      JSON.stringify({ nope: true }),
      JSON.stringify({
        model: "m",
        answers: { r0_c0: { type: "noul", noul: 0.5 } },
        usage,
      }),
    ];
    for (const body of bodies) {
      const fetchFn = vi.fn(async () => new Response(body, { status: 200 }));
      expect(await failureFor(fetchFn)).toEqual({
        reason: "invalid_answer",
        status: null,
      });
    }
  });

  it("reports anything unclassified as other", async () => {
    const fetchFn = vi.fn();
    const failure = await failureFor(fetchFn, {}, [ROWS[0], ROWS[0]] as typeof ROWS);
    expect(failure).toEqual({ reason: "other", status: null });
  });
});
