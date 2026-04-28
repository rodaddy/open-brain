#!/usr/bin/env bun
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

import { parseArgs } from "util";
import { readdir, readFile, stat, writeFile, mkdir } from "fs/promises";
import { join, basename, dirname } from "path";
import { createHash } from "crypto";
import { existsSync } from "fs";

const CLAUDE_PROJECTS_DIR =
  process.env.CLAUDE_PROJECTS_DIR ??
  join(process.env.HOME ?? "", ".claude/projects");

const HISTORY_FILE = join(process.env.HOME ?? "", ".claude/history.jsonl");

// Falls back to a local LiteLLM instance — override via LITELLM_URL env var
const LITELLM_URL = process.env.LITELLM_URL ?? "http://localhost:4000";
const EXTRACTION_MODEL = process.env.EXTRACTION_MODEL ?? "sonnet";

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

interface SessionExtract {
  summary: string;
  key_decisions: string[];
  learnings: string[];
  next_steps: string[];
  blockers: string[];
  project: string;
  date?: string;
}

interface JsonlEvent {
  type: string;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string }>;
  };
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  timestamp?: string;
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
        const date = new Date(entry.timestamp).toISOString().split("T")[0]!;
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
  const match = dirName.match(/-Volumes-ThunderBolt-Development-(.+)/);
  if (match) return match[1]!;
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

// --- Conversation extraction ---

function extractTextContent(
  content: string | Array<{ type: string; text?: string }>,
): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n");
  }
  return "";
}

function extractConversation(lines: JsonlEvent[]): {
  text: string;
  filesChanged: string[];
  branch?: string;
} {
  const parts: string[] = [];
  const filesChanged = new Set<string>();
  let branch: string | undefined;

  for (const event of lines) {
    if (event.gitBranch && !branch) branch = event.gitBranch;

    if (event.type === "human" || event.type === "user") {
      const content = event.message?.content;
      if (content) {
        const text = extractTextContent(content).slice(0, 2000);
        if (text) parts.push(`USER: ${text}`);
      }
    } else if (event.type === "assistant") {
      const content = event.message?.content;
      if (content) {
        const text = extractTextContent(content).slice(0, 2000);
        if (text) parts.push(`ASSISTANT: ${text}`);
      }
    } else if (event.type === "file-history-snapshot") {
      // Extract file paths from snapshots
      const msg = event.message;
      if (msg && typeof msg === "object") {
        const content = (msg as Record<string, unknown>).content;
        if (typeof content === "string" && content.includes("/")) {
          // File paths often appear in content
          const pathMatch = content.match(
            /(?:\/[\w.-]+)+(?:\.(?:ts|js|sql|md|json|py|sh|yml|yaml))/g,
          );
          if (pathMatch) pathMatch.forEach((p) => filesChanged.add(p));
        }
      }
    }
  }

  // Smart sampling: first 3 turns for context, last 30% for outcomes, sample middle
  const total = parts.length;
  if (total <= 30) {
    // Short session — include everything
    return {
      text: parts.join("\n\n").slice(0, 12000),
      filesChanged: Array.from(filesChanged).slice(0, 20),
      branch,
    };
  }

  const head = parts.slice(0, 6); // first 3 exchanges for context
  const tailStart = Math.floor(total * 0.7);
  const tail = parts.slice(tailStart); // last 30% for outcomes
  const midStart = Math.floor(total * 0.3);
  const midEnd = Math.floor(total * 0.5);
  const mid = parts.slice(midStart, midEnd); // middle 20% for core work

  const sampled = [
    "--- SESSION START ---",
    ...head,
    `--- MIDDLE (turns ${midStart}-${midEnd} of ${total}) ---`,
    ...mid,
    `--- FINAL SECTION (turns ${tailStart}-${total} of ${total}) ---`,
    ...tail,
  ];

  return {
    text: sampled.join("\n\n").slice(0, 14000),
    filesChanged: Array.from(filesChanged).slice(0, 20),
    branch,
  };
}

// --- LLM extraction ---

