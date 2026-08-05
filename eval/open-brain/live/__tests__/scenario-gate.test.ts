import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadScenarioFixture,
  parseScenarioFixture,
  ScenarioFixtureScopeKeyError,
} from "../scenario-fixtures.ts";
import { runScenarioGate } from "../scenario-gate.ts";
import { parseProviderOutput } from "../scenario-transport.ts";
import type {
  ProviderExecution,
  ScenarioFixture,
  ScenarioRecord,
  ScenarioTransport,
  TeardownTally,
} from "../scenario-types.ts";

const FIXTURE = parseScenarioFixture(
  JSON.parse(
    readFileSync(
      join(import.meta.dir, "../../fixtures/scenarios-v1.json"),
      "utf8",
    ),
  ),
);

interface FakeOptions {
  zeroWrite?: boolean;
  emptyProviderOutput?: boolean;
  /** Raw stderr a failing capture child writes before dying (issue #583). */
  captureStderr?: string;
  /** Exit code for that failing capture child. */
  captureExitCode?: number;
  /** Stdout for that failing capture child; defaults to empty. */
  captureStdout?: string;
  lostCapture?: boolean;
  ignoredKeys?: string[];
  packCharLimit?: number;
  packItems?: Array<Record<string, unknown>>;
  packItemCount?: number;
  packThrows?: boolean;
  cleanupFails?: number;
}

interface LaneState {
  id: string;
  current_context_md: string | null;
  events: Array<{ id: string; content: string }>;
}

function fakeTransport(opts: FakeOptions = {}): ScenarioTransport {
  const lanes = new Map<string, LaneState>();
  let sequence = 0;
  const nextId = (prefix: string) => `${prefix}-${++sequence}`;

  function execution(
    operation: string,
    result: Record<string, unknown>,
  ): ProviderExecution {
    const lost = operation === "capture" && opts.lostCapture;
    return {
      exitCode: 0,
      receipt: {
        operation,
        status: lost ? "lost" : "saved",
        durable: !lost,
        direct_attempted: true,
        fallback_attempted: false,
        ignored_optional_request_keys: opts.ignoredKeys,
      },
      result,
    };
  }

  return {
    async executeProvider(request) {
      const operation = String(request.operation);
      const scope = request.scope as { session_key: string };
      const lane =
        lanes.get(scope.session_key) ?? {
          id: nextId("lane"),
          current_context_md: null,
          events: [],
        };
      lanes.set(scope.session_key, lane);
      if (operation === "capture" && opts.emptyProviderOutput) {
        return parseProviderOutput("", 0);
      }
      if (operation === "capture" && opts.captureStderr !== undefined) {
        // Exercised through the real parser, so the test proves the production
        // stderr path rather than a hand-built execution object.
        return parseProviderOutput(
          opts.captureStdout ?? "",
          opts.captureExitCode ?? 1,
          opts.captureStderr,
        );
      }
      if (operation === "capture") {
        if (!opts.zeroWrite && !opts.lostCapture) {
          lane.events.push({
            id: nextId("event"),
            content: String(request.content),
          });
        }
        return execution(operation, {
          event_id: lane.events.at(-1)?.id,
          lane_id: lane.id,
        });
      }
      lane.current_context_md = String(request.summary);
      return execution(operation, {
        session_id: nextId("session"),
        lane_id: lane.id,
      });
    },
    async logMemory() {
      return { id: nextId("memory") };
    },
    async contextPack() {
      if (opts.packThrows) throw new Error("synthetic pack failure");
      const items = opts.packItems ?? [
        { id: "memory-1", citation_id: "citation-1" },
      ];
      const sections = {
        durable_memory: {
          label: "durable_memory",
          namespace_scoped: true,
          items,
          item_count: opts.packItemCount ?? items.length,
          truncated: false,
        },
      };
      const serialized = JSON.stringify(sections).length;
      return {
        status: "ok",
        sections,
        budget: {
          whole_pack: {
            content_char_limit: opts.packCharLimit ?? serialized,
          },
        },
      };
    },
    async sessionContext({ sessionKey }) {
      const lane = lanes.get(sessionKey);
      return lane
        ? { lane, events: lane.events, event_count: lane.events.length }
        : { lane: null, events: [], event_count: 0 };
    },
    async cleanup(records: ScenarioRecord[]): Promise<TeardownTally> {
      const failed = Math.min(opts.cleanupFails ?? 0, records.length);
      return {
        attempted: records.length,
        archived: records.length - failed,
        already_absent: 0,
        failed,
      };
    },
    async close() {},
  };
}

