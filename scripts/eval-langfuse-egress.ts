#!/usr/bin/env bun

/**
 * Live Langfuse egress verifier for Open Brain (issue #578, phase 1).
 *
 *   OPEN_BRAIN_LANGFUSE_EGRESS=1 bun scripts/eval-langfuse-egress.ts --drive
 *   OPEN_BRAIN_LANGFUSE_EGRESS=1 bun scripts/eval-langfuse-egress.ts --verify --tag <tag>
 *
 * The explicit OPEN_BRAIN_LANGFUSE_EGRESS=1 opt-in is mandatory. Langfuse
 * coordinates come from the existing OPENBRAIN_TRACING_* variables. Output is
 * content-free: counts, ids, statuses, and detector labels only. Trace bodies,
 * credentials, matching values, and match offsets are never emitted.
 *
 * ``--drive`` invokes the real raw-capture Stop hook, so it also requires
 * OPENBRAIN_CAPTURE_BASE_URL and OPENBRAIN_CAPTURE_TOKEN (or their shared
 * aliases). The driver rejects a missing raw configuration before spawning a
 * child; a hook's normal exit-zero contract cannot prove a capture happened.
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Database } from "bun:sqlite";
import { SECRET_DETECTORS } from "../src/secret-patterns.ts";

const OPT_IN_ENV = "OPEN_BRAIN_LANGFUSE_EGRESS";
const INGESTION_SUFFIX = "/api/public/ingestion";
const DEFAULT_EVENT_COUNT = 3;
const DEFAULT_PAGE_LIMIT = 100;
const DEFAULT_SETTLE_TIMEOUT_SECONDS = 60;
const DEFAULT_SETTLE_POLL_INTERVAL_MS = 2_000;
const MAX_TRACE_PAGES = 100;
const EMIT_FAILURE_MARKER = "observation emit failed";
const CAPTURE_TRACE_TAG = "open-brain-capture";
const CAPTURE_OPTION_ENV_KEYS = [
  "OPENBRAIN_CAPTURE_AGENT_ID",
  "OPENBRAIN_CAPTURE_AGENT",
  "OPENBRAIN_SPOOL_PATH",
  "OPENBRAIN_ALLOW_INSECURE_HTTP",
] as const;

export interface LangfuseReadConfig {
  endpoint: string;
  publicKey: string;
  secretKey: string;
}

interface CaptureDriveConfig {
  baseUrl: string;
  token: string;
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
}

export interface CliOutcome {
  exitCode: number;
  receipt?: EgressReceipt;
  error?: string;
}

interface CliOptions {
  mode: "drive" | "verify";
  tag: string;
  count: number;
  requireCost: boolean;
  settleTimeoutSeconds: number;
}

interface LangfuseTrace {
  id: string;
  observations: unknown[];
  body: unknown;
}

interface VerificationOptions {
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

export interface DriveOutcome {
  tag: string;
  count: number;
  exitCode: number;
  stdout: string;
  stderr: string;
  observeOffset: number;
}

interface DriveOptions {
  tag: string;
  count: number;
  env: Record<string, string | undefined>;
  cwd?: string;
}

interface ObservationOffsetOptions {
  fileExists?: (path: string) => Promise<boolean>;
  databaseFactory?: (path: string) => Database;
  fallbackOffset?: (path: string, sessionKey: string) => Promise<number>;
}

/** Normalize either a bare Langfuse host or its public ingestion URL. */
export function langfuseHost(endpoint: string): string {
  return endpoint
    .replace(/\/$/, "")
    .replace(new RegExp(`${INGESTION_SUFFIX}$`), "");
}

