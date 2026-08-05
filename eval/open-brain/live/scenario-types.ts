import type { TeardownTally } from "./gate.ts";
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
  cleanup(records: ScenarioRecord[], namespace: string): Promise<TeardownTally>;
  close(): Promise<void>;
}

export type { TeardownTally };

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
  teardown: TeardownTally;
}
