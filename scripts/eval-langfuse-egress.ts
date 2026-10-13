#!/usr/bin/env node

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

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { DatabaseSync as Database } from "node:sqlite";
import { runCaptureStop } from "./capture-stop-child.ts";
import { summarizeChildStderr } from "../server/logging/child-stderr.ts";
import { SECRET_DETECTORS } from "../server/security/secret-patterns.ts";
import {
  DEFAULT_SETTLE_TIMEOUT_SECONDS,
  fieldPresent,
  isGeneration,
  objectValue,
  queryUntilSettled,
  secretScan,
  serializeCliOutcome,
} from "./eval-langfuse-egress-read.ts";
import type {
  CliOutcome,
  EgressCheck,
  EgressReceipt,
  HttpTransport,
  LangfuseReadConfig,
  VerificationOptions,
} from "./eval-langfuse-egress-read.ts";

// The read layer is this gate's own half, split out only to keep each file
// small; callers and tests still import every name from this entrypoint.
export { serializeCliOutcome, queryTaggedTraces } from "./eval-langfuse-egress-read.ts";
export type {
  CliOutcome,
  EgressCheck,
  EgressReceipt,
  HttpTransport,
  LangfuseReadConfig,
  VerificationOptions,
} from "./eval-langfuse-egress-read.ts";

const OPT_IN_ENV = "OPEN_BRAIN_LANGFUSE_EGRESS";
const INGESTION_SUFFIX = "/api/public/ingestion";
const DEFAULT_EVENT_COUNT = 3;
const EMIT_FAILURE_MARKER = "observation emit failed";
const CAPTURE_OPTION_ENV_KEYS = [
  "OPENBRAIN_CAPTURE_AGENT_ID",
  "OPENBRAIN_CAPTURE_AGENT",
  "OPENBRAIN_SPOOL_PATH",
  "OPENBRAIN_ALLOW_INSECURE_HTTP",
] as const;

interface CaptureDriveConfig {
  baseUrl: string;
  token: string;
}

interface CliOptions {
  mode: "drive" | "verify";
  tag: string;
  count: number;
  requireCost: boolean;
  settleTimeoutSeconds: number;
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
  return endpoint.replace(/\/$/, "").replace(new RegExp(`${INGESTION_SUFFIX}$`), "");
}

/**
 * Read one env var and trim it, collapsing unset and whitespace-only to "".
 * Hoisted so the config readers below read as a list of coordinates rather
 * than a chain of optional-chain plus nullish-coalescing branches, each of
 * which oxlint counts against the function's complexity.
 */
function trimmedEnv(env: Record<string, string | undefined>, name: string): string {
  return env[name]?.trim() ?? "";
}

/**
 * First non-empty of the named vars. `||` semantics, not `??`: deployed
 * hook-env wrappers pass VAR="${VAR:-}", so an unset CAPTURE var arrives as an
 * empty string and must still fall through to the alias (#525 documented this
 * exact shape for the Python side; config.py:163-171).
 */
function firstTrimmedEnv(
  env: Record<string, string | undefined>,
  ...names: string[]
): string {
  for (const name of names) {
    const value = trimmedEnv(env, name);
    if (value) return value;
  }
  return "";
}

/** Resolve read-side coordinates from the existing tracing environment. */
export function readLangfuseEgressConfig(
  env: Record<string, string | undefined> = process.env,
): LangfuseReadConfig {
  if (env.OPENBRAIN_TRACING_ENABLED !== "1") {
    throw new Error("OPENBRAIN_TRACING_ENABLED must equal 1");
  }
  const endpoint = trimmedEnv(env, "OPENBRAIN_TRACING_ENDPOINT");
  const publicKey = trimmedEnv(env, "OPENBRAIN_TRACING_PUBLIC_KEY");
  const secretKey = trimmedEnv(env, "OPENBRAIN_TRACING_SECRET_KEY");
  if (!endpoint || !publicKey || !secretKey) {
    throw new Error("OPENBRAIN_TRACING_* coordinates are incomplete");
  }
  return { endpoint: langfuseHost(endpoint), publicKey, secretKey };
}

/** Resolve the raw capture coordinates the real Stop hook needs before observing. */
export function readCaptureDriveConfig(
  env: Record<string, string | undefined> = process.env,
): CaptureDriveConfig {
  const baseUrl = firstTrimmedEnv(
    env,
    "OPENBRAIN_CAPTURE_BASE_URL",
    "OPENBRAIN_BASE_URL",
  );
  const token = firstTrimmedEnv(env, "OPENBRAIN_CAPTURE_TOKEN", "OPENBRAIN_TOKEN");
  if (!baseUrl || !token) {
    throw new Error(
      "OPENBRAIN_CAPTURE_BASE_URL and OPENBRAIN_CAPTURE_TOKEN are required for --drive",
    );
  }
  return { baseUrl, token };
}

