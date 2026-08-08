#!/usr/bin/env bun
/**
 * pr-body-gate -- repo-local hard gate on PR bodies for open-brain.
 *
 * WHY THIS EXISTS -- AND WHY IT IS FORCED RATHER THAN ADVISORY
 *
 * Ledger item 14 (docs/issue-graph.md, 2026-08-07) built the deterministic
 * floor after three lanes failed `scripts/validate-pr-body.ts` three different
 * ways in one night, all format rather than substance: a PR template generated
 * from the validator's own field list, a local validation command in every lane
 * briefing, and a `pr-scribe` agent that only returns a body the validator has
 * already accepted. Every piece of it was ADVISORY -- a lane that did not run
 * the validator paid nothing until CI rejected the PR, which is the round trip
 * the whole thing existed to remove.
 *
 * Ledger item 17, operator ruling 2026-08-08:
 *
 *   "if it's not enforced, it's pretty much useless. Everything that's not
 *    enforced eventually gets unused... If I don't hammer it into you and force
 *    you to use it, eventually you'll decide that it's not useful and you
 *    won't."
 *
 * So the validator stops being something a lane is asked to remember. This hook
 * runs it on the way out. CI stays the backstop; it is no longer the first
 * detector. Global promotion is deliberately deferred -- this is repo-local.
 *
 * WHY PARSED ARGUMENTS, NOT TEXT MATCHING
 *
 * A guard that over-fires is a worse tax than the failure it prevents, and this
 * repo has the receipt: issue #618, a git guard that matched protected-branch
 * names inside heredoc TEXT rather than in the command being run, and taxed
 * every lane until it was fixed. `rg -q 'gh pr create'` on the raw command
 * string would reintroduce exactly that -- it cannot tell a lane RUNNING
 * `gh pr create` from a lane WRITING a doc about running it, and lanes in this
 * repo write about it constantly (this very file contains the phrase).
 *
 * The mechanism is therefore: tokenize the command with real shell quoting
 * rules and STRIP heredoc bodies first, split on command separators, and for
 * each resulting simple command check that the executable word is `gh`, the
 * subcommand is `pr`, and the verb is `create` or `edit`. Only then are
 * `--body`/`-b`/`--body-file`/`-F` read as OPTIONS OF THAT COMMAND. A quoted
 * string is a single token and is never inspected for command structure, so
 * `echo 'gh pr create --body bad'` is one `echo` with one argument, and a
 * heredoc is content rather than syntax. `scripts/done-means/pr-body-gate-fires.sh`
 * clauses 4a-4c are the standing proof, and they fail loudly if anyone
 * "simplifies" this into a substring match.
 *
 * WHY IT NEVER FAILS QUIETLY
 *
 * Per the no-silent-adjustments rule (AGENTS.md Coding Standards, 2026-08-08):
 * when this hook cannot do its job -- an unreadable `--body-file`, a validator
 * that will not run -- it REFUSES AND SAYS WHY. It does not silently allow
 * (that turns the gate off exactly when a lane is doing something unusual, and
 * nothing reports the gate stopped working) and it does not silently block (a
 * lane wedged with no reason burns a session guessing).
 *
 * The one deliberate fail-open is an unparseable or absent hook PAYLOAD: that
 * yields no command, which is not a `gh pr create`, so the call proceeds. A bad
 * read must degrade to "no enforcement", never "no session" -- the same
 * decision design-lookup-gate.ts documents at its own readInput().
 *
 * MECHANISM
 *
 *   PreToolUse on Bash -- parse the command; if it is a gh pr create/edit
 *   carrying a body, run that body through scripts/validate-pr-body.ts with
 *   PR_BODY/PR_TITLE set. Exit 2 blocks the call and hands stderr back to the
 *   model as the reason. Exit 0 allows.
 *
 * The validator is SPAWNED, never reimplemented. Its rules are the contract
 * (`scripts/done-means/pr-template-passes-validator.sh` holds the template
 * against them); a second copy of those rules here would be the drift that
 * check exists to prevent.
 */

import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

type HookInput = {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
};

