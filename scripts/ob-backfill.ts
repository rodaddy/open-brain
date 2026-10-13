#!/usr/bin/env node
/**
 * ob-backfill: Extract sessions from Claude Code JSONL transcripts and push to OB.
 *
 * Usage:
 *   bun scripts/ob-backfill.ts [--dir <path>] [--project <name>] [--dry-run] [--limit <n>] [--retry]
 *
 * Reads main conversation + subagent meta + file snapshots + history.jsonl dates.
 * Uses LLM to extract session summaries/decisions/learnings.
 * Pushes to OB with deterministic session_ids (idempotent — safe to re-run).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "util";
import { readdir, readFile, stat, writeFile, mkdir } from "fs/promises";
import { join, basename, dirname } from "path";
import { createHash } from "crypto";
import { existsSync } from "fs";
import { extractSession, type SessionExtract } from "./ob-backfill-extract.ts";
import { extractConversation, type JsonlEvent } from "./ob-backfill-transcript.ts";

const CLAUDE_PROJECTS_DIR =
  process.env.CLAUDE_PROJECTS_DIR ?? join(process.env.HOME ?? "", ".claude/projects");

const HISTORY_FILE = join(process.env.HOME ?? "", ".claude/history.jsonl");

/** Failed sessions queue -- persisted locally for retry on next session-start/wrap */
const FAILED_QUEUE_PATH =
  process.env.BACKFILL_FAILED_QUEUE ??
  join(process.env.HOME ?? "", ".openclaw/workspace/.ob-backfill-failed.json");

interface FailedEntry {
  path: string;
  project: string;
  reason: string;
  timestamp: string;
}

async function loadFailedQueue(): Promise<FailedEntry[]> {
  try {
    const raw = await readFile(FAILED_QUEUE_PATH, "utf-8");
    return JSON.parse(raw) as FailedEntry[];
  } catch {
    return [];
  }
}

async function saveFailedQueue(queue: FailedEntry[]): Promise<void> {
  await mkdir(dirname(FAILED_QUEUE_PATH), { recursive: true });
  await writeFile(FAILED_QUEUE_PATH, JSON.stringify(queue, null, 2));
}

async function appendToFailedQueue(
  filePath: string,
  project: string,
  reason: string,
): Promise<void> {
  const queue = await loadFailedQueue();
  // Dedup by path
  const existing = queue.findIndex((e) => e.path === filePath);
  if (existing >= 0) queue.splice(existing, 1);
  queue.push({
    path: filePath,
    project,
    reason,
    timestamp: new Date().toISOString(),
  });
  await saveFailedQueue(queue);
}

async function removeFromFailedQueue(filePath: string): Promise<void> {
  const queue = await loadFailedQueue();
  const filtered = queue.filter((e) => e.path !== filePath);
  if (filtered.length !== queue.length) await saveFailedQueue(filtered);
}

interface HistoryEntry {
  display: string;
  project: string;
  sessionId: string;
  timestamp: number;
}

interface SubagentMeta {
  agentType: string;
  description: string;
}

// --- History index: sessionId → date + first prompt ---

async function loadHistoryIndex(): Promise<
  Map<string, { date: string; firstPrompt: string }>
> {
  const index = new Map<string, { date: string; firstPrompt: string }>();
  try {
    const content = await readFile(HISTORY_FILE, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as HistoryEntry;
      if (!entry.sessionId) continue;
      if (!index.has(entry.sessionId)) {
        const [date = ""] = new Date(entry.timestamp).toISOString().split("T");
        index.set(entry.sessionId, { date, firstPrompt: entry.display });
      }
    }
  } catch {
    // history.jsonl may not exist
  }
  return index;
}

// --- Project name parsing ---

function parseProjectName(dirName: string): string {
  const match = dirName.match(/-srv-dev-(.+)/);
  if (match?.[1]) return match[1];
  return dirName.replace(/^-/, "");
}

// --- Subagent meta loading ---