function assertSafeTag(tag: string): void {
  const validShape = /^[A-Za-z0-9._:-]{1,128}$/.test(tag);
  const secretShaped = SECRET_DETECTORS.some((detector) => detector.pattern.test(tag));
  if (!validShape || secretShaped) throw new Error("--tag must be a safe identifier");
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
  if (drive === verify) throw new Error("select exactly one of --drive or --verify");
  const countText = argumentValue(args, "count") ?? String(DEFAULT_EVENT_COUNT);
  const count = Number.parseInt(countText, 10);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("--count must be a positive integer");
  }
  const settleTimeoutText =
    argumentValue(args, "settle-timeout") ?? String(DEFAULT_SETTLE_TIMEOUT_SECONDS);
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
      // An empty scanned set proves nothing about egress safety, so it reports
      // skipped-no-data AND fails: passed is coupled to the data, not to the
      // absence of hits, so a caller passing expectedTraces: 0 cannot get a
      // run certified secret-free while the scanner examined nothing (#583
      // review finding — the arrival_count default was the only thing holding
      // the old comment's claim, and it is caller-overridable).
      passed: traces.length > 0 && secretHitCount === 0,
      fatal: true,
      observed: secretHitCount,
      detector_counts: scan.counts,
      content_fields_present: scan.contentFieldsPresent,
      status:
        traces.length === 0
          ? "skipped-no-data"
          : secretHitCount === 0
            ? "pass"
            : "fail",
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
    options.fileExists ?? ((path) => Promise.resolve(existsSync(path)));
  if (!(await fileExists(watermarkPath))) return 0;
  const databaseFactory =
    options.databaseFactory ??
    ((path) => {
      // Lazy: bun 1.3.13 cannot resolve node:sqlite, and this module is
      // imported (for types alone) by several bun test files. Requiring it
      // here keeps module load working everywhere and confines the Node
      // requirement to the code path that truly needs a database.
      const { DatabaseSync } = require("node:sqlite") as {
        DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => Database;
      };
      return new DatabaseSync(path, { readOnly: true });
    });
  const sessionKey = `observe:${tag}`;
  try {
    const database = databaseFactory(watermarkPath);
    try {
      const row = database
        .prepare("SELECT offset FROM watermark WHERE session_key = ?")
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

/**
 * Promisified execFile: node's callback spawn exposes no `.exited` promise.
 * Rejects on a non-zero exit rather than resolving with the code.
 */
const execFileAsync = promisify(execFile);

async function sqlite3WatermarkOffset(
  watermarkPath: string,
  sessionKey: string,
): Promise<number> {
  const quotedSessionKey = sessionKey.replaceAll("'", "''");
  const statement =
    "SELECT offset FROM watermark WHERE session_key = '" + `${quotedSessionKey}';`;
  // execFileAsync rejects on a non-zero exit, which is exactly the throw this
  // site already performed; the message is preserved verbatim and still
  // carries no child output, keeping the probe content-free.
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "sqlite3",
      ["-ifexists", watermarkPath, statement],
      { encoding: "utf8" },
    ));
  } catch {
    throw new Error("watermark SQLite probe failed");
  }
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
  const passed = checks.every((check) => check.passed || !check.fatal);
  // Only surfaced on failure: a healthy run's stderr is noise, and the receipt
  // stays content-free either way (issue #583).
  const diagnostics = passed ? {} : summarizeChildStderr(outcome.stderr);
  return {
    gate: "langfuse_egress",
    mode: "drive",
    tag: outcome.tag,
    passed,
    expected: { traces: 1, observations: outcome.count + 1 },
    observed: { traces: 0, observations: 0, generations: 0 },
    checks,
    ...diagnostics,
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
  await writeFile(transcriptPath, `${transcript.join("\n")}\n`);
  const payload = JSON.stringify({
    session_id: options.tag,
    transcript_path: transcriptPath,
    cwd,
    hook_event_name: "Stop",
    stop_hook_active: false,
  });
  // spawn, not execFile: this child is FED on stdin, and execFile offers no
  // way to write to it. The exit code is a VALUE here (it flows into
  // evaluateDriveOutcome as the capture_exit check), so a rejecting wrapper
  // would be wrong -- runCaptureStop resolves with the code instead.
  const { exitCode, stdout, stderr } = await runCaptureStop({
    cwd: path.join(cwd, "python", "openbrain"),
    env: captureEnvironment(options.env, config, capture, watermarkPath),
    payload,
  });
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

if (import.meta.main) {
  const args = process.argv.slice(2);
  // runEgressCli resolves its own failures into an outcome with a non-zero
  // exitCode rather than rejecting, so there is no rejection path to handle.
  void runEgressCli(args).then((outcome) => {
    const output = serializeCliOutcome(outcome, args.includes("--json"));
    const writer = outcome.exitCode === 0 ? console.log : console.error;
    writer(output);
    process.exitCode = outcome.exitCode;
  });
}
