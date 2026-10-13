#!/usr/bin/env node

import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import { z } from "zod";
import {
  diffTraces,
  renderRepeatReport,
  renderSessionTraces,
  renderTimeline,
  renderTraceDiff,
  repeatExitCode,
  traceDiffExitCode,
  type LangfuseTrace,
} from "./langfuse-trace-lib.ts";

interface LangfuseConfig {
  endpoint: string;
  publicKey: string;
  secretKey: string;
}

interface CliOptions {
  command: "get" | "session" | "diff" | "repeat";
  positionals: string[];
  json: boolean;
  query?: string;
  count: number;
}

const observationSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    type: z.string().optional(),
    parentObservationId: z.string().nullable().optional(),
    startTime: z.string().optional(),
    endTime: z.string().optional(),
    latency: z.number().optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .passthrough();

const traceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    timestamp: z.string().optional(),
    release: z.string().nullable().optional(),
    sessionId: z.string().nullable().optional(),
    userId: z.string().nullable().optional(),
    latency: z.number().optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    observations: z.array(observationSchema).optional(),
  })
  .passthrough();

const traceListRowSchema = traceSchema.omit({ observations: true });

const tracePageSchema = z.union([
  z.array(traceListRowSchema),
  z
    .object({
      data: z.array(traceListRowSchema),
      meta: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough(),
]);

const HELP = `Open Brain Langfuse trace forensics

Usage:
  bun scripts/langfuse-trace.ts get <traceId> [--json]
  bun scripts/langfuse-trace.ts session <sessionKey> [-n N] [--json]
  bun scripts/langfuse-trace.ts diff <traceIdA> <traceIdB> [--json]
  bun scripts/langfuse-trace.ts repeat <toolName> --query <q> [-n N] [--json]

Environment:
  OPENBRAIN_TRACING_ENDPOINT
  OPENBRAIN_TRACING_PUBLIC_KEY
  OPENBRAIN_TRACING_SECRET_KEY

The local values live in /opt/open-brain-local/local-clone.env.
Source that file before running these commands; values are never printed.
The repeat command also uses OPENBRAIN_BASE_URL, OPENBRAIN_TOKEN, and
OPENBRAIN_NAMESPACE from that environment and drives the existing Python
openbrain-memory OpenBrainClient.call_tool path through uv run.
`;

function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/$/, "").replace(/\/api\/public\/ingestion$/, "");
}

function trimmedEnv(env: Record<string, string | undefined>, key: string): string {
  return env[key]?.trim() ?? "";
}

function readConfig(
  env: Record<string, string | undefined> = process.env,
): LangfuseConfig {
  const endpoint = trimmedEnv(env, "OPENBRAIN_TRACING_ENDPOINT");
  const publicKey = trimmedEnv(env, "OPENBRAIN_TRACING_PUBLIC_KEY");
  const secretKey = trimmedEnv(env, "OPENBRAIN_TRACING_SECRET_KEY");
  if (!endpoint || !publicKey || !secretKey) {
    throw new Error(
      "OPENBRAIN_TRACING_ENDPOINT, OPENBRAIN_TRACING_PUBLIC_KEY, and OPENBRAIN_TRACING_SECRET_KEY are required",
    );
  }
  return { endpoint: normalizeEndpoint(endpoint), publicKey, secretKey };
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

const EXPECTED_POSITIONALS: Record<string, number> = {
  get: 1,
  session: 1,
  diff: 2,
  repeat: 1,
};

function assertKnownCommand(command: string | undefined): asserts command is string {
  if (!command || !Object.hasOwn(EXPECTED_POSITIONALS, command)) {
    throw new Error(`unknown command: ${command ?? ""}`);
  }
}

function assertPositionalShape(
  command: string,
  positionals: string[],
  query: string | undefined,
): void {
  if (positionals.length !== EXPECTED_POSITIONALS[command]) {
    throw new Error(`${command} received the wrong number of positional arguments`);
  }
  if (command === "repeat" && !query) throw new Error("repeat requires --query <q>");
}

function parseCli(args: string[]): CliOptions | "help" {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      query: { type: "string" },
      n: { type: "string", short: "n", default: "3" },
    },
  });
  if (parsed.values.help || parsed.positionals.length === 0) return "help";
  const [command, ...positionals] = parsed.positionals;
  assertKnownCommand(command);
  assertPositionalShape(command, positionals, parsed.values.query);
  const count = parsePositiveInteger(parsed.values.n ?? "3", "-n");
  if (command === "repeat" && count < 2)
    throw new Error("repeat requires -n 2 or greater");
  return {
    command: command as CliOptions["command"],
    positionals,
    json: parsed.values.json ?? false,
    query: parsed.values.query,
    count,
  };
}

function authorization(config: LangfuseConfig): string {
  return `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`;
}

