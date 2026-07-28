/**
 * Backfill ob_raw_turns from the Claude Code transcripts on disk.
 *
 * WHY THIS EXISTS. Measured 2026-07-28: across all projects since 2026-07-25
 * 21:00, the transcripts hold 1,236 operator messages. ob_raw_turns held 329.
 * Three defects in the deployed capture hook, none of them a policy anyone
 * chose:
 *
 *   raw-turns.ts:188  `Math.min(options.limit ?? 8, MAX_BATCH)` -- each Stop
 *                     hook reads only the last EIGHT transcript entries. That is
 *                     fine when a turn is one entry and wrong the moment the
 *                     agent makes tool calls, because every call and every
 *                     result is its own entry. A turn with six commands is 13+
 *                     entries, so the operator's message scrolls out of the
 *                     window and nothing ever comes back for it.
 *   raw-turns.ts:31   TAIL_BYTES = 1 MB, so a long transcript cannot be fully
 *                     re-read even if the limit were raised.
 *   (no watermark)    There is no cursor, offset, queue, or drain anywhere in
 *                     the adapter -- verified by search. Each hook reads the
 *                     tail and forgets. A missed entry is missed permanently.
 *
 * The transcripts themselves are complete and untouched by any of this, so the
 * corpus is fully recoverable. This script is the recovery.
 *
 * WHY IT WRITES SQL DIRECTLY. The normal path is the wheel-packaged ingest
 * adapter, which is exactly the thing that is broken, and its source is not
 * checked out anywhere in the fleet. A one-time recovery through the same
 * broken component would inherit its limits.
 *
 * IDEMPOTENT BY turn_uuid. Every transcript line carries a stable `uuid` from
 * the runtime, so re-running this is free and partial runs are safe to resume.
 * ON CONFLICT DO NOTHING against the existing unique index does the work.
 *
 * WHAT IS INGESTED, and the operator's rule it follows (2026-07-28): "all of the
 * actual things that end up on the screen that I see should all be ingested."
 * So: operator messages and assistant messages, both in full. tool_result
 * entries are recorded too -- raw-turns.ts:93 is explicit that the raw lane does
 * NOT discard them, unlike the distilled lane -- but they are marked in metadata
 * so a later stage can exclude them without re-deriving what they were.
 *
 * NOT INGESTED: system reminders, hook injections, and meta blocks. Those are
 * machinery the operator never typed and never read as conversation. They are
 * what `<system-reminder>` wrappers mark, and treating them as operator turns is
 * how a capture corpus fills with its own plumbing.
 */

import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createPool } from "../src/db/pool.ts";

const PROJECTS = `${process.env.HOME}/.claude/projects`;
// Operator scope, 2026-07-28: "we can go back to Sunday so or Saturday night
// say 9 PM until now". Everything earlier is explicitly out of scope for this
// run -- it is a different corpus and a different decision.
const SINCE = new Date("2026-07-25T21:00:00-04:00");
const NAMESPACE = process.env.OPENBRAIN_NAMESPACE ?? "rico";
const DRY = !process.argv.includes("--write");

type Turn = {
  turn_uuid: string;
  parent_turn_uuid: string | null;
  session_ref: string;
  repo: string | null;
  turn_index: number;
  role: string;
  is_human_prompt: boolean;
  content: string;
  occurred_at: string;
  kind: string;
};

/** The project dir name encodes the cwd: -Volumes-ThunderBolt-Development-foo */
function repoOf(dir: string): string | null {
  const m = dir.match(/^-Volumes-ThunderBolt-Development-(.+)$/);
  return m
    ? m[1]
    : dir === "-Volumes-ThunderBolt-Development"
      ? "Development"
      : null;
}

/** Make a string storable: no NUL, no lone surrogates, no invalid sequences. */
function sanitize(s: string): string {
  return (
    s
      .replace(/\u0000/g, "")
      // Lone surrogates survive JSON.parse but are not valid UTF-8 on the wire.
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
      .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
  );
}

/**
 * Pull the readable text out of a transcript message.
 *
 * Returns null for anything that is machinery rather than conversation. The
 * `<system-reminder>` / hook-output wrappers are injected into the user role by
 * the runtime, so role alone cannot tell them apart from something typed.
 */
