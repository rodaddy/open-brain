import { describe, expect, it, vi } from "vitest";
import { enqueueDreamRemIfEligible } from "./maintenance-sweep.ts";
import type { RemProducerConfig } from "../config/maintenance.ts";

const enabled: RemProducerConfig = {
  enabled: true,
  backlogHighWater: 10,
  maxRequestsPerMinute: 3,
  minHeadroomBytes: 1_000,
  forcedSliceSize: 25,
  minGapMs: 0,
};

function signals(
  overrides: Partial<Parameters<typeof enqueueDreamRemIfEligible>[0]["signals"]> = {},
) {
  return {
    nowMs: 10_000,
    schedulerStartedAtMs: 9_000,
    lastRemCompletedAtMs: 9_500,
    requestsPerMinute: 2,
    headroomBytes: 2_000,
    lightBacklog: 0,
    ...overrides,
  };
}

describe("REM producer eligibility", () => {
  it("preserves Light-only behavior while REM is disabled", async () => {
    const enqueue = vi.fn();
    const result = await enqueueDreamRemIfEligible({
      config: { enabled: false },
      signals: signals(),
      queue: { enqueue },
    });
    expect(result).toEqual({ eligible: false, enqueued: false, reason: "disabled" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("enqueues one bounded global REM slice when low request rate is eligible", async () => {
    const enqueue = vi.fn().mockResolvedValue({ enqueueOutcome: "inserted" });
    const result = await enqueueDreamRemIfEligible({
      config: enabled,
      signals: signals(),
      queue: { enqueue },
    });
    expect(result).toEqual({ eligible: true, enqueued: true, reason: "low_rate" });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith({
      kind: "dream.rem",
      version: 1,
      payload: { batch_size: 25 },
      idempotencyKey: "dream.rem:auto:9500",
    });
  });

  it("fails closed on missing or invalid measurements", async () => {
    for (const invalid of [
      { requestsPerMinute: Number.NaN },
      { headroomBytes: -1 },
      { lightBacklog: Number.NaN },
      { nowMs: Number.NaN },
    ]) {
      const enqueue = vi.fn();
      const result = await enqueueDreamRemIfEligible({
        config: enabled,
        signals: signals(invalid),
        queue: { enqueue },
      });
      expect(result.reason).toBe("invalid_signals");
      expect(enqueue).not.toHaveBeenCalled();
    }
  });

  it("rejects a slice larger than the REM stage's existing bound", async () => {
    const enqueue = vi.fn();
    const result = await enqueueDreamRemIfEligible({
      config: { ...enabled, forcedSliceSize: 301 },
      signals: signals(),
      queue: { enqueue },
    });
    expect(result.reason).toBe("invalid_config");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("deduplicates repeated eligibility on the last completion identity", async () => {
    const enqueue = vi.fn().mockResolvedValue({ enqueueOutcome: "deduped" });
    const result = await enqueueDreamRemIfEligible({
      config: enabled,
      signals: signals({ requestsPerMinute: 99, lightBacklog: 10 }),
      queue: { enqueue },
    });
    expect(result).toEqual({ eligible: true, enqueued: false, reason: "backlog" });
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("holds REM in cooldown inside the minimum gap and enqueues nothing", async () => {
    const enqueue = vi.fn();
    const result = await enqueueDreamRemIfEligible({
      config: { ...enabled, minGapMs: 501 },
      signals: signals(),
      queue: { enqueue },
    });
    expect(result).toEqual({ eligible: false, enqueued: false, reason: "cooldown" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("proceeds at exactly the minimum gap", async () => {
    const enqueue = vi.fn().mockResolvedValue({ enqueueOutcome: "inserted" });
    const result = await enqueueDreamRemIfEligible({
      config: { ...enabled, minGapMs: 500 },
      signals: signals(),
      queue: { enqueue },
    });
    expect(result.reason).toBe("low_rate");
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("applies no gap before the first REM completion", async () => {
    const enqueue = vi.fn().mockResolvedValue({ enqueueOutcome: "inserted" });
    const result = await enqueueDreamRemIfEligible({
      config: { ...enabled, minGapMs: 900_000 },
      signals: signals({ lastRemCompletedAtMs: null }),
      queue: { enqueue },
    });
    expect(result.reason).toBe("low_rate");
    expect(enqueue).toHaveBeenCalledOnce();
  });
});
