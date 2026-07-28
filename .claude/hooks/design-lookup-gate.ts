#!/usr/bin/env bun
/**
 * design-lookup-gate -- repo-local hard gate for open-brain.
 *
 * WHY THIS EXISTS
 *
 * The recurring failure in this repo is not bad research. It is *skipped*
 * research: a design already exists, is good, and gets ignored in favour of an
 * invented replacement that is worse. Measured instance (2026-07-27): three
 * "new" ideas -- idle-gap episodes, three-views storage, sliding context
 * windows -- were already specified in docs/dream-design.md and
 * docs/code-brain-design.md, better, and not one was proposed with a citation.
 *
 * Lookup is not expensive here. `aqmd "question"` and Open Brain recall are one
 * command each. So this gate does not try to make research cheaper; it makes
 * skipping it impossible for anything that MUTATES.
 *
 * WHAT IT CAN AND CANNOT DO -- read before extending.
 *
 * Hooks fire on tool calls and prompt submission. Nothing fires between the
 * model deciding to say something and that text reaching the operator. A gate
 * therefore CANNOT stop an unresearched idea from being *spoken*; it can only
 * stop that idea from becoming a file. That gap is closed socially, by the
 * citation-or-UNVERIFIED contract, not by code. Do not add a "block prose"
 * mode -- it is not implementable, and pretending otherwise gives false
 * assurance.
 *
 * MECHANISM
 *
 *   PostToolUse -- watch for a qualifying lookup; record it in session state.
 *   PreToolUse  -- on a mutating tool, require a non-stale lookup in this
 *                  session. Exit 2 blocks the call and hands stderr back to
 *                  the model as the reason.
 *
 * STALENESS IS ABOUT SUBJECT, NOT AGE.
 *
 * The first version counted tool calls: a lookup stayed valid for 25
 * gate-eligible calls regardless of what it was about. That is recency, and
 * recency is the wrong test. Measured failure, 2026-07-28: an `aqmd` about
 * frontend precedent reset the counter, and the gate then passed an edit to
 * `src/distiller.ts` that raised MAX_CANDIDATE_CHARS -- reinventing, badly, the
 * decomposition already specified in #192/#247 and implemented in
 * src/decomposition.ts. `aqmd search chunk` would have surfaced it in 0.11s.
 * The gate fired, found a "recent lookup", and allowed the exact class of edit
 * it exists to stop. A session that reads many design docs is permanently
 * unlocked -- the more diligent the session looks, the less the gate does.
 *
 * So a lookup now covers a SUBJECT, and the gate asks whether the file being
 * mutated is one this session actually looked into. Two ways to satisfy it:
 *
 *   1. Token overlap between the mutated path and a recorded lookup. Editing
 *      `src/distiller.ts` after `aqmd "distiller"` is informed; after
 *      `aqmd "frontend precedent"` it is not.
 *   2. A recent lookup that mentions the file's own basename.
 *
 * Age still applies as a backstop (MAX_TOOLS_SINCE_LOOKUP), because a matching
 * lookup from 200 calls ago is also not evidence. Both tests must pass.
 *
 * FAILING CLOSED ON RELEVANCE IS DELIBERATE. The cost of a false block is one
 * `aqmd` call, roughly a tenth of a second. The cost of a false pass is an hour
 * of rediscovering a design that was already written down. Those are not
 * symmetric, so the tie goes to blocking.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** Tools that write to the repo. These are what the gate protects. */
const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "NotebookEdit",
]);

/**
 * Bash mutates only sometimes, and blocking every Bash call would make the
 * gate unusable -- the lookup itself is a Bash call. So match write intent.
 */
