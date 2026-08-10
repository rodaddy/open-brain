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
import {
  type Token,
  parseSimpleCommands,
  executableWords,
  isGhBinary,
} from "./lib/shell-command-parse.ts";

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
 * THE PARSER LIVES IN ./lib/shell-command-parse.ts.
 *
 * It was extracted there when merge-gate.ts arrived needing exactly the same
 * #618-proof tokenizer. A second copy would have been identical on the day of
 * the split and would have drifted afterwards, so a #618 fix landing in one gate
 * would leave the other still taxing lanes -- the
 * `sme.duplicated_selection_lists_diverge` pattern. Behaviour is unchanged;
 * clauses 4a-4c of scripts/done-means/pr-body-gate-fires.sh still hold it.
 */


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

const commands = parseSimpleCommands(rawCommand);

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

/**
 * WHICH TREE THE Done-means PATH IS RESOLVED AGAINST (issue #706).
 *
 * This hook is registered as `$CLAUDE_PROJECT_DIR/.claude/hooks/pr-body-gate.ts`,
 * so VALIDATOR above always points into the PRIMARY CHECKOUT — which is sitting
 * on the base branch. Lanes work in a worktree, and a lane's done-means check is
 * a NEW file on the lane branch. The validator used to resolve `Done-means`
 * against its own tree, so a PR that introduced its own check was structurally
 * refused, and the cheapest ways past were all false receipts: name a different
 * pre-existing check that never judged this lane, or claim `not applicable`.
 *
 * The payload's `cwd` is the tree the command was actually run from — the lane
 * worktree — so it is handed to the validator as the tree under review. The
 * VALIDATOR SCRIPT is still the primary checkout's copy: this passes the tree to
 * inspect, not the rules to inspect it with, so a lane cannot weaken the gate by
 * editing the validator on its own branch.
 *
 * `CLAUDE_PROJECT_DIR` is deliberately NOT used here. It is the primary
 * checkout, which is the exact tree that produced the bug.
 */
const reviewRoot = input.cwd?.trim() || process.cwd();

const result = spawnSync("bun", [VALIDATOR], {
  encoding: "utf8",
  env: {
    ...process.env,
    PR_BODY: body,
    PR_TITLE: target.title ?? "",
    PR_REPO_DIR: reviewRoot,
  },
  cwd: reviewRoot,
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

// ALLOWED. Echo the validator's resolution notes so the pass is not silent
// about WHICH tree answered the Done-means path (issue #706, AGENTS.md nothing
// silent). stderr, because stdout on a PreToolUse hook is parsed as a decision
// document; this is commentary on an allow, not a decision.
for (const line of (result.stdout ?? "").split("\n")) {
  if (line.startsWith("Done-means resolved")) {
    console.error(`[${HOOK_NAME}] ${line}`);
  }
}

process.exit(0);
