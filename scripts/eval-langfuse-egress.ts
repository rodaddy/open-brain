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
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { SECRET_DETECTORS } from "../src/secret-patterns.ts";

const OPT_IN_ENV = "OPEN_BRAIN_LANGFUSE_EGRESS";
const INGESTION_SUFFIX = "/api/public/ingestion";
const DEFAULT_EVENT_COUNT = 3;
const DEFAULT_PAGE_LIMIT = 100;

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
  label: "arrival_count" | "generation_metadata" | "total_cost" | "secret_scan";
  passed: boolean;
  fatal: boolean;
  observed: number;
  expected?: number;
  detector_counts?: Record<string, number>;
}

export interface EgressReceipt {
  gate: "langfuse_egress";
  mode: "drive" | "verify";
  tag: string;
  passed: boolean;
  expected: { traces: number; observations: number };
  observed: { traces: number; observations: number; generations: number };
  checks: EgressCheck[];
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
  config: LangfuseReadConfig;
  transport?: HttpTransport;
}

interface DriveOptions {
  tag: string;
  count: number;
  env: Record<string, string | undefined>;
  cwd?: string;
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
  const tag = argumentValue(args, "tag") ?? randomUUID();
  assertSafeTag(tag);
  return {
    mode: drive ? "drive" : "verify",
    tag,
    count,
    requireCost: args.includes("--require-cost"),
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
  return { id, observations: arrayField(value, "observations"), body: value };
}

function pageData(value: unknown): unknown[] {
  const direct = arrayField(value, "data");
  if (direct.length > 0) return direct;
  return Array.isArray(value) ? value : [];
}

function hasNextPage(value: unknown, page: number): boolean {
  const meta = objectValue(objectValue(value)?.meta);
  const totalPages = meta?.totalPages ?? meta?.total_pages;
  return typeof totalPages === "number" && page < totalPages;
}

async function queryTaggedTraces(
  tag: string,
  config: LangfuseReadConfig,
  transport: HttpTransport,
): Promise<LangfuseTrace[]> {
  const traces: LangfuseTrace[] = [];
  let page = 1;
  let more = true;
  while (more) {
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
      traces.push(traceFrom(detail) ?? summaryTrace);
    }
    more = hasNextPage(payload, page);
    page += 1;
  }
  return traces;
}

function secretCounts(traces: LangfuseTrace[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const trace of traces) {
    const serialized = JSON.stringify(trace.body);
    for (const detector of SECRET_DETECTORS) {
      if (!detector.pattern.test(serialized)) continue;
      counts[detector.kind] = (counts[detector.kind] ?? 0) + 1;
    }
  }
  return counts;
}

/** Query Langfuse and evaluate the issue #578 egress assertions. */
export async function verifyLangfuseEgress(
  options: VerificationOptions,
): Promise<EgressReceipt> {
  const transport = options.transport ?? fetch;
  const traces = await queryTaggedTraces(
    options.tag,
    options.config,
    transport,
  );
  const observations = traces.flatMap((trace) => trace.observations);
  const generations = observations.filter(isGeneration);
  const metadataCount = generations.filter(
    (row) =>
      fieldPresent(row, "providedModelName", "provided_model_name") &&
      fieldPresent(row, "usageDetails", "usage_details"),
  ).length;
  const costCount = generations.filter((row) =>
    fieldPresent(row, "totalCost", "total_cost"),
  ).length;
  const detectorCounts = secretCounts(traces);
  const secretHitCount = Object.values(detectorCounts).reduce(
    (sum, count) => sum + count,
    0,
  );
  const expectedTraces = options.expectedTraces ?? 1;
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
      detector_counts: detectorCounts,
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

function captureEnvironment(
  env: Record<string, string | undefined>,
  config: LangfuseReadConfig,
  watermarkPath: string,
): Record<string, string> {
  const child: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key.startsWith("OPENBRAIN_TRACING_")) continue;
    child[key] = value;
  }
  child.OPENBRAIN_OBSERVATION_ENABLED = "1";
  child.OPENBRAIN_OBSERVATION_ENDPOINT = config.endpoint;
  child.OPENBRAIN_OBSERVATION_PUBLIC_KEY = config.publicKey;
  child.OPENBRAIN_OBSERVATION_SECRET_KEY = config.secretKey;
  child.OPENBRAIN_CAPTURE_WATERMARK_PATH = watermarkPath;
  return child;
}

/** Drive the real Python Stop-hook capture path with known generation turns. */
export async function driveLangfuseEgress(
  options: DriveOptions,
): Promise<EgressReceipt> {
  const config = readLangfuseEgressConfig(options.env);
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
    env: captureEnvironment(options.env, config, watermarkPath),
    stdin: new Blob([payload]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await processHandle.exited;
  if (exitCode !== 0) throw new Error(`capture path exited ${exitCode}`);
  return {
    gate: "langfuse_egress",
    mode: "drive",
    tag: options.tag,
    passed: true,
    expected: { traces: 1, observations: options.count + 1 },
    observed: {
      traces: 0,
      observations: options.count,
      generations: options.count,
    },
    checks: [],
  };
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
  for (const check of receipt.checks) {
    lines.push(
      `check=${check.label} status=${check.passed ? "PASS" : "FAIL"} fatal=${check.fatal} observed=${check.observed}${check.expected === undefined ? "" : ` expected=${check.expected}`}`,
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