const HOOK_NAME = "pr-body-gate";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VALIDATOR = join(REPO_ROOT, "scripts", "validate-pr-body.ts");

/**
 * Read the hook payload with a NON-BLOCKING read.
 *
 * `readFileSync(0)` returns whatever is buffered rather than waiting for the
 * writer to close, which is what `await Bun.stdin.text()` does. That await
 * wedged a session in this repo on 2026-07-28 and needed a Claude restart to
 * recover; see design-lookup-gate.ts readInput() for the full account. Do not
 * "modernise" this back into an await.
 */
function readInput(): HookInput {
  try {
    const text = readFileSync(0, "utf8");
    return text.trim() ? (JSON.parse(text) as HookInput) : {};
  } catch {
    return {};
  }
}

/**
 * Remove heredoc BODIES from a command string, leaving the redirection operator.
 *
 * A heredoc body is data the shell feeds to a process; it is not command syntax
 * and must never be scanned for one. This is the #618 failure mode in its purest
 * form -- a lane writing a doc that quotes an invalid PR body inside
 * `git commit -F - <<'EOF' ... EOF` is not creating a PR.
 *
 * Handles `<<WORD`, `<<'WORD'`, `<<"WORD"`, and the `<<-` indented form (whose
 * terminator may be preceded by tabs).
 */
function stripHeredocBodies(command: string): string {
  const lines = command.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    out.push(line);
    i += 1;

    // Collect every heredoc opened on this line, in order.
    const opens = [...line.matchAll(/<<(-?)\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/g)];
    for (const open of opens) {
      const dashed = open[1] === "-";
      const terminator = open[3]!;
      while (i < lines.length) {
        const candidate = dashed ? lines[i]!.replace(/^\t+/, "") : lines[i]!;
        i += 1;
        if (candidate.trim() === terminator) break;
      }
    }
  }

  return out.join("\n");
}

type Token = { value: string; quoted: boolean };

/**
 * Tokenize with shell quoting rules.
 *
 * `quoted` records whether any part of the token came from inside quotes. That
 * flag is what keeps `echo 'gh pr create'` from ever being read as a command:
 * the whole phrase is ONE token, and a quoted token is never treated as an
 * executable name or a separator.
 */
function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  let mode: "none" | "single" | "double" = "none";

  const push = () => {
    if (started) tokens.push({ value: current, quoted });
    current = "";
    quoted = false;
    started = false;
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;

    if (mode === "single") {
      if (ch === "'") mode = "none";
      else current += ch;
      continue;
    }

    if (mode === "double") {
      if (ch === '"') mode = "none";
      else if (ch === "\\" && i + 1 < command.length) {
        i += 1;
        current += command[i]!;
      } else current += ch;
      continue;
    }

    if (ch === "'") {
      mode = "single";
      quoted = true;
      started = true;
      continue;
    }
    if (ch === '"') {
      mode = "double";
      quoted = true;
      started = true;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      i += 1;
      current += command[i]!;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }

    current += ch;
    started = true;
  }

  push();
  return tokens;
}

/**
 * Split a token stream into simple commands on UNQUOTED separators.
 *
 * `a && gh pr create ...` must still be inspected; `echo '&& gh pr create'`
 * must not be split at all, because that separator is inside a quoted token.
 */
const SEPARATORS = new Set(["&&", "||", ";", "|", "&", "\n"]);

function splitCommands(tokens: Token[]): Token[][] {
  const commands: Token[][] = [];
  let current: Token[] = [];

  for (const token of tokens) {
    if (!token.quoted && SEPARATORS.has(token.value)) {
      if (current.length > 0) commands.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) commands.push(current);
  return commands;
}

/**
 * Drop leading env assignments and common wrappers so `FOO=1 command gh pr ...`
 * and `env X=y gh pr ...` still resolve to `gh`. Deliberately small: this is
 * about not being trivially evaded by a habitual prefix, not about emulating a
 * shell.
 */
function executableWords(command: Token[]): Token[] {
  let index = 0;
  while (index < command.length) {
    const token = command[index]!;
    if (!token.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value)) {
      index += 1;
      continue;
    }
    if (!token.quoted && (token.value === "env" || token.value === "command")) {
      index += 1;
      continue;
    }
    break;
  }
  return command.slice(index);
}

