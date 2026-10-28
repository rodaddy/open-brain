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
  TeardownResidue,
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
  failure_labels: [],
};

/**
 * The residue reading used when the transport reported none (issue #671).
 *
 * NOT a pass. `checked: false` says the run could not observe rows, and the
 * verdict below treats that as unproven rather than clean -- a verdict derived
 * from an unperformed check is exactly the defect this issue exists to remove,
 * in the other direction.
 */
const UNCHECKED_RESIDUE: TeardownResidue = {
  checked: false,
  rows: 0,
  by_table: {},
  unchecked_reason: "transport reported no residue observation",
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
    ...request.optional_request_fields,
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

/**
 * The durable_memory section half of the check: presence, the server-reported
 * item count agreeing with the items actually carried, and the fixture's
 * minimum. Split out of `durableSectionChecks` so each half stays readable and
 * independently testable; the failure labels and check keys are unchanged.
 */
function durableMemorySectionReading(
  sections: Record<string, unknown>,
  minItems: number,
): {
  failures: string[];
  checks: { section_present: boolean; item_count: number; reported_item_count: number };
} {
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
  return {
    failures,
    checks: {
      section_present: Boolean(section),
      item_count: items.length,
      reported_item_count: reportedItemCount ?? -1,
    },
  };
}

/**
 * The whole-pack budget half of the check: the limit must be present, and the
 * serialized sections must fit inside it. A missing limit is a distinct failure
 * from an exceeded one -- an absent budget is unproven, not within budget.
 */
function durableBudgetReading(
  sections: Record<string, unknown>,
  budget: Record<string, unknown>,
): {
  failures: string[];
  checks: {
    serialized_chars: number;
    content_char_limit: number;
    within_budget: boolean;
  };
} {
  const failures: string[] = [];
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
      serialized_chars: serializedChars,
      content_char_limit: charLimit ?? -1,
      within_budget: charLimit !== null && serializedChars <= charLimit,
    },
  };
}

