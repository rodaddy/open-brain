import type {
  CaptureRequest,
  ProviderExecution,
  ScenarioFixture,
  ScenarioFixtureCase,
  ScenarioGateReceipt,
  ScenarioRecord,
  ScenarioScope,
  ScenarioTransport,
  ScenarioVerdict,
  TeardownTally,
} from "./scenario-types.ts";
import { LiveTransportError, type ContextPackScope } from "./transport.ts";

export interface RunScenarioGateOptions {
  fixture: ScenarioFixture;
  namespace: string;
  transport: ScenarioTransport;
  commit: string;
  generatedAt: string;
  runId: string;
}

export interface ScenarioGateOutcome {
  receipt: ScenarioGateReceipt;
  passed: boolean;
}

const EMPTY_TEARDOWN: TeardownTally = {
  attempted: 0,
  archived: 0,
  already_absent: 0,
  failed: 0,
};

function materialize<T>(value: T, runId: string, namespace: string): T {
  const text = JSON.stringify(value)
    .replaceAll("{{run_id}}", runId)
    .replaceAll("{{namespace}}", namespace);
  return JSON.parse(text) as T;
}

function packScope(scope: ScenarioScope, namespace: string): ContextPackScope {
  return {
    namespace,
    agent: scope.agent,
    platform: scope.platform,
    server_id: scope.server_id,
    channel_id: scope.channel_id,
    thread_id: scope.thread_id ?? null,
    session_key: scope.session_key,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    return record ? [record] : [];
  });
}

function ignoredRequestFailures(
  execution: ProviderExecution,
  request: Record<string, unknown>,
): string[] {
  const ignored = execution.receipt?.ignored_optional_request_keys ?? [];
  return ignored
    .filter((key) => Object.hasOwn(request, key))
    .map((key) => `provider_ignored_request_key:${key}`);
}

/**
 * Content-free child diagnostics for a verdict. A provider can exit nonzero and
 * still emit a parseable receipt, so this covers the path that never throws;
 * only attached when the scenario actually failed and the child said something.
 */
function executionDiagnostics(
  execution: ProviderExecution,
  passed: boolean,
): { error_class?: string; stderr_first_line?: string } {
  if (passed) return {};
  return {
    ...(execution.error_class ? { error_class: execution.error_class } : {}),
    ...(execution.stderr_first_line
      ? { stderr_first_line: execution.stderr_first_line }
      : {}),
  };
}

function providerFailures(
  execution: ProviderExecution,
  request: Record<string, unknown>,
): string[] {
  const failures: string[] = [];
  if (execution.exitCode !== 0) failures.push("provider_exit_nonzero");
  const receipt = execution.receipt;
  if (!receipt) {
    failures.push("capture_receipt_absent");
    return failures;
  }
  if (receipt.status === "lost" && !receipt.durable) {
    failures.push("capture_receipt_lost");
  } else if (receipt.status !== "saved") {
    failures.push("capture_receipt_not_saved");
  }
  if (!receipt.durable) failures.push("capture_not_durable");
  failures.push(...ignoredRequestFailures(execution, request));
  return failures;
}

function providerPayload(
  request: CaptureRequest,
  namespace: string,
): Record<string, unknown> {
  return {
    operation: request.operation,
    distilled: request.distilled,
    content: request.content,
    event_type: request.event_type,
    scope: request.scope,
    config: { namespace },
    ...(request.optional_request_fields ?? {}),
  };
}

function collectProviderRecords(
  execution: ProviderExecution,
  sessionKey: string,
  records: ScenarioRecord[],
): void {
  const eventId = execution.result.event_id;
  const laneId = execution.result.lane_id;
  if (typeof laneId === "string") {
    records.push({ kind: "lane", id: laneId, session_key: sessionKey });
  }
  if (typeof eventId === "string" && typeof laneId === "string") {
    records.push({ kind: "event", id: eventId, lane_id: laneId });
  }
}

function collectContextRecords(
  context: Record<string, unknown>,
  content: string,
  sessionKey: string,
): { found: boolean; records: ScenarioRecord[] } {
  const lane = asRecord(context.lane);
  const events = recordArray(context.events);
  const event = events.find((item) => item.content === content);
  const records: ScenarioRecord[] = [];
  const laneId = typeof lane?.id === "string" ? lane.id : undefined;
  if (laneId) records.push({ kind: "lane", id: laneId, session_key: sessionKey });
  if (event && typeof event.id === "string" && laneId) {
    records.push({ kind: "event", id: event.id, lane_id: laneId });
  }
  return { found: Boolean(event), records };
}