function isGhBinary(word: string): boolean {
  if (word === "gh") return true;
  // An absolute or relative path to the gh binary is still gh.
  return /(^|\/)gh$/.test(word) && word.includes("/");
}

type BodySource =
  | { kind: "inline"; flag: string; value: string }
  | { kind: "file"; flag: string; path: string };

type PrCommand = {
  verb: "create" | "edit";
  title: string | null;
  body: BodySource | null;
};

/**
 * Identify a `gh pr create|edit` and read its body/title OPTIONS.
 *
 * Everything here is positional and flag-shaped: the executable must be gh, the
 * next word must be `pr`, the next must be create/edit. A command that does not
 * have that shape returns null and is allowed untouched, which is why
 * `gh pr view 610`, `gh issue create --body ...`, and any non-gh command never
 * reach the validator.
 */
function parsePrCommand(command: Token[]): PrCommand | null {
  const words = executableWords(command);
  const first = words[0];
  if (!first || first.quoted || !isGhBinary(first.value)) return null;

  // Skip gh's own global flags between `gh` and `pr` (e.g. --repo owner/name).
  let index = 1;
  const globalWithValue = new Set(["--repo", "-R"]);
  while (index < words.length) {
    const word = words[index]!;
    if (word.quoted || !word.value.startsWith("-")) break;
    if (word.value.includes("=")) index += 1;
    else if (globalWithValue.has(word.value)) index += 2;
    else index += 1;
  }

  const subcommand = words[index];
  if (!subcommand || subcommand.value !== "pr") return null;
  const verbToken = words[index + 1];
  if (!verbToken) return null;
  const verb = verbToken.value;
  if (verb !== "create" && verb !== "edit") return null;

  let title: string | null = null;
  let body: BodySource | null = null;

  const valueOf = (i: number, inlineValue: string | null): [string | null, number] => {
    if (inlineValue !== null) return [inlineValue, i + 1];
    const next = words[i + 1];
    if (!next) return [null, i + 1];
    return [next.value, i + 2];
  };

  let i = index + 2;
  while (i < words.length) {
    const word = words[i]!;
    // A quoted token is a VALUE, never a flag. `--body '--body-file x'` is a
    // body whose text happens to look like a flag.
    if (word.quoted || !word.value.startsWith("-")) {
      i += 1;
      continue;
    }

    const eq = word.value.indexOf("=");
    const flag = eq === -1 ? word.value : word.value.slice(0, eq);
    const inlineValue = eq === -1 ? null : word.value.slice(eq + 1);

    if (flag === "--body" || flag === "-b") {
      const [value, next] = valueOf(i, inlineValue);
      if (value !== null) body = { kind: "inline", flag, value };
      i = next;
      continue;
    }
    if (flag === "--body-file" || flag === "-F") {
      const [value, next] = valueOf(i, inlineValue);
      if (value !== null) body = { kind: "file", flag, path: value };
      i = next;
      continue;
    }
    if (flag === "--title" || flag === "-t") {
      const [value, next] = valueOf(i, inlineValue);
      title = value;
      i = next;
      continue;
    }

    i += 1;
  }

  return { verb, title, body };
}

function refuse(lines: string[]): never {
  console.error(lines.join("\n"));
  process.exit(2);
}

