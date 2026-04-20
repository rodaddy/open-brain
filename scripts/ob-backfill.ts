#!/usr/bin/env bun
/**
 * ob-backfill: Extract sessions from Claude Code JSONL transcripts and push to OB.
 *
 * Usage:
 *   bun scripts/ob-backfill.ts [--dir <path>] [--project <name>] [--dry-run] [--limit <n>]
 *
 * Scans JSONL transcripts, uses LLM to extract session summaries/decisions/learnings,
 * pushes to OB with deterministic session_ids (idempotent — safe to re-run).
 */

import { parseArgs } from "util";
import { readdir, readFile, stat } from "fs/promises";
import { join, basename } from "path";
import { createHash } from "crypto";

const CLAUDE_PROJECTS_DIR =
  process.env.CLAUDE_PROJECTS_DIR ??
  join(process.env.HOME ?? "", ".claude/projects");

const LITELLM_URL = process.env.LITELLM_URL ?? "http://10.71.20.53:4000";
const EXTRACTION_MODEL = process.env.EXTRACTION_MODEL ?? "flash";

interface SessionExtract {
  summary: string;
  key_decisions: string[];
  learnings: string[];
  next_steps: string[];
  blockers: string[];
  project: string;
  branch?: string;
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

function parseProjectName(dirName: string): string {
  const match = dirName.match(/-Volumes-ThunderBolt-Development-(.+)/);
  if (match) return match[1]!;
  return dirName.replace(/^-/, "");
}

function extractConversation(lines: JsonlEvent[]): string {
  const parts: string[] = [];
  let branch: string | undefined;
  let cwd: string | undefined;

  for (const event of lines) {
    if (event.gitBranch && !branch) branch = event.gitBranch;
    if (event.cwd && !cwd) cwd = event.cwd;

    if (event.type === "human" || event.type === "user") {
      const content = event.message?.content;
      if (typeof content === "string") {
        parts.push(`USER: ${content.slice(0, 500)}`);
      } else if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type === "text" && c.text) {
            parts.push(`USER: ${c.text.slice(0, 500)}`);
          }
        }
      }
    } else if (event.type === "assistant") {
      const content = event.message?.content;
      if (typeof content === "string") {
        parts.push(`ASSISTANT: ${content.slice(0, 500)}`);
      } else if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type === "text" && c.text) {
            parts.push(`ASSISTANT: ${c.text.slice(0, 500)}`);
          }
        }
      }
    }
  }

  return parts.join("\n\n").slice(0, 12000);
}

async function extractSession(
  conversation: string,
  project: string,
): Promise<SessionExtract | null> {
  const prompt = `You are extracting a structured session summary from a Claude Code transcript.

Project: ${project}

Extract:
1. summary: 2-3 paragraph narrative of what was accomplished and why it matters
2. key_decisions: array of decisions WITH rationale ("Chose X over Y because Z")
3. learnings: array of gotchas, patterns, or solutions discovered
4. next_steps: array of specific actionable items
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
        temperature: 0,
      }),
    });

    if (!response.ok) {
      console.error(`LLM extraction failed: ${response.status}`);
      return null;
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = json.choices?.[0]?.message?.content;
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Record<string, unknown>;
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
    };
  } catch (err) {
    console.error(
      `Extraction error: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

function sanitize(text: string): string {
  // Strip all control chars except newline (\n) and tab (\t)
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "").trim();
}

