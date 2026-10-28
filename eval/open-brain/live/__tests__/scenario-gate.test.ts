import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { expectDefined } from "../../../../scripts/test-support/expect-defined.ts";
import {
  loadScenarioFixture,
  parseScenarioFixture,
  ScenarioFixtureScopeKeyError,
} from "../scenario-fixtures.ts";
import { runScenarioGate } from "../scenario-gate.ts";
import type { ScenarioFixture, ScenarioTransport } from "../scenario-types.ts";
import { FIXTURE, fakeTransport } from "./scenario-gate-test-support.ts";

function run(transport: ScenarioTransport, fixture: ScenarioFixture = FIXTURE) {
  return runScenarioGate({
    fixture,
    namespace: "eval-live-recall-scenario-test",
    transport,
    commit: "testcommit",
    generatedAt: "2026-08-05T00:00:00.000Z",
    runId: "scenario-test-run",
  });
}

function expectContentFree(receipt: unknown): void {
  const json = JSON.stringify(receipt);
  expect(json).not.toContain("capture round-trip marker");
  expect(json).not.toContain("marlin telemetry cache marker");
  expect(json).not.toContain("checkpoint summary");
}

/** The nth scenario receipt, narrowed rather than asserted non-null. */
function scenarioAt(outcome: Awaited<ReturnType<typeof run>>, index: number) {
  return expectDefined(
    outcome.receipt.scenarios[index],
    `scenario receipt at index ${index}`,
  );
}

// --- fixture validation ----------------------------------------------------

function testLoadsShippedFixture(): void {
  expect(FIXTURE.fixture_id).toBe("open-brain-scenarios-v1");
  expect(FIXTURE.scenarios.map((scenario) => scenario.kind)).toEqual([
    "capture_round_trip",
    "durable_memory_shape",
    "checkpoint_round_trip",
  ]);
}

function testRejectsDuplicateIds(): void {
  const first = expectDefined(FIXTURE.scenarios[0], "first fixture scenario");
  expect(() => parseScenarioFixture({ ...FIXTURE, scenarios: [first, first] })).toThrow(
    /duplicate scenario id/,
  );
}

async function testRejectsNonContractScopeKey(): Promise<void> {
  const path = join(
    dirname(fileURLToPath(import.meta.url)),
    "scenario-invalid-scope.fixture.json",
  );
  const error = await loadScenarioFixture(path).catch((caught) => caught);

  expect(error).toBeInstanceOf(ScenarioFixtureScopeKeyError);
  expect(error.message).toMatch(/non-contract scope key\(s\): bogus/);
}

describe("scenario fixture validation", () => {
  it("loads the shipped three-scenario fixture", testLoadsShippedFixture);
  it("rejects duplicate scenario ids", testRejectsDuplicateIds);
  it(
    "rejects a non-contract fixture scope key at load",
    testRejectsNonContractScopeKey,
  );
});

// --- runScenarioGate: green path -------------------------------------------

async function testGreenRunTearsDownExactRecords(): Promise<void> {
  const outcome = await run(fakeTransport());
  expect(outcome.receipt.failures).toEqual([]);
  expect(outcome.passed).toBe(true);
  expect(outcome.receipt.scenarios).toHaveLength(3);
  expect(outcome.receipt.scenarios.every((scenario) => scenario.passed)).toBe(true);
  expect(outcome.receipt.teardown).toEqual({
    attempted: 6,
    archived: 6,
    already_absent: 0,
    failed: 0,
    failure_labels: [],
  });
  // #671: a clean run observes residue and finds none — distinct from never
  // having looked, which the gate refuses to pass on.
  expect(outcome.receipt.teardown_residue.checked).toBe(true);
  expect(outcome.receipt.teardown_residue.rows).toBe(0);
  expect(outcome.receipt.diagnostics).toEqual([]);
  expectContentFree(outcome.receipt);
}

async function testStderrDiagnosticsOffPassingScenario(): Promise<void> {
  const outcome = await run(fakeTransport());
  expect(outcome.passed).toBe(true);
  for (const scenario of outcome.receipt.scenarios) {
    expect(scenario.error_class).toBeUndefined();
    expect(scenario.stderr_first_line).toBeUndefined();
  }
}

// --- runScenarioGate: capture failures --------------------------------------

