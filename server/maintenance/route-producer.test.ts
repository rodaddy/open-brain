/** The dream.route producer decision (issue 1525), against a fake queue. */
import { describe, expect, test } from "vitest";
import type { RouteProducerConfig } from "../config/maintenance.ts";
import {
  enqueueDreamRouteIfEligible,
  type RouteEligibilitySignals,
} from "./route-producer.ts";

const ENABLED: RouteProducerConfig = {
  enabled: true,
  backend: "fake",
  sliceSize: 50,
  minGapMs: 1_000,
  maxUsdPerRun: 1,
};

interface Enqueued {
  kind: string;
  idempotencyKey: string;
  payload: unknown;
}

function fakeQueue(outcome: "inserted" | "deduped" = "inserted") {
  const calls: Enqueued[] = [];
  return {
    calls,
    queue: {
      enqueue: async (request: Enqueued) => {
        calls.push(request);
        return { enqueueOutcome: outcome } as never;
      },
    },
  };
}

function signals(over: Partial<RouteEligibilitySignals> = {}): RouteEligibilitySignals {
  return { nowMs: 10_000, lastRouteTerminalAtMs: null, hasUnrouted: true, ...over };
}

describe("enqueueDreamRouteIfEligible", () => {
  test("disabled config never enqueues", async () => {
    const q = fakeQueue();
    const result = await enqueueDreamRouteIfEligible({
      config: { enabled: false },
      signals: signals(),
      queue: q.queue,
    });
    expect(result).toEqual({ eligible: false, enqueued: false, reason: "disabled" });
    expect(q.calls).toHaveLength(0);
  });

  test.each([
    ["non-finite now", signals({ nowMs: Number.NaN })],
    ["negative now", signals({ nowMs: -1 })],
    ["terminal after now", signals({ lastRouteTerminalAtMs: 20_000 })],
  ])("invalid signals (%s) never enqueue", async (_label, s) => {
    const q = fakeQueue();
    const result = await enqueueDreamRouteIfEligible({
      config: ENABLED,
      signals: s,
      queue: q.queue,
    });
    expect(result.reason).toBe("invalid_signals");
    expect(q.calls).toHaveLength(0);
  });

  test("inside the gap is cooldown", async () => {
    const q = fakeQueue();
    const result = await enqueueDreamRouteIfEligible({
      config: ENABLED,
      signals: signals({ lastRouteTerminalAtMs: 9_500 }),
      queue: q.queue,
    });
    expect(result).toEqual({ eligible: false, enqueued: false, reason: "cooldown" });
    expect(q.calls).toHaveLength(0);
  });

  test("nothing unrouted does not enqueue", async () => {
    const q = fakeQueue();
    const result = await enqueueDreamRouteIfEligible({
      config: ENABLED,
      signals: signals({ hasUnrouted: false }),
      queue: q.queue,
    });
    expect(result.reason).toBe("nothing_unrouted");
    expect(q.calls).toHaveLength(0);
  });

  test("first run is due and keyed to the first window", async () => {
    const q = fakeQueue();
    const result = await enqueueDreamRouteIfEligible({
      config: ENABLED,
      signals: signals(),
      queue: q.queue,
    });
    expect(result).toEqual({ eligible: true, enqueued: true, reason: "due" });
    expect(q.calls[0]?.kind).toBe("dream.route");
    expect(q.calls[0]?.idempotencyKey).toBe("dream.route:auto:first");
    expect(q.calls[0]?.payload).toEqual({ batch_size: 50 });
  });

  test("a gap exactly equal to minGapMs enqueues", async () => {
    const q = fakeQueue();
    const result = await enqueueDreamRouteIfEligible({
      config: ENABLED,
      signals: signals({ lastRouteTerminalAtMs: 9_000 }),
      queue: q.queue,
    });
    expect(result.reason).toBe("due");
    expect(q.calls[0]?.idempotencyKey).toBe("dream.route:auto:9000");
  });

  test("a deduped enqueue reports enqueued false", async () => {
    const q = fakeQueue("deduped");
    const result = await enqueueDreamRouteIfEligible({
      config: ENABLED,
      signals: signals(),
      queue: q.queue,
    });
    expect(result).toEqual({ eligible: true, enqueued: false, reason: "due" });
  });
});
