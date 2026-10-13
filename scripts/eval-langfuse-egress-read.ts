/**
 * Langfuse read layer for the egress gate (issue #578, split out at issue 864).
 *
 * Everything here is the READ half of `eval-langfuse-egress.ts`: the shared
 * receipt types, the defensive JSON field accessors, the paged trace query and
 * its settle loop, the content-free secret scan, and the receipt renderers.
 * The gate script keeps the drive half — spawning the real Stop hook — and the
 * CLI. The split is mechanical: no call was changed, only its home.
 *
 * The content-free discipline is unchanged and is the point of the gate:
 * counts, ids, statuses, and detector labels only, never trace bodies,
 * credentials, matching values, or match offsets.
 */

import { setTimeout as delay } from "node:timers/promises";

import { SECRET_DETECTORS } from "../server/security/secret-patterns.ts";

export const DEFAULT_PAGE_LIMIT = 100;
export const DEFAULT_SETTLE_TIMEOUT_SECONDS = 60;
export const DEFAULT_SETTLE_POLL_INTERVAL_MS = 2_000;
export const MAX_TRACE_PAGES = 100;
export const CAPTURE_TRACE_TAG = "open-brain-capture";

export interface LangfuseReadConfig {
  endpoint: string;
  publicKey: string;
  secretKey: string;
}

export type HttpTransport = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface EgressCheck {
  label:
    | "arrival_count"
    | "generation_metadata"
    | "total_cost"
    | "secret_scan"
    | "capture_exit"
    | "emit_proven";
  passed: boolean;
  fatal: boolean;
  observed: number;
  expected?: number;
  detector_counts?: Record<string, number>;
  content_fields_present?: boolean;
  emit_failure_detected?: boolean;
  /**
   * `skipped-no-data` marks a check that had nothing to examine, which is NOT
   * the same claim as `pass`. A scan over zero traces found zero secrets
   * trivially; reporting that as a pass is a vacuous green (issue #583).
   */
  status?: "pass" | "fail" | "skipped-no-data";
}

export interface EgressReceipt {
  gate: "langfuse_egress";
  mode: "drive" | "verify";
  tag: string;
  passed: boolean;
  expected: { traces: number; observations: number };
  observed: { traces: number; observations: number; generations: number };
  checks: EgressCheck[];
  settle?: { waited_ms: number; timed_out: boolean; polls: number };
  /**
   * Content-free diagnostics from the drive child: error class plus one
   * redacted stderr line. Without these a drive failure presents as a bare
   * exit code and has to be recovered by replaying the command (issue #583).
   */
  error_class?: string;
  stderr_first_line?: string;
}

export interface CliOutcome {
  exitCode: number;
  receipt?: EgressReceipt;
  error?: string;
}

export interface LangfuseTrace {
  id: string;
  observations: unknown[];
  body: unknown;
}

export interface VerificationOptions {
  tag: string;
  expectedObservations: number;
  expectedGenerations?: number;
  expectedTraces?: number;
  requireCost?: boolean;
  settleTimeoutSeconds?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  config: LangfuseReadConfig;
  transport?: HttpTransport;
}

export interface SettledTraces {
  traces: LangfuseTrace[];
  waitedMs: number;
  timedOut: boolean;
  polls: number;
}

function basicAuthorization(config: LangfuseReadConfig): string {
  return `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`;
}

async function fetchJson(
  url: URL,
  config: LangfuseReadConfig,
  transport: HttpTransport,
): Promise<unknown> {
  const response = await transport(url, {
    headers: { authorization: basicAuthorization(config) },
  });
  if (!response.ok) throw new Error(`Langfuse API request failed (${response.status})`);
  return response.json();
}

export function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function arrayField(value: unknown, name: string): unknown[] {
  const object = objectValue(value);
  return Array.isArray(object?.[name]) ? object[name] : [];
}