/** Resolve read-side coordinates from the existing tracing environment. */
export function readLangfuseEgressConfig(
  env: Record<string, string | undefined> = process.env,
): LangfuseReadConfig {
  const enabled = env.OPENBRAIN_TRACING_ENABLED === "1";
  const endpoint = env.OPENBRAIN_TRACING_ENDPOINT?.trim() ?? "";
  const publicKey = env.OPENBRAIN_TRACING_PUBLIC_KEY?.trim() ?? "";
  const secretKey = env.OPENBRAIN_TRACING_SECRET_KEY?.trim() ?? "";
  if (!enabled) throw new Error("OPENBRAIN_TRACING_ENABLED must equal 1");
  if (!endpoint || !publicKey || !secretKey) {
    throw new Error("OPENBRAIN_TRACING_* coordinates are incomplete");
  }
  return { endpoint: langfuseHost(endpoint), publicKey, secretKey };
}

/** Resolve the raw capture coordinates the real Stop hook needs before observing. */
export function readCaptureDriveConfig(
  env: Record<string, string | undefined> = process.env,
): CaptureDriveConfig {
  const baseUrl =
    env.OPENBRAIN_CAPTURE_BASE_URL?.trim() ?? env.OPENBRAIN_BASE_URL?.trim() ?? "";
  const token =
    env.OPENBRAIN_CAPTURE_TOKEN?.trim() ?? env.OPENBRAIN_TOKEN?.trim() ?? "";
  if (!baseUrl || !token) {
    throw new Error(
      "OPENBRAIN_CAPTURE_BASE_URL and OPENBRAIN_CAPTURE_TOKEN are required for --drive",
    );
  }
  return { baseUrl, token };
}

function assertSafeTag(tag: string): void {
  const validShape = /^[A-Za-z0-9._:-]{1,128}$/.test(tag);
  const secretShaped = SECRET_DETECTORS.some((detector) =>
    detector.pattern.test(tag),
  );
  if (!validShape || secretShaped)
    throw new Error("--tag must be a safe identifier");
}

function argumentValue(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  const next = index >= 0 ? args[index + 1] : undefined;
  return next && !next.startsWith("--") ? next : undefined;
}

/** Parse the CLI without touching the environment or network. */
export function parseEgressArgs(args: string[]): CliOptions {
  const drive = args.includes("--drive");
  const verify = args.includes("--verify");
  if (drive === verify)
    throw new Error("select exactly one of --drive or --verify");
  const countText = argumentValue(args, "count") ?? String(DEFAULT_EVENT_COUNT);
  const count = Number.parseInt(countText, 10);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("--count must be a positive integer");
  }
  const settleTimeoutText =
    argumentValue(args, "settle-timeout") ??
    String(DEFAULT_SETTLE_TIMEOUT_SECONDS);
  const settleTimeoutSeconds = Number(settleTimeoutText);
  if (!Number.isFinite(settleTimeoutSeconds) || settleTimeoutSeconds < 0) {
    throw new Error("--settle-timeout must be a non-negative number");
  }
  const tag = argumentValue(args, "tag") ?? randomUUID();
  assertSafeTag(tag);
  return {
    mode: drive ? "drive" : "verify",
    tag,
    count,
    requireCost: args.includes("--require-cost"),
    settleTimeoutSeconds,
  };
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
  if (!response.ok)
    throw new Error(`Langfuse API request failed (${response.status})`);
  return response.json();
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayField(value: unknown, name: string): unknown[] {
  const object = objectValue(value);
  return Array.isArray(object?.[name]) ? object[name] : [];
}

function stringField(value: unknown, ...names: string[]): string | undefined {
  const object = objectValue(value);
  const found = names
    .map((name) => object?.[name])
    .find((item) => typeof item === "string");
  return typeof found === "string" ? found : undefined;
}

function fieldPresent(value: unknown, ...names: string[]): boolean {
  const object = objectValue(value);
  return names.some(
    (name) => object?.[name] !== null && object?.[name] !== undefined,
  );
}

function isGeneration(value: unknown): boolean {
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

async function queryTaggedTraces(
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
    more = hasNextPage(
      payload,
      page,
      summaries.length,
      DEFAULT_PAGE_LIMIT,
    );
    page += 1;
  }
  return traces;
}

