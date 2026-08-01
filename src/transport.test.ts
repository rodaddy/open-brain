import { describe, it, expect } from "bun:test";
import { __testing } from "./transport.ts";

/**
 * F1 regression (Sol cross-family review): the idle session TTL bounds the gap
 * BETWEEN calls, not the duration of one call. When the TTL dropped from 30
 * minutes to 30 seconds, a single tool call that runs longer than the TTL (a
 * large decompose, a batch of embeddings) began to trip the inactivity timer
 * mid-flight, which closed the transport out from under the executing request.
 * These prove the in-flight guard: the timer may fire during a request, but it
 * must not close the session until the request has settled.
 */
describe("transport session TTL does not expire an in-flight request", () => {
  it("keeps the session and its transport alive while a request runs past the TTL", async () => {
    const sessionId = "sess-inflight-1";
    // TTL far shorter than the work: the idle timer WILL fire mid-request.
    const result = await __testing.runSlowRequestUnderShortTtl({
      sessionId,
      ttlMs: 10,
      work: () => new Promise((resolve) => setTimeout(resolve, 60)),
    });

    // The timer fired at 10ms while the 60ms request was still running, but the
    // stub transport was never closed during the request: expiry deferred.
    expect(result.closedDuringRequest).toBe(false);
    // The session was still registered when the request returned -- it was not
    // deleted mid-flight.
    expect(result.existedAfterRequest).toBe(true);
  });

  it("does not close the transport even when the TTL is effectively zero", async () => {
    const sessionId = "sess-inflight-2";
    const result = await __testing.runSlowRequestUnderShortTtl({
      sessionId,
      ttlMs: 0,
      work: () => new Promise((resolve) => setTimeout(resolve, 40)),
    });
    expect(result.closedDuringRequest).toBe(false);
    expect(result.existedAfterRequest).toBe(true);
  });
});
