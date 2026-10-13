#!/usr/bin/env node
// SessionStart hook: loads knowledge + session context from Open Brain
// Uses mcp2cli for transport/auth -- no raw HTTP
// Fires on: * (all session starts)
// Silent on all errors -- never blocks session start

import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const KNOWN_TAGS: Record<string, string> = {
  hono: "hono",
  react: "react",
  express: "express",
  next: "nextjs",
  "@modelcontextprotocol/sdk": "modelcontextprotocol-sdk",
  pg: "pg",
  pgvector: "pgvector",
  zod: "zod",
  htmx: "htmx",
  bun: "bun",
  typescript: "typescript",
  prisma: "prisma",
  drizzle: "drizzle",
  cors: "cors",
  "@hono/zod-openapi": "openapi",
  "@anthropic-ai/sdk": "anthropic-sdk",
  openai: "openai",
};

const RRF_K = 60;
const MAX_OUTPUT_CHARS = 3000;
const MAX_CONTENT_CHARS = 500;

// Detect project tags from package.json dependencies
function detectTags(cwd: string): string[] {
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return Object.keys(deps)
      .map((dep) => KNOWN_TAGS[dep])
      .filter((tag): tag is string => Boolean(tag));
  } catch {
    /* ignore parse errors */
    return [];
  }
}

// Typed formatter for the `unknown` values carried in the normalized result
// records. Primitives render as themselves; anything else is JSON so a payload
// shape change can never emit "[object Object]" into the session context.
function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value) ?? "";
}

function parseMaybeJson(inner: unknown): unknown {
  if (typeof inner !== "string") return inner;
  try {
    return JSON.parse(inner);
  } catch {
    return inner;
  }
}

// Async helper: call mcp2cli and parse JSON result
async function callMcp(
  service: string,
  tool: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  try {
    // execFile REJECTS on a nonzero exit where Bun's `await proc.exited`
    // resolved with the code; the outer catch returns null either way, so the
    // "spawn failed -> null" behavior is unchanged.
    const { stdout } = await execFileAsync(
      "mcp2cli",
      [service, tool, "--params", JSON.stringify(params)],
      { timeout: 8000, encoding: "utf8" },
    );
    const output = JSON.parse(stdout.trim());
    if (output?.result === undefined) return output;
    return parseMaybeJson(output.result);
  } catch {
    return null;
  }
}

// Normalize OB results (distance 0-1 lower=better -> score 0-1 higher=better)
function normalizeBrain(obResult: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(obResult)) return [];
  return (obResult as Array<Record<string, unknown>>).map((r) => ({
    source: "brain",
    type: r.source_type,
    content: r.content_preview,
    score: 1 - (Number(r.distance) || 0.5),
    tags: r.tags,
  }));
}

// Normalize qmd results (score 0-1 higher=better, nested in .results)
function normalizeQmd(qmdResult: unknown): Array<Record<string, unknown>> {
  const isObject =
    qmdResult && typeof qmdResult === "object" && !Array.isArray(qmdResult);
  const qmdInner = isObject
    ? ((qmdResult as Record<string, unknown>).results as
        Array<Record<string, unknown>> | undefined)
    : null;
  if (!Array.isArray(qmdInner)) return [];
  return qmdInner.map((r) => ({
    source: "qmd",
    type: "file",
    content: asText(r.snippet ?? r.content).slice(0, 300),
    score: Number(r.score) || 0.5,
    path: r.file || r.path,
    collection: r.collection,
  }));
}

// Reciprocal Rank Fusion: position-based merge so both sources get fair representation
function fuse(
  ...sources: Array<Array<Record<string, unknown>>>
): Array<Record<string, unknown>> {
  const withRrf: Array<Record<string, unknown> & { rrf: number }> = [];
  for (const source of sources) {
    source.forEach((entry, i) => {
      withRrf.push({ ...entry, rrf: 1 / (RRF_K + i + 1) });
    });
  }
  return withRrf.sort((a, b) => b.rrf - a.rrf).slice(0, 10);
}