function observationContentPresent(observation: unknown): boolean {
  const body = objectValue(observation);
  if (!body) return false;
  return Object.hasOwn(body, "input") || Object.hasOwn(body, "output");
}

function secretScan(traces: LangfuseTrace[]): {
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

interface SettledTraces {
  traces: LangfuseTrace[];
  waitedMs: number;
  timedOut: boolean;
  polls: number;
}

async function queryUntilSettled(
  options: VerificationOptions,
  transport: HttpTransport,
  expectedTraces: number,
): Promise<SettledTraces> {
  const timeoutMs =
    (options.settleTimeoutSeconds ?? DEFAULT_SETTLE_TIMEOUT_SECONDS) * 1_000;
  const pollIntervalMs =
    options.pollIntervalMs ?? DEFAULT_SETTLE_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds: number) => Bun.sleep(milliseconds));
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

/** Query Langfuse and evaluate the issue #578 egress assertions. */
export async function verifyLangfuseEgress(
  options: VerificationOptions,
): Promise<EgressReceipt> {
  const transport = options.transport ?? fetch;
  const expectedTraces = options.expectedTraces ?? 1;
  const settled = await queryUntilSettled(options, transport, expectedTraces);
  const traces = settled.traces;
  const observations = traces.flatMap((trace) => trace.observations);
  const generations = observations.filter(isGeneration);
  const metadataCount = generations.filter(
    (row) =>
      fieldPresent(row, "model", "providedModelName", "provided_model_name") &&
      fieldPresent(row, "usageDetails", "usage_details"),
  ).length;
  const costCount = generations.filter((row) =>
    fieldPresent(row, "totalPrice", "totalCost", "total_cost"),
  ).length;
  const scan = secretScan(traces);
  const secretHitCount = Object.values(scan.counts).reduce(
    (sum, count) => sum + count,
    0,
  );
  const expectedGenerations =
    options.expectedGenerations ?? options.expectedObservations;
  const checks: EgressCheck[] = [
    {
      label: "arrival_count",
      passed:
        traces.length === expectedTraces &&
        observations.length === options.expectedObservations,
      fatal: true,
      observed: observations.length,
      expected: options.expectedObservations,
    },
    {
      label: "generation_metadata",
      passed:
        generations.length === expectedGenerations &&
        metadataCount === expectedGenerations,
      fatal: true,
      observed: metadataCount,
      expected: expectedGenerations,
    },
    {
      label: "total_cost",
      passed: costCount === expectedGenerations,
      fatal: options.requireCost === true,
      observed: costCount,
      expected: expectedGenerations,
    },
    {
      label: "secret_scan",
      passed: secretHitCount === 0,
      fatal: true,
      observed: secretHitCount,
      detector_counts: scan.counts,
      content_fields_present: scan.contentFieldsPresent,
    },
  ];
  const passed = checks.every((check) => check.passed || !check.fatal);
  return {
    gate: "langfuse_egress",
    mode: "verify",
    tag: options.tag,
    passed,
    expected: {
      traces: expectedTraces,
      observations: options.expectedObservations,
    },
    observed: {
      traces: traces.length,
      observations: observations.length,
      generations: generations.length,
    },
    checks,
    settle: {
      waited_ms: settled.waitedMs,
      timed_out: settled.timedOut,
      polls: settled.polls,
    },
  };
}

function scratchRoot(cwd: string): string {
  const marker = `${path.sep}_worktrees${path.sep}`;
  const markerIndex = cwd.indexOf(marker);
  const projectRoot = markerIndex >= 0 ? cwd.slice(0, markerIndex) : cwd;
  return path.join(projectRoot, "_scratch", "langfuse-egress");
}