async function extractSession(
  conversation: string,
  project: string,
  subagents: string[],
  filesChanged: string[],
  date?: string,
): Promise<SessionExtract | null> {
  const uniqueHash = createHash("sha256")
    .update(conversation.slice(0, 200))
    .digest("hex")
    .slice(0, 8);

  const contextParts = [
    `Project: ${project} [ref:${uniqueHash}]`,
    date ? `Date: ${date}` : "",
    subagents.length > 0
      ? `Subagent work delegated:\n${subagents.map((s) => `- ${s}`).join("\n")}`
      : "",
    filesChanged.length > 0
      ? `Files modified:\n${filesChanged.map((f) => `- ${f}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = `You are extracting a structured session summary from a Claude Code transcript.

${contextParts}

Extract:
1. summary: 2-3 paragraph narrative of what was accomplished, why it matters, and what state things ended in. Include specific file names, tool names, and technical details. A future AI agent should understand the session from this summary alone.
2. key_decisions: array of decisions WITH rationale ("Chose X over Y because Z"). Every session has at least one decision — if you can't find explicit ones, infer from the implementation choices.
3. learnings: array of gotchas, patterns, bugs found, or solutions discovered. Include enough context to be useful without the transcript.
4. next_steps: array of specific actionable items mentioned or implied
5. blockers: array of things that stalled progress (empty array if none)

Return JSON only, no markdown fences.

TRANSCRIPT:
${conversation}`;

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const apiKey = process.env.LITELLM_API_KEY;
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const response = await fetch(`${LITELLM_URL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: EXTRACTION_MODEL,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        max_tokens: 2048,
        temperature: 0.1,
        caching: false,
      }),
    });

    if (!response.ok) {
      console.error(`  LLM extraction failed: ${response.status}`);
      return null;
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = json.choices?.[0]?.message?.content;
    if (!raw) return null;

    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    return {
      summary: (parsed.summary as string) ?? "",
      key_decisions: Array.isArray(parsed.key_decisions)
        ? (parsed.key_decisions as string[])
        : [],
      learnings: Array.isArray(parsed.learnings)
        ? (parsed.learnings as string[])
        : [],
      next_steps: Array.isArray(parsed.next_steps)
        ? (parsed.next_steps as string[])
        : [],
      blockers: Array.isArray(parsed.blockers)
        ? (parsed.blockers as string[])
        : [],
      project,
      date,
    };
  } catch (err) {
    console.error(
      `  Extraction error: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

// --- Sanitization ---

function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "")
    .replace(/\n/g, " ")
    .trim();
}

// --- OB push ---

async function pushToOB(
  extract: SessionExtract,
  sessionId: string,
  dryRun: boolean,
): Promise<boolean> {
  if (dryRun) {
    console.log(`  [DRY RUN] session_id: ${sessionId}`);
    console.log(`    project: ${extract.project}`);
    if (extract.date) console.log(`    date: ${extract.date}`);
    console.log(`    summary: ${extract.summary.slice(0, 150)}...`);
    console.log(
      `    decisions: ${extract.key_decisions.length}, learnings: ${extract.learnings.length}, next_steps: ${extract.next_steps.length}`,
    );
    if (extract.key_decisions.length > 0)
      console.log(
        `    decision[0]: ${extract.key_decisions[0]!.slice(0, 120)}`,
      );
    if (extract.learnings.length > 0)
      console.log(`    learning[0]: ${extract.learnings[0]!.slice(0, 120)}`);
    return true;
  }

  const params = JSON.stringify({
    session_id: sessionId,
    project: extract.project,
    summary: sanitize(extract.summary),
    tags: [
      "backfill",
      extract.project,
      ...(extract.date ? [extract.date] : []),
    ],
    key_decisions: extract.key_decisions.map(sanitize),
    next_steps: extract.next_steps.map(sanitize),
    blockers: extract.blockers.map(sanitize),
  });

  const proc = Bun.spawn(
    ["mcp2cli", "open-brain", "session_save", "--params", params],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error(`  session_save failed: ${stdout.slice(0, 200)}`);
    return false;
  }

  const result = JSON.parse(stdout);
  const id = result.result?.id ?? "?";
  const merged = result.result?.merged ?? false;
  console.log(`  session: saved (id: ${id}, merged: ${merged})`);

  // Log learnings
  for (const learning of extract.learnings) {
    const lParams = JSON.stringify({
      content: sanitize(learning),
      tags: ["backfill", extract.project],
    });
    const lProc = Bun.spawn(
      ["mcp2cli", "open-brain", "log_thought", "--params", lParams],
      { stdout: "pipe", stderr: "pipe" },
    );
    await lProc.exited;
  }

  // Log decisions
  for (const decision of extract.key_decisions) {
    const parts = decision.split(" because ");
    const dParams = JSON.stringify({
      title: sanitize(parts[0]!).slice(0, 200),
      rationale: sanitize(parts[1] ?? decision),
      tags: ["backfill", extract.project],
    });
    const dProc = Bun.spawn(
      ["mcp2cli", "open-brain", "log_decision", "--params", dParams],
      { stdout: "pipe", stderr: "pipe" },
    );
    await dProc.exited;
  }

  const counts = [
    extract.learnings.length > 0
      ? `${extract.learnings.length} learnings`
      : null,
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

async function processSession(
  jsonlPath: string,
  sessionDir: string | null,
  project: string,
  historyInfo: { date: string; firstPrompt: string } | undefined,
  dryRun: boolean,
): Promise<boolean> {
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

  const extract = await extractSession(
    text,
    project,
    subagents,
    filesChanged,
    date,
  );
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

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      dir: { type: "string", default: CLAUDE_PROJECTS_DIR },
      project: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      retry: { type: "boolean", default: false },
      limit: { type: "string", default: "10" },
      concurrency: { type: "string", default: "1" },
    },
  });

  const projectsDir = values.dir!;
  const filterProject = values.project;
  const dryRun = values["dry-run"]!;
  const retryMode = values.retry!;
  const limit = parseInt(values.limit!, 10);
  const concurrency = parseInt(values.concurrency!, 10);

  // Retry mode: re-process only previously failed sessions
  if (retryMode) {
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
      const historyInfo = historyIndex.get(sessionUuid);
      console.log(`  Retrying: ${basename(entry.path)} (${entry.project})`);
      const success = await processSession(
        entry.path,
        sessionDir,
        entry.project,
        historyInfo,
        dryRun,
      );
      if (success) retryPushed++;
    }
    const remaining = await loadFailedQueue();
    console.log(`\n--- Retry Summary ---`);
    console.log(`Retried: ${queue.length}`);
    console.log(`Pushed: ${retryPushed}`);
    console.log(`Still failing: ${remaining.length}`);
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

  // Collect all work items first
  interface WorkItem {
    filePath: string;
    sessionDir: string | null;
    project: string;
    historyInfo: { date: string; firstPrompt: string } | undefined;
  }

  const workItems: WorkItem[] = [];
  const projectDirs = await readdir(projectsDir);

  for (const dirName of projectDirs.sort()) {
    const project = parseProjectName(dirName);
    if (filterProject && project !== filterProject) continue;

    const dirPath = join(projectsDir, dirName);
    const dirStat = await stat(dirPath);
    if (!dirStat.isDirectory()) continue;

    const entries = await readdir(dirPath);
    const jsonlFiles = entries
      .filter((f) => f.endsWith(".jsonl"))
      .slice(0, limit);
    if (jsonlFiles.length === 0) continue;

    const sessionDirs = new Set(
      entries.filter((f) => !f.endsWith(".jsonl") && !f.startsWith(".")),
    );

    for (const file of jsonlFiles) {
      const filePath = join(dirPath, file);
      const sessionUuid = basename(file, ".jsonl");
      const sessionDir = sessionDirs.has(sessionUuid)
        ? join(dirPath, sessionUuid)
        : null;
      const historyInfo = historyIndex.get(sessionUuid);
      workItems.push({ filePath, sessionDir, project, historyInfo });
    }
  }

  console.log(`Total sessions to process: ${workItems.length}\n`);

  let totalProcessed = 0;
  let totalPushed = 0;
  let totalSkipped = 0;
  let currentProject = "";

  // Process in batches of `concurrency`
  for (let i = 0; i < workItems.length; i += concurrency) {
    const batch = workItems.slice(i, i + concurrency);

    // Print project headers for new projects in this batch
    for (const item of batch) {
      if (item.project !== currentProject) {
        currentProject = item.project;
        const count = workItems.filter(
          (w) => w.project === item.project,
        ).length;
        console.log(`\n=== ${item.project} (${count} sessions) ===`);
      }
    }

    const results = await Promise.allSettled(
      batch.map((item) =>
        processSession(
          item.filePath,
          item.sessionDir,
          item.project,
          item.historyInfo,
          dryRun,
        ),
      ),
    );

    for (const result of results) {
      totalProcessed++;
      if (result.status === "fulfilled" && result.value) {
        totalPushed++;
      } else {
        totalSkipped++;
      }
    }
  }

  // Report failed queue status
  const failedQueue = await loadFailedQueue();

  console.log(`\n--- Summary ---`);
  console.log(`Processed: ${totalProcessed}`);
  console.log(`Pushed to OB: ${totalPushed}`);
  console.log(`Skipped (too short or extraction failed): ${totalSkipped}`);
  if (failedQueue.length > 0) {
    console.log(
      `\n⚠️  ${failedQueue.length} session(s) in failed queue (${FAILED_QUEUE_PATH})`,
    );
    console.log(`   Run with --retry to re-process them.`);
    for (const entry of failedQueue.slice(0, 5)) {
      console.log(
        `   - ${basename(entry.path)} (${entry.project}): ${entry.reason}`,
      );
    }
    if (failedQueue.length > 5)
      console.log(`   ... and ${failedQueue.length - 5} more`);
  }
  if (dryRun) console.log("(dry-run mode — nothing was written)");
}

main().catch(console.error);
