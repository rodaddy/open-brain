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

/**
 * Tools that write to the repo. These are what the gate protects.
 *
 * AskUserQuestion is here because handing a question back to the operator is a
 * mutation of HIS time, and the expensive failure mode is identical: an answer
 * that already exists in the repo gets re-litigated by the one person whose
 * attention is scarcest. Measured instance, 2026-07-29: the gate was asked
 * which grading prompt to use for round three. `_plans/435-436-dream-hosted-rem.md:235`
 * already specified it -- and the two options offered were a stale pair the
 * same document had superseded. The operator's reply was "you were supposed to
 * know that". A bad edit costs a revert; a bad question costs trust and time.
 */
const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "NotebookEdit",
  "AskUserQuestion",
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

/**
 * Denied commands, READ FROM ~/.claude/settings.json rather than listed here.
 *
 * WHY THIS IS DATA AND NOT A CONSTANT. Measured twice in one hour, 2026-07-29,
 * both times by the model editing THIS FILE: it hand-wrote a tool rule from
 * memory that banned `rg`, which `settings.json` explicitly ALLOWS, and called
 * `fd` a drop-in for `find`, which it is not. A second copy of a permission
 * list is a copy that drifts, and the drifted copy is authoritative for whoever
 * reads it. So there is no second copy. The operator's config is the only list.
 *
 * WHAT THIS ADDS over the permission layer, which already blocks these: the
 * REASON and the REPLACEMENT. Measured, 2026-07-29: four `grep` calls were
 * denied across one session while searching for the round-two bake-off results.
 * Every denial arrived as a bare "permission denied", so each one read as a
 * failure of that particular command rather than a standing decision -- and the
 * response was to vary the flags, then the directory, then to propose a script
 * that walked the tree by hand. The results were in the repo the whole time at
 * `_plans/435-436-dream-hosted-rem.md:201`; one `aqmd search "terra"` found
 * them. The operator had to intervene four times.
 *
 * A bare denial trains evasion. A denial that names the winning move trains the
 * habit. That is the whole delta.
 */
const DENY_REPLACEMENT: ReadonlyArray<[RegExp, string]> = [
  [
    /^(sudo\s+)?(grep|egrep|fgrep)\b/,
    'rg -- and before that, `aqmd search "<word>"` (~0.1s, searches the index across the whole tree)',
  ],
  [
    /^(sudo\s+)?find\b/,
    "mdfind (Spotlight index, instant) for locating files; `fd` for name/type patterns under a path",
  ],
  [/^(sudo\s+)?mktemp\b/, "{temp_workspace}/open-brain/_scratch/"],
  [
    /^(sudo\s+)?(pip|pip3)\b/,
    "uv (this repo's Python is the uv environment, never system pip)",
  ],
  [/^\/usr\/bin\/python3?\b/, "the uv environment or the agent Python wrapper"],
];

/**
 * Searching a tree by walking it in a script.
 *
 * This is the escalation the permission layer cannot see: once the direct
 * command is denied, the next move is a Bun/Python script that does the same
 * walk. Same intent, one level of indirection, and it was reached for this
 * session after the third denial.
 */
const TREE_WALK_SCRIPT =
  /\b(readdirSync|walkSync|Bun\.Glob|globSync|os\.walk|filepath\.Walk|fast-glob)\b/;

/** The sanctioned first move for any "where is X" question in this repo. */
const SEARCH_FIRST =
  'aqmd search "<one word>"   # BM25 over the repo index, ~0.1s\n' +
  '  aqmd "<the question>"      # semantic, when you know the idea not the word';

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
  // A question's subject is its text. Without this the subject is always empty,
  // so no lookup can ever match and AskUserQuestion is blocked unconditionally,
  // which contradicts the unlock-by-lookup intent documented on MUTATING_TOOLS.
  if (tool === "AskUserQuestion") return JSON.stringify(input.questions ?? "");
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

