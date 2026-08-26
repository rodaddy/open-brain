#!/usr/bin/env bun
/**
 * verify-lane — the SCRIPT layer. Controller verification as a deterministic
 * command, and the only thing that may issue a merge receipt.
 *
 *   bun scripts/verify-lane.ts <pr-number> [--check <path>] [--fresh-db]
 *
 * ---------------------------------------------------------------------------
 * WHERE THIS SITS
 * ---------------------------------------------------------------------------
 * Operator-ratified architecture, verbatim (2026-08-08):
 *
 *   "Agent produces, script judges, hook enforces — three layers, each doing
 *    the only thing it's good at."
 *
 * The agent (lane) produces a PR and a report. THIS script judges. The hook
 * (`.claude/hooks/merge-gate.ts`) enforces that the judgment happened and is
 * still current. The layers are deliberately unable to do each other's jobs:
 *
 *   - This script NEVER trusts a report. It does not read the lane's RED/GREEN
 *     transcripts, does not parse claims, and does not grade prose. It fetches
 *     the PR's head, checks that head out fresh, runs the check, and reports
 *     the exit code it observed. `docs/sop-rlvr-lanes.md` step 3: "worker
 *     output is PROPOSED until this passes."
 *
 *   - The hook NEVER uses AI judgment. It compares the SHA in this script's
 *     receipt against the SHA gh reports as the PR's current head. That is a
 *     string comparison, which is the only kind of check that cannot be talked
 *     out of a refusal.
 *
 * ---------------------------------------------------------------------------
 * WHY THE RECEIPT CARRIES A SHA
 * ---------------------------------------------------------------------------
 * A receipt is evidence about ONE COMMIT, not about a pull request. If the lane
 * pushes after verification, the receipt describes code that is no longer what
 * would merge. A gate that accepted such a receipt would be strictly worse than
 * no gate at all: it would launder an unverified push through a real-looking
 * green artifact, which is exactly the false-floor failure LAW 0 exists to
 * prevent. So the SHA observed AT RUN TIME goes into the receipt line, and
 * merge-gate refuses when it no longer matches.
 *
 * The head SHA is re-read AFTER the check completes and compared against the
 * SHA that was checked out. If the PR moved WHILE the check was running, the
 * receipt would attribute a pass to a commit that was never tested — so that
 * case refuses instead of posting.
 *
 * ---------------------------------------------------------------------------
 * WHY THE WORKTREE IS FRESH, AND BOOTSTRAPPED RATHER THAN HAND-BUILT
 * ---------------------------------------------------------------------------
 * `scripts/lane-bootstrap.ts` (ledger item 15) exists because ~5 hand-built
 * lane environments in one night each hit a missing `.env`, missing deps, or a
 * swallowed exit code. Re-deriving that here would reintroduce all three, so
 * this script INVOKES lane-bootstrap rather than hand-rolling a second
 * bootstrap, then moves the worktree onto the PR head.
 *
 * Fresh also catches the `.gitignore` class: a lane-created file that a
 * `.gitignore` rule silently drops from a clean checkout passes in the lane's
 * own directory and fails for everyone else (lane-contract.md Tightenings —
 * `.claude/*` nearly ate the pr-scribe agent).
 *
 * ---------------------------------------------------------------------------
 * NOTHING IS SILENT (AGENTS.md Coding Standards, 2026-08-08)
 * ---------------------------------------------------------------------------
 * Every step announces itself by name. Every failure names the step, prints the
 * check's real output, and exits non-zero. There is no path here that observes
 * a failure and continues, and no path that posts a receipt for a check that
 * did not exit 0 — a receipt is a claim about reality and this script is the
 * only thing licensed to make it.
 *
 * TEARDOWN of the verification worktree is PRINTED, never executed
 * (ledger item 15's rejection record, docs/issue-graph.md:284). This file
 * contains no delete path.
 */