function durableSectionChecks(
  sections: Record<string, unknown>,
  budget: Record<string, unknown>,
  minItems: number,
): { failures: string[]; checks: Record<string, boolean | number | string> } {
  const sectionReading = durableMemorySectionReading(sections, minItems);
  const budgetReading = durableBudgetReading(sections, budget);
  return {
    failures: [...sectionReading.failures, ...budgetReading.failures],
    checks: { ...sectionReading.checks, ...budgetReading.checks },
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

/**
 * Run the checkpoint call itself and read its receipt. Split out of
 * `runCheckpointScenario` so the scenario function reads as three steps (event,
 * checkpoint, resume) instead of one long body. Appends its own failure labels
 * and pushes the session record in the same order as before.
 */
async function runCheckpointCall(
  checkpoint: Extract<
    ScenarioFixtureCase,
    { kind: "checkpoint_round_trip" }
  >["checkpoint"],
  namespace: string,
  transport: ScenarioTransport,
  records: ScenarioRecord[],
): Promise<{ execution: ProviderExecution; failures: string[] }> {
  const request = {
    operation: checkpoint.operation,
    distilled: checkpoint.distilled,
    summary: checkpoint.summary,
    key_decisions: checkpoint.key_decisions,
    next_steps: checkpoint.next_steps,
    scope: checkpoint.scope,
    config: { namespace },
  };
  const execution = await transport.executeProvider(request);
  const failures = ignoredRequestFailures(execution, request);
  if (execution.exitCode !== 0) failures.push("checkpoint_exit_nonzero");
  if (execution.receipt?.status !== "saved") {
    failures.push("checkpoint_receipt_not_saved");
  }
  if (!execution.receipt?.durable) failures.push("checkpoint_not_durable");
  const sessionId = execution.result.session_id;
  if (typeof sessionId === "string") {
    records.push({ kind: "memory", table: "sessions", id: sessionId });
  } else {
    failures.push("checkpoint_session_id_missing");
  }
  return { execution, failures };
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
  const checkpoint = await runCheckpointCall(
    scenario.checkpoint,
    namespace,
    transport,
    records,
  );
  const checkpointExecution = checkpoint.execution;
  failures.push(...checkpoint.failures);

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

/**
 * A transport throw is the case that used to be a bare label with no way to
 * tell WHY the provider died (issue #583). Carry the child's content-free
 * diagnostics into the verdict.
 */
function transportErrorVerdict(
  scenario: ScenarioFixtureCase,
  error: unknown,
): ScenarioVerdict {
  const transportError = error instanceof LiveTransportError ? error : undefined;
  return {
    scenario_id: scenario.id,
    kind: scenario.kind,
    passed: false,
    failures: [
      transportError
        ? `scenario_transport_error:${transportError.label}`
        : "scenario_transport_error",
    ],
    checks: {},
    ...(transportError?.errorClass ? { error_class: transportError.errorClass } : {}),
    ...(transportError?.stderrFirstLine
      ? { stderr_first_line: transportError.stderrFirstLine }
      : {}),
  };
}

/**
 * THE TEARDOWN VERDICT CHANNEL (issue #671).
 *
 * What fails the run is RESIDUE -- rows this run's namespace still owns, read
 * back out of the database. What does NOT fail the run is `teardown.failed`,
 * which counts cleanup CALLS THAT THREW. Those are different facts, and
 * conflating them is what made the third credentialed #653 verify exit 1 on a
 * database a 12-table residue query had just proven clean: two `archive_entry`
 * calls threw, the composed namespace purge then removed every row, and no one
 * corrected the count.
 *
 * The thrown calls are not swept under the rug -- they are REPORTED, by label,
 * as a diagnostic (see `teardownCallDiagnostics`). An operator reading the
 * receipt still learns exactly which call failed and why; they just no longer
 * learn a wrong verdict from it.
 */
function residueFailures(residue: TeardownResidue): string[] {
  if (!residue.checked) {
    // Unchecked is unproven, not clean. Refusing to pass here is the same
    // discipline in the opposite direction: a verdict may not rest on an
    // observation that never ran.
    return [
      `teardown_residue_unchecked:${residue.unchecked_reason ?? "no reason given"}`,
    ];
  }
  if (residue.rows > 0) {
    const tables = Object.entries(residue.by_table)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([table, count]) => `${table}=${count}`)
      .join(",");
    // Names the table and the count, because "residue exists" without saying
    // WHERE is the dead-end-error class this issue's sibling defect is about.
    return [`teardown_residue:rows=${residue.rows}${tables ? `;${tables}` : ""}`];
  }
  return [];
}

/**
 * DIAGNOSTIC, never a verdict input: the labels of any cleanup calls that
 * threw. Emitted whenever there were any, INCLUDING on an otherwise-passing
 * run -- a silent throw is how the #671 label went unrecoverable in the first
 * place.
 */
function teardownCallDiagnostics(teardown: TeardownTally): string[] {
  if (teardown.failed <= 0) return [];
  const labels =
    teardown.failure_labels.length > 0
      ? `;labels=${teardown.failure_labels.join("|")}`
      : "";
  return [`teardown_call_failures:${teardown.failed}${labels}`];
}

export async function runScenarioGate(
  opts: RunScenarioGateOptions,
): Promise<ScenarioGateOutcome> {
  const fixture = materialize(opts.fixture, opts.runId, opts.namespace);
  const records: ScenarioRecord[] = [];
  const verdicts: ScenarioVerdict[] = [];
  let teardown = EMPTY_TEARDOWN;
  let residue: TeardownResidue = UNCHECKED_RESIDUE;

  try {
    for (const scenario of fixture.scenarios) {
      try {
        verdicts.push(
          await runScenario(scenario, opts.namespace, opts.transport, records),
        );
      } catch (error: unknown) {
        verdicts.push(transportErrorVerdict(scenario, error));
      }
    }
  } finally {
    const uniqueRecords = Array.from(
      new Map(
        records.map((record) => [`${record.kind}:${record.id}`, record]),
      ).values(),
    );
    const cleanup = await opts.transport.cleanup(uniqueRecords, opts.namespace);
    teardown = cleanup.tally;
    residue = cleanup.residue;
  }

  const failures = verdicts.flatMap((verdict) =>
    verdict.failures.map((failure) => `${verdict.scenario_id}:${failure}`),
  );

  // See `residueFailures` for the teardown verdict channel (issue #671):
  // residue fails the run, thrown cleanup calls are a diagnostic only.
  failures.push(...residueFailures(residue));
  const teardownDiagnostics = teardownCallDiagnostics(teardown);
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
      diagnostics: teardownDiagnostics,
      teardown,
      teardown_residue: residue,
    },
  };
}