async function pushToOB(
  extract: SessionExtract,
  sessionId: string,
  dryRun: boolean,
): Promise<boolean> {
  if (dryRun) {
    console.log(`  [DRY RUN] Would push session_save:`);
    console.log(`    session_id: ${sessionId}`);
    console.log(`    project: ${extract.project}`);
    console.log(`    summary: ${extract.summary.slice(0, 100)}...`);
    console.log(`    decisions: ${extract.key_decisions.length}`);
    console.log(`    learnings: ${extract.learnings.length}`);
    return true;
  }

  const paramsObj = {
    session_id: sessionId,
    project: extract.project,
    summary: sanitize(extract.summary).replace(/\n/g, " "),
    tags: ["backfill", extract.project],
    key_decisions: extract.key_decisions.map((d) =>
      sanitize(d).replace(/\n/g, " "),
    ),
    next_steps: extract.next_steps.map((s) => sanitize(s).replace(/\n/g, " ")),
    blockers: extract.blockers.map((b) => sanitize(b).replace(/\n/g, " ")),
  };
  const params = JSON.stringify(paramsObj);

  const proc = Bun.spawn(
    ["mcp2cli", "open-brain", "session_save", "--params", params],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error(`  session_save failed: ${stdout}`);
    return false;
  }

  const result = JSON.parse(stdout);
  console.log(
    `  session: ${result.success ? "saved" : "failed"} (id: ${result.result?.id ?? "?"}, merged: ${result.result?.merged ?? false})`,
  );

  for (const learning of extract.learnings) {
    const lParams = JSON.stringify({
      content: learning,
      tags: ["backfill", extract.project],
    });
    const lProc = Bun.spawn(
      ["mcp2cli", "open-brain", "log_thought", "--params", lParams],
      { stdout: "pipe", stderr: "pipe" },
    );
    await lProc.exited;
  }
  if (extract.learnings.length > 0) {
    console.log(`  learnings: ${extract.learnings.length} logged`);
  }

  for (const decision of extract.key_decisions) {
    const parts = decision.split(" because ");
    const dParams = JSON.stringify({
      title: parts[0]!.slice(0, 200),
      rationale: parts[1] ?? decision,
      tags: ["backfill", extract.project],
    });
    const dProc = Bun.spawn(
      ["mcp2cli", "open-brain", "log_decision", "--params", dParams],
      { stdout: "pipe", stderr: "pipe" },
    );
    await dProc.exited;
  }
  if (extract.key_decisions.length > 0) {
    console.log(`  decisions: ${extract.key_decisions.length} logged`);
  }

  return true;
}

async function processJsonl(
  filePath: string,
  project: string,
  dryRun: boolean,
): Promise<boolean> {
  const content = await readFile(filePath, "utf-8");
  const lines = content
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as JsonlEvent);

  const humanCount = lines.filter(
    (l) => l.type === "human" || l.type === "user",
  ).length;
  if (humanCount < 3) {
    return false;
  }

  const conversation = extractConversation(lines);
  if (conversation.length < 200) {
    return false;
  }

  const sessionId = `backfill-${createHash("sha256").update(filePath).digest("hex").slice(0, 16)}`;

  console.log(
    `\n  Processing: ${basename(filePath)} (${lines.length} events, ${humanCount} user turns)`,
  );

  const extract = await extractSession(conversation, project);
  if (!extract || !extract.summary) {
    console.log(`  Skipped: extraction returned empty`);
    return false;
  }

  return pushToOB(extract, sessionId, dryRun);
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      dir: { type: "string", default: CLAUDE_PROJECTS_DIR },
      project: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      limit: { type: "string", default: "10" },
    },
  });

  const projectsDir = values.dir!;
  const filterProject = values.project;
  const dryRun = values["dry-run"]!;
  const limit = parseInt(values.limit!, 10);

  console.log(`ob-backfill: scanning ${projectsDir}`);
  if (dryRun) console.log("  MODE: dry-run (no OB writes)");
  console.log(`  LIMIT: ${limit} sessions per project`);

  const projectDirs = await readdir(projectsDir);
  let totalProcessed = 0;
  let totalPushed = 0;

  for (const dirName of projectDirs) {
    const project = parseProjectName(dirName);
    if (filterProject && project !== filterProject) continue;

    const dirPath = join(projectsDir, dirName);
    const dirStat = await stat(dirPath);
    if (!dirStat.isDirectory()) continue;

    const files = (await readdir(dirPath))
      .filter((f) => f.endsWith(".jsonl"))
      .slice(0, limit);

    if (files.length === 0) continue;

    console.log(`\n=== ${project} (${files.length} sessions) ===`);

    for (const file of files) {
      const filePath = join(dirPath, file);
      totalProcessed++;
      const success = await processJsonl(filePath, project, dryRun);
      if (success) totalPushed++;
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`Processed: ${totalProcessed}`);
  console.log(`Pushed to OB: ${totalPushed}`);
  if (dryRun) console.log("(dry-run mode — nothing was written)");
}

main().catch(console.error);