import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Machine-specific (#636), so read rather than hardcoded. The fallback
// announces itself for the same reason lane-bootstrap's does: a verification
// worktree quietly created on a different volume is one the operator's
// teardown sweep will not find.
const TEMP_WORKSPACE_SOURCE = process.env.OPENBRAIN_TEMP_WORKSPACE?.trim()
  ? "OPENBRAIN_TEMP_WORKSPACE"
  : process.env.DEV_TMP?.trim()
    ? "DEV_TMP"
    : "fallback";
const TEMP_WORKSPACE =
  process.env.OPENBRAIN_TEMP_WORKSPACE?.trim() ||
  process.env.DEV_TMP?.trim() ||
  join(homedir(), ".cache");
const WORKTREE_BASE = join(TEMP_WORKSPACE, "open-brain", "_worktrees");

if (TEMP_WORKSPACE_SOURCE === "fallback") {
  console.warn(
    `[verify-lane] ADJUSTED: neither OPENBRAIN_TEMP_WORKSPACE nor DEV_TMP is set, ` +
      `so the verification worktree goes under ${WORKTREE_BASE}. ` +
      `Set OPENBRAIN_TEMP_WORKSPACE to place it with your other lane artifacts.`,
  );
}
const RECEIPT_PREFIX = "verify-lane receipt:";

// The ref lane-bootstrap cuts its worktree from, and therefore the ref whose
// dependencies it installs. Named once so the deps-at-head comparison below
// and lane-bootstrap cannot drift apart silently.
const BOOTSTRAP_REF = "origin/main";

interface Args {
  pr: string;
  check: string | null;
  freshDb: boolean;
}

class VerifyLaneError extends Error {
  constructor(
    readonly step: string,
    message: string,
    readonly detail: string = "",
  ) {
    super(message);
  }
}

function usage(): string {
  return [
    "verify-lane — re-run a PR's done-means check on its own head and receipt it.",
    "",
    "  bun scripts/verify-lane.ts <pr-number> [--check <path>] [--fresh-db]",
    "",
    "  <pr-number>     the PR to verify",
    "  --check <path>  done-means check to run, when the PR body has no",
    "                  '- Done-means: <path>' line",
    "  --fresh-db      pass --fresh-db to lane-bootstrap (checks that touch Postgres)",
    "",
    "Teardown of the verification worktree is PRINTED, never executed.",
    "",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  let pr = "";
  let check: string | null = null;
  let freshDb = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--check") {
      check = argv[++i] ?? "";
    } else if (arg === "--fresh-db") {
      freshDb = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    } else if (arg.startsWith("-")) {
      throw new VerifyLaneError("args", `unknown argument "${arg}".`, usage());
    } else if (!pr) {
      pr = arg;
    } else {
      throw new VerifyLaneError("args", `unexpected extra argument "${arg}".`, usage());
    }
  }

  if (!/^\d+$/.test(pr)) {
    throw new VerifyLaneError(
      "args",
      "a PR number is required.",
      usage(),
    );
  }
  if (check !== null && !check.trim()) {
    throw new VerifyLaneError("args", "--check was given with no path.", usage());
  }

  return { pr, check: check?.trim() ?? null, freshDb };
}

function step(name: string, detail: string): void {
  process.stdout.write(`  [ok]   ${name}: ${detail}\n`);
}

function note(name: string, detail: string): void {
  process.stdout.write(`  [..]   ${name}: ${detail}\n`);
}

/** Run a command, capturing stdout. Named failure, no swallowed exit codes. */
function capture(
  stepName: string,
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): string {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    env: opts.env ?? process.env,
    input: opts.input,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw new VerifyLaneError(
      stepName,
      `could not execute ${cmd}: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new VerifyLaneError(
      stepName,
      `${cmd} ${args.join(" ")} exited ${result.status}`,
      `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
    );
  }
  return (result.stdout ?? "").trim();
}

/**
 * Locate the done-means check.
 *
 * Order: the PR body's `- Done-means: <path>` line, then `--check <path>`.
 * NEITHER present is a LOUD failure, never a pass — a verification run with
 * nothing to verify that exited 0 would hand the merge gate a receipt meaning
 * "I ran nothing", which is the silent-free-pass failure this whole mechanism
 * exists to prevent.
 */