async function testZeroWriteCaptureFailsOnReadBack(): Promise<void> {
  const outcome = await run(fakeTransport({ zeroWrite: true }));
  expect(outcome.passed).toBe(false);
  expect(outcome.receipt.failures).toContain(
    "capture-round-trip:capture_round_trip_missing",
  );
  const capture = scenarioAt(outcome, 0);
  expect(capture.checks.provider_exit_zero).toBe(true);
  expect(capture.checks.receipt_saved).toBe(true);
  expect(capture.checks.read_back_exact).toBe(false);
}

async function testStderrFirstLineReachesReceipt(): Promise<void> {
  // Issue #583: a dead provider used to present as a bare exit code, so the
  // real root cause had to be recovered by replaying the command by hand.
  const outcome = await run(
    fakeTransport({
      captureStderr: [
        "Traceback (most recent call last):",
        '  File "provider.py", line 12, in main',
        "PermissionError: scope key 'project' was rejected",
      ].join("\n"),
    }),
  );
  expect(outcome.passed).toBe(false);
  const capture = scenarioAt(outcome, 0);
  expect(capture.error_class).toBe("PermissionError");
  expect(capture.stderr_first_line).toBe(
    "PermissionError: scope key 'project' was rejected",
  );
  expect(outcome.receipt.failures.join(" ")).toContain(
    "capture-round-trip:scenario_transport_error",
  );
  expectContentFree(outcome.receipt);
}

async function testEmptyProviderResultIsAbsentReceipt(): Promise<void> {
  const outcome = await run(fakeTransport({ emptyProviderOutput: true }));
  expect(outcome.passed).toBe(false);
  expect(outcome.receipt.failures).toContain(
    "capture-round-trip:capture_receipt_absent",
  );
  expect(outcome.receipt.failures).not.toContain(
    "capture-round-trip:scenario_transport_error",
  );
  const capture = scenarioAt(outcome, 0);
  expect(capture.checks.provider_exit_zero).toBe(true);
  expect(capture.checks.receipt_saved).toBe(false);
  expect(capture.checks.read_back_exact).toBe(false);
}

async function testScopeProofLossIsIndependentOfExitCode(): Promise<void> {
  const outcome = await run(fakeTransport({ lostCapture: true }));
  expect(outcome.passed).toBe(false);
  expect(outcome.receipt.failures).toContain("capture-round-trip:capture_receipt_lost");
  expect(outcome.receipt.failures).toContain("capture-round-trip:capture_not_durable");
  expect(outcome.receipt.failures).not.toContain(
    "capture-round-trip:provider_exit_nonzero",
  );
  expect(scenarioAt(outcome, 0).checks.provider_exit_zero).toBe(true);
  expectContentFree(outcome.receipt);
}

// --- runScenarioGate: ignored request keys ----------------------------------

async function testIgnoredCheckpointKeyFails(): Promise<void> {
  const outcome = await run(fakeTransport({ ignoredKeys: ["summary", "kind"] }));
  expect(outcome.passed).toBe(false);
  expect(outcome.receipt.failures).toContain(
    "checkpoint-wrap-round-trip:provider_ignored_request_key:summary",
  );
  expect(outcome.receipt.failures).not.toContain(
    "checkpoint-wrap-round-trip:provider_ignored_request_key:kind",
  );
}

async function testIgnoredCaptureKeyFails(): Promise<void> {
  const outcome = await run(fakeTransport({ ignoredKeys: ["candidate_type"] }));
  expect(outcome.passed).toBe(false);
  expect(outcome.receipt.failures).toContain(
    "capture-round-trip:provider_ignored_request_key:candidate_type",
  );
}

// --- runScenarioGate: durable_memory pack shape -----------------------------

async function testItemCountMismatchFails(): Promise<void> {
  const outcome = await run(fakeTransport({ packItems: [], packItemCount: 5 }));
  expect(outcome.passed).toBe(false);
  expect(outcome.receipt.failures).toContain(
    "durable-memory-pack-shape:durable_memory_item_count_mismatch",
  );
  expect(outcome.receipt.failures).toContain(
    "durable-memory-pack-shape:durable_memory_items_missing",
  );
  const durable = scenarioAt(outcome, 1);
  expect(durable.checks.item_count).toBe(0);
  expect(durable.checks.reported_item_count).toBe(5);
}