const MUTATING_BASH =
  /\b(git\s+(commit|push|merge|rebase|reset)|psql[^|]*-c\s*["']?\s*(insert|update|delete|alter|drop|create)|bun\s+run\s+migrate)\b/i;

/** A call that counts as having consulted the existing design. */
const LOOKUP_BASH =
  /\b(aqmd|qmd\s+(query|search|get)|ob-memory-provider|brain_answer|brain_search)\b/i;

/** Design documents whose Read counts as a lookup. */
const DESIGN_DOC =
  /docs\/(dream-design|code-brain-design|full-send-derivation-spec|memory-contract|dream-ethereal-runs|qmd-ob-layered-recall|decisions\/|sme\/|prior-art\/)/;

/**
 * How many gate-eligible calls a lookup stays valid for. This is now only the
 * age backstop; relevance is the primary test. Small enough that a matching
 * lookup from far earlier in the session does not count, large enough that one
 * multi-file edit does not re-prompt on every file.
 */
const MAX_TOOLS_SINCE_LOOKUP = 25;

/** How many recent lookups to keep. A session legitimately works on 2-3
 * subjects at once (a fix, its test, its doc), and each should stay unlocked. */
const LOOKUP_HISTORY = 8;

/**
 * Tokens that carry no subject. Without this, `src/...` in a path matches the
 * word "src" in any command and every lookup relates to every file.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "src",
  "test",
  "tests",
  "spec",
  "docs",
  "doc",
  "lib",
  "scripts",
  "script",
  "index",
  "main",
  "the",
  "and",
  "for",
  "how",
  "what",
  "why",
  "does",
  "with",
  "from",
  "into",
  "this",
  "that",
  "are",
  "was",
  "not",
  "get",
  "set",
  "run",
  "open",
  "brain",
  "openbrain",
  "qmd",
  "aqmd",
  "query",
  "search",
  "grep",
  "json",
  "yml",
  "yaml",
  "md",
  "ts",
  "js",
  "py",
  "sql",
  "new",
  "old",
  "pg",
]);

type HookInput = {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
};

type Lookup = {
  at: string;
  what: string;
  /** Subject tokens, so relevance does not re-parse the raw string. */
  tokens: string[];
  /** Value of the session tool counter when this lookup happened. */
  atToolCount: number;
};

type SessionState = {
  /** Most recent first. */
  lookups: Lookup[];
  /** Monotonic count of gate-eligible calls; lookup age is a difference. */
  toolCount: number;
  updatedAt: string;
  /** Legacy fields from the count-only gate; read for migration, not written. */
  lastLookupAt?: string;
  lastLookupWhat?: string;
  toolsSinceLookup?: number;
};

type StateFile = { sessions: Record<string, SessionState> };

const STATE_PATH = join(
  homedir(),
  ".local",
  "state",
  "open-brain-design-gate",
  "state.json",
);

function loadState(): StateFile {
  if (!existsSync(STATE_PATH)) return { sessions: {} };
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as StateFile;
  } catch {
    // A corrupt state file must not wedge every tool call in the repo.
    return { sessions: {} };
  }
}

function saveState(state: StateFile): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

/**
 * Read the hook payload with a NON-BLOCKING read.
 *
 * The first version of this used `await Bun.stdin.text()`, which resolves only
 * on EOF. When the caller holds the pipe open, that await never returns and the
 * hook wedges the tool call behind it. That is not theoretical: on 2026-07-28
 * this gate hung the session and the operator had to restart Claude to recover.
 *
 * `readFileSync(0)` reads whatever is already buffered on the fd and returns.
 * It does not wait for a writer to close. That removes the hang at the source,
 * rather than racing it against a timer -- a timeout race still leaves the hook
 * sitting there for the length of the timer on every single call, and a gate
 * that can stall the session is worse than no gate at all.
 *
 * An unreadable or empty payload yields `{}`, so `tool_name` is "", which is
 * not mutating, so PreToolUse exits 0 and the call proceeds. Failing OPEN is
 * deliberate: a bad read must degrade to "no enforcement", never "no session".
 */
function readInput(): HookInput {
  try {
    const text = readFileSync(0, "utf8");
    return text.trim() ? (JSON.parse(text) as HookInput) : {};
  } catch {
    return {};
  }
}