function transcriptLine(tag: string, index: number): string {
  return JSON.stringify({
    type: "assistant",
    uuid: randomUUID(),
    sessionId: tag,
    cwd: `langfuse-egress:${tag}`,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      model: "claude-fable-5",
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 3,
      },
      content: [
        {
          type: "text",
          text: `egress verifier event ${index + 1}; run ${tag}`,
        },
      ],
    },
  });
}

export function captureEnvironment(
  env: Record<string, string | undefined>,
  config: LangfuseReadConfig,
  capture: CaptureDriveConfig,
  watermarkPath: string,
): Record<string, string> {
  const child: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key.startsWith("OPENBRAIN_")) continue;
    child[key] = value;
  }
  child.OPENBRAIN_CAPTURE_BASE_URL = capture.baseUrl;
  child.OPENBRAIN_CAPTURE_TOKEN = capture.token;
  for (const key of CAPTURE_OPTION_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) child[key] = value;
  }
  child.OPENBRAIN_OBSERVATION_ENABLED = "1";
  child.OPENBRAIN_OBSERVATION_ENDPOINT = config.endpoint;
  child.OPENBRAIN_OBSERVATION_PUBLIC_KEY = config.publicKey;
  child.OPENBRAIN_OBSERVATION_SECRET_KEY = config.secretKey;
  child.OPENBRAIN_CAPTURE_WATERMARK_PATH = watermarkPath;
  return child;
}

export async function observationOffset(
  watermarkPath: string,
  tag: string,
  options: ObservationOffsetOptions = {},
): Promise<number> {
  const fileExists =
    options.fileExists ?? ((path) => Bun.file(path).exists());
  if (!(await fileExists(watermarkPath))) return 0;
  const databaseFactory =
    options.databaseFactory ??
    ((path) => new Database(path, { readonly: true, create: false }));
  const sessionKey = `observe:${tag}`;
  try {
    const database = databaseFactory(watermarkPath);
    try {
      const row = database
        .query("SELECT offset FROM watermark WHERE session_key = ?")
        .get(sessionKey);
      const offset = objectValue(row)?.offset;
      return typeof offset === "number" && offset > 0 ? offset : 0;
    } finally {
      database.close();
    }
  } catch {
    const fallbackOffset = options.fallbackOffset ?? sqlite3WatermarkOffset;
    return fallbackOffset(watermarkPath, sessionKey);
  }
}