export function stringField(value: unknown, ...names: string[]): string | undefined {
  const object = objectValue(value);
  const found = names
    .map((name) => object?.[name])
    .find((item) => typeof item === "string");
  return typeof found === "string" ? found : undefined;
}

export function fieldPresent(value: unknown, ...names: string[]): boolean {
  const object = objectValue(value);
  return names.some((name) => object?.[name] !== null && object?.[name] !== undefined);
}

export function isGeneration(value: unknown): boolean {
  return stringField(value, "type")?.toUpperCase() === "GENERATION";
}

function traceFrom(value: unknown): LangfuseTrace | undefined {
  const id = stringField(value, "id");
  if (!id) return undefined;
  const object = objectValue(value) ?? {};
  const { observations: _observations, ...body } = object;
  return { id, observations: arrayField(value, "observations"), body };
}

function isCaptureTrace(trace: LangfuseTrace): boolean {
  return arrayField(trace.body, "tags").includes(CAPTURE_TRACE_TAG);
}

function pageData(value: unknown): unknown[] {
  const direct = arrayField(value, "data");
  if (direct.length > 0) return direct;
  return Array.isArray(value) ? value : [];
}

function hasNextPage(
  value: unknown,
  page: number,
  rowCount: number,
  pageSize: number,
): boolean {
  const meta = objectValue(objectValue(value)?.meta);
  const totalPages = meta?.totalPages ?? meta?.total_pages;
  if (typeof totalPages === "number") return page < totalPages;
  return rowCount === pageSize;
}

/** Fetch one summary page's capture traces, each hydrated by its detail read. */
async function captureTracesOnPage(
  summaries: unknown[],
  config: LangfuseReadConfig,
  transport: HttpTransport,
): Promise<LangfuseTrace[]> {
  const traces: LangfuseTrace[] = [];
  for (const summary of summaries) {
    const summaryTrace = traceFrom(summary);
    if (!summaryTrace) continue;
    const detailUrl = new URL(
      `/api/public/traces/${encodeURIComponent(summaryTrace.id)}`,
      config.endpoint,
    );
    const detail = await fetchJson(detailUrl, config, transport);
    const trace = traceFrom(detail) ?? summaryTrace;
    if (isCaptureTrace(trace)) traces.push(trace);
  }
  return traces;
}

export async function queryTaggedTraces(
  tag: string,
  config: LangfuseReadConfig,
  transport: HttpTransport,
): Promise<LangfuseTrace[]> {
  const traces: LangfuseTrace[] = [];
  let page = 1;
  let more = true;
  while (more && page <= MAX_TRACE_PAGES) {
    const url = new URL("/api/public/traces", config.endpoint);
    url.searchParams.set("sessionId", tag);
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", String(DEFAULT_PAGE_LIMIT));
    const payload = await fetchJson(url, config, transport);
    const summaries = pageData(payload);
    traces.push(...(await captureTracesOnPage(summaries, config, transport)));
    more = hasNextPage(payload, page, summaries.length, DEFAULT_PAGE_LIMIT);
    page += 1;
  }
  return traces;
}

export async function queryUntilSettled(
  options: VerificationOptions,
  transport: HttpTransport,
  expectedTraces: number,
): Promise<SettledTraces> {
  const timeoutMs =
    (options.settleTimeoutSeconds ?? DEFAULT_SETTLE_TIMEOUT_SECONDS) * 1_000;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_SETTLE_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => delay(milliseconds));
  const startedAt = now();
  let polls = 0;
  let traces: LangfuseTrace[] = [];
  while (true) {
    traces = await queryTaggedTraces(options.tag, options.config, transport);
    polls += 1;
    const observations = traces.flatMap((trace) => trace.observations);
    const arrived =
      traces.length >= expectedTraces &&
      observations.length >= options.expectedObservations;
    const waitedMs = Math.max(0, now() - startedAt);
    if (arrived) return { traces, waitedMs, timedOut: false, polls };
    if (waitedMs >= timeoutMs) {
      return { traces, waitedMs, timedOut: true, polls };
    }
    await sleep(Math.min(pollIntervalMs, timeoutMs - waitedMs));
  }
}