async function runCaptureScenario(
  scenario: Extract<ScenarioFixtureCase, { kind: "capture_round_trip" }>,
  namespace: string,
  transport: ScenarioTransport,
  records: ScenarioRecord[],
): Promise<ScenarioVerdict> {
  const request = providerPayload(scenario.request, namespace);
  const execution = await transport.executeProvider(request);
  collectProviderRecords(execution, scenario.request.scope.session_key, records);
  const failures = providerFailures(execution, request);
  const context = await transport.sessionContext({
    sessionKey: scenario.request.scope.session_key,
    namespace,
  });
  const roundTrip = collectContextRecords(
    context,
    scenario.request.content,
    scenario.request.scope.session_key,
  );
  if (!roundTrip.found) failures.push("capture_round_trip_missing");
  records.push(...roundTrip.records);
  return {
    scenario_id: scenario.id,
    kind: scenario.kind,
    passed: failures.length === 0,
    failures,
    checks: {
      provider_exit_zero: execution.exitCode === 0,
      receipt_saved: execution.receipt?.status === "saved",
      durable: execution.receipt?.durable ?? false,
      read_back_exact: roundTrip.found,
    },
    ...executionDiagnostics(execution, failures.length === 0),
  };
}

function durableSectionChecks(
  sections: Record<string, unknown>,
  budget: Record<string, unknown>,
  minItems: number,
): { failures: string[]; checks: Record<string, boolean | number | string> } {
  const failures: string[] = [];
  const section = asRecord(sections.durable_memory);
  const items = recordArray(section?.items);
  const reportedItemCount =
    typeof section?.item_count === "number" ? section.item_count : null;
  if (!section) failures.push("durable_memory_section_missing");
  if (reportedItemCount !== null && reportedItemCount !== items.length) {
    failures.push("durable_memory_item_count_mismatch");
  }
  if (items.length < minItems) failures.push("durable_memory_items_missing");
  const wholePack = asRecord(budget.whole_pack);
  const charLimit =
    typeof wholePack?.content_char_limit === "number"
      ? wholePack.content_char_limit
      : null;
  const serializedChars = JSON.stringify(sections).length;
  if (charLimit === null) failures.push("durable_memory_budget_missing");
  if (charLimit !== null && serializedChars > charLimit) {
    failures.push("durable_memory_budget_exceeded");
  }
  return {
    failures,
    checks: {
      section_present: Boolean(section),
      item_count: items.length,
      reported_item_count: reportedItemCount ?? -1,
      serialized_chars: serializedChars,
      content_char_limit: charLimit ?? -1,
      within_budget: charLimit !== null && serializedChars <= charLimit,
    },
  };
}

async function runDurableMemoryScenario(
  scenario: Extract<ScenarioFixtureCase, { kind: "durable_memory_shape" }>,
  namespace: string,
  transport: ScenarioTransport,
  records: ScenarioRecord[],
): Promise<ScenarioVerdict> {
  const seed = await transport.logMemory({ ...scenario.seed, namespace });
  records.push({ kind: "memory", table: scenario.seed.table, id: seed.id });
  const payload = await transport.contextPack({
    scope: packScope(scenario.request.scope, namespace),
    query: scenario.request.query,
    budgetMaxTokens: scenario.request.budget_max_tokens,
  });
  const checked = durableSectionChecks(
    payload.sections,
    payload.budget,
    scenario.expected.min_items,
  );
  if (payload.status !== "ok") checked.failures.push("durable_memory_status_not_ok");
  return {
    scenario_id: scenario.id,
    kind: scenario.kind,
    passed: checked.failures.length === 0,
    failures: checked.failures,
    checks: {
      ...checked.checks,
      explicit_token_budget: scenario.request.budget_max_tokens,
      query_present: scenario.request.query.trim().length > 0,
    },
  };
}