const REMEDY = [
  "",
  "Fix it before the call, not after CI:",
  "",
  "  1. Start from .github/pull_request_template.md — it is held against the",
  "     validator by scripts/done-means/pr-template-passes-validator.sh, so a",
  "     filled template cannot fail on SHAPE. Do not reconstruct the sections.",
  "  2. Or delegate composition to the pr-scribe agent",
  "     (.claude/agents/pr-scribe.md), which returns a body only after it has",
  "     seen the validator exit 0.",
  "  3. Validate locally, then re-run this command:",
  "",
  '       PR_BODY="$(cat body.md)" PR_TITLE="..." bun scripts/validate-pr-body.ts',
  "",
  "     Add CONTRACT_PARITY_REQUIRED=true when the diff touches paths in",
  "     contracts/parity-paths.txt.",
  "",
  "Ledger item 17 (docs/issue-graph.md), operator 2026-08-08: this is FORCED,",
  "not advisory — \"if it's not enforced, it's pretty much useless\". CI is the",
  "backstop, not the first detector.",
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const input = readInput();

if ((input.tool_name ?? "") !== "Bash") process.exit(0);

const rawCommand =
  typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
if (!rawCommand.trim()) process.exit(0);

const commands = splitCommands(tokenize(stripHeredocBodies(rawCommand)));

let target: PrCommand | null = null;
for (const command of commands) {
  const parsed = parsePrCommand(command);
  if (parsed?.body) {
    target = parsed;
    break;
  }
}

// Not a gh pr create/edit carrying a body: allow untouched. This includes
// `gh pr view`, `gh pr create` with no body (gh opens an editor, and there is
// no text to validate yet), and every non-gh command in the repo.
if (!target || !target.body) process.exit(0);

const source = target.body;
let body: string;

if (source.kind === "inline") {
  body = source.value;
} else {
  const path = isAbsolute(source.path)
    ? source.path
    : join(input.cwd ?? process.cwd(), source.path);
  if (!existsSync(path)) {
    refuse([
      `BLOCKED by ${HOOK_NAME}: could not read the PR body file.`,
      "",
      `  ${source.flag} ${source.path}`,
      `  resolved to: ${path}`,
      "  reason: no such file",
      "",
      "This is a refusal, not a pass. The gate cannot validate a body it cannot",
      "read, and silently allowing would turn enforcement off at exactly the",
      "moment something unusual is happening (AGENTS.md, no silent adjustments).",
      "",
      "Check the path — a body file written to /tmp is invisible across sandbox",
      "boundaries and is a repo rule violation in its own right. Use",
      "{temp_workspace}/open-brain/_scratch/.",
    ]);
  }
  try {
    body = readFileSync(path, "utf8");
  } catch (error) {
    refuse([
      `BLOCKED by ${HOOK_NAME}: could not read the PR body file.`,
      "",
      `  ${source.flag} ${source.path}`,
      `  resolved to: ${path}`,
      `  reason: ${error instanceof Error ? error.message : String(error)}`,
      "",
      "This is a refusal, not a pass. The gate cannot validate a body it cannot",
      "read (AGENTS.md, no silent adjustments).",
    ]);
  }
}

if (!existsSync(VALIDATOR)) {
  refuse([
    `BLOCKED by ${HOOK_NAME}: the PR body validator is missing.`,
    "",
    `  expected at: ${VALIDATOR}`,
    "",
    "The gate refuses rather than waving the call through, because a missing",
    "validator means enforcement is not happening and nobody would be told",
    "(AGENTS.md, no silent adjustments). Restore the script, or say explicitly",
    "that this PR is going out unvalidated and why.",
  ]);
}

const result = spawnSync("bun", [VALIDATOR], {
  encoding: "utf8",
  env: {
    ...process.env,
    PR_BODY: body,
    PR_TITLE: target.title ?? "",
  },
});

if (result.error || result.status === null) {
  refuse([
    `BLOCKED by ${HOOK_NAME}: could not run the PR body validator.`,
    "",
    `  command: bun ${VALIDATOR}`,
    `  reason: ${result.error ? result.error.message : "process produced no exit status"}`,
    "",
    "The gate refuses rather than allowing an unvalidated body through",
    "(AGENTS.md, no silent adjustments).",
  ]);
}

if (result.status !== 0) {
  const validatorOutput = `${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd();
  refuse([
    `BLOCKED by ${HOOK_NAME}: this PR body fails scripts/validate-pr-body.ts.`,
    "",
    `  gh pr ${target.verb}, body from ${source.kind === "inline" ? source.flag : `${source.flag} ${source.path}`}`,
    "",
    "The validator said:",
    "",
    validatorOutput
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
    ...REMEDY,
  ]);
}

process.exit(0);
