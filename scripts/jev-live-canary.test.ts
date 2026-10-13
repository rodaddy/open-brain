import { describe, expect, it } from "vitest";
import {
  createCanaryLogger,
  evaluateOutgoingCanary,
  type ProviderCallReceipt,
} from "./jev-live-canary.ts";

function call(questionCount: number): ProviderCallReceipt {
  return {
    status: 200,
    requestBytes: 100,
    questionCount,
    responseAnswerCount: questionCount,
    model: "jev-1.13.0",
    inputTokens: 10,
    outputTokens: 2,
  };
}

describe("Jev live canary outgoing acceptance", () => {
  it("accepts a full evaluated pool larger than the returned page", () => {
    expect(evaluateOutgoingCanary([call(15)], 0)).toEqual({
      validMapping: true,
      evaluatedCandidateCount: 15,
    });
  });

  it("validates every provider batch in a split full pool", () => {
    expect(evaluateOutgoingCanary([call(9), call(6)], 0)).toEqual({
      validMapping: true,
      evaluatedCandidateCount: 15,
    });
  });

  it("fails when the real reranker fallback event fires despite matching counts", () => {
    const observer = createCanaryLogger();
    observer.logger.warn({ candidate_count: 8 }, "jev_rerank_failed_fallback_rrf");
    expect(evaluateOutgoingCanary([call(8)], observer.fallbackCount())).toEqual({
      validMapping: false,
      evaluatedCandidateCount: 8,
    });
  });
});