function resolveCheck(body: string, flagCheck: string | null): { path: string; source: string } {
  // `- Done-means: <path>`, tolerant of leading whitespace and bullet spelling,
  // deliberately NOT tolerant of bold labels — lane-contract.md records that
  // bolded labels break `^-\s*Label:` matching, so the plain form is the one
  // lanes are told to write and the one this reads.
  const match = body.match(/^[ \t]*-[ \t]*Done-means:[ \t]*(\S+)[ \t]*$/m);
  if (match) return { path: match[1]!, source: "PR body '- Done-means:' line" };
  if (flagCheck) return { path: flagCheck, source: "--check flag" };

  throw new VerifyLaneError(
    "done-means",
    "no done-means check could be resolved for this PR.",
    [
      "Nothing was verified, so nothing is being receipted. This is a refusal,",
      "not a pass: a verification run that exited 0 having run no check would",
      "hand merge-gate a receipt meaning \"I ran nothing\".",
      "",
      "Give it one of these:",
      "",
      "  1. Add a line to the PR body's Verification section:",
      "",
      "       - Done-means: scripts/done-means/<check>.sh",
      "",
      "     (plain bullet, no bold label — a bolded label breaks the match, and",
      "      an h3 inside a validator section silently truncates it.)",
      "",
      "  2. Or name it on the command line:",
      "",
      "       bun scripts/verify-lane.ts <pr-number> --check scripts/done-means/<check>.sh",
    ].join("\n"),
  );
}

/**
 * The set of files whose contents decide what `bun install` produces. A
 * difference in ANY of them between the bootstrap ref and the PR head means
 * the `node_modules` lane-bootstrap installed does not describe the head.
 */
export const DEPENDENCY_MANIFESTS = ["package.json", "bun.lock"] as const;

export interface DepsAtHeadDecision {
  /** true when `bun install --frozen-lockfile` must be re-run at the head. */
  reinstall: boolean;
  /** The `deps-at-head` step line, printed on BOTH paths. */
  detail: string;
}

/**
 * Decide whether the verification worktree needs its dependencies reinstalled
 * for the PR head.
 *
 * WHY THIS EXISTS (#775). lane-bootstrap cuts the worktree from `origin/main`
 * and installs deps THERE; this script then hard-resets the same worktree onto
 * the PR head. The SOURCE moves and `node_modules` does not, so any PR that
 * adds or bumps a dependency was verified against origin/main's dependency
 * tree. Measured twice on PR #771 (head 2d67702), which adds `oxlint`: the
 * done-means check died on `MISSING TOOL: .../node_modules/.bin/oxlint` and NO
 * receipt was posted, while a second `bun install --frozen-lockfile` in that
 * same worktree installed the 2 missing packages and the identical check
 * passed.
 *
 * `manifestsDiffer` is the caller's `git diff --quiet <base> <head> --
 * package.json bun.lock` result, inverted: git exits 0 when there is no
 * difference.
 *
 * NOTHING IS ADJUSTED SILENTLY (AGENTS.md Coding Standards): both outcomes
 * produce a line, so the transcript always says which path ran.
 */