async function runCheckpointScenario(
  scenario: Extract<ScenarioFixtureCase, { kind: "checkpoint_round_trip" }>,
  namespace: string,
  transport: ScenarioTransport,
  records: ScenarioRecord[],
): Promise<ScenarioVerdict> {
  const eventRequest = providerPayload(scenario.event, namespace);
  const eventExecution = await transport.executeProvider(eventRequest);
  collectProviderRecords(eventExecution, scenario.event.scope.session_key, records);
  const failures = providerFailures(eventExecution, eventRequest);
  const checkpointRequest = {
    operation: scenario.checkpoint.operation,
    distilled: scenario.checkpoint.distilled,
    summary: scenario.checkpoint.summary,
    key_decisions: scenario.checkpoint.key_decisions,
    next_steps: scenario.checkpoint.next_steps,
    scope: scenario.checkpoint.scope,
    config: { namespace },
  };
  const checkpointExecution = await transport.executeProvider(checkpointRequest);
  failures.push(...ignoredRequestFailures(checkpointExecution, checkpointRequest));
  if (checkpointExecution.exitCode !== 0) failures.push("checkpoint_exit_nonzero");
  if (checkpointExecution.receipt?.status !== "saved") {
    failures.push("checkpoint_receipt_not_saved");
  }
  if (!checkpointExecution.receipt?.durable) failures.push("checkpoint_not_durable");
  const checkpointSessionId = checkpointExecution.result.session_id;
  if (typeof checkpointSessionId === "string") {
    records.push({ kind: "memory", table: "sessions", id: checkpointSessionId });
  } else {
    failures.push("checkpoint_session_id_missing");
  }

  const context = await transport.sessionContext({
    sessionKey: scenario.checkpoint.scope.session_key,
    namespace,
  });
  const roundTrip = collectContextRecords(
    context,
    scenario.event.content,
    scenario.checkpoint.scope.session_key,
  );
  if (!roundTrip.found) failures.push("checkpoint_event_missing_on_resume");
  const lane = asRecord(context.lane);
  const summarySurfaced = lane?.current_context_md === scenario.checkpoint.summary;
  if (!summarySurfaced) failures.push("checkpoint_summary_missing_on_resume");

  records.push(...roundTrip.records);
  return {
    scenario_id: scenario.id,
    kind: scenario.kind,
    passed: failures.length === 0,
    failures,
    checks: {
      event_receipt_saved: eventExecution.receipt?.status === "saved",
      checkpoint_receipt_saved: checkpointExecution.receipt?.status === "saved",
      lane_events_surface: roundTrip.found,
      checkpoint_summary_surface: summarySurfaced,
    },
    // Two children run here; the checkpoint call is the later one, so its
    // stderr is the more proximate explanation when both spoke.
    ...executionDiagnostics(
      checkpointExecution.stderr_first_line ? checkpointExecution : eventExecution,
      failures.length === 0,
    ),
  };
}

async function runScenario(
  scenario: ScenarioFixtureCase,
  namespace: string,
  transport: ScenarioTransport,
  records: ScenarioRecord[],
): Promise<ScenarioVerdict> {
  switch (scenario.kind) {
    case "capture_round_trip":
      return runCaptureScenario(scenario, namespace, transport, records);
    case "durable_memory_shape":
      return runDurableMemoryScenario(scenario, namespace, transport, records);
    case "checkpoint_round_trip":
      return runCheckpointScenario(scenario, namespace, transport, records);
  }
}

export async function runScenarioGate(
  opts: RunScenarioGateOptions,
): Promise<ScenarioGateOutcome> {
  const fixture = materialize(opts.fixture, opts.runId, opts.namespace);
  const records: ScenarioRecord[] = [];
  const verdicts: ScenarioVerdict[] = [];
  let teardown = EMPTY_TEARDOWN;

  try {
    for (const scenario of fixture.scenarios) {
      try {
        verdicts.push(
          await runScenario(scenario, opts.namespace, opts.transport, records),
        );
      } catch (error: unknown) {
        // A transport throw is the case that used to be a bare label with no
        // way to tell WHY the provider died (issue #583). Carry the child's
        // content-free diagnostics into the verdict.
        const transportError =
          error instanceof LiveTransportError ? error : undefined;
        verdicts.push({
          scenario_id: scenario.id,
          kind: scenario.kind,
          passed: false,
          failures: [
            transportError
              ? `scenario_transport_error:${transportError.label}`
              : "scenario_transport_error",
          ],
          checks: {},
          ...(transportError?.errorClass
            ? { error_class: transportError.errorClass }
            : {}),
          ...(transportError?.stderrFirstLine
            ? { stderr_first_line: transportError.stderrFirstLine }
            : {}),
        });
      }
    }
  } finally {
    const uniqueRecords = Array.from(
      new Map(records.map((record) => [`${record.kind}:${record.id}`, record])).values(),
    );
    teardown = await opts.transport.cleanup(uniqueRecords, opts.namespace);
  }

  const failures = verdicts.flatMap((verdict) =>
    verdict.failures.map((failure) => `${verdict.scenario_id}:${failure}`),
  );
  if (teardown.failed > 0) {
    failures.push(`teardown_failed:${teardown.failed}`);
  }
  const passed = failures.length === 0;
  return {
    passed,
    receipt: {
      schema: "openbrain.scenario_gate.v1",
      generated_at: opts.generatedAt,
      commit: opts.commit,
      fixture_id: fixture.fixture_id,
      namespace: opts.namespace,
      scenarios: verdicts,
      passed,
      failures,
      teardown,
    },
  };
}