function argOf(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

/**
 * Split text into subject tokens.
 *
 * Splits on non-alphanumerics AND on camelCase/snake_case boundaries, so
 * `distill-exchange.ts`, `distillExchange`, and `distill_exchange` all yield
 * {distill, exchange} and a lookup phrased any of those ways matches a file
 * named any of the others. Short and generic tokens are dropped -- they would
 * make everything relevant to everything, which is the bug being fixed.
 */
function tokenize(text: string): string[] {
  return [
    ...new Set(
      text
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .split(/[^A-Za-z0-9]+/)
        .map((token) => token.toLowerCase())
        .filter((token) => token.length >= 3 && !STOPWORDS.has(token)),
    ),
  ];
}

/**
 * Is this mutation covered by one of the recorded lookups?
 *
 * Relevance is deliberately generous about WHICH lookup matches (any one will
 * do) and strict about WHETHER one does (a real shared subject token, not a
 * substring). A mutation with no identifiable subject -- an empty path and an
 * unparseable command -- counts as uncovered, so the gate blocks rather than
 * waving through what it cannot classify.
 */
function relevantLookup(
  session: SessionState,
  subject: string[],
): Lookup | null {
  if (subject.length === 0) return null;
  for (const lookup of session.lookups) {
    if (session.toolCount - lookup.atToolCount >= MAX_TOOLS_SINCE_LOOKUP) {
      continue; // age backstop: a matching but ancient lookup is not evidence
    }
    if (lookup.tokens.some((token) => subject.includes(token))) return lookup;
  }
  return null;
}

/** What is this mutation about? Path for file writes, command for Bash. */
function mutationSubject(tool: string, input: Record<string, unknown>): string {
  if (tool === "Bash") return String(input.command ?? "");
  return String(input.file_path ?? input.notebook_path ?? "");
}

/** Does this call count as consulting the existing design? */
function isLookup(tool: string, input: Record<string, unknown>): string | null {
  if (tool === "Bash") {
    const cmd = String(input.command ?? "");
    if (LOOKUP_BASH.test(cmd)) return cmd.slice(0, 120);
  }
  if (tool === "Read") {
    const path = String(input.file_path ?? "");
    if (DESIGN_DOC.test(path)) return path;
  }
  return null;
}

/** Does this call mutate the repo, and therefore need a prior lookup? */
function isMutating(tool: string, input: Record<string, unknown>): boolean {
  if (MUTATING_TOOLS.has(tool)) return true;
  if (tool === "Bash") return MUTATING_BASH.test(String(input.command ?? ""));
  return false;
}

const event = argOf("--event", "pre-tool-use");
const input = readInput();
const tool = input.tool_name ?? "";
const toolInput = input.tool_input ?? {};
const sessionId =
  input.session_id ?? `open-brain:${input.cwd ?? process.cwd()}`;

const state = loadState();
const stored = state.sessions[sessionId];
// Migration: a session recorded by the count-only gate has no `lookups`. Treat
// it as having none rather than crashing -- the next lookup repopulates it.
const session: SessionState = {
  lookups: stored?.lookups ?? [],
  toolCount: stored?.toolCount ?? 0,
  updatedAt: stored?.updatedAt ?? new Date().toISOString(),
};

if (event === "post-tool-use") {
  const what = isLookup(tool, toolInput);
  if (what) {
    session.lookups = [
      {
        at: new Date().toISOString(),
        what,
        tokens: tokenize(what),
        atToolCount: session.toolCount,
      },
      ...session.lookups,
    ].slice(0, LOOKUP_HISTORY);
    session.updatedAt = new Date().toISOString();
    state.sessions[sessionId] = session;
    saveState(state);
  }
  process.exit(0);
}

// pre-tool-use
if (!isMutating(tool, toolInput)) process.exit(0);

const subject = tokenize(mutationSubject(tool, toolInput));
const covered = relevantLookup(session, subject);

if (!covered) {
  const target = mutationSubject(tool, toolInput).slice(0, 100) || "(unknown)";
  const recent = session.lookups
    .filter((l) => session.toolCount - l.atToolCount < MAX_TOOLS_SINCE_LOOKUP)
    .slice(0, 3);

  const reason =
    session.lookups.length === 0
      ? "No design lookup has happened in this session."
      : recent.length === 0
        ? "Every recorded lookup is older than the age backstop."
        : [
            "No lookup in this session covers this subject. Recent lookups were about:",
            ...recent.map((l) => `  - ${l.what.slice(0, 90)}`),
            "",
            `This edit is about: ${target}`,
            "A lookup on a DIFFERENT subject is not evidence that this change is",
            "informed. That was the 2026-07-28 failure this test exists to stop.",
          ].join("\n");

  process.stderr.write(
    [
      `BLOCKED by design-lookup-gate: ${tool} requires a design lookup first.`,
      "",
      reason,
      "",
      "This repo has existing, good designs. The recurring failure is inventing",
      "a worse replacement without reading them. Before writing, run ONE of:",
      "",
      '  aqmd search "<a word from the thing you are about to change>"',
      '  aqmd "<the question you are about to answer with new structure>"',
      '  aqmd research "<how do the prior-art clones handle this>"',
      "  Read docs/dream-design.md (or code-brain-design.md, docs/decisions/)",
      "",
      "BM25 search is ~0.1s and takes a single word. There is no budget in which",
      "skipping it is the faster path.",
      "",
      "Then state what the existing design says and propose only the delta.",
      "If nothing covers it, say UNVERIFIED explicitly and proceed.",
    ].join("\n"),
  );
  process.exit(2);
}

session.toolCount += 1;
session.updatedAt = new Date().toISOString();
state.sessions[sessionId] = session;
saveState(state);
process.exit(0);