async function loadSubagentMetas(sessionDir: string): Promise<string[]> {
  const subagentsDir = join(sessionDir, "subagents");
  try {
    const files = await readdir(subagentsDir);
    const metas: string[] = [];
    for (const f of files) {
      if (!f.endsWith(".meta.json")) continue;
      try {
        const raw = await readFile(join(subagentsDir, f), "utf-8");
        const meta = JSON.parse(raw) as SubagentMeta;
        metas.push(`[${meta.agentType}] ${meta.description}`);
      } catch {
        // skip malformed
      }
    }
    return metas;
  } catch {
    return [];
  }
}

// --- Sanitization (see scripts/ob-backfill-sanitize.ts) ---

export { buildDecisionLogParams, sanitize } from "./ob-backfill-sanitize.ts";

import {
  buildDecisionLogParams,
  sanitize,
  sanitizeStructuralField,
} from "./ob-backfill-sanitize.ts";

// --- OB push ---

/**
 * Promisified execFile: node's callback spawn has no `.exited` promise, and
 * this is the shape that replaces it for the two bounded mcp2cli calls below.
 * Note it REJECTS on a non-zero exit rather than resolving with a code, so
 * every call site here handles that explicitly.
 */
const execFileAsync = promisify(execFile);

/**
 * Fire-and-forget mcp2cli call for the per-item logging tools. Extracted from
 * pushToOB, where the two loops were byte-identical apart from the tool name
 * and the params shape; the spawn options and awaited exit are unchanged.
 */
async function runObTool(tool: string, params: Record<string, unknown>): Promise<void> {
  // execFileAsync REJECTS on a non-zero exit where the previous `await
  // proc.exited` resolved with the code and ignored it. This call site is
  // deliberately fire-and-forget, so the catch preserves that: a failing
  // per-item log must not abort the backfill.
  try {
    await execFileAsync(
      "mcp2cli",
      ["open-brain", tool, "--params", JSON.stringify(params)],
      { encoding: "utf8" },
    );
  } catch {
    // Intentionally ignored -- matches the pre-migration behavior.
  }
}

/** Console display width for dry-run previews. Affects printing only. */
const PREVIEW_DISPLAY_WIDTH = 120;

/**
 * Prints the dry-run preview of one session. Hoisted out of pushToOB so that
 * function stays within the repo complexity rule; the printed lines are
 * unchanged apart from using a shared display width for the field previews.
 */
function logDryRun(
  extract: SessionExtract,
  sessionId: string,
  project: string,
  date: string | undefined,
): void {
  console.log(`  [DRY RUN] session_id: ${sessionId}`);
  console.log(`    project: ${project}`);
  if (date) console.log(`    date: ${date}`);
  console.log(`    summary: ${sanitize(extract.summary).slice(0, 150)}...`);
  console.log(
    `    decisions: ${extract.key_decisions.length}, learnings: ${extract.learnings.length}, next_steps: ${extract.next_steps.length}, blockers: ${extract.blockers.length}`,
  );
  const previews: Array<[string, string[]]> = [
    ["decision", extract.key_decisions],
    ["learning", extract.learnings],
    ["next_step", extract.next_steps],
    ["blocker", extract.blockers],
  ];
  for (const [label, values] of previews) {
    const [first] = values;
    if (first === undefined) continue;
    const preview = sanitize(first).slice(0, PREVIEW_DISPLAY_WIDTH);
    console.log(`    ${label}[0]: ${preview}`);
  }
}

/**
 * Runs session_save and reports whether it succeeded. Hoisted out of pushToOB
 * so that function stays within the repo complexity rule; the spawn, the
 * failure print, and the saved-line print are unchanged.
 */
