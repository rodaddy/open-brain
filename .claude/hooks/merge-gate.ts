#!/usr/bin/env bun
/**
 * merge-gate — repo-local hard gate on `gh pr merge` for open-brain.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 * ---------------------------------------------------------------------------
 * Operator-ratified architecture (2026-08-08), verbatim:
 *
 *   "Agent produces, script judges, hook enforces — three layers, each doing
 *    the only thing it's good at."
 *
 * This file is the ENFORCE layer and nothing else. It contains ZERO judgment
 * about whether a PR is good. It does not read the diff, does not evaluate the
 * lane's report, does not decide whether the tests were adequate. It asks two
 * questions with string comparisons against data `gh` returns:
 *
 *   (a) VERIFICATION — did `scripts/verify-lane.ts` post a receipt, and does the
 *       SHA in that receipt equal the PR's CURRENT head?
 *   (b) HARVEST — did the ratchet (ledger item 19) happen, or was it explicitly
 *       and non-trivially declared unnecessary?
 *
 * That restriction is the whole design. A gate that reasons can be reasoned
 * with, and a session that wants to merge is precisely the session least suited
 * to judging whether it may. A string comparison cannot be talked out of a
 * refusal, which is why the SHA check is a string comparison and not a
 * "does this look current" assessment.
 *
 * ---------------------------------------------------------------------------
 * (a) WHY A RECEIPT'S SHA MUST MATCH THE CURRENT HEAD
 * ---------------------------------------------------------------------------
 * A receipt is evidence about ONE COMMIT. If a lane pushes after verification,
 * the receipt describes code that is no longer what would merge. Accepting a
 * stale receipt would be worse than having no gate: it launders an unverified
 * push through a real-looking green artifact and hands the operator a false
 * floor (LAW 0 — the cost lands later and larger than the check would have).
 *
 * So a stale receipt is refused, and the refusal names BOTH SHAs so the reason
 * is legible rather than mysterious.
 *
 * ---------------------------------------------------------------------------
 * (b) WHY SILENCE ON HARVEST IS A REFUSAL
 * ---------------------------------------------------------------------------
 * lane-contract.md, ledger item 19: "A lesson that appears in a lane report and
 * not here is a defect in the merge pass that accepted the report." The harvest
 * is the ratchet that makes each dispatch start stronger than the last, and it
 * is the step most easily skipped because skipping it costs nothing at merge
 * time — which is exactly the operator's standing ruling about advisory
 * mechanisms (ledger item 17): "if it's not enforced, it's pretty much useless.
 * Everything that's not enforced eventually gets unused."
 *
 * Three things satisfy it, and silence is not one of them:
 *   - `docs/lane-contract.md` is among the PR's changed files (the harvest is
 *     IN this PR), or
 *   - a `No new lessons: <reason>` line, with a reason that states something, or
 *   - a `harvested: <commit-ref> ...` comment (the harvest landed elsewhere).
 *
 * The placeholder screen on the middle form is deliberate. "No new lessons: n/a"
 * is a way of typing the required characters without making the required claim,
 * and a ratchet satisfiable with noise is not a ratchet. Same reasoning as
 * `lane-bootstrap.ts`'s PLACEHOLDER_REASONS.
 *
 * ---------------------------------------------------------------------------
 * WHY PARSED ARGUMENTS, NOT TEXT MATCHING
 * ---------------------------------------------------------------------------
 * Issue #618: a guard that matched protected-branch names inside heredoc TEXT
 * rather than in the command being run, and taxed every lane until it was fixed.
 * `rg -q 'gh pr merge'` on a raw command string reintroduces it exactly — it
 * cannot tell a session RUNNING a merge from a session WRITING a doc about one,
 * and lanes in this repo write about it constantly (this file does, twice).
 *
 * The parser is therefore SHARED with pr-body-gate.ts rather than copied:
 * `.claude/hooks/lib/shell-command-parse.ts`. A copy would be identical on the
 * day of the split and would drift afterwards, so a #618 fix landing in one gate
 * would leave the other still taxing lanes. Clauses 5a-5c of
 * `scripts/done-means/merge-gate-and-verify-lane.sh` are the standing proof and
 * fail loudly if anyone "simplifies" this into a substring match.
 *
 * ---------------------------------------------------------------------------
 * WHY IT NEVER FAILS QUIETLY
 * ---------------------------------------------------------------------------
 * Per the no-silent-adjustments rule (AGENTS.md Coding Standards, 2026-08-08):
 * when this hook cannot do its job — `gh` missing, a query that fails, JSON it
 * cannot parse — it REFUSES AND SAYS WHY. Silently allowing turns the gate off
 * exactly when something unusual is happening, and nothing reports that
 * enforcement stopped.
 *
 * The one deliberate fail-open is an unparseable or absent hook PAYLOAD: that
 * yields no command, which is not a `gh pr merge`, so the call proceeds. A bad
 * read must degrade to "no enforcement", never "no session" — the same decision
 * pr-body-gate.ts and design-lookup-gate.ts document at their own readInput().
 *
 * ---------------------------------------------------------------------------
 * OPERATOR MERGES VIA THE GITHUB WEB UI ARE UNTOUCHED, BY DESIGN
 * ---------------------------------------------------------------------------
 * This is a PreToolUse hook on an agent's Bash tool. It governs what an AGENT
 * may do, and it has no reach into github.com. Rico clicking "Squash and merge"
 * in the web UI is not gated here and is not meant to be: the operator is the
 * authority this mechanism serves, not a subject of it. If a hard requirement
 * on ALL merges is ever wanted, that belongs in a branch protection rule or a
 * required status check on GitHub's side — a different mechanism, chosen
 * deliberately, not an accident of where this hook happens to run.
 *
 * MECHANISM
 *
 *   PreToolUse on Bash — parse the command; if it is `gh pr merge <n>`, query gh
 *   for the PR's head SHA, body, comments, and changed files, then check (a) and
 *   (b). Exit 2 blocks the call and hands stderr back to the model as the
 *   reason. Exit 0 allows.
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  parseSimpleCommands,
  matchGhCommand,
  firstPositional,
} from "./lib/shell-command-parse.ts";

type HookInput = {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
};

const HOOK_NAME = "merge-gate";
const RECEIPT_PREFIX = "verify-lane receipt:";
const HARVEST_FILE = "docs/lane-contract.md";

/** Flags of `gh pr merge` that take a SEPARATE value, so their value is never
 *  mistaken for the PR number. */
