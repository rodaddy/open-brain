import { describe, expect, test } from "vitest";
import { evaluateDriveOutcome } from "./eval-langfuse-egress.ts";
import { check } from "./test-support/eval-langfuse-egress-test-support.ts";

describe("Langfuse egress verification", () => {
  test("drive outcome requires a successful exit and advanced observe watermark", () => {
    const receipt = evaluateDriveOutcome({
      tag: "run-tag",
      count: 3,
      exitCode: 0,
      stdout: "",
      stderr: "",
      observeOffset: 42,
    });

    expect(receipt.passed).toBe(true);
    expect(receipt.observed).toEqual({
      traces: 0,
      observations: 0,
      generations: 0,
    });
    expect(check(receipt, "capture_exit")).toMatchObject({
      passed: true,
      fatal: true,
      observed: 0,
      expected: 0,
    });
    expect(check(receipt, "emit_proven")).toMatchObject({
      passed: true,
      fatal: true,
      observed: 42,
      emit_failure_detected: false,
    });
  });

  test("drive outcome fails without watermark proof or on explicit emit failure", () => {
    const missingWatermark = evaluateDriveOutcome({
      tag: "run-tag",
      count: 1,
      exitCode: 0,
      stdout: "",
      stderr: "",
      observeOffset: 0,
    });
    const explicitFailure = evaluateDriveOutcome({
      tag: "run-tag",
      count: 1,
      exitCode: 0,
      stdout: "",
      stderr: "observation emit failed (network); turns left for retry",
      observeOffset: 9,
    });
    const captureFailure = evaluateDriveOutcome({
      tag: "run-tag",
      count: 1,
      exitCode: 7,
      stdout: "",
      stderr: "",
      observeOffset: 9,
    });

    expect(missingWatermark.passed).toBe(false);
    expect(check(missingWatermark, "emit_proven")).toMatchObject({
      passed: false,
      observed: 0,
      emit_failure_detected: false,
    });
    expect(explicitFailure.passed).toBe(false);
    expect(check(explicitFailure, "emit_proven")).toMatchObject({
      passed: false,
      observed: 9,
      emit_failure_detected: true,
    });
    expect(captureFailure.passed).toBe(false);
    expect(check(captureFailure, "capture_exit")).toMatchObject({
      passed: false,
      observed: 7,
      expected: 0,
    });
  });
});