export function decideDepsAtHead(input: {
  baseRef: string;
  headSha: string;
  manifestsDiffer: boolean;
}): DepsAtHeadDecision {
  const manifests = DEPENDENCY_MANIFESTS.join(", ");
  if (input.manifestsDiffer) {
    return {
      reinstall: true,
      detail:
        `reinstalled: lockfile differs from ${input.baseRef} ` +
        `(${manifests} changed between ${input.baseRef} and ${input.headSha})`,
    };
  }
  return {
    reinstall: false,
    detail:
      `unchanged: lockfile matches ${input.baseRef} ` +
      `(${manifests} identical, bootstrap deps describe ${input.headSha})`,
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  process.stdout.write("verify-lane\n");
  process.stdout.write(`  PR:        #${args.pr}\n\n`);

  // --- 0. re-entry guard ----------------------------------------------------
  // THE GUARD LIVES IN THE ENVIRONMENT, NOT IN THE CHECKED-OUT CODE.
  //
  // Measured twice on 2026-08-08, and the second time is the instructive one:
  //
  //   Attempt 1 — verify-lane ran the merge-gate check, whose live clause found
  //   the very PR under verification open, and called verify-lane on it again.
  //   331 worktrees (one `bun install` each) before it was killed by hand.
  //
  //   Attempt 2 — a SKIP-BY-GUARD clause was added to the check, verified
  //   working, and it recursed anyway: 747 processes. The reason is the whole
  //   lesson. verify-lane runs the check from a FRESH WORKTREE AT THE PR HEAD
  //   SHA, which is by definition the code as it was BEFORE the fix. A guard
  //   that lives in the repo cannot protect the run that checks out an older
  //   commit of that repo — the guarded copy is never the copy that executes.
  //
  // So the authoritative guard is HERE, in the process that does the spawning,
  // and it is carried in the ENVIRONMENT, which every descendant inherits
  // regardless of which commit it was checked out from. Depth is counted rather
  // than only matching PR numbers, so an A->B->A cycle through different PRs
  // still terminates.
  //
  // The check's own MGVL_IN_VERIFY_LANE clause is kept as the POLITE layer: it
  // makes a nested run report SKIP-BY-GUARD legibly instead of being refused.
  // This one is the LOAD-BEARING layer and does not depend on the check
  // cooperating, or even on the check being a version that knows the rule.
  const ancestry = (process.env.MGVL_VERIFY_LANE_PRS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const MAX_DEPTH = 1;

  if (ancestry.length >= MAX_DEPTH) {
    throw new VerifyLaneError(
      "re-entry",
      `refusing to nest verify-lane (depth ${ancestry.length + 1} > ${MAX_DEPTH}).`,
      [
        `  ancestry: ${ancestry.join(" -> ")} -> ${args.pr}`,
        "",
        "verify-lane runs a PR's done-means check in a fresh worktree AT THE PR",
        "HEAD. If that check calls verify-lane, the nested run checks out the same",
        "head and runs the same check — unbounded recursion, each level paying for",
        "a worktree and a full dependency install.",
        "",
        "Measured 2026-08-08: 331 worktrees on the first occurrence, then 747",
        "processes on the second — the second AFTER the check itself had been",
        "given a skip clause, because the nested run checks out the PR head, which",
        "predates the fix. A guard in the repo cannot protect a run that checks out",
        "an older commit of that repo, which is why this guard is in the",
        "environment instead.",
        "",
        "A done-means check that wants to exercise verify-lane should read",
        "MGVL_IN_VERIFY_LANE and skip its own live clause when it is set. The",
        "OUTER run is the live proof.",
        "",
        "If this run is a SYNTHETIC probe of the error paths (a stubbed PR that",
        "runs no check and cannot recurse), clear the ancestry for that call:",
        "",
        "    MGVL_VERIFY_LANE_PRS= MGVL_IN_VERIFY_LANE= bun scripts/verify-lane.ts <n>",
        "",
        "Note for whoever is reading a FAILED ASSERTION that led here: this",
        "refusal fires BEFORE the done-means check is resolved, so a test",
        "asserting on the '- Done-means:' / '--check' error text will not find it",
        "in this output. That is this guard talking, not the resolver. Observed",
        "2026-08-08: a clause green standalone went red under controller",
        "verification for exactly this reason, and the failure message blamed the",
        "wrong thing.",
      ].join("\n"),
    );
  }
  const alreadyVerifying = ancestry;

  // --- 1. read the PR -------------------------------------------------------
  const raw = capture("pr-view", "gh", [
    "pr",
    "view",
    args.pr,
    "--json",
    "number,headRefOid,body,url",
  ]);
  let pr: { headRefOid?: string; body?: string; url?: string };
  try {
    pr = JSON.parse(raw);
  } catch (error) {
    throw new VerifyLaneError(
      "pr-view",
      `gh returned output that is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      raw.slice(0, 2000),
    );
  }

  const headSha = (pr.headRefOid ?? "").trim();
  if (!headSha) {
    throw new VerifyLaneError(
      "pr-view",
      `gh reported no head SHA for PR #${args.pr}. Without a head SHA there is nothing to pin a receipt to.`,
    );
  }
  step("pr-view", `head ${headSha}`);

  // --- 2. resolve the check -------------------------------------------------
  const resolved = resolveCheck(pr.body ?? "", args.check);
  step("done-means", `${resolved.path} (from ${resolved.source})`);

  // --- 3. fresh worktree, via lane-bootstrap --------------------------------
  // lane-bootstrap owns environment correctness (.env, deps, optional migrated
  // DB) and fails loudly by contract. It creates the branch from origin/main;
  // this script then moves that worktree onto the PR head, which is the commit
  // the receipt will name.
  const stamp = `${process.pid}${Date.now().toString(36)}`;
  const verifyBranch = `verify-lane/pr-${args.pr}-${stamp}`;
  const worktreePath = join(
    WORKTREE_BASE,
    verifyBranch.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
  );

  note("bootstrap", `standing up a fresh worktree for PR #${args.pr} head ${headSha}`);
  const bootstrapArgs = [
    join(REPO_ROOT, "scripts", "lane-bootstrap.ts"),
    "--branch",
    verifyBranch,
    "--reason",
    `verify-lane: independent controller re-run of ${resolved.path} against PR #${args.pr} head ${headSha}`,
  ];
  if (args.freshDb) bootstrapArgs.push("--fresh-db");

  const bootstrap = spawnSync("bun", bootstrapArgs, {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const bootstrapOutput = `${bootstrap.stdout ?? ""}${bootstrap.stderr ?? ""}`;
  process.stdout.write(
    bootstrapOutput
      .split("\n")
      .map((line) => (line.trim() ? `         | ${line}` : ""))
      .filter(Boolean)
      .join("\n") + "\n",
  );
  if (bootstrap.error || bootstrap.status !== 0) {
    throw new VerifyLaneError(
      "bootstrap",
      `lane-bootstrap failed (exit ${bootstrap.status ?? "none"}). No verification ran, so no receipt is posted.`,
      bootstrapOutput.trim(),
    );
  }
  step("bootstrap", `worktree at ${worktreePath}`);

  // Pull the PR head into the fresh worktree. `git fetch origin <sha>` then a
  // hard reset is the shape that works for PRs from forks and for SHAs that no
  // named ref points at any more.
  let fetchEnv: NodeJS.ProcessEnv = process.env;
  try {
    capture("fetch-head", "git", ["fetch", "origin", headSha, "--quiet"], {
      cwd: worktreePath,
      env: fetchEnv,
    });
  } catch {
    // Some remotes refuse a bare-SHA fetch; fall back to the pull ref, which
    // GitHub always publishes. Announced, not silent.
    note("fetch-head", `bare-SHA fetch refused; falling back to refs/pull/${args.pr}/head`);
    capture("fetch-head", "git", [
      "fetch",
      "origin",
      `refs/pull/${args.pr}/head`,
      "--quiet",
    ], { cwd: worktreePath, env: fetchEnv });
  }
  capture("checkout-head", "git", ["reset", "--hard", headSha, "--quiet"], {
    cwd: worktreePath,
  });

  const checkedOut = capture("checkout-head", "git", ["rev-parse", "HEAD"], {
    cwd: worktreePath,
  });
  if (checkedOut !== headSha) {
    throw new VerifyLaneError(
      "checkout-head",
      `the worktree is at ${checkedOut} but PR #${args.pr} head is ${headSha}. Refusing to verify a commit other than the PR head.`,
    );
  }
  step("checkout-head", `worktree at PR head ${headSha}`);

  // --- 3b. dependencies AT THE HEAD (#775) ---------------------------------
  // lane-bootstrap installed deps for BOOTSTRAP_REF; the reset above moved the
  // source to the PR head without touching node_modules. Reconcile that here,
  // or a PR that adds a dependency can never earn a receipt.
  //
  // `git diff --quiet` exits 0 for "no difference" and 1 for "differs", so a
  // non-zero exit is a normal answer rather than a failure — it cannot go
  // through capture(), which throws on any non-zero status. Any OTHER exit
  // code (a bad ref, a missing object) is a real error and fails loudly, so
  // this never silently decides "unchanged" because git could not compare.
  const diff = spawnSync(
    "git",
    ["diff", "--quiet", BOOTSTRAP_REF, headSha, "--", ...DEPENDENCY_MANIFESTS],
    { cwd: worktreePath, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (diff.error) {
    throw new VerifyLaneError(
      "deps-at-head",
      `could not compare dependency manifests: ${diff.error.message}`,
    );
  }
  if (diff.status !== 0 && diff.status !== 1) {
    throw new VerifyLaneError(
      "deps-at-head",
      `git diff --quiet ${BOOTSTRAP_REF} ${headSha} exited ${diff.status}. ` +
        "Refusing to guess whether the head's dependencies are installed.",
      `${diff.stdout ?? ""}${diff.stderr ?? ""}`.trim(),
    );
  }

  const depsDecision = decideDepsAtHead({
    baseRef: BOOTSTRAP_REF,
    headSha,
    manifestsDiffer: diff.status === 1,
  });
  if (depsDecision.reinstall) {
    note("deps-at-head", `installing the head's dependencies in ${worktreePath}`);
    // Same fail-loud shape lane-bootstrap uses for its own deps step
    // (scripts/lane-bootstrap.ts): a partially-installed environment is not a
    // thing to verify against, so a non-zero install aborts before run-check.
    capture("deps-at-head", "bun", ["install", "--frozen-lockfile"], {
      cwd: worktreePath,
    });
  }
  step("deps-at-head", depsDecision.detail);

  // --- 4. run the check -----------------------------------------------------
  const checkPath = join(worktreePath, resolved.path);
  if (!existsSync(checkPath)) {
    throw new VerifyLaneError(
      "run-check",
      `the done-means check does not exist at PR head ${headSha}.`,
      [
        `  named:    ${resolved.path} (from ${resolved.source})`,
        `  resolved: ${checkPath}`,
        "",
        "A check that is missing from a FRESH checkout but present in the lane's",
        "own worktree is the .gitignore class of defect (lane-contract.md",
        "Tightenings): it was never committed, or a rule drops it. Verify what",
        "`git ls-files` says about the path on the PR branch.",
        "",
        "Teardown for the worktree this run created — run it yourself:",
        "",
        `    git worktree remove ${worktreePath}`,
      ].join("\n"),
    );
  }

  note("run-check", `bash ${resolved.path} (cwd ${worktreePath})`);
  // RE-ENTRY MARKER. A done-means check may legitimately want to exercise
  // verify-lane (this repo's own merge-gate check does). Without a marker that
  // is unbounded recursion: verify-lane runs the check, the check calls
  // verify-lane on the same PR, forever. Measured 2026-08-08 — 331 worktrees
  // before it was killed by hand. The check reads this variable and reports
  // SKIP-BY-GUARD rather than recursing; the guard below refuses outright.
  const check = spawnSync("bash", [checkPath], {
    cwd: worktreePath,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      MGVL_IN_VERIFY_LANE: `pr-${args.pr}`,
      MGVL_VERIFY_LANE_PRS: [...alreadyVerifying, args.pr].join(","),
    },
  });
  const checkOutput = `${check.stdout ?? ""}${check.stderr ?? ""}`.trimEnd();
  process.stdout.write(
    checkOutput
      .split("\n")
      .map((line) => `         | ${line}`)
      .join("\n") + "\n",
  );

  if (check.error) {
    throw new VerifyLaneError(
      "run-check",
      `could not execute the check: ${check.error.message}`,
      checkOutput,
    );
  }

  const teardown = [
    "Teardown for the worktree this run created — run it yourself (nothing here",
    "is automatic; ledger item 15):",
    "",
    `    git worktree remove ${worktreePath}`,
  ].join("\n");

  if (check.status !== 0) {
    // The whole point. A failing check posts NOTHING.
    throw new VerifyLaneError(
      "run-check",
      `${resolved.path} exited ${check.status} at PR head ${headSha}. NO RECEIPT POSTED — the PR is not verified.`,
      `${checkOutput}\n\n${teardown}`,
    );
  }
  step("run-check", `${resolved.path} exited 0 at ${headSha}`);

  // --- 5. re-read the head; refuse if the PR moved under us -----------------
  // A receipt naming a SHA that was never actually tested is worse than no
  // receipt: merge-gate would accept it as current and merge untested code.
  const headAfter = capture("recheck-head", "gh", [
    "pr",
    "view",
    args.pr,
    "--json",
    "headRefOid",
    "-q",
    ".headRefOid",
  ]).trim();
  if (headAfter !== headSha) {
    throw new VerifyLaneError(
      "recheck-head",
      `PR #${args.pr} moved WHILE the check was running: ${headSha} -> ${headAfter}. NO RECEIPT POSTED.`,
      [
        "The check passed against a commit that is no longer the PR head, so a",
        "receipt would attribute a pass to code that was never tested. Re-run",
        "verify-lane against the new head.",
        "",
        teardown,
      ].join("\n"),
    );
  }
  step("recheck-head", `still ${headSha} — the check and the receipt describe the same commit`);

  // --- 6. post the receipt --------------------------------------------------
  // One machine-readable line, then the check's tail in a details block. The
  // first line is what merge-gate parses; everything after it is for humans.
  const timestamp = new Date().toISOString();
  const receiptLine =
    `${RECEIPT_PREFIX} check=${resolved.path} exit=0 sha=${headSha} at=${timestamp}`;

  const tail = checkOutput.split("\n").slice(-60).join("\n");
  const comment = [
    receiptLine,
    "",
    "<details><summary>check output (tail)</summary>",
    "",
    "```",
    tail,
    "```",
    "",
    "</details>",
    "",
    `Posted by \`scripts/verify-lane.ts\`. The SHA above is the PR head observed at run time;`,
    "`.claude/hooks/merge-gate.ts` refuses the merge if the PR has moved since.",
  ].join("\n");

  // Write via a file rather than an inline argument: a multi-KB body on argv is
  // how a comment gets truncated or mangled by quoting.
  const scratchDir = join(REPO_ROOT, "_scratch");
  mkdirSync(scratchDir, { recursive: true });
  const commentFile = join(scratchDir, `verify-lane-receipt-${args.pr}-${stamp}.md`);
  writeFileSync(commentFile, comment, "utf-8");

  capture("post-receipt", "gh", [
    "pr",
    "comment",
    args.pr,
    "--body-file",
    commentFile,
  ]);
  step("post-receipt", `receipt comment posted to PR #${args.pr}`);

  process.stdout.write(
    [
      "",
      "─".repeat(72),
      "VERIFIED",
      "─".repeat(72),
      `  PR:        #${args.pr}${pr.url ? ` (${pr.url})` : ""}`,
      `  check:     ${resolved.path}`,
      `  exit:      0`,
      `  head SHA:  ${headSha}`,
      `  at:        ${timestamp}`,
      `  receipt:   posted as a PR comment`,
      "",
      "  This is the ONLY artifact merge-gate accepts, and it is bound to the SHA",
      "  above. If the PR is pushed to again, the receipt goes stale and the gate",
      "  refuses until verify-lane is re-run.",
      "",
      "─".repeat(72),
      teardown,
      "",
      `  Receipt body kept at: ${commentFile}`,
      "",
    ].join("\n"),
  );
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    if (err instanceof VerifyLaneError) {
      process.stderr.write(`\n  [FAIL] ${err.step}: ${err.message}\n`);
      if (err.detail) {
        process.stderr.write(
          "\n" +
            err.detail
              .split("\n")
              .map((line) => (line.trim() ? `         ${line}` : ""))
              .join("\n") +
            "\n",
        );
      }
      process.stderr.write("\n");
      process.exit(1);
    }
    process.stderr.write(
      `\n  [FAIL] unexpected: ${err instanceof Error ? err.stack || err.message : String(err)}\n\n`,
    );
    process.exit(1);
  }
}