async function saveSession(params: string): Promise<boolean> {
  // The failure branch below prints the child's STDOUT, so the rejection has
  // to be caught rather than propagated: execFile attaches the captured
  // stdout/stderr to the thrown error, and that is the only place it survives
  // on a non-zero exit.
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "mcp2cli",
      ["open-brain", "session_save", "--params", params],
      { encoding: "utf8" },
    ));
  } catch (error) {
    const failed = error as { stdout?: string; message?: string };
    const detail = failed.stdout ?? failed.message ?? "";
    console.error(`  session_save failed: ${detail.slice(0, 200)}`);
    return false;
  }

  const result = JSON.parse(stdout);
  const id = result.result?.id ?? "?";
  const merged = result.result?.merged ?? false;
  console.log(`  session: saved (id: ${id}, merged: ${merged})`);
  return true;
}

async function pushToOB(
  extract: SessionExtract,
  sessionId: string,
  dryRun: boolean,
): Promise<boolean> {
  const project = sanitizeStructuralField(extract.project);
  const date = extract.date ? sanitizeStructuralField(extract.date) : undefined;

  if (dryRun) {
    logDryRun(extract, sessionId, project, date);
    return true;
  }

  const params = JSON.stringify({
    session_id: sessionId,
    project,
    summary: sanitize(extract.summary),
    tags: ["backfill", project, ...(date ? [date] : [])],
    key_decisions: extract.key_decisions.map(sanitize),
    next_steps: extract.next_steps.map(sanitize),
    blockers: extract.blockers.map(sanitize),
  });

  if (!(await saveSession(params))) return false;

  for (const learning of extract.learnings) {
    await runObTool("log_thought", {
      content: sanitize(learning),
      tags: ["backfill", project],
    });
  }

  for (const decision of extract.key_decisions) {
    await runObTool("log_decision", buildDecisionLogParams(decision, project));
  }

  const counts = [
    extract.learnings.length > 0 ? `${extract.learnings.length} learnings` : null,
    extract.key_decisions.length > 0
      ? `${extract.key_decisions.length} decisions`
      : null,
  ]
    .filter(Boolean)
    .join(", ");
  if (counts) console.log(`  also logged: ${counts}`);

  return true;
}

// --- Process a single JSONL file ---

interface WorkItem {
  filePath: string;
  sessionDir: string | null;
  project: string;
  historyInfo: { date: string; firstPrompt: string } | undefined;
}

/** Parses a JSONL transcript, skipping lines that do not parse. */
async function readJsonlEvents(jsonlPath: string): Promise<JsonlEvent[]> {
  const content = await readFile(jsonlPath, "utf-8");
  const lines: JsonlEvent[] = [];
  for (const l of content.split("\n")) {
    if (!l.trim()) continue;
    try {
      lines.push(JSON.parse(l) as JsonlEvent);
    } catch {
      // skip malformed JSONL lines
    }
  }
  return lines;
}

async function processSession(item: WorkItem, dryRun: boolean): Promise<boolean> {
  const { filePath: jsonlPath, sessionDir, project, historyInfo } = item;
  const lines = await readJsonlEvents(jsonlPath);

  const humanCount = lines.filter(
    (l) => l.type === "human" || l.type === "user",
  ).length;
  if (humanCount < 3) return false;

  const { text, filesChanged, branch } = extractConversation(lines);
  if (text.length < 200) return false;

  // Load subagent metas if session dir exists
  const subagents = sessionDir ? await loadSubagentMetas(sessionDir) : [];

  const sessionId = `backfill-${createHash("sha256").update(jsonlPath).digest("hex").slice(0, 16)}`;
  const date = historyInfo?.date;

  console.log(
    `\n  ${basename(jsonlPath, ".jsonl")}${date ? ` (${date})` : ""} — ${humanCount} turns, ${subagents.length} subagents, ${filesChanged.length} files${branch ? `, branch: ${branch}` : ""}`,
  );

  const extract = await extractSession(text, {
    project,
    subagents,
    filesChanged,
    date,
  });
  if (!extract || !extract.summary) {
    console.log(`  Skipped: extraction returned empty`);
    await appendToFailedQueue(
      jsonlPath,
      project,
      "extraction returned empty or LLM unavailable",
    );
    return false;
  }

  const pushed = await pushToOB(extract, sessionId, dryRun);
  if (pushed) {
    // Successfully pushed -- remove from failed queue if it was there
    await removeFromFailedQueue(jsonlPath);
  } else {
    await appendToFailedQueue(jsonlPath, project, "OB push failed");
  }
  return pushed;
}