function observationContentPresent(observation: unknown): boolean {
  const body = objectValue(observation);
  if (!body) return false;
  return Object.hasOwn(body, "input") || Object.hasOwn(body, "output");
}

export function secretScan(traces: LangfuseTrace[]): {
  counts: Record<string, number>;
  contentFieldsPresent: boolean;
} {
  const counts: Record<string, number> = {};
  let contentFieldsPresent = false;
  for (const trace of traces) {
    const observationBodies = trace.observations.map((observation) => {
      if (observationContentPresent(observation)) contentFieldsPresent = true;
      return observation;
    });
    const serialized = JSON.stringify({
      trace: trace.body,
      observations: observationBodies,
    });
    for (const detector of SECRET_DETECTORS) {
      if (!detector.pattern.test(serialized)) continue;
      counts[detector.kind] = (counts[detector.kind] ?? 0) + 1;
    }
  }
  return { counts, contentFieldsPresent };
}

/**
 * Render one receipt check as its own text lines. Hoisted so each optional
 * field's own branch is counted against this small renderer rather than the
 * whole serializer.
 */
function serializeCheckLines(check: EgressCheck): string[] {
  const contentFields =
    check.content_fields_present === undefined
      ? ""
      : ` content_fields_present=${check.content_fields_present}`;
  const emitFailure =
    check.emit_failure_detected === undefined
      ? ""
      : ` emit_failure_detected=${check.emit_failure_detected}`;
  const expected = check.expected === undefined ? "" : ` expected=${check.expected}`;
  const status = check.status ?? (check.passed ? "pass" : "fail");
  const lines = [
    `check=${check.label} status=${status.toUpperCase()} fatal=${check.fatal} observed=${check.observed}${expected}${contentFields}${emitFailure}`,
  ];
  for (const [kind, count] of Object.entries(check.detector_counts ?? {})) {
    lines.push(`detector=${kind} count=${count}`);
  }
  return lines;
}

/** Render the receipt header block: verdict, mode/tag, expected, observed. */
function serializeReceiptHeader(receipt: EgressReceipt): string[] {
  const lines = [
    `Langfuse egress gate: ${receipt.passed ? "PASS" : "FAIL"}`,
    `mode=${receipt.mode} tag=${receipt.tag}`,
    `expected traces=${receipt.expected.traces} observations=${receipt.expected.observations}`,
    `observed traces=${receipt.observed.traces} observations=${receipt.observed.observations} generations=${receipt.observed.generations}`,
  ];
  if (receipt.settle) {
    lines.push(
      `settle waited_ms=${receipt.settle.waited_ms} timed_out=${receipt.settle.timed_out} polls=${receipt.settle.polls}`,
    );
  }
  return lines;
}

/** Render the trailing content-free diagnostics, when the child said anything. */
function serializeReceiptDiagnostics(receipt: EgressReceipt): string[] {
  const lines: string[] = [];
  if (receipt.error_class) lines.push(`error_class=${receipt.error_class}`);
  if (receipt.stderr_first_line) {
    lines.push(`stderr_first_line=${receipt.stderr_first_line}`);
  }
  return lines;
}

/** Serialize only the content-free receipt or stable error message. */
export function serializeCliOutcome(outcome: CliOutcome, json: boolean): string {
  if (outcome.error) return `Langfuse egress gate error: ${outcome.error}`;
  const receipt = outcome.receipt;
  if (!receipt) return "Langfuse egress gate error: no receipt";
  if (json) return JSON.stringify(receipt, null, 2);
  return [
    ...serializeReceiptHeader(receipt),
    ...receipt.checks.flatMap(serializeCheckLines),
    ...serializeReceiptDiagnostics(receipt),
  ].join("\n");
}
