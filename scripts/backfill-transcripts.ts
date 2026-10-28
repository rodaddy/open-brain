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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { createPool } from "./settings.ts";

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

/** The project dir name encodes the cwd: -srv-dev-foo */
function repoOf(dir: string): string | null {
  const m = dir.match(/^-srv-dev-(.+)$/);
  return m ? (m[1] ?? null) : dir === "-srv-dev" ? "Development" : null;
}

// NUL is illegal in Postgres text at all. It is stripped with a string split
// rather than a regex: a control escape inside a pattern is what oxlint's
// no-control-regex flags, and both spellings remove exactly the same bytes.
const NUL = String.fromCharCode(0);
/** Make a string storable: no NUL, no lone surrogates, no invalid sequences. */
function sanitize(s: string): string {
  return (
    s
      .split(NUL)
      .join("")
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
function extractString(content: string): { text: string; kind: string } | null {
  const t = content.trim();
  if (!t) return null;
  // Injected machinery, not typed input.
  if (t.startsWith("<") && /^<[a-z-]+(-[a-z]+)*>/i.test(t)) return null;
  if (t.startsWith("Caveat:") || t.startsWith("## Development Policy Refresh")) {
    return null;
  }
  return { text: sanitize(content), kind: "text" };
}

/** The text pieces of a tool_result block, whose content is string or blocks. */
function toolResultParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (inner) =>
        inner &&
        typeof inner === "object" &&
        (inner as { type?: string }).type === "text",
    )
    .map((inner) => (inner as { text?: string }).text ?? "");
}

/** One content block's contribution: its text, and the kind it implies. */
function blockParts(block: unknown): { parts: string[]; kind?: string } {
  if (!block || typeof block !== "object") return { parts: [] };
  const type = (block as { type?: string }).type;
  if (type === "text") {
    const t = (block as { text?: string }).text ?? "";
    return { parts: t.trim() ? [t] : [] };
  }
  if (type === "tool_result") {
    return {
      parts: toolResultParts((block as { content?: unknown }).content),
      kind: "tool_result",
    };
  }
  if (type === "tool_use") {
    const name = (block as { name?: string }).name ?? "tool";
    const input = JSON.stringify((block as { input?: unknown }).input ?? {});
    return { parts: [`[${name}] ${input}`], kind: "tool_use" };
  }
  // `thinking` and anything unrecognised contribute nothing: not on screen, and
  // not the operator's words.
  return { parts: [] };
}

function extract(msg: unknown): { text: string; kind: string } | null {
  if (!msg || typeof msg !== "object") return null;
  const content = (msg as { content?: unknown }).content;

  if (typeof content === "string") return extractString(content);
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  let kind = "text";
  for (const b of content) {
    const got = blockParts(b);
    parts.push(...got.parts);
    if (got.kind) kind = got.kind;
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

/** One transcript line, parsed; null for blank, unparseable, or out-of-scope. */
function parseLine(
  line: string,
): { record: Record<string, unknown>; type: string; ts: string } | null {
  if (!line.trim()) return null;
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  const type = record.type as string | undefined;
  if (type !== "user" && type !== "assistant") return null;
  const ts = record.timestamp as string | undefined;
  if (!ts || new Date(ts) < SINCE) return null;
  return { record, type, ts };
}

function readTranscript(path: string, sessionRef: string, repo: string | null): Turn[] {
  const out: Turn[] = [];
  let index = 0;
  const raw = readFileSync(path, "utf8");

  for (const line of raw.split("\n")) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const { record: j, type, ts } = parsed;

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
      // The flag everything downstream keys on: what the operator actually
      // typed. A tool_result arrives with role=user and is NOT a human prompt.
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

/**
 * Insert one turn. Returns true when a row was written, false on a duplicate
 * that `ON CONFLICT DO NOTHING` swallowed.
 */
async function insertTurn(db: pg.Pool, t: Turn): Promise<boolean> {
  const hash = createHash("sha256").update(t.content).digest("hex");
  const r = await db.query(
    // occurred_at IS THE ORDERING KEY AND MUST BE WRITTEN.
    //
    // The first version named only created_at and bound the transcript
    // timestamp to it, leaving occurred_at NULL on all 20,535 backfilled
    // rows -- 77% of the table. Nothing failed: the insert succeeded and the
    // row counts looked right. The rows were simply invisible to every
    // time-windowed query, and 036:60 derives session_seq by
    // `ORDER BY occurred_at, id`, so 17,554 rows also came out with no
    // sequence. Measured 2026-07-28.
    //
    // 032:158-161 states the contract this violated: "occurred_at is
    // Graphiti's reference_time: when the turn HAPPENED... created_at would
    // silently scramble the conversation." A backfill is exactly the case it
    // describes -- three days of history stored in one minute -- so writing
    // only created_at dates the whole corpus to the moment the script ran.
    //
    // Both are written, deliberately: occurred_at = when it was said, from
    // the transcript; created_at = when it was stored.
    `INSERT INTO ob_raw_turns
           (namespace, turn_uuid, parent_turn_uuid, session_ref, repo, turn_index,
            role, is_human_prompt, content, metadata, content_hash, runtime,
            redaction_applied, created_by, retention_tier, occurred_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'{}'::jsonb,$13,'live',$14,$14)
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
  return Boolean(r.rowCount);
}

/** Insert one slice, returning its new-row and duplicate-row tallies. */
async function insertBatch(
  db: pg.Pool,
  batch: Turn[],
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;
  for (const t of batch) {
    if (await insertTurn(db, t)) inserted += 1;
    else skipped += 1;
  }
  return { inserted, skipped };
}

const pool = createPool();
let inserted = 0;
let skipped = 0;
try {
  for (let i = 0; i < all.length; i += 200) {
    const counts = await insertBatch(pool, all.slice(i, i + 200));
    inserted += counts.inserted;
    skipped += counts.skipped;
    console.log(
      `  ${Math.min(i + 200, all.length)}/${all.length} (${inserted} new, ${skipped} dupe)`,
    );
  }
  console.log(`\ninserted ${inserted}, already present ${skipped}`);
} finally {
  await pool.end();
}