const MERGE_FLAGS_WITH_VALUES = new Set([
  "--body",
  "-b",
  "--body-file",
  "-F",
  "--subject",
  "-t",
  "--match-head-commit",
  "--author-email",
  "-A",
  "--repo",
  "-R",
]);

/**
 * Reasons that are technically non-empty but state nothing. A ratchet
 * satisfiable with noise is not a ratchet. Mirrors lane-bootstrap.ts's
 * PLACEHOLDER_REASONS on purpose — same problem, same answer.
 */
const PLACEHOLDER_REASONS = new Set([
  "n/a",
  "na",
  "none",
  "nothing",
  "no",
  "-",
  "tbd",
  "todo",
  "x",
  "nil",
  "null",
  "not applicable",
  "no lessons",
  "nothing new",
  "nothing to add",
  "n/a.",
  "none.",
]);

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

function refuse(lines: string[]): never {
  console.error(lines.join("\n"));
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const input = readInput();

if ((input.tool_name ?? "") !== "Bash") process.exit(0);

const rawCommand =
  typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
if (!rawCommand.trim()) process.exit(0);

let prNumber: string | null = null;
for (const command of parseSimpleCommands(rawCommand)) {
  const matched = matchGhCommand(command, "pr", ["merge"]);
  if (!matched) continue;
  const positional = firstPositional(matched.rest, MERGE_FLAGS_WITH_VALUES);
  // `gh pr merge` with no number merges the PR for the current branch. There is
  // no number to check, and allowing it would be an unenforced hole, so it is
  // refused with the explicit spelling that IS checkable.
  if (!positional) {
    refuse([
      `BLOCKED by ${HOOK_NAME}: \`gh pr merge\` with no PR number.`,
      "",
      "This gate verifies a receipt against a specific PR's head SHA, and the",
      "bare form resolves the PR implicitly from the current branch — there is",
      "nothing here to check, and allowing it would be a hole in the gate rather",
      "than a decision to skip it.",
      "",
      "Name the PR:",
      "",
      "    gh pr merge <pr-number> --squash --delete-branch",
    ]);
  }
  if (!/^\d+$/.test(positional)) continue;
  prNumber = positional;
  break;
}

// Not a `gh pr merge <n>`: allow untouched. This includes `gh pr view`,
// `gh pr create`, any non-gh command, and — critically — every string literal
// and heredoc body that merely CONTAINS the phrase (#618).
if (!prNumber) process.exit(0);

// ---------------------------------------------------------------------------
// Query gh. Any failure here REFUSES with a named reason; it never allows.
// ---------------------------------------------------------------------------
const result = spawnSync(
  "gh",
  ["pr", "view", prNumber, "--json", "number,headRefOid,body,comments,files"],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);

if (result.error || result.status !== 0) {
  refuse([
    `BLOCKED by ${HOOK_NAME}: could not ask gh about PR #${prNumber}.`,
    "",
    `  command: gh pr view ${prNumber} --json number,headRefOid,body,comments,files`,
    `  reason:  ${
      result.error ? result.error.message : `gh exited ${result.status}`
    }`,
    ...(result.stderr
      ? ["", "  gh said:", ...String(result.stderr).trimEnd().split("\n").map((l) => `    ${l}`)]
      : []),
    "",
    "This is a refusal, not a pass. The gate cannot confirm a verification",
    "receipt it cannot read, and silently allowing would turn enforcement off at",
    "exactly the moment something unusual is happening (AGENTS.md, no silent",
    "adjustments).",
  ]);
}

type PrView = {
  headRefOid?: string;
  body?: string;
  comments?: { body?: string }[];
  files?: { path?: string }[];
};

let pr: PrView;
try {
  pr = JSON.parse(result.stdout ?? "") as PrView;
} catch (error) {
  refuse([
    `BLOCKED by ${HOOK_NAME}: gh returned output that is not JSON for PR #${prNumber}.`,
    "",
    `  reason: ${error instanceof Error ? error.message : String(error)}`,
    "",
    "This is a refusal, not a pass (AGENTS.md, no silent adjustments).",
  ]);
}

const headSha = (pr.headRefOid ?? "").trim();
if (!headSha) {
  refuse([
    `BLOCKED by ${HOOK_NAME}: gh reported no head SHA for PR #${prNumber}.`,
    "",
    "Without a current head SHA there is nothing to compare a receipt against,",
    "so the verification condition cannot be evaluated. Refusing rather than",
    "guessing (AGENTS.md, no silent adjustments).",
  ]);
}

const comments = (pr.comments ?? []).map((c) => String(c.body ?? ""));
const body = String(pr.body ?? "");
const changedFiles = (pr.files ?? []).map((f) => String(f.path ?? ""));

const VERIFY_COMMAND = `    bun scripts/verify-lane.ts ${prNumber}`;

// ---------------------------------------------------------------------------
// (a) VERIFICATION — a receipt whose SHA equals the CURRENT head.
// ---------------------------------------------------------------------------
type Receipt = { sha: string; check: string; at: string; line: string };

function parseReceipts(sources: string[]): Receipt[] {
  const found: Receipt[] = [];
  for (const source of sources) {
    for (const line of source.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith(RECEIPT_PREFIX)) continue;
      const sha = trimmed.match(/\bsha=([0-9a-fA-F]{7,40})\b/)?.[1] ?? "";
      const check = trimmed.match(/\bcheck=(\S+)/)?.[1] ?? "(unnamed)";
      const at = trimmed.match(/\bat=(\S+)/)?.[1] ?? "(no timestamp)";
      found.push({ sha, check, at, line: trimmed });
    }
  }
  return found;
}