function extract(msg: unknown): { text: string; kind: string } | null {
  if (!msg || typeof msg !== "object") return null;
  const content = (msg as { content?: unknown }).content;

  if (typeof content === "string") {
    const t = content.trim();
    if (!t) return null;
    // Injected machinery, not typed input.
    if (t.startsWith("<") && /^<[a-z-]+(-[a-z]+)*>/i.test(t)) return null;
    if (
      t.startsWith("Caveat:") ||
      t.startsWith("## Development Policy Refresh")
    )
      return null;
    return { text: sanitize(content), kind: "text" };
  }

  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  let kind = "text";
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const type = (b as { type?: string }).type;
    if (type === "text") {
      const t = (b as { text?: string }).text ?? "";
      if (t.trim()) parts.push(t);
    } else if (type === "tool_result") {
      kind = "tool_result";
      const c = (b as { content?: unknown }).content;
      if (typeof c === "string") parts.push(c);
      else if (Array.isArray(c)) {
        for (const inner of c) {
          if (
            inner &&
            typeof inner === "object" &&
            (inner as { type?: string }).type === "text"
          ) {
            parts.push((inner as { text?: string }).text ?? "");
          }
        }
      }
    } else if (type === "tool_use") {
      kind = "tool_use";
      const name = (b as { name?: string }).name ?? "tool";
      const input = JSON.stringify((b as { input?: unknown }).input ?? {});
      parts.push(`[${name}] ${input}`);
    } else if (type === "thinking") {
      // Deliberately skipped: not on screen, and not the operator's words.
      continue;
    }
  }

  // Tool output carries raw terminal bytes -- ANSI escapes, lone surrogates,
  // and NUL. Postgres rejects all three (22021 invalid byte sequence, and NUL
  // is illegal in text at all), so a single unsanitized tool result aborts the
  // whole backfill. Strip rather than skip: the turn is still the record of
  // what happened, and the bytes carry no meaning once rendered.
  const text = sanitize(parts.join("\n").trim());
  if (!text) return null;
  // A system-reminder that arrived as a content block is still machinery.
  if (kind === "text" && text.startsWith("<system-reminder>")) return null;
  return { text, kind };
}

function readTranscript(
  path: string,
  sessionRef: string,
  repo: string | null,
): Turn[] {
  const out: Turn[] = [];
  let index = 0;
  const raw = require("node:fs").readFileSync(path, "utf8") as string;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }

    const type = j.type as string | undefined;
    if (type !== "user" && type !== "assistant") continue;

    const ts = j.timestamp as string | undefined;
    if (!ts || new Date(ts) < SINCE) continue;

    const got = extract(j.message);
    if (!got) continue;

    const uuid =
      (j.uuid as string) ??
      createHash("sha256")
        .update(`${sessionRef}:${index}:${got.text.slice(0, 200)}`)
        .digest("hex")
        .slice(0, 36);

    out.push({
      turn_uuid: uuid,
      parent_turn_uuid: (j.parentUuid as string) ?? null,
      session_ref: sessionRef,
      repo,
      turn_index: index++,
      role: type === "user" && got.kind !== "text" ? "tool" : type,
      // The load-bearing flag: what the operator actually typed. A tool_result
      // arrives with role=user and is NOT a human prompt.
      is_human_prompt: type === "user" && got.kind === "text",
      content: got.text,
      occurred_at: ts,
      kind: got.kind,
    });
  }
  return out;
}

const all: Turn[] = [];
for (const dir of readdirSync(PROJECTS)) {
  const full = join(PROJECTS, dir);
  let files: string[];
  try {
    files = readdirSync(full).filter((f) => f.endsWith(".jsonl"));
  } catch {
    continue;
  }
  const repo = repoOf(dir);
  for (const f of files) {
    const p = join(full, f);
    if (statSync(p).mtime < SINCE) continue;
    all.push(...readTranscript(p, p, repo));
  }
}

const human = all.filter((t) => t.is_human_prompt).length;
const asst = all.filter((t) => t.role === "assistant").length;
const tool = all.filter((t) => t.role === "tool").length;

console.log(`parsed ${all.length} turns since ${SINCE.toISOString()}`);
console.log(`  ${human} operator, ${asst} assistant, ${tool} tool`);

if (DRY) {
  console.log("\nDRY RUN. Re-run with --write to insert.");
  process.exit(0);
}

const pool = createPool();
let inserted = 0;
let skipped = 0;
try {
  for (let i = 0; i < all.length; i += 200) {
    const batch = all.slice(i, i + 200);
    for (const t of batch) {
      const hash = createHash("sha256").update(t.content).digest("hex");
      const r = await pool.query(
        `INSERT INTO ob_raw_turns
           (namespace, turn_uuid, parent_turn_uuid, session_ref, repo, turn_index,
            role, is_human_prompt, content, metadata, content_hash, runtime,
            redaction_applied, created_by, retention_tier, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'{}'::jsonb,$13,'live',$14)
         ON CONFLICT (namespace, turn_uuid) DO NOTHING
         RETURNING id`,
        [
          NAMESPACE,
          t.turn_uuid,
          t.parent_turn_uuid,
          t.session_ref,
          t.repo,
          t.turn_index,
          t.role,
          t.is_human_prompt,
          t.content,
          JSON.stringify({
            kind: t.kind,
            backfilled: true,
            source: "transcript",
          }),
          hash,
          "claude",
          "backfill-transcripts",
          t.occurred_at,
        ],
      );
      if (r.rowCount) inserted++;
      else skipped++;
    }
    console.log(
      `  ${Math.min(i + 200, all.length)}/${all.length} (${inserted} new, ${skipped} dupe)`,
    );
  }
  console.log(`\ninserted ${inserted}, already present ${skipped}`);
} finally {
  await pool.end();
}