async function sqlite3WatermarkOffset(
  watermarkPath: string,
  sessionKey: string,
): Promise<number> {
  const quotedSessionKey = sessionKey.replaceAll("'", "''");
  const statement =
    "SELECT offset FROM watermark WHERE session_key = '" +
    `${quotedSessionKey}';`;
  const child = Bun.spawn(["sqlite3", "-ifexists", watermarkPath, statement], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error("watermark SQLite probe failed");
  const offset = Number.parseInt(stdout.trim(), 10);
  return Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
}

/** Evaluate content-free evidence produced by the drive child process. */
export function evaluateDriveOutcome(outcome: DriveOutcome): EgressReceipt {
  const emitFailureDetected = `${outcome.stdout}\n${outcome.stderr}`.includes(
    EMIT_FAILURE_MARKER,
  );
  const checks: EgressCheck[] = [
    {
      label: "capture_exit",
      passed: outcome.exitCode === 0,
      fatal: true,
      observed: outcome.exitCode,
      expected: 0,
    },
    {
      label: "emit_proven",
      passed: outcome.observeOffset > 0 && !emitFailureDetected,
      fatal: true,
      observed: outcome.observeOffset,
      expected: 1,
      emit_failure_detected: emitFailureDetected,
    },
  ];
  return {
    gate: "langfuse_egress",
    mode: "drive",
    tag: outcome.tag,
    passed: checks.every((check) => check.passed || !check.fatal),
    expected: { traces: 1, observations: outcome.count + 1 },
    observed: { traces: 0, observations: 0, generations: 0 },
    checks,
  };
}

/** Drive the real Python Stop-hook capture path with known generation turns. */
export async function driveLangfuseEgress(
  options: DriveOptions,
): Promise<EgressReceipt> {
  const config = readLangfuseEgressConfig(options.env);
  const capture = readCaptureDriveConfig(options.env);
  const cwd = options.cwd ?? process.cwd();
  const runDir = path.join(scratchRoot(cwd), `${options.tag}-${randomUUID()}`);
  await mkdir(runDir, { recursive: true });
  const transcriptPath = path.join(runDir, "transcript.jsonl");
  const watermarkPath = path.join(runDir, "watermarks.sqlite");
  const transcript = Array.from({ length: options.count }, (_, index) =>
    transcriptLine(options.tag, index),
  );
  await Bun.write(transcriptPath, `${transcript.join("\n")}\n`);
  const payload = JSON.stringify({
    session_id: options.tag,
    transcript_path: transcriptPath,
    cwd,
    hook_event_name: "Stop",
    stop_hook_active: false,
  });
  const processHandle = Bun.spawn(["uv", "run", "openbrain-capture-stop"], {
    cwd: path.join(cwd, "python", "openbrain"),
    env: captureEnvironment(options.env, config, capture, watermarkPath),
    stdin: new Blob([payload]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  const observeOffset = await observationOffset(watermarkPath, options.tag);
  return evaluateDriveOutcome({
    tag: options.tag,
    count: options.count,
    exitCode,
    stdout,
    stderr,
    observeOffset,
  });
}

/** Execute the CLI lifecycle with injectable environment and HTTP transport. */
export async function runEgressCli(
  args: string[],
  env: Record<string, string | undefined> = process.env,
  transport: HttpTransport = fetch,
): Promise<CliOutcome> {
  if (env[OPT_IN_ENV] !== "1") {
    return { exitCode: 2, error: `${OPT_IN_ENV} must equal 1` };
  }
  try {
    const options = parseEgressArgs(args);
    const config = readLangfuseEgressConfig(env);
    const receipt =
      options.mode === "drive"
        ? await driveLangfuseEgress({
            tag: options.tag,
            count: options.count,
            env,
          })
        : await verifyLangfuseEgress({
            tag: options.tag,
            expectedObservations: options.count + 1,
            expectedGenerations: options.count,
            requireCost: options.requireCost,
            settleTimeoutSeconds: options.settleTimeoutSeconds,
            config,
            transport,
          });
    return { exitCode: receipt.passed ? 0 : 1, receipt };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown error";
    return { exitCode: 2, error: message };
  }
}

/** Serialize only the content-free receipt or stable error message. */
export function serializeCliOutcome(
  outcome: CliOutcome,
  json: boolean,
): string {
  if (outcome.error) return `Langfuse egress gate error: ${outcome.error}`;
  const receipt = outcome.receipt;
  if (!receipt) return "Langfuse egress gate error: no receipt";
  if (json) return JSON.stringify(receipt, null, 2);
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
  for (const check of receipt.checks) {
    const contentFields =
      check.content_fields_present === undefined
        ? ""
        : ` content_fields_present=${check.content_fields_present}`;
    const emitFailure =
      check.emit_failure_detected === undefined
        ? ""
        : ` emit_failure_detected=${check.emit_failure_detected}`;
    lines.push(
      `check=${check.label} status=${check.passed ? "PASS" : "FAIL"} fatal=${check.fatal} observed=${check.observed}${check.expected === undefined ? "" : ` expected=${check.expected}`}${contentFields}${emitFailure}`,
    );
    for (const [kind, count] of Object.entries(check.detector_counts ?? {})) {
      lines.push(`detector=${kind} count=${count}`);
    }
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  runEgressCli(args).then((outcome) => {
    const output = serializeCliOutcome(outcome, args.includes("--json"));
    const writer = outcome.exitCode === 0 ? console.log : console.error;
    writer(output);
    process.exitCode = outcome.exitCode;
  });
}