// Receipts are read from COMMENTS ONLY, never from the PR body. The body is
// lane-authored and editable by the thing being gated; a receipt read from it
// would let a lane write its own verification. Comments carry a receipt only
// because verify-lane posted one.
const receipts = parseReceipts(comments);

if (receipts.length === 0) {
  refuse([
    `BLOCKED by ${HOOK_NAME}: PR #${prNumber} has no verify-lane receipt.`,
    "",
    `  current head: ${headSha}`,
    `  receipts found: none`,
    "",
    "Condition (a) VERIFICATION failed. A merge requires an independent re-run",
    "of the PR's done-means check by scripts/verify-lane.ts, which posts a",
    `\`${RECEIPT_PREFIX}\` comment ONLY when the check exits 0.`,
    "",
    "docs/sop-rlvr-lanes.md step 3: the controller re-runs the check",
    "independently before merge — worker output is PROPOSED until then. A lane's",
    "own green transcript is not this receipt and cannot substitute for it.",
    "",
    "Satisfy it:",
    "",
    VERIFY_COMMAND,
    "",
    "  (add --check <path> if the PR body carries no '- Done-means: <path>' line,",
    "   and --fresh-db if the check touches Postgres.)",
  ]);
}

const current = receipts.filter((r) => r.sha.toLowerCase() === headSha.toLowerCase());

