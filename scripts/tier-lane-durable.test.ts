import { describe, expect, test, afterEach } from "bun:test";
import { parseArgs, runLaneTiering } from "./tier-lane-durable.ts";

// The DB-driven loop of runLaneTiering is covered indirectly: it composes the
// same classifyLaneEvent / findDurableDuplicate / graduateLaneEvent functions
// exercised by src/tiering.test.ts and the live-Postgres block in
// src/tools/__tests__/tier-lane.test.ts. Here we cover the pieces that do not
// need a database: the kill switch and argument parsing.

describe("tier-lane-durable parseArgs", () => {
  test("defaults to dry-run with sane bounds", () => {
    const args = parseArgs([]);
    expect(args.apply).toBe(false);
    expect(args.batchSize).toBe(20);
    expect(args.maxApply).toBe(5);
    expect(args.dupThreshold).toBe(0.08);
    expect(args.minContentLength).toBe(24);
  });

  test("parses apply + tuning flags", () => {
    const args = parseArgs([
      "--apply",
      "--batch-size",
      "50",
      "--max-apply",
      "10",
      "--dup-threshold",
      "0.05",
      "--min-content-length",
      "40",
    ]);
    expect(args.apply).toBe(true);
    expect(args.batchSize).toBe(50);
    expect(args.maxApply).toBe(10);
    expect(args.dupThreshold).toBe(0.05);
    expect(args.minContentLength).toBe(40);
  });
});

describe("tier-lane-durable kill switch", () => {
  afterEach(() => {
    delete process.env.OPENBRAIN_PROMOTION_KILL_SWITCH;
  });

  test("runLaneTiering throws before touching the DB when the kill switch is set", async () => {
    process.env.OPENBRAIN_PROMOTION_KILL_SWITCH = "1";
    // Throws before createPool, so no DB connection is attempted.
    expect(runLaneTiering(parseArgs([]))).rejects.toThrow(
      "OPENBRAIN_PROMOTION_KILL_SWITCH is enabled",
    );
  });
});