/**
 * Is this call SEARCHING THE TREE for something -- in any spelling?
 *
 * WHY THIS IS A CATEGORY AND NOT A COMMAND LIST. The operator hardened the
 * `grep` denial and an agent immediately used `Grep` with a capital G -- the
 * built-in tool, allowed at settings.json:197. That is not a clever bypass; it
 * is the predictable end of every blocklist. Ban a spelling and the next
 * spelling wins: Grep, rg, sed -n /re/p, awk /re/, perl -ne, a readdir script,
 * or an Agent spawned to do the search on your behalf. The set of ways to walk
 * a tree is open, so enumerating it is a losing game that has to be re-fought
 * every time someone finds a synonym.
 *
 * So this classifies the ACT: "find where X is". The operator's objection was
 * never to the string `grep` -- it is to walking the tree instead of querying
 * the index. `aqmd search "terra"` found in one call what four denied greps and
 * a proposed walker script did not, on 2026-07-29.
 *
 * The inversion that makes this stable: instead of enumerating what is
 * forbidden (open set, always one variant behind), require what counts as
 * having looked (closed set, already defined above as LOOKUP_BASH). A tree
 * search is allowed the moment an index lookup exists in this session. It is
 * not a ban on rg -- rg is the right tool once you know the literal token.
 * It is a ban on making the tree the FIRST move.
 */