async function fetchJson(url: URL, config: LangfuseConfig): Promise<unknown> {
  const response = await fetch(url, {
    headers: { authorization: authorization(config) },
  });
  if (!response.ok) throw new Error(`Langfuse API request failed (${response.status})`);
  return response.json();
}

function parseTracePage(payload: unknown): {
  traces: LangfuseTrace[];
  totalPages?: number;
} {
  const parsed = tracePageSchema.safeParse(payload);
  if (!parsed.success)
    throw new Error("Langfuse returned an invalid trace-list response");
  if (Array.isArray(parsed.data)) return { traces: parsed.data };
  const value = parsed.data.meta?.totalPages ?? parsed.data.meta?.total_pages;
  return {
    traces: parsed.data.data,
    totalPages: typeof value === "number" ? value : undefined,
  };
}

async function fetchTrace(id: string, config: LangfuseConfig): Promise<LangfuseTrace> {
  const url = new URL(`/api/public/traces/${encodeURIComponent(id)}`, config.endpoint);
  const parsed = traceSchema.safeParse(await fetchJson(url, config));
  if (!parsed.success) throw new Error(`Langfuse returned an invalid trace for ${id}`);
  return parsed.data;
}

async function listTraceSummaries(
  filters: Record<string, string>,
  requested: number,
  config: LangfuseConfig,
): Promise<LangfuseTrace[]> {
  const traces: LangfuseTrace[] = [];
  let page = 1;
  while (traces.length < requested) {
    const url = new URL("/api/public/traces", config.endpoint);
    Object.entries(filters).forEach(([key, value]) => url.searchParams.set(key, value));
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", "100");
    const result = parseTracePage(await fetchJson(url, config));
    traces.push(...result.traces);
    if (
      result.traces.length === 0 ||
      (result.totalPages !== undefined && page >= result.totalPages)
    )
      break;
    page += 1;
  }
  return traces.slice(0, requested);
}

async function listTraceDetails(
  filters: Record<string, string>,
  requested: number,
  config: LangfuseConfig,
): Promise<LangfuseTrace[]> {
  const summaries = await listTraceSummaries(filters, requested, config);
  return Promise.all(summaries.map((trace) => fetchTrace(trace.id, config)));
}

const PYTHON_REPEAT = String.raw`
import json
import os
import sys
from openbrain_memory import OpenBrainClient

tool_name, query, count_text = sys.argv[1:]
client = OpenBrainClient(
    os.environ["OPENBRAIN_BASE_URL"],
    os.environ["OPENBRAIN_TOKEN"],
    os.environ.get("OPENBRAIN_NAMESPACE", "rico"),
    agent_id=os.environ.get("OPENBRAIN_AGENT_ID"),
    role=os.environ.get("OPENBRAIN_ROLE"),
    allow_insecure_http=os.environ.get("OPENBRAIN_ALLOW_INSECURE_HTTP") == "1",
)
try:
    for _ in range(int(count_text)):
        client.call_tool(tool_name, {"query": query})
    print(json.dumps({"session_id": client.session_id}))
finally:
    client.close()
`;

/**
 * Promisified execFile: node's callback spawn exposes no `.exited` promise.
 * It REJECTS on a non-zero exit rather than resolving with the code, so the
 * one call site below converts that rejection back into this file's existing
 * error message.
 */
const execFileAsync = promisify(execFile);

export function repeatChildFailureMessage(exitCode: number, stderr: string): string {
  const detail = stderr.trim();
  return `OpenBrainClient repeat failed (exit ${exitCode})${detail ? `: ${detail}` : ""}`;
}

export function parseRepeatChildOutput(stdout: string): string {
  const lastLine = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!lastLine) throw new Error("OpenBrainClient repeat returned no JSON result");
  let payload: unknown;
  try {
    payload = JSON.parse(lastLine);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`OpenBrainClient repeat returned invalid JSON: ${detail}`);
  }
  const sessionId = (payload as { session_id?: unknown } | null)?.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("OpenBrainClient repeat returned no MCP session id");
  }
  return sessionId;
}

async function driveRepeat(
  toolName: string,
  query: string,
  count: number,
): Promise<string> {
  for (const key of ["OPENBRAIN_BASE_URL", "OPENBRAIN_TOKEN"]) {
    if (!process.env[key]) throw new Error(`${key} is required for repeat`);
  }
  // execFileAsync rejects on a non-zero exit and attaches the captured
  // stdout/stderr plus `code` to the error, which is where the failure detail
  // now comes from. `code` is undefined/null when the child was killed by a
  // signal or never launched, so it is normalized to -1 before reaching
  // repeatChildFailureMessage -- that helper is exported and typed `number`,
  // and its signature is deliberately left alone.
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "uv",
      ["run", "python", "-c", PYTHON_REPEAT, toolName, query, String(count)],
      {
        cwd: new URL("../python/openbrain-memory/", import.meta.url).pathname,
        env: process.env,
        encoding: "utf8",
      },
    ));
  } catch (error) {
    const failed = error as { code?: number | string | null; stderr?: string };
    const exitCode = typeof failed.code === "number" ? failed.code : -1;
    throw new Error(repeatChildFailureMessage(exitCode, failed.stderr ?? ""));
  }
  // Parsed OUTSIDE the try: parseRepeatChildOutput throws on malformed output,
  // and catching that here would relabel a parse failure as a child failure.
  return parseRepeatChildOutput(stdout);
}