function run(
  transport: ScenarioTransport,
  fixture: ScenarioFixture = FIXTURE,
) {
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

describe("scenario fixture validation", () => {
  it("loads the shipped three-scenario fixture", () => {
    expect(FIXTURE.fixture_id).toBe("open-brain-scenarios-v1");
    expect(FIXTURE.scenarios.map((scenario) => scenario.kind)).toEqual([
      "capture_round_trip",
      "durable_memory_shape",
      "checkpoint_round_trip",
    ]);
  });

  it("rejects duplicate scenario ids", () => {
    expect(() =>
      parseScenarioFixture({
        ...FIXTURE,
        scenarios: [FIXTURE.scenarios[0], FIXTURE.scenarios[0]],
      }),
    ).toThrow(/duplicate scenario id/);
  });

  it("rejects a non-contract fixture scope key at load", async () => {
    const path = join(import.meta.dir, "scenario-invalid-scope.fixture.json");
    const error = await loadScenarioFixture(path).catch((caught) => caught);

    expect(error).toBeInstanceOf(ScenarioFixtureScopeKeyError);
    expect(error.message).toMatch(/non-contract scope key\(s\): bogus/);
  });
});

describe("runScenarioGate", () => {
  it("runs all scenarios through the fake transport and tears down exact records", async () => {
    const outcome = await run(fakeTransport());
    expect(outcome.receipt.failures).toEqual([]);
    expect(outcome.passed).toBe(true);
    expect(outcome.receipt.scenarios).toHaveLength(3);
    expect(outcome.receipt.scenarios.every((scenario) => scenario.passed)).toBe(
      true,
    );
    expect(outcome.receipt.teardown).toEqual({
      attempted: 6,
      archived: 6,
      already_absent: 0,
      failed: 0,
    });
    expectContentFree(outcome.receipt);
  });

  it("fails the exit-0 zero-write capture by reading it back", async () => {
    const outcome = await run(fakeTransport({ zeroWrite: true }));
    expect(outcome.passed).toBe(false);
    expect(outcome.receipt.failures).toContain(
      "capture-round-trip:capture_round_trip_missing",
    );
    const capture = outcome.receipt.scenarios[0]!;
    expect(capture.checks.provider_exit_zero).toBe(true);
    expect(capture.checks.receipt_saved).toBe(true);
    expect(capture.checks.read_back_exact).toBe(false);
  });

  it("carries a failing child's stderr first line into the scenario receipt", async () => {
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
    const capture = outcome.receipt.scenarios[0]!;
    expect(capture.error_class).toBe("PermissionError");
    expect(capture.stderr_first_line).toBe(
      "PermissionError: scope key 'project' was rejected",
    );
    expect(outcome.receipt.failures.join(" ")).toContain(
      "capture-round-trip:scenario_transport_error",
    );
    expectContentFree(outcome.receipt);
  });

  it("leaves stderr diagnostics off a passing scenario", async () => {
    const outcome = await run(fakeTransport());
    expect(outcome.passed).toBe(true);
    for (const scenario of outcome.receipt.scenarios) {
      expect(scenario.error_class).toBeUndefined();
      expect(scenario.stderr_first_line).toBeUndefined();
    }
  });

  it("names an exit-0 empty provider result as an absent capture receipt", async () => {
    const outcome = await run(fakeTransport({ emptyProviderOutput: true }));
    expect(outcome.passed).toBe(false);
    expect(outcome.receipt.failures).toContain(
      "capture-round-trip:capture_receipt_absent",
    );
    expect(outcome.receipt.failures).not.toContain(
      "capture-round-trip:scenario_transport_error",
    );
    const capture = outcome.receipt.scenarios[0]!;
    expect(capture.checks.provider_exit_zero).toBe(true);
    expect(capture.checks.receipt_saved).toBe(false);
    expect(capture.checks.read_back_exact).toBe(false);
  });

  it("surfaces scope-proof loss independently of the provider exit code", async () => {
    const outcome = await run(fakeTransport({ lostCapture: true }));
    expect(outcome.passed).toBe(false);
    expect(outcome.receipt.failures).toContain(
      "capture-round-trip:capture_receipt_lost",
    );
    expect(outcome.receipt.failures).toContain(
      "capture-round-trip:capture_not_durable",
    );
    expect(outcome.receipt.failures).not.toContain(
      "capture-round-trip:provider_exit_nonzero",
    );
    expect(outcome.receipt.scenarios[0]!.checks.provider_exit_zero).toBe(true);
    expectContentFree(outcome.receipt);
  });

  it("fails when the provider ignores any key the request sent", async () => {
    const outcome = await run(fakeTransport({ ignoredKeys: ["summary", "kind"] }));
    expect(outcome.passed).toBe(false);
    expect(outcome.receipt.failures).toContain(
      "checkpoint-wrap-round-trip:provider_ignored_request_key:summary",
    );
    expect(outcome.receipt.failures).not.toContain(
      "checkpoint-wrap-round-trip:provider_ignored_request_key:kind",
    );
  });

  it("fails when the capture request's own sent key is ignored", async () => {
    const outcome = await run(
      fakeTransport({ ignoredKeys: ["candidate_type"] }),
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.receipt.failures).toContain(
      "capture-round-trip:provider_ignored_request_key:candidate_type",
    );
  });

  it("fails when durable_memory item_count disagrees with the actual items", async () => {
    const outcome = await run(
      fakeTransport({ packItems: [], packItemCount: 5 }),
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.receipt.failures).toContain(
      "durable-memory-pack-shape:durable_memory_item_count_mismatch",
    );
    expect(outcome.receipt.failures).toContain(
      "durable-memory-pack-shape:durable_memory_items_missing",
    );
    const durable = outcome.receipt.scenarios[1]!;
    expect(durable.checks.item_count).toBe(0);
    expect(durable.checks.reported_item_count).toBe(5);
  });

  it("fails the durable_memory scenario when serialized sections exceed the reported budget", async () => {
    const outcome = await run(fakeTransport({ packCharLimit: 1 }));
    expect(outcome.passed).toBe(false);
    expect(outcome.receipt.failures).toContain(
      "durable-memory-pack-shape:durable_memory_budget_exceeded",
    );
  });

  it("registers a write for finally teardown before a later pack read throws", async () => {
    const outcome = await run(fakeTransport({ packThrows: true }));
    expect(outcome.passed).toBe(false);
    expect(outcome.receipt.failures).toContain(
      "durable-memory-pack-shape:scenario_transport_error",
    );
    expect(outcome.receipt.teardown.attempted).toBe(6);
    expect(outcome.receipt.teardown.failed).toBe(0);
  });

  it("fails an otherwise-green batch when teardown strands a record", async () => {
    const outcome = await run(fakeTransport({ cleanupFails: 1 }));
    expect(outcome.passed).toBe(false);
    expect(outcome.receipt.teardown.failed).toBe(1);
    expect(outcome.receipt.failures).toContain("teardown_failed:1");
  });
});