async function testBudgetExceededFails(): Promise<void> {
  const outcome = await run(fakeTransport({ packCharLimit: 1 }));
  expect(outcome.passed).toBe(false);
  expect(outcome.receipt.failures).toContain(
    "durable-memory-pack-shape:durable_memory_budget_exceeded",
  );
}

async function testWriteRegisteredBeforePackThrows(): Promise<void> {
  const outcome = await run(fakeTransport({ packThrows: true }));
  expect(outcome.passed).toBe(false);
  expect(outcome.receipt.failures).toContain(
    "durable-memory-pack-shape:scenario_transport_error",
  );
  expect(outcome.receipt.teardown.attempted).toBe(6);
  expect(outcome.receipt.teardown.failed).toBe(0);
}

// --- runScenarioGate: teardown residue vs call failures (#671) --------------

async function testResidueFailsOtherwiseGreenBatch(): Promise<void> {
  const outcome = await run(fakeTransport({ residueRows: 2 }));
  expect(outcome.passed).toBe(false);
  expect(outcome.receipt.teardown_residue.rows).toBe(2);
  expect(outcome.receipt.failures).toContain("teardown_residue:rows=2;thoughts=2");
}

async function testThrownCleanupCallsAreDiagnosticsNotFailures(): Promise<void> {
  // The third credentialed #653 verify in miniature: calls threw, the database
  // came back clean, and the old gate exited 1 anyway.
  const outcome = await run(fakeTransport({ cleanupFails: 2 }));
  expect(outcome.passed).toBe(true);
  expect(outcome.receipt.teardown.failed).toBe(2);
  // The tally is REPORTED, so the operator still learns the calls failed...
  expect(outcome.receipt.diagnostics.join(" ")).toContain("teardown_call_failures:2");
  // ...by label, which the bare `catch {}` used to discard...
  expect(outcome.receipt.teardown.failure_labels).toEqual([
    "fake_cleanup:threw-0",
    "fake_cleanup:threw-1",
  ]);
  expect(outcome.receipt.diagnostics.join(" ")).toContain("fake_cleanup:threw-0");
  // ...and it is NOT in the verdict channel.
  expect(outcome.receipt.failures.join(" ")).not.toContain("teardown");
}

async function testUncheckedResidueRefusesToPass(): Promise<void> {
  const outcome = await run(fakeTransport({ residueUnchecked: true }));
  expect(outcome.passed).toBe(false);
  expect(outcome.receipt.failures.join(" ")).toContain("teardown_residue_unchecked");
}

describe("runScenarioGate", () => {
  it(
    "runs all scenarios through the fake transport and tears down exact records",
    testGreenRunTearsDownExactRecords,
  );
  it(
    "fails the exit-0 zero-write capture by reading it back",
    testZeroWriteCaptureFailsOnReadBack,
  );
  it(
    "carries a failing child's stderr first line into the scenario receipt",
    testStderrFirstLineReachesReceipt,
  );
  it(
    "leaves stderr diagnostics off a passing scenario",
    testStderrDiagnosticsOffPassingScenario,
  );
  it(
    "names an exit-0 empty provider result as an absent capture receipt",
    testEmptyProviderResultIsAbsentReceipt,
  );
  it(
    "surfaces scope-proof loss independently of the provider exit code",
    testScopeProofLossIsIndependentOfExitCode,
  );
  it(
    "fails when the provider ignores any key the request sent",
    testIgnoredCheckpointKeyFails,
  );
  it(
    "fails when the capture request's own sent key is ignored",
    testIgnoredCaptureKeyFails,
  );
  it(
    "fails when durable_memory item_count disagrees with the actual items",
    testItemCountMismatchFails,
  );
  it(
    "fails the durable_memory scenario when serialized sections exceed the reported budget",
    testBudgetExceededFails,
  );
  it(
    "registers a write for finally teardown before a later pack read throws",
    testWriteRegisteredBeforePackThrows,
  );
  it(
    "fails an otherwise-green batch when teardown leaves RESIDUE, naming the table and count",
    testResidueFailsOtherwiseGreenBatch,
  );
  it(
    "PASSES when cleanup calls threw but no rows remain, reporting the labels as diagnostics (#671)",
    testThrownCleanupCallsAreDiagnosticsNotFailures,
  );
  it(
    "refuses to pass when residue was never observed — unchecked is unproven, not clean (#671)",
    testUncheckedResidueRefusesToPass,
  );
});