export function selectRepeatedTraceSummaries(
  summaries: LangfuseTrace[],
  count: number,
  startedAt: string,
): LangfuseTrace[] | undefined {
  const startedAtMs = Date.parse(startedAt);
  const fresh = summaries
    .filter((trace) => Date.parse(trace.timestamp ?? "") >= startedAtMs)
    .sort(
      (a, b) =>
        Date.parse(a.timestamp ?? "") - Date.parse(b.timestamp ?? "") ||
        a.id.localeCompare(b.id),
    );
  if (fresh.length > count) {
    throw new Error(
      `Langfuse returned ${fresh.length} fresh traces; expected exactly ${count}`,
    );
  }
  return fresh.length === count ? fresh : undefined;
}

interface RepeatWaitRequest {
  sessionId: string;
  toolName: string;
  count: number;
  startedAt: string;
}

async function waitForRepeatedTraces(
  request: RepeatWaitRequest,
  config: LangfuseConfig,
): Promise<LangfuseTrace[]> {
  const { sessionId, toolName, count, startedAt } = request;
  const deadline = Date.now() + 30_000;
  while (Date.now() <= deadline) {
    const summaries = await listTraceSummaries(
      { sessionId, name: toolName },
      count + 1,
      config,
    );
    const selected = selectRepeatedTraceSummaries(summaries, count, startedAt);
    if (selected)
      return Promise.all(selected.map((trace) => fetchTrace(trace.id, config)));
    await sleep(500);
  }
  throw new Error(
    `Langfuse did not return ${count} fresh ${toolName} traces for session ${sessionId}`,
  );
}

function positionalAt(options: CliOptions, index: number): string {
  const value = options.positionals[index];
  if (value === undefined) {
    throw new Error(
      `${options.command} received the wrong number of positional arguments`,
    );
  }
  return value;
}

function requiredQuery(options: CliOptions): string {
  if (!options.query) throw new Error("repeat requires --query <q>");
  return options.query;
}

async function run(
  options: CliOptions,
  config: LangfuseConfig,
): Promise<{ output: unknown; exitCode: number }> {
  switch (options.command) {
    case "get": {
      const trace = await fetchTrace(positionalAt(options, 0), config);
      return { output: options.json ? trace : renderTimeline(trace), exitCode: 0 };
    }
    case "session": {
      const traces = await listTraceDetails(
        { sessionId: positionalAt(options, 0) },
        options.count,
        config,
      );
      return {
        output: options.json ? traces : renderSessionTraces(traces),
        exitCode: 0,
      };
    }
    case "diff": {
      const [traceA, traceB] = await Promise.all([
        fetchTrace(positionalAt(options, 0), config),
        fetchTrace(positionalAt(options, 1), config),
      ]);
      const comparison = diffTraces(traceA, traceB);
      return {
        output: options.json ? comparison : renderTraceDiff(comparison),
        exitCode: traceDiffExitCode(comparison),
      };
    }
    case "repeat": {
      const startedAt = new Date().toISOString();
      const toolName = positionalAt(options, 0);
      const sessionId = await driveRepeat(
        toolName,
        requiredQuery(options),
        options.count,
      );
      const traces = await waitForRepeatedTraces(
        { sessionId, toolName, count: options.count, startedAt },
        config,
      );
      const [baseline] = traces;
      if (!baseline)
        throw new Error(
          `Langfuse did not return ${options.count} fresh ${toolName} traces`,
        );
      const comparisons = traces.slice(1).map((trace) => diffTraces(baseline, trace));
      const report = { sessionId, traces, comparisons };
      return {
        output: options.json ? report : renderRepeatReport(sessionId, traces),
        exitCode: repeatExitCode(comparisons),
      };
    }
  }
}

if (import.meta.main) {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options === "help") {
      console.log(HELP);
    } else {
      const outcome = await run(options, readConfig());
      console.log(
        typeof outcome.output === "string"
          ? outcome.output
          : JSON.stringify(outcome.output, null, 2),
      );
      process.exitCode = outcome.exitCode;
    }
  } catch (error: unknown) {
    console.error(
      error instanceof Error ? error.message : "unknown trace forensics error",
    );
    process.exitCode = 2;
  }
}