if (current.length === 0) {
  const newest = receipts[receipts.length - 1]!;
  refuse([
    `BLOCKED by ${HOOK_NAME}: PR #${prNumber}'s verify-lane receipt is STALE.`,
    "",
    `  receipt SHA:  ${newest.sha || "(none recorded)"}`,
    `  current head: ${headSha}`,
    `  these do not match — the PR has been pushed to since it was verified.`,
    "",
    `  receipt: ${newest.line}`,
    ...(receipts.length > 1
      ? ["", `  (${receipts.length} receipts on this PR; none names the current head.)`]
      : []),
    "",
    "Condition (a) VERIFICATION failed. A receipt is evidence about ONE COMMIT,",
    "not about a pull request. The verified commit is no longer what would",
    "merge, so accepting this receipt would launder an unverified push through a",
    "real-looking green artifact — strictly worse than having no gate, because it",
    "hands the operator a false floor (LAW 0).",
    "",
    "Satisfy it by re-verifying the CURRENT head:",
    "",
    VERIFY_COMMAND,
  ]);
}

// ---------------------------------------------------------------------------
// (b) HARVEST — the ratchet, ledger item 19.
// ---------------------------------------------------------------------------
const RATCHET_QUOTE = [
  "docs/lane-contract.md (ledger item 19, the ratchet rule):",
  "",
  '  "after every lane run, the controller harvests the lane\'s refusals,',
  "   workarounds, self-caught defects, and surprises into the Tightenings",
  "   changelog below — with provenance — before the next dispatch. A lesson",
  "   that appears in a lane report and not here is a defect in the merge pass",
  '   that accepted the report."',
];

const harvestedInPr = changedFiles.includes(HARVEST_FILE);

function findLine(prefix: RegExp, sources: string[]): string | null {
  for (const source of sources) {
    for (const line of source.split("\n")) {
      const trimmed = line.trim().replace(/^[-*]\s*/, "");
      if (prefix.test(trimmed)) return trimmed;
    }
  }
  return null;
}

const noLessonsLine = findLine(/^No new lessons:/i, [body, ...comments]);
const harvestedLine = findLine(/^harvested:/i, comments);

let harvestOk = false;
let harvestEvidence = "";

