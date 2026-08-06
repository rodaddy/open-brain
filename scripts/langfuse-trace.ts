#!/usr/bin/env bun

import { parseArgs } from "node:util";
import {
  diffTraces,
  renderRepeatReport,
  renderSessionTraces,
  renderTimeline,
  renderTraceDiff,
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

The local values live in /Volumes/ThunderBolt/open-brain-local/local-clone.env.
Source that file before running these commands; values are never printed.
The repeat command also uses OPENBRAIN_BASE_URL, OPENBRAIN_TOKEN, and
OPENBRAIN_NAMESPACE from that environment and drives the existing Python
openbrain-memory OpenBrainClient.call_tool path through uv run.
`;

function normalizeEndpoint(endpoint: string): string {
  return endpoint
    .replace(/\/$/, "")
    .replace(/\/api\/public\/ingestion$/, "");
}

function readConfig(env: Record<string, string | undefined> = process.env): LangfuseConfig {
  const endpoint = env.OPENBRAIN_TRACING_ENDPOINT?.trim() ?? "";
  const publicKey = env.OPENBRAIN_TRACING_PUBLIC_KEY?.trim() ?? "";
  const secretKey = env.OPENBRAIN_TRACING_SECRET_KEY?.trim() ?? "";
  if (!endpoint || !publicKey || !secretKey) {
    throw new Error("OPENBRAIN_TRACING_ENDPOINT, OPENBRAIN_TRACING_PUBLIC_KEY, and OPENBRAIN_TRACING_SECRET_KEY are required");
  }
  return { endpoint: normalizeEndpoint(endpoint), publicKey, secretKey };
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
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
  if (!command || !["get", "session", "diff", "repeat"].includes(command)) {
    throw new Error(`unknown command: ${command ?? ""}`);
  }
  const expectedPositionals: Record<string, number> = { get: 1, session: 1, diff: 2, repeat: 1 };
  if (positionals.length !== expectedPositionals[command]) {
    throw new Error(`${command} received the wrong number of positional arguments`);
  }
  if (command === "repeat" && !parsed.values.query) throw new Error("repeat requires --query <q>");
  const count = parsePositiveInteger(parsed.values.n ?? "3", "-n");
  if (command === "repeat" && count < 2) throw new Error("repeat requires -n 2 or greater");
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
  const response = await fetch(url, { headers: { authorization: authorization(config) } });
  if (!response.ok) throw new Error(`Langfuse API request failed (${response.status})`);
  return response.json();
}

function pageData(payload: unknown): LangfuseTrace[] {
  if (Array.isArray(payload)) return payload as LangfuseTrace[];
  const data = (payload as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? (data as LangfuseTrace[]) : [];
}

function totalPages(payload: unknown): number | undefined {
  const meta = (payload as { meta?: Record<string, unknown> } | null)?.meta;
  const value = meta?.totalPages ?? meta?.total_pages;
  return typeof value === "number" ? value : undefined;
}

async function fetchTrace(id: string, config: LangfuseConfig): Promise<LangfuseTrace> {
  const url = new URL(`/api/public/traces/${encodeURIComponent(id)}`, config.endpoint);
  const payload = await fetchJson(url, config);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Langfuse returned an invalid trace for ${id}`);
  }
  return payload as LangfuseTrace;
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
    const payload = await fetchJson(url, config);
    const rows = pageData(payload);
    traces.push(...rows);
    const pages = totalPages(payload);
    if (rows.length === 0 || (pages !== undefined && page >= pages)) break;
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

async function driveRepeat(toolName: string, query: string, count: number): Promise<string> {
  for (const key of ["OPENBRAIN_BASE_URL", "OPENBRAIN_TOKEN"]) {
    if (!process.env[key]) throw new Error(`${key} is required for repeat`);
  }
  const child = Bun.spawn(
    ["uv", "run", "python", "-c", PYTHON_REPEAT, toolName, query, String(count)],
    {
      cwd: new URL("../python/openbrain-memory/", import.meta.url).pathname,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`OpenBrainClient repeat failed (exit ${exitCode})`);
  const payload = JSON.parse(stdout) as { session_id?: unknown };
  if (typeof payload.session_id !== "string" || payload.session_id.length === 0) {
    throw new Error("OpenBrainClient repeat returned no MCP session id");
  }
  return payload.session_id;
}

async function waitForRepeatedTraces(
  sessionId: string,
  toolName: string,
  count: number,
  startedAt: string,
  config: LangfuseConfig,
): Promise<LangfuseTrace[]> {
  const deadline = Date.now() + 30_000;
  while (Date.now() <= deadline) {
    const summaries = await listTraceSummaries({ sessionId, name: toolName }, count, config);
    const fresh = summaries.filter((trace) => String(trace.timestamp ?? "") >= startedAt);
    if (fresh.length >= count) {
      const selected = fresh.slice(0, count).reverse();
      return Promise.all(selected.map((trace) => fetchTrace(trace.id, config)));
    }
    await Bun.sleep(500);
  }
  throw new Error(`Langfuse did not return ${count} fresh ${toolName} traces for session ${sessionId}`);
}

async function run(options: CliOptions, config: LangfuseConfig): Promise<{ output: unknown; exitCode: number }> {
  switch (options.command) {
    case "get": {
      const trace = await fetchTrace(options.positionals[0]!, config);
      return { output: options.json ? trace : renderTimeline(trace), exitCode: 0 };
    }
    case "session": {
      const traces = await listTraceDetails({ sessionId: options.positionals[0]! }, options.count, config);
      return { output: options.json ? traces : renderSessionTraces(traces), exitCode: 0 };
    }
    case "diff": {
      const [traceA, traceB] = await Promise.all([
        fetchTrace(options.positionals[0]!, config),
        fetchTrace(options.positionals[1]!, config),
      ]);
      const comparison = diffTraces(traceA, traceB);
      return {
        output: options.json ? comparison : renderTraceDiff(comparison),
        exitCode: traceDiffExitCode(comparison),
      };
    }
    case "repeat": {
      const startedAt = new Date().toISOString();
      const sessionId = await driveRepeat(options.positionals[0]!, options.query!, options.count);
      const traces = await waitForRepeatedTraces(sessionId, options.positionals[0]!, options.count, startedAt, config);
      const report = { sessionId, traces, comparisons: traces.slice(1).map((trace) => diffTraces(traces[0]!, trace)) };
      return { output: options.json ? report : renderRepeatReport(sessionId, traces), exitCode: 0 };
    }
  }
}

if (import.meta.main) {
  try {
    const options = parseCli(Bun.argv.slice(2));
    if (options === "help") {
      console.log(HELP);
    } else {
      const outcome = await run(options, readConfig());
      console.log(typeof outcome.output === "string" ? outcome.output : JSON.stringify(outcome.output, null, 2));
      process.exitCode = outcome.exitCode;
    }
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : "unknown trace forensics error");
    process.exitCode = 2;
  }
}