function isTreeSearch(tool: string, input: Record<string, unknown>): boolean {
  if (tool === "Grep" || tool === "Glob") return true;
  if (tool !== "Bash") return false;

  const cmd = String(input.command ?? "");
  if (LOOKUP_BASH.test(cmd)) return false; // the index IS the sanctioned path
  if (TREE_WALK_SCRIPT.test(cmd)) return true;

  // A PIPE IS A FILTER, NOT A SEARCH. `ps aux | grep postgres` narrows output
  // that already exists; it never touches the tree. Only the FIRST segment of a
  // pipeline can be a tree search, and blocking the rest would make the gate
  // unusable -- which is how the first version of this failed its own check.
  const head = cmd.split("|")[0]!;

  // Searchers by name, allowed or denied. `rg` is ALLOWED by the permission
  // layer and is the right tool for a literal token -- but as the OPENING move
  // it is still walking the tree before asking the index, which is the act
  // being gated. Allowed-ness is about which tool; this is about which order.
  return /(^|[;&]\s*)(sudo\s+)?(grep|egrep|fgrep|rg|ag|ack|find|fd)\b/.test(
    head,
  );
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

/**
 * NOTHING FROM THIS REPO WRITES TO THE SHARED VOLUME.
 *
 * /Volumes/collab (= /mnt/collab on Linux) is shared storage between agents and
 * humans. Its own README documents a 3-folder-per-agent structure; root-level
 * scratch is not part of it. This repo left 37 files in that root -- probe
 * scripts, .bak copies of its own source, grading logs, bake-off JSON -- and
 * the operator hit them from a sandboxed session where he could not even `ls`
 * the directory to find out what was going on.
 *
 * There is no remote leg here. This repo runs local, against a local Postgres,
 * with a local scratch bucket already configured as TMPDIR in .claude/settings.
 * The share was never needed; it was just the first path that came to mind.
 *
 * READS ARE FINE -- reviews genuinely live there (reviews/open-brain/PR#/).
 * This blocks WRITES only, and it fails closed: no lookup exempts it, because
 * this is not a "did you research it" question. It is a boundary.
 */
const COLLAB_PATH = /(\/Volumes\/collab|\/mnt\/collab)\b/;

/** Reviews genuinely live on the share -- that is what it is FOR. */
const COLLAB_ALLOWED =
  /(\/Volumes\/collab|\/mnt\/collab)\/(reviews|_archive)\b/;

/**
 * Adding a cap on remembered content: block, always, no lookup exempts it.
 *
 * This repo is a memory system. Recall means TOTAL recall, and how big the
 * database gets is the operator's decision, never an agent's. Storage already
 * solved size -- src/chunking.ts chunks ONLY so embeddings work, and the full
 * text stays whole on the parent row -- so a cap added anywhere downstream is
 * an agent re-litigating a settled design and losing data to do it.
 *
 * Measured on 2026-07-30, all self-inflicted, all silent:
 *   - resume.py printed content at [:200]. A reading agent in another repo hit
 *     that and told the operator Open Brain "stores messages truncated to ~200
 *     chars". It does not: 7,437 rows exceed 205, the longest is 6,837. A cut
 *     in a READER became a false claim about the DATABASE.
 *   - boundedContextLine cut every line to 500 across seven read paths --
 *     lane events, checkpoint, durable memory, profile_guidance, repo_facts.
 *     Canon would have arrived pre-truncated before a canon row existed.
 *   - ingest_raw_turn REJECTED turns over 200k, losing 100% instead of the
 *     overflow, and failing the whole 100-turn batch with it.
 *
 * Operator, 2026-07-30: "It's my decision if I want this Open Brain database to
 * be 17,000 gigs because all of the data is there... I'm not asking you to do
 * any of this cutting and making things smaller. I've never asked you to do
 * that. If I ever do ask you to do that, ask me if I turned crazy."
 *
 * Scope: content headed for or coming out of memory. Identifier bounds
 * (uuid/token/hash/slug/prefix), display width, and timestamp slicing are not
 * content loss and are not matched.
 */
const CONTENT_CAP = new RegExp(
  [
    // .slice(0, N) / .substring(0, N) / [:N] with N >= 20 -- below that it is a
    // hash prefix or an id, not prose.
    String.raw`\.slice\(\s*0\s*,\s*\d{2,}\s*\)`,
    String.raw`\.substring\(\s*0\s*,\s*\d{2,}\s*\)`,
    String.raw`\[\s*:\s*\d{2,}\s*\]`,
    // Zod / validator ceilings on a content field.
    String.raw`\.max\(\s*\d{3,}\s*\)`,
    // Naming a cap into existence.
    String.raw`\b(MAX|LIMIT)_[A-Z_]*(CHARS|CHARACTERS|LEN|LENGTH|BYTES|SIZE)\b`,
    String.raw`\btruncate[A-Za-z]*\s*\(`,
  ].join("|"),
);

/** Identifier/formatting bounds are legitimate: a uuid is not a memory. */
const CAP_EXEMPT =
  /uuid|token|hash|sha|slug|prefix|digest|\bid\b|width|indent|created_at|occurred_at|timestamp|ISOString|padEnd|padStart/i;

/** Only files that carry memory content. A cap in a UI or a test is not this. */
const MEMORY_SURFACE =
  /(resume\.py|ob-memory-provider|agent-context-pack|session-context|ingest-raw-turn|raw-turns|turn-capture|lane|recall|chunking|capture|distill|guidance|repo-facts)/i;

function addsContentCap(tool: string, input: Record<string, unknown>): boolean {
  const target = String(
    input.file_path ?? input.notebook_path ?? input.command ?? "",
  );
  if (!MEMORY_SURFACE.test(target)) return false;
  // Only the text being written matters; an Edit that REMOVES a cap is the fix.
  const added = String(input.new_string ?? input.content ?? "");
  if (!added) return false;
  return CONTENT_CAP.test(added) && !CAP_EXEMPT.test(added);
}

if (addsContentCap(tool, toolInput)) {
  process.stderr.write(
    [
      "BLOCKED by design-lookup-gate: you are adding a cap on remembered content.",
      "",
      `Target: ${mutationSubject(tool, toolInput).slice(0, 120)}`,
      "",
      "STANDING RULE: never truncate, cap, cut, or shorten anything on an Open",
      "Brain read or write path. Recall means TOTAL recall. Database size is the",
      "operator's decision alone -- he has never asked for content to be made",
      "smaller, and if you think you hear that request, ASK HIM IF HE HAS GONE",
      "CRAZY before writing a single character.",
      "",
      "Storage already solved size. src/chunking.ts chunks ONLY so embeddings",
      "work; the full text stays whole on the parent row. A cap downstream is",
      "re-litigating a settled design and losing data to do it.",
      "",
      "This exact reflex, three times on 2026-07-30 alone:",
      "  resume.py [:200]        -> an agent told the operator the DATABASE",
      "                             truncates at 200 chars. It does not.",
      "  boundedContextLine 500  -> silently cut seven read paths, canon included.",
      "  ingest_raw_turn 200k    -> REJECTED the turn whole, and its 99 batch-mates.",
      "",
      "If a bound is genuinely required (a protocol ceiling, a real API limit),",
      "ASK THE OPERATOR FIRST and say which limit and whose it is.",
      "",
      "Identifier bounds (uuid/token/hash/slug), display width, and timestamp",
      "slicing are not content loss and are not blocked.",
    ].join("\n"),
  );
  process.exit(2);
}

/**
 * Limitation language, anywhere, in any tool: hard block. No lookup, no
 * rephrase, and no tool-specific carve-out clears it.
 *
 * addsContentCap above stops a cap being WRITTEN into a memory-surface file.
 * That is too narrow twice over: it only watches certain paths, and it only
 * watches code. The reflex is not path-scoped and it is not code-scoped -- it
 * shows up in a question, an issue body, a commit message, a design doc, a
 * comment, a plan. So this one matches the LANGUAGE, in every tool.
 *
 * What happened on 2026-07-30, and why the earlier gate was not enough:
 * mid-way through a session spent REMOVING caps from every Open Brain path, the
 * agent opened a wayfinder ticket and its first act was an AskUserQuestion
 * offering three cap sizes for canon -- per-lane, global, reserved-floor. Every
 * option a limit; "no cap" was not among them. The gate DID fire, twice, but
 * its message said "requires a design lookup first" -- so the agent read it as
 * a procedural toll, ran two `aqmd` searches, and re-fired the same question.
 * The second search returned the answer (_plans/canon-always-known.md:177-179:
 * canon is a filter whose rows must ALL come back). The agent quoted that line
 * back to the operator and shipped the cap menu anyway.
 *
 * The lesson is in the message, not the matcher: a gate that names a
 * satisfiable precondition invites satisfying the precondition. This one offers
 * no door. The ONLY way past is to stop and put it to the operator in prose.
 *
 * Operator, 2026-07-30, verbatim: "I have never once, in any conversation I've
 * had with these agents or anything, ever asked for caps or downsizing or
 * limiting or slimming things down... Never ask me to limit things unless I
 * personally ask you to. You should never do it or suggest it on your own
 * ever." And: "I don't care if this thing ends up being 2, 7, 12 gigs in the
 * database. What I need is for it to WORK PROPERLY, and then we can figure out
 * how to pare it down."
 *
 * This is not a judgment the agent makes badly. It is a default the model
 * reaches for when nothing stops it -- bounded output reads as good engineering
 * in the abstract, so "how big should it be" gets composed before the actual
 * requirement (total recall) is ever consulted. A wall works where a rule does
 * not, because a wall needs no remembering.
 *
 * The operator raises the subject whenever he likes. This blocks the AGENT
 * raising it, never his own request, and never the removal of an existing cap.
 */
const CAP_PROPOSAL = new RegExp(
  [
    String.raw`\b(cap|caps|capped|capping)\b`,
    String.raw`\b(limit|limits|limiting|limited|limitation|limitations)\b`,
    String.raw`\b(ceiling|quota|throttle|throttling|budgeted)\b`,
    String.raw`\b(truncat|trim|prun|downsiz|shrink|curtail|constrain|restrict)\w*`,
    String.raw`\bslim(?:med|ming)?\b`,
    String.raw`\bpared?\b|\bparing\b`,
    String.raw`\b(smaller|fewer|leaner|tighter)\b`,
    String.raw`\bmax[_\s-]?(tokens|size|items|chars|characters|length|rows|events|bytes|count)\b`,
    String.raw`\bsize\s+(limit|cap|budget|ceiling)\b`,
    String.raw`\btoken\s+budget\b`,
    String.raw`\bhow\s+(big|large|many|much)\b`,
    String.raw`\bcut\s+(it|them|this|that|down|off)\b`,
    String.raw`\bkeep\s+it\s+(small|short|tight|brief|bounded)\b`,
    String.raw`\btop[_\s-]?\d+\b`,
    String.raw`\bfirst\s+\d+\s+(rows|items|events|results|chars)\b`,
  ].join("|"),
  "i",
);

/**
 * Removing a cap is the fix and must never be blocked. Also exempt: reporting
 * that a cap EXISTS (the finding), and the operator's own framing quoted back.
 */
const CAP_PROPOSAL_EXEMPT = new RegExp(
  [
    // Log-FILE rotation retention is ops hygiene, not remembered content --
    // memory content stays unbounded. pino-roll's vendor API names its
    // retention property `limit`, and STANDARDS-observability.md:61-63
    // mandates three rotated files. Operator authorized this exact exemption
    // 2026-08-02 after the #463 foundation worker hard-stopped on the conflict.
    String.raw`\bpino-?roll\b`,
    String.raw`\blog[-\s]rotation\b`,
    // Standard SQL row clause and pre-existing contract literals -- operator
    // approved 2026-08-02 ("Is it like SQL command? Yeah, that's definitely
    // approved for use... Standard SQL, yeah, you can use that.") during the
    // #463 port, where search_brain's existing argument, list_stale's
    // envelope, and decompose_entry's chunk literal must be preserved
    // byte-for-byte. Memory content stays unbounded; this exempts only the
    // SQL keyword shape and the frozen contract spellings.
    String.raw`\bLIMIT\s+(\$\d|\d+)`,
    String.raw`\blimit["']?\s*[:=]`,
    String.raw`\btrimmed_chunk_text\b`,
    String.raw`\.trim\(`,
    // Same operator-approved class, further members: the realtime session
    // envelope's recorded field names, which the context-pack parity fixture
    // must reproduce verbatim from observed current-src output. Memory content
    // stays unbounded; JSON-key shapes only, prose proposals still hit the wall.
    String.raw`["'](ttl_ms|max_sessions|max_items_per_session|trimmed|purged|dropped|expired|marked)["']\s*:`,
    String.raw`\b(counters|budget)["']?\s*:`,
    // Same operator-approved class, further members: `get_entry`'s compact
    // render envelope. `max_chars`, `content_length`, and `content_truncated`
    // are EXISTING current-src response fields (`src/tools/get-entry.ts`), and
    // the #463 gap-closure fixture records them verbatim from observed output.
    // Recording a field current-src already emits is not proposing a cap;
    // memory content stays unbounded and prose proposals still hit the wall.
    String.raw`\b(max_chars|content_length|content_truncated|DEFAULT_COMPACT_MAX_CHARS)\b`,
    // Same operator-approved class, further members: SQL DDL grammar. Operator
    // narrowed the gate 2026-08-02 ("we can narrow the gate now anyway. I
    // think the point has been proven") after the #469 worker hard-stopped on
    // the CHECK-constraint keywords its migration requires. SQL CONSTRAINT /
    // CHECK grammar enforces table integrity, not shrinkage; the noun/keyword
    // is exempt while the verb forms (constrain, constrained, constraining)
    // still hit the wall. Memory content stays unbounded; prose proposals to
    // make something smaller are still blocked.
    String.raw`\bCHECK\s*\(`,
    String.raw`\bCONSTRAINTS?\b`,
    String.raw`\bno\s+(cap|caps|limit|limits|ceiling)\b`,
    String.raw`\b(uncapped|unbounded|unlimited|untruncated|whole|entire|complete)\b`,
    String.raw`\b(un|de)-?(cap|caps|capping|limit|limiting|truncat)\w*`,
    String.raw`\b(remov|delet|strip|eliminat|drop|kill|rip)\w*\s+(the\s+|a\s+|any\s+|every\s+|all\s+)?(cap|caps|limit|limits|ceiling|truncat\w*|bound|bounds)`,
    String.raw`\b(lift|lifting|raise|raising|widen|widening|relax|relaxing)\b`,
    String.raw`\bwithout\s+(a\s+)?(cap|limit|ceiling|bound)`,
    String.raw`\btotal\s+recall\b`,
    String.raw`\bwide\s+open\b`,
    String.raw`\bnever\s+(truncate|cap|cut|shorten|limit)\b`,
  ].join("|"),
  "i",
);

/**
 * Every surface the operator or the repo would see it on: a question, a file
 * being written, a command, a commit message, an issue body.
 */
/**
 * Read-only verbs. Judged on the leading verb; `rg ... | head` is still a read.
 *
 * MUST stay declared above capProposalText. `const` is not hoisted, so when
 * this sat below its caller the reference threw at call time and every search
 * was refused -- including the sweep that was removing the ceilings.
 */
const BASH_READ_ONLY =
  /^\s*(rg|fd|ls|cat|head|tail|wc|jq|sort|uniq|diff|stat|file|which|mdfind|aqmd|qmd|bat|tree|du|df|ps|env|printenv|echo|pwd|date|sqlite3|psql\s+-[tAcl]|git\s+(log|show|diff|status|blame|branch|remote|rev-parse|ls-files)|gh\s+(issue|pr)\s+(view|list|status)|gh\s+api|bun\s+(test|run\s+\S*(test|check)\S*))\b/;

function capProposalText(tool: string, input: Record<string, unknown>): string {
  if (tool === "AskUserQuestion") return JSON.stringify(input.questions ?? "");
  if (tool === "Write" || tool === "NotebookEdit") {
    return String(input.content ?? input.new_source ?? "");
  }
  if (tool === "Edit") return String(input.new_string ?? "");
  if (tool === "Bash") {
    const cmd = String(input.command ?? "");
    // A read cannot bound anything. Searching for the word is how you find the
    // thing to delete, and blocking that made this gate an obstacle to its own
    // purpose -- the first two commands after it shipped were an `rg` for these
    // constants and an `rg` for a test name, and both were refused.
    return BASH_READ_ONLY.test(cmd) ? "" : cmd;
  }
  return "";
}

/**
 * Counts how much ceiling-shaped text a string carries. Comparing the count
 * before and after an edit is what separates the fix from the defect.
 */
function capWeight(text: string): number {
  return (text.match(new RegExp(CAP_PROPOSAL.source, "gi")) ?? []).length;
}

/**
 * Removal is ALWAYS allowed. Addition is NEVER allowed.
 *
 * Operator, 2026-07-30: "You should be allowed to undo fucking caps and stupid
 * shit. You just shouldn't be allowed to do stupid caps and shit."
 *
 * The first cut of this block judged an Edit on `new_string` alone, so it could
 * not tell deleting a ceiling from adding one -- and it promptly blocked the
 * sweep that was tearing the ceilings out, because every such edit necessarily
 * names the thing it deletes. An Edit carries `old_string` too, so the honest
 * test is directional: if the replacement carries no more ceiling-shaped text
 * than the text it replaces, the edit is removing or holding steady, and it
 * passes. Only a net INCREASE is a proposal.
 */
function proposesACap(tool: string, input: Record<string, unknown>): boolean {
  const text = capProposalText(tool, input);
  if (!text) return false;
  if (CAP_PROPOSAL_EXEMPT.test(text)) return false;
  if (!CAP_PROPOSAL.test(text)) return false;
  if (tool === "Edit") {
    // Net-new ceiling text only. Deleting or rewording an existing one passes.
    return capWeight(text) > capWeight(String(input.old_string ?? ""));
  }
  if (tool === "Write") {
    // A Write replaces the whole file, so the prior weight is whatever is on
    // disk today -- zero for a new file, which makes any ceiling in it net-new.
    let prior = "";
    try {
      const path = String(input.file_path ?? "");
      if (path) prior = readFileSync(path, "utf8");
    } catch {
      prior = "";
    }
    return capWeight(text) > capWeight(prior);
  }
  return true;
}

if (proposesACap(tool, toolInput)) {
  process.stderr.write(
    [
      "BLOCKED by design-lookup-gate: HARD NO on limitation language.",
      "",
      `Matched in ${tool}: ${(capProposalText(tool, toolInput).match(CAP_PROPOSAL) ?? [""])[0]}`,
      "",
      "STANDING RULE: never propose, suggest, ask about, design in, or write a",
      "cap, limit, ceiling, quota, budget, truncation, or any other way of making",
      "something smaller. Not in a question, not in code, not in a doc, not in a",
      "commit message, not as an aside. The operator has NEVER asked for one, in",
      "any session, and does not want to be asked.",
      "",
      'Operator, 2026-07-30: "You should never do it or suggest it on your own',
      'ever." And: "I don\'t care if this thing ends up being 2, 7, 12 gigs in the',
      "database. What I need is for it to WORK PROPERLY, and then we can figure",
      "out how to pare it down. What I don't need is paring it down before it",
      'works properly and making none of the shit work."',
      "",
      "ORDER OF OPERATIONS IS FIXED: make it work, get ALL the data in, prove it",
      "works. Size is discussed after that, and only when HE raises it.",
      "",
      "THERE IS NO PRECONDITION THAT CLEARS THIS BLOCK. No design lookup, no",
      "citation, no rephrase. On 2026-07-30 this gate fired twice with a message",
      "naming a lookup, so the agent ran two searches and re-fired the same cap",
      "question -- one of those searches had already returned the answer. Running",
      "a command does not buy passage. Do not try.",
      "",
      "THE ONLY WAY THROUGH: if a bound is 1000% unavoidable -- a protocol",
      "ceiling, a hard third-party API limit, a datatype maximum -- STOP, and say",
      "so to the operator in plain prose: which limit, whose it is, what breaks",
      "without it, and what you measured. Then wait. He decides. An agent that",
      "believes it has a perfect reason is exactly the agent this block exists",
      "for.",
      "",
      "NEVER BLOCKED: removing, lifting, raising, widening, or deleting an",
      "existing cap. Reporting that a cap exists. Quoting the operator.",
    ].join("\n"),
  );
  process.exit(2);
}

function writesToCollab(tool: string, input: Record<string, unknown>): boolean {
  if (tool === "Write" || tool === "Edit" || tool === "NotebookEdit") {
    const path = String(input.file_path ?? input.notebook_path ?? "");
    return COLLAB_PATH.test(path) && !COLLAB_ALLOWED.test(path);
  }
  if (tool !== "Bash") return false;
  const cmd = String(input.command ?? "");
  if (!COLLAB_PATH.test(cmd) || COLLAB_ALLOWED.test(cmd)) return false;
  // Writing verbs only. `ls`, `cat`, and a read-only Bun script are legitimate.
  return /(^|[;&|]\s*)(mv|cp|tee|touch|mkdir|dd|rsync|install)\b|>\s*["']?(\/Volumes\/collab|\/mnt\/collab)|Bun\.write|writeFileSync|createWriteStream|open\([^)]*["']w/.test(
    cmd,
  );
}

if (writesToCollab(tool, toolInput)) {
  process.stderr.write(
    [
      "BLOCKED by design-lookup-gate: this repo does not write to /Volumes/collab.",
      "",
      `Target: ${mutationSubject(tool, toolInput).slice(0, 120)}`,
      "",
      "collab is the SHARED volume between agents and humans. This repo runs",
      "entirely local -- local Postgres, local models, local scratch -- so there",
      "is no reason for anything here to land there. 37 files from this repo were",
      "archived out of its root on 2026-07-29 after the operator found them from",
      "a sandboxed session where he could not even list the directory.",
      "",
      "Write here instead:",
      "",
      "  $TMPDIR                      # already set to the repo scratch bucket",
      "  {temp_workspace}/open-brain/_scratch/",
      "",
      "Reading from collab is fine, and reviews/ still lives there.",
    ].join("\n"),
  );
  process.exit(2);
}

/**
 * Tree search before any index lookup: block, and name the replacement.
 *
 * A bare "permission denied" is what produced four escalating grep attempts on
 * 2026-07-29 -- with no alternative attached, each denial read as a failure of
 * that command rather than a standing decision. So the reason and the exact
 * next command travel with the block. This is the whole difference between
 * training evasion and training the habit.
 */
if (isTreeSearch(tool, toolInput) && session.lookups.length === 0) {
  const cmd = mutationSubject(tool, toolInput).slice(0, 100);
  const replacement = DENY_REPLACEMENT.find(([pattern]) =>
    pattern.test(cmd.trim()),
  )?.[1];

  process.stderr.write(
    [
      `BLOCKED by design-lookup-gate: search the index before walking the tree.`,
      "",
      `This call searches the tree: ${cmd || tool}`,
      "No index lookup has happened yet in this session.",
      "",
      "Run this first:",
      "",
      `  ${SEARCH_FIRST}`,
      "",
      replacement ? `For this command specifically, use: ${replacement}\n` : "",
      "The index crosses the whole tree in ~0.1s and returns ranked hits with",
      "file:line. A tree walk is slower, misses anything phrased differently,",
      "and an empty result from one reads as 'does not exist' when it means",
      "'wrong word'. Measured 2026-07-29: four denied greps and a proposed",
      "walker script failed to find the round-two bake-off results; one",
      '`aqmd search "terra"` found them at _plans/435-436-dream-hosted-rem.md:201.',
      "",
      "This is NOT a ban on rg/Grep. Once one lookup exists in this session,",
      "they are unlocked -- they are the right tools for a literal token you",
      "already know. The rule is only that the tree is never the FIRST move.",
    ].join("\n"),
  );
  process.exit(2);
}

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
