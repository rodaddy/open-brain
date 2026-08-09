import type { TeardownResidue, TeardownTally } from "./gate.ts";
import type { ContextPackScope } from "./transport.ts";

export type ScenarioKind =
  | "capture_round_trip"
  | "durable_memory_shape"
  | "checkpoint_round_trip";

export interface ScenarioScope
  extends Omit<ContextPackScope, "namespace" | "thread_id"> {
  thread_id?: string | null;
}

export interface CaptureRequest {
  operation: "capture";
  distilled: true;
  content: string;
  event_type: string;
  scope: ScenarioScope;
  optional_request_fields?: Record<string, unknown>;
}

export interface CheckpointRequest {
  operation: "checkpoint";
  distilled: true;
  summary: string;
  key_decisions: string[];
  next_steps: string[];
  scope: ScenarioScope;
}

export interface CaptureRoundTripScenario {
  id: string;
  kind: "capture_round_trip";
  request: CaptureRequest;
}

export interface DurableMemoryShapeScenario {
  id: string;
  kind: "durable_memory_shape";
  seed: {
    table: "thoughts" | "decisions";
    content: string;
    tags: string[];
  };
  request: {
    query: string;
    budget_max_tokens: number;
    scope: ScenarioScope;
  };
  expected: {
    section: "durable_memory";
    min_items: number;
  };
}

export interface CheckpointRoundTripScenario {
  id: string;
  kind: "checkpoint_round_trip";
  event: CaptureRequest;
  checkpoint: CheckpointRequest;
}

export type ScenarioFixtureCase =
  | CaptureRoundTripScenario
  | DurableMemoryShapeScenario
  | CheckpointRoundTripScenario;

export interface ScenarioFixture {
  schema_version: 1;
  fixture_id: string;
  description: string;
  scenarios: ScenarioFixtureCase[];
}

export interface ProviderReceipt {
  operation: string;
  status: string;
  durable: boolean;
  direct_attempted: boolean;
  fallback_attempted: boolean;
  ignored_optional_request_keys?: string[];
}

export interface ProviderExecution {
  exitCode: number;
  receipt?: ProviderReceipt;
  result: Record<string, unknown>;
  /** Error class recognized in the provider's stderr, when it failed. */
  error_class?: string;
  /** First meaningful stderr line, redacted. */
  stderr_first_line?: string;
}

export type ScenarioRecord =
  | {
      kind: "memory";
      table: "thoughts" | "decisions" | "sessions";
      id: string;
    }
  | {
      kind: "event";
      id: string;
      lane_id: string;
    }
  | {
      kind: "lane";
      id: string;
      session_key: string;
    };

export interface ScenarioTransport {
  executeProvider(request: Record<string, unknown>): Promise<ProviderExecution>;
  logMemory(opts: {
    table: "thoughts" | "decisions";
    content: string;
    tags: string[];
    namespace: string;
  }): Promise<{ id: string }>;
  contextPack(opts: {
    scope: ContextPackScope;
    query: string;
    budgetMaxTokens: number;
  }): Promise<{
    status: string;
    sections: Record<string, unknown>;
    budget: Record<string, unknown>;
  }>;
  sessionContext(opts: {
    sessionKey: string;
    namespace: string;
  }): Promise<Record<string, unknown>>;
  /**
   * Remove this run's records and namespace, and REPORT WHAT IS LEFT (#671).
   *
   * The residue half is the load-bearing return value: the tally counts cleanup
   * CALLS, and a call that threw is not the same fact as a row that remains.
   * A transport that cannot observe rows returns `checked: false` -- which the
   * gate treats as unproven, never as clean.
   */
  cleanup(
    records: ScenarioRecord[],
    namespace: string,
  ): Promise<{ tally: TeardownTally; residue: TeardownResidue }>;
  close(): Promise<void>;
}

export type { TeardownResidue, TeardownTally };

export interface ScenarioVerdict {
  scenario_id: string;
  kind: ScenarioKind;
  passed: boolean;
  failures: string[];
  checks: Record<string, boolean | number | string>;
  /**
   * Content-free child diagnostics for a failing scenario: error class plus one
   * redacted stderr line. Present only when the provider actually said
   * something on stderr (issue #583).
   */
  error_class?: string;
  stderr_first_line?: string;
}

export interface ScenarioGateReceipt {
  schema: "openbrain.scenario_gate.v1";
  generated_at: string;
  commit: string;
  fixture_id: string;
  namespace: string;
  scenarios: ScenarioVerdict[];
  passed: boolean;
  failures: string[];
  /**
   * Content-free NON-VERDICT observations (#671). Anything an operator needs in
   * order to explain a run but which must never by itself decide pass/fail --
   * today, the labels of cleanup calls that threw. Kept out of `failures` on
   * purpose: `failures` is the verdict channel, and mixing a diagnostic into it
   * is the exact defect #671 removes.
   */
  diagnostics: string[];
  /**
   * DIAGNOSTICS ONLY since #671. Counts of cleanup calls plus one content-free
   * label per failure. The gate verdict does NOT read `failed` -- see
   * `teardown_residue`, which reads rows.
   */
  teardown: TeardownTally;
  /**
   * The load-bearing teardown signal (#671): rows still carrying this run's
   * namespace, queried from the database after cleanup ran.
   */
  teardown_residue: TeardownResidue;
}