// --- Main ---

type HistoryIndex = Map<string, { date: string; firstPrompt: string }>;

/**
 * Re-processes the sessions in the failed queue. Hoisted out of main so that
 * function stays within the repo function-size rule; the sequence of reads,
 * prints, and queue updates is unchanged.
 */
async function runRetryMode(dryRun: boolean): Promise<void> {
  const queue = await loadFailedQueue();
  if (queue.length === 0) {
    console.log("ob-backfill: no failed sessions to retry.");
    return;
  }
  console.log(`ob-backfill: retrying ${queue.length} failed session(s)...\n`);
  const historyIndex = await loadHistoryIndex();
  let retryPushed = 0;
  for (const entry of queue) {
    if (!existsSync(entry.path)) {
      console.log(
        `  ${basename(entry.path)} -- file no longer exists, removing from queue`,
      );
      await removeFromFailedQueue(entry.path);
      continue;
    }
    const sessionUuid = basename(entry.path, ".jsonl");
    const parentDir = dirname(entry.path);
    const sessionDir = existsSync(join(parentDir, sessionUuid))
      ? join(parentDir, sessionUuid)
      : null;
    console.log(`  Retrying: ${basename(entry.path)} (${entry.project})`);
    const success = await processSession(
      {
        filePath: entry.path,
        sessionDir,
        project: entry.project,
        historyInfo: historyIndex.get(sessionUuid),
      },
      dryRun,
    );
    if (success) retryPushed++;
  }
  const remaining = await loadFailedQueue();
  console.log(`\n--- Retry Summary ---`);
  console.log(`Retried: ${queue.length}`);
  console.log(`Pushed: ${retryPushed}`);
  console.log(`Still failing: ${remaining.length}`);
}

/** Transcript files under one project directory, paired with their session dir. */
async function collectProjectWorkItems(
  dirPath: string,
  project: string,
  perProject: number,
  historyIndex: HistoryIndex,
): Promise<WorkItem[]> {
  const entries = await readdir(dirPath);
  const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl")).slice(0, perProject);
  if (jsonlFiles.length === 0) return [];

  const sessionDirs = new Set(
    entries.filter((f) => !f.endsWith(".jsonl") && !f.startsWith(".")),
  );

  return jsonlFiles.map((file) => {
    const sessionUuid = basename(file, ".jsonl");
    return {
      filePath: join(dirPath, file),
      sessionDir: sessionDirs.has(sessionUuid) ? join(dirPath, sessionUuid) : null,
      project,
      historyInfo: historyIndex.get(sessionUuid),
    };
  });
}

/** Walks the projects directory and builds the full work list. */
async function collectWorkItems(options: {
  projectsDir: string;
  filterProject: string | undefined;
  perProject: number;
  historyIndex: HistoryIndex;
}): Promise<WorkItem[]> {
  const { projectsDir, filterProject, perProject, historyIndex } = options;
  const workItems: WorkItem[] = [];
  const projectDirs = await readdir(projectsDir);

  for (const dirName of projectDirs.sort()) {
    const project = parseProjectName(dirName);
    if (filterProject && project !== filterProject) continue;

    const dirPath = join(projectsDir, dirName);
    const dirStat = await stat(dirPath);
    if (!dirStat.isDirectory()) continue;

    workItems.push(
      ...(await collectProjectWorkItems(dirPath, project, perProject, historyIndex)),
    );
  }
  return workItems;
}

/** Prints the `=== project ===` header when a batch enters a new project. */
function announceProjects(
  batch: WorkItem[],
  workItems: WorkItem[],
  currentProject: string,
): string {
  let seen = currentProject;
  for (const item of batch) {
    if (item.project === seen) continue;
    seen = item.project;
    const count = workItems.filter((w) => w.project === item.project).length;
    console.log(`\n=== ${item.project} (${count} sessions) ===`);
  }
  return seen;
}