function typeLabelFor(r: Record<string, unknown>): string {
  if (r.source !== "brain") return "FILE";
  if (r.type === "decision") return "DECISION";
  if (r.type === "thought") return "TECHNIQUE";
  return (asText(r.type) || "ENTRY").toUpperCase();
}

function headingFor(r: Record<string, unknown>): string {
  if (r.source !== "brain" && r.path) return asText(r.path);
  return asText(r.content).split("\n")[0] || "Untitled";
}

function renderResult(r: Record<string, unknown>, lines: string[]): void {
  lines.push(`## [${typeLabelFor(r)}] ${headingFor(r)}`);
  if (Array.isArray(r.tags) && r.tags.length) {
    lines.push(
      `**Tags:** ${(r.tags as string[]).map((t: string) => "#" + t).join(" ")}`,
    );
  }
  if (r.collection) lines.push(`**Collection:** ${asText(r.collection)}`);
  const content = asText(r.content);
  if (content) {
    lines.push(
      content.length > MAX_CONTENT_CHARS
        ? content.slice(0, MAX_CONTENT_CHARS) + "..."
        : content,
    );
  }
  lines.push("");
  lines.push("---");
  lines.push("");
}

function pushSessionList(lines: string[], heading: string, items: unknown): void {
  if (!Array.isArray(items) || !items.length) return;
  lines.push(`\n### ${heading}`);
  for (const item of items) lines.push(`- ${asText(item)}`);
}

function hasSessionPayload(sessionResult: unknown): boolean {
  if (!sessionResult || typeof sessionResult !== "object") return false;
  const record = sessionResult as Record<string, unknown>;
  if (!("text" in record)) return true;
  return !asText(record.text).startsWith("No sessions");
}

function renderSession(
  session: Record<string, unknown>,
  lines: string[],
  project: string,
): void {
  if (!lines.length) {
    lines.push(`<!-- PAI Brain Context for ${project} -->`);
  }
  lines.push("## Previous Session");
  lines.push(
    `**Project:** ${asText(session.project) || "global"} | **Saved:** ${asText(session.created_at)}`,
  );
  if (session.summary) lines.push(`\n${asText(session.summary)}`);
  pushSessionList(lines, "Key Decisions", session.key_decisions);
  pushSessionList(lines, "Blockers", session.blockers);
  pushSessionList(lines, "Next Steps", session.next_steps);
  lines.push("");
}

try {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const { cwd } = input;
  const project = cwd.split("/").pop() || "unknown";

  const tags = detectTags(cwd);
  const searchQuery = [project, ...tags.slice(0, 5)].join(" ");

  // Client-side federation: all three calls in parallel
  const [obResult, qmdResult, sessionResult] = await Promise.all([
    callMcp("open-brain", "search_brain", { query: searchQuery, limit: 7 }),
    callMcp("qmd", "search", { query: searchQuery, limit: 5 }),
    callMcp("open-brain", "session_load", { project }),
  ]);

  const results = fuse(normalizeBrain(obResult), normalizeQmd(qmdResult));

  const lines: string[] = [];

  if (results.length > 0) {
    lines.push(`<!-- PAI Brain Context for ${project} -->`);
    lines.push(`<!-- Detected tags: ${tags.map((t) => "#" + t).join(" ")} -->`);
    lines.push("");
    lines.push("## Relevant Past Learnings");
    lines.push("");
    for (const r of results) renderResult(r, lines);
  }

  // Session context section
  if (hasSessionPayload(sessionResult)) {
    renderSession(sessionResult as Record<string, unknown>, lines, project);
  }

  if (lines.length > 0) {
    lines.push("<!-- End PAI Brain Context -->");
    let output = lines.join("\n");
    if (output.length > MAX_OUTPUT_CHARS) {
      const omitted = output.length - MAX_OUTPUT_CHARS;
      output =
        output.slice(0, MAX_OUTPUT_CHARS) +
        `\n<!-- Truncated: ${omitted} chars omitted -->`;
    }
    console.log(output);
  }
} catch (err) {
  // Log but never block session start
  console.error(
    `open-brain session-load hook error: ${err instanceof Error ? err.message : JSON.stringify(err)}`,
  );
  process.exit(0);
}
