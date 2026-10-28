import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_JEV_MAX_REQUEST_BYTES,
  DEFAULT_JEV_MAX_STATE_QUESTION_BYTES,
  DEFAULT_JEV_MODEL,
  rerankWithJev,
  type JevConfig,
} from "./jev.ts";

const usage = { input_tokens: 12, output_tokens: 4 };

function response(body: unknown): Response {
  return new Response(JSON.stringify({ ...(body as object), usage }), { status: 200 });
}

const config: JevConfig = {
  enabled: true,
  apiKey: "k",
  baseUrl: "https://api.typesafe.ai/v1/systemone",
  model: DEFAULT_JEV_MODEL,
  timeoutMs: 1000,
  maxRequestBytes: DEFAULT_JEV_MAX_REQUEST_BYTES,
  maxStateQuestionBytes: DEFAULT_JEV_MAX_STATE_QUESTION_BYTES,
};

const CANDIDATES = [
  { id: "big", content: "x".repeat(62_000) },
  { id: "small", content: "short" },
];

describe("Jev default request size", () => {
  it("plans a request for a 62 KB record under the default values", async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("expected JSON request body");
      const body = JSON.parse(init.body);
      const answers: Record<string, { type: "noul"; noul: number }> = {};
      for (const key of Object.keys(body.questions)) {
        answers[key] = {
          type: "noul",
          noul: body.questions[key].instructions.includes("big") ? 0.9 : 0.1,
        };
      }
      return response({ model: DEFAULT_JEV_MODEL, answers });
    });

    const result = await rerankWithJev(config, "q", CANDIDATES, { fetchFn });

    expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(result.map(({ id }) => id)).toEqual(["big", "small"]);
  });

  it("default values follow the documented token figures at 3 bytes per token", () => {
    expect(DEFAULT_JEV_MAX_REQUEST_BYTES).toBe(192_000);
    expect(DEFAULT_JEV_MAX_STATE_QUESTION_BYTES).toBe(96_000);
  });
});