if (harvestedInPr) {
  harvestOk = true;
  harvestEvidence = `${HARVEST_FILE} is among this PR's changed files`;
} else if (harvestedLine) {
  // Must carry something ref-shaped, or "harvested:" is just a word.
  const ref = harvestedLine.slice("harvested:".length).trim();
  if (/[0-9a-f]{7,40}|#\d+|\//i.test(ref) && ref.length >= 7) {
    harvestOk = true;
    harvestEvidence = `comment: ${harvestedLine}`;
  } else {
    refuse([
      `BLOCKED by ${HOOK_NAME}: PR #${prNumber}'s \`harvested:\` line names no commit.`,
      "",
      `  found: ${harvestedLine}`,
      "",
      "Condition (b) HARVEST failed. `harvested:` claims the lesson landed",
      "somewhere else, so it must say WHERE — a commit SHA, an issue/PR number,",
      "or a path. An unverifiable claim of harvest is the thing the ratchet rule",
      "exists to catch.",
      "",
      ...RATCHET_QUOTE,
      "",
      "Satisfy it:",
      "",
      `    gh pr comment ${prNumber} --body "harvested: <commit-sha> docs/lane-contract.md Tightenings entry for this lane"`,
    ]);
  }
} else if (noLessonsLine) {
  const reason = noLessonsLine.slice("No new lessons:".length).trim();
  const normalized = reason.toLowerCase().replace(/\s+/g, " ").trim();
  if (!reason || PLACEHOLDER_REASONS.has(normalized) || reason.length < 12) {
    refuse([
      `BLOCKED by ${HOOK_NAME}: PR #${prNumber}'s \`No new lessons:\` reason is a placeholder.`,
      "",
      `  found:  ${noLessonsLine}`,
      `  reason: "${reason}" states nothing`,
      "",
      "Condition (b) HARVEST failed. A ratchet satisfiable with noise is not a",
      "ratchet — this is the same screen lane-bootstrap.ts puts on --reason, for",
      "the same reason. Claiming a lane produced no operating lesson is a real",
      "claim; write the sentence that makes it.",
      "",
      ...RATCHET_QUOTE,
      "",
      "Satisfy it with a reason that states something, e.g.:",
      "",
      `    No new lessons: every refusal this lane hit was already recorded in the`,
      `    Tightenings changelog (rm-spelling ban, rg -e); nothing new surfaced.`,
    ]);
  }
  harvestOk = true;
  harvestEvidence = `declared: ${noLessonsLine}`;
}

if (!harvestOk) {
  refuse([
    `BLOCKED by ${HOOK_NAME}: PR #${prNumber} says nothing about the harvest.`,
    "",
    `  ${HARVEST_FILE} changed in this PR: no`,
    `  "No new lessons:" line in body or comments: no`,
    `  "harvested:" comment: no`,
    "",
    "Condition (b) HARVEST failed. SILENCE IS A REFUSAL — the harvest is the",
    "step that costs nothing to skip at merge time, which is exactly why it must",
    "be the one the gate insists on (ledger item 17: \"if it's not enforced, it's",
    "pretty much useless\").",
    "",
    ...RATCHET_QUOTE,
    "",
    "Satisfy it any of three ways:",
    "",
    `  1. Harvest IN this PR — add the Tightenings entry to ${HARVEST_FILE}.`,
    "",
    "  2. Declare there was nothing, with a reason that states something:",
    "",
    `       No new lessons: <what you looked for and why nothing was new>`,
    "",
    "     (in the PR body, or as a comment.)",
    "",
    "  3. Point at where it landed instead:",
    "",
    `       gh pr comment ${prNumber} --body "harvested: <commit-sha> ${HARVEST_FILE} entry"`,
  ]);
}

// ---------------------------------------------------------------------------
// Both conditions hold. Allow, and say why on stdout so the transcript records
// what was checked rather than leaving a silent pass.
// ---------------------------------------------------------------------------
const passed = current[0]!;
console.log(
  [
    `${HOOK_NAME}: PR #${prNumber} may merge.`,
    `  (a) verification: receipt for ${passed.check} exits 0 at ${headSha} (${passed.at})`,
    `  (b) harvest:      ${harvestEvidence}`,
  ].join("\n"),
);

process.exit(0);