/** Runs the work list in batches of `concurrency` and tallies the outcomes. */
async function runBatches(
  workItems: WorkItem[],
  concurrency: number,
  dryRun: boolean,
): Promise<{
  totalProcessed: number;
  totalPushed: number;
  totalSkipped: number;
}> {
  let totalProcessed = 0;
  let totalPushed = 0;
  let totalSkipped = 0;
  let currentProject = "";

  for (let i = 0; i < workItems.length; i += concurrency) {
    const batch = workItems.slice(i, i + concurrency);
    currentProject = announceProjects(batch, workItems, currentProject);

    const results = await Promise.allSettled(
      batch.map((item) => processSession(item, dryRun)),
    );

    for (const result of results) {
      totalProcessed++;
      if (result.status === "fulfilled" && result.value) totalPushed++;
      else totalSkipped++;
    }
  }

  return { totalProcessed, totalPushed, totalSkipped };
}

/**
 * Prints the run summary and the failed-queue status. Hoisted out of main so
 * that function stays within the repo complexity rule; the printed lines and
 * the queue read are unchanged.
 */
async function reportSummary(
  totals: { totalProcessed: number; totalPushed: number; totalSkipped: number },
  dryRun: boolean,
): Promise<void> {
  const failedQueue = await loadFailedQueue();

  console.log(`\n--- Summary ---`);
  console.log(`Processed: ${totals.totalProcessed}`);
  console.log(`Pushed to OB: ${totals.totalPushed}`);
  console.log(`Skipped (too short or extraction failed): ${totals.totalSkipped}`);
  if (failedQueue.length > 0) {
    console.log(
      `\n⚠️  ${failedQueue.length} session(s) in failed queue (${FAILED_QUEUE_PATH})`,
    );
    console.log(`   Run with --retry to re-process them.`);
    for (const entry of failedQueue.slice(0, 5)) {
      console.log(`   - ${basename(entry.path)} (${entry.project}): ${entry.reason}`);
    }
    if (failedQueue.length > 5) {
      console.log(`   ... and ${failedQueue.length - 5} more`);
    }
  }
  if (dryRun) console.log("(dry-run mode — nothing was written)");
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      dir: { type: "string", default: CLAUDE_PROJECTS_DIR },
      project: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      retry: { type: "boolean", default: false },
      limit: { type: "string", default: "10" },
      concurrency: { type: "string", default: "1" },
    },
  });

  const projectsDir = values.dir ?? CLAUDE_PROJECTS_DIR;
  const filterProject = values.project;
  const dryRun = values["dry-run"] ?? false;
  const retryMode = values.retry ?? false;
  const limit = parseInt(values.limit ?? "10", 10);
  const concurrency = parseInt(values.concurrency ?? "1", 10);

  if (retryMode) {
    await runRetryMode(dryRun);
    return;
  }

  console.log(`ob-backfill: scanning ${projectsDir}`);
  if (dryRun) console.log("  MODE: dry-run (no OB writes)");
  console.log(`  LIMIT: ${limit} sessions per project`);
  console.log(`  CONCURRENCY: ${concurrency} parallel workers\n`);

  // Load history index for date resolution
  console.log("Loading history index...");
  const historyIndex = await loadHistoryIndex();
  console.log(`  ${historyIndex.size} sessions indexed from history.jsonl\n`);

  const workItems = await collectWorkItems({
    projectsDir,
    filterProject,
    perProject: limit,
    historyIndex,
  });

  console.log(`Total sessions to process: ${workItems.length}\n`);

  const { totalProcessed, totalPushed, totalSkipped } = await runBatches(
    workItems,
    concurrency,
    dryRun,
  );

  await reportSummary({ totalProcessed, totalPushed, totalSkipped }, dryRun);
}

if (import.meta.main) {
  main().catch(console.error);
}
