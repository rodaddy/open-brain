/**
 * verify-lane support — the numbered steps of `scripts/verify-lane.ts`, the
 * runtime constants they read, and the small helpers they print through.
 *
 * WHY THIS FILE EXISTS. `verify-lane.ts` carried 518 code lines against the
 * 500 ceiling in `.oxlintrc.json`, and its `main()` was one 308-line function
 * scoring 35 on complexity against a ceiling of 10 — inherited debt that
 * predates the Forgejo port and that blocked every commit staging the file
 * (issue 1011, operator ruling M14: fix mechanically, in the same commit,
 * behavior unchanged).
 *
 * The split is MECHANICAL. Every symbol here is moved verbatim; every step
 * name, message string, printed line, and exit code is byte-identical to what
 * the single-file version emitted. Nothing here makes a decision the original
 * did not make.
 *
 * The division is by ROLE. This file holds the STEPS — read the pull request,
 * stand up the worktree, check out the head, reconcile dependencies, run the
 * check, re-read the head, post the receipt — each one a named function whose
 * signature states what it needs and what it produces. `verify-lane.ts` keeps
 * the argument parsing and the `main()` that calls these in order, so the
 * sequence a reader must trust ("no path posts a receipt for a check that did
 * not exit 0") is still readable top to bottom in one place.
 */

import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ForgeApiError, forgeGet, forgePost, type ForgePull } from "./forge-api.ts";
import {
  RECEIPT_PREFIX,
  VerifyLaneError,
  capture,
  note,
  step,
} from "./verify-lane-io.ts";
import { parseFreshDbName } from "./verify-lane-db.ts";

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

// The ref lane-bootstrap cuts its worktree from, and therefore the ref whose
// dependencies it installs. Named once so the deps-at-head comparison below
// and lane-bootstrap cannot drift apart silently.
const BOOTSTRAP_REF = "origin/main";

export interface Args {
  pr: string;
  check: string | null;
  freshDb: boolean;
}

/**
 * State threaded through the numbered steps of `main()`.
 *
 * The steps used to be one 308-line function sharing closure variables; the
 * split (issue 1011, ruling M14) passes this object instead, so each step's
 * inputs and outputs are visible in its signature. Fields are filled in step
 * order and every one is read by a later step.
 */
export interface LaneContext {
  args: Args;
  headSha: string;
  resolved: { path: string; source: string };
  worktreePath: string;
  checkOutput: string;
  teardown: string;
  /** The `dropdb` line for the fresh database, when bootstrap created one (issue 1667). */
  freshDbDrop: string | null;
}

// --- 0. re-entry guard ------------------------------------------------------
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
// This one is the authoritative layer and does not depend on the check
// cooperating, or even on the check being a version that knows the rule.
export function readAncestry(args: Args): string[] {
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
        "    MGVL_VERIFY_LANE_PRS= MGVL_IN_VERIFY_LANE= node scripts/verify-lane.ts <n>",
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
  return ancestry;
}

// --- 1. read the PR ---------------------------------------------------------
export async function readPullRequest(args: Args): Promise<ForgePull> {
  try {
    return await forgeGet<ForgePull>(`/pulls/${args.pr}`);
  } catch (error) {
    throw new VerifyLaneError(
      "pr-view",
      `Forgejo returned no readable pull request: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof ForgeApiError ? error.detail : "",
    );
  }
}

export function readHeadSha(pr: ForgePull, args: Args): string {
  const headSha = (pr.head?.sha ?? "").trim();
  if (!headSha) {
    throw new VerifyLaneError(
      "pr-view",
      `Forgejo reported no head SHA for PR #${args.pr}. Without a head SHA there is nothing to pin a receipt to.`,
    );
  }
  step("pr-view", `head ${headSha}`);
  return headSha;
}

// --- 3. fresh worktree, via lane-bootstrap ----------------------------------
// lane-bootstrap owns environment correctness (.env, deps, optional migrated
// DB) and fails loudly by contract. It creates the branch from origin/main;
// this script then moves that worktree onto the PR head, which is the commit
// the receipt will name.
export function bootstrapWorktree(
  ctx: Pick<LaneContext, "args" | "headSha" | "resolved">,
  stamp: string,
  onFreshDb: (dbName: string) => void = () => {},
): { worktreePath: string; bootstrapSha: string } {
  const verifyBranch = `verify-lane/pr-${ctx.args.pr}-${stamp}`;
  const worktreePath = join(
    WORKTREE_BASE,
    verifyBranch
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, ""),
  );

  note(
    "bootstrap",
    `standing up a fresh worktree for PR #${ctx.args.pr} head ${ctx.headSha}`,
  );
  const bootstrapArgs = [
    join(REPO_ROOT, "scripts", "lane-bootstrap.ts"),
    "--branch",
    verifyBranch,
    "--reason",
    `verify-lane: independent controller re-run of ${ctx.resolved.path} against PR #${ctx.args.pr} head ${ctx.headSha}`,
  ];
  if (ctx.args.freshDb) bootstrapArgs.push("--fresh-db");

  const bootstrap = spawnSync(process.execPath, bootstrapArgs, {
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
  // Read BEFORE the failure check (issue 1667): a migrate failure happens after
  // createdb, so a failed bootstrap can still leave a database to drop.
  const freshDb = parseFreshDbName(bootstrapOutput);
  if (freshDb) onFreshDb(freshDb);
  if (bootstrap.error || bootstrap.status !== 0) {
    throw new VerifyLaneError(
      "bootstrap",
      `lane-bootstrap failed (exit ${bootstrap.status ?? "none"}). No verification ran, so no receipt is posted.`,
      bootstrapOutput.trim(),
    );
  }
  step("bootstrap", `worktree at ${worktreePath}`);

  // The commit whose dependencies lane-bootstrap ACTUALLY installed, read
  // before anything moves the worktree (review round 1, P1-a). BOOTSTRAP_REF is
  // a mutable ref: if it advances between the bootstrap and the compare below,
  // diffing against the ref can report "identical" while the INSTALLED tree
  // still differs from the head, silently skipping the install. A SHA cannot
  // move.
  const bootstrapSha = capture("bootstrap", "git", ["rev-parse", "HEAD"], {
    cwd: worktreePath,
  });
  step("bootstrap", `deps installed at ${bootstrapSha} (from ${BOOTSTRAP_REF})`);
  return { worktreePath, bootstrapSha };
}

/**
 * Pull the PR head into the fresh worktree. `git fetch origin <sha>` then a
 * hard reset is the shape that works for PRs from forks and for SHAs that no
 * named ref points at any more.
 */
export function checkoutHead(
  ctx: Pick<LaneContext, "args" | "headSha" | "worktreePath">,
): void {
  const { args, headSha, worktreePath } = ctx;
  const fetchEnv: NodeJS.ProcessEnv = process.env;
  try {
    capture("fetch-head", "git", ["fetch", "origin", headSha, "--quiet"], {
      cwd: worktreePath,
      env: fetchEnv,
    });
  } catch {
    // Some remotes refuse a bare-SHA fetch; fall back to the pull ref, which
    // GitHub always publishes. Announced, not silent.
    note(
      "fetch-head",
      `bare-SHA fetch refused; falling back to refs/pull/${args.pr}/head`,
    );
    capture(
      "fetch-head",
      "git",
      ["fetch", "origin", `refs/pull/${args.pr}/head`, "--quiet"],
      { cwd: worktreePath, env: fetchEnv },
    );
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
}

/**
 * The fresh database's teardown lines (issue 1667). The drop is automatic; the
 * command is printed for the case where that drop fails.
 */
function freshDbTeardownLines(freshDbDrop: string | null): string[] {
  if (!freshDbDrop) return [];
  return [
    "",
    "The fresh database this run created is dropped automatically when",
    "verify-lane exits. If an ORPHANED DATABASE block is printed, that drop",
    "failed — run it yourself:",
    "",
    `    ${freshDbDrop}`,
  ];
}

/** The teardown text, printed on the failure paths and again in the banner. */
export function teardownText(
  worktreePath: string,
  freshDbDrop: string | null = null,
): string {
  return [
    "Teardown for the worktree this run created — run it yourself (nothing here",
    "is automatic; ledger item 15):",
    "",
    `    git worktree remove ${worktreePath}`,
    ...freshDbTeardownLines(freshDbDrop),
  ].join("\n");
}

/** Refuse before running anything if the check is absent from the fresh checkout. */
export function requireCheckExists(
  ctx: Pick<LaneContext, "headSha" | "resolved" | "worktreePath" | "freshDbDrop">,
  checkPath: string,
): void {
  if (existsSync(checkPath)) return;
  throw new VerifyLaneError(
    "run-check",
    `the done-means check does not exist at PR head ${ctx.headSha}.`,
    [
      `  named:    ${ctx.resolved.path} (from ${ctx.resolved.source})`,
      `  resolved: ${checkPath}`,
      "",
      "A check that is missing from a FRESH checkout but present in the lane's",
      "own worktree is the .gitignore class of defect (lane-contract.md",
      "Tightenings): it was never committed, or a rule drops it. Verify what",
      "`git ls-files` says about the path on the PR branch.",
      "",
      "Teardown for the worktree this run created — run it yourself:",
      "",
      `    git worktree remove ${ctx.worktreePath}`,
      ...freshDbTeardownLines(ctx.freshDbDrop),
    ].join("\n"),
  );
}

// --- 4. run the check -------------------------------------------------------
export function runCheck(
  ctx: Pick<
    LaneContext,
    "args" | "headSha" | "resolved" | "worktreePath" | "freshDbDrop"
  >,
  alreadyVerifying: string[],
): { checkOutput: string; teardown: string } {
  const { args, headSha, resolved, worktreePath, freshDbDrop } = ctx;
  const checkPath = join(worktreePath, resolved.path);
  requireCheckExists(ctx, checkPath);

  note("run-check", `bash ${resolved.path} (cwd ${worktreePath})`);
  // RE-ENTRY MARKER. A done-means check may legitimately want to exercise
  // verify-lane (this repo's own merge-gate check does). Without a marker that
  // is unbounded recursion: verify-lane runs the check, the check calls
  // verify-lane on the same PR, forever. Measured 2026-08-08 — 331 worktrees
  // before it was killed by hand. The check reads this variable and reports
  // SKIP-BY-GUARD rather than recursing; the guard above refuses outright.
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

  const teardown = teardownText(worktreePath, freshDbDrop);

  if (check.status !== 0) {
    // The whole point. A failing check posts NOTHING.
    throw new VerifyLaneError(
      "run-check",
      `${resolved.path} exited ${check.status} at PR head ${headSha}. NO RECEIPT POSTED — the PR is not verified.`,
      `${checkOutput}\n\n${teardown}`,
    );
  }
  step("run-check", `${resolved.path} exited 0 at ${headSha}`);
  return { checkOutput, teardown };
}

// --- 5. re-read the head; refuse if the PR moved under us -------------------
// A receipt naming a SHA that was never actually tested is worse than no
// receipt: merge-gate would accept it as current and merge untested code.
export async function recheckHead(
  ctx: Pick<LaneContext, "args" | "headSha" | "teardown">,
): Promise<void> {
  const { args, headSha, teardown } = ctx;
  let headAfter: string;
  try {
    const after = await forgeGet<ForgePull>(`/pulls/${args.pr}`);
    headAfter = (after.head?.sha ?? "").trim();
  } catch (error) {
    throw new VerifyLaneError(
      "recheck-head",
      `Forgejo returned no readable pull request on re-read: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof ForgeApiError ? error.detail : "",
    );
  }
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
  step(
    "recheck-head",
    `still ${headSha} — the check and the receipt describe the same commit`,
  );
}

// --- 6. post the receipt ----------------------------------------------------
// One machine-readable line, then the check's tail in a details block. The
// first line is what merge-gate parses; everything after it is for humans.
export async function postReceipt(
  ctx: Pick<LaneContext, "args" | "headSha" | "resolved" | "checkOutput">,
  stamp: string,
): Promise<{ timestamp: string; commentFile: string }> {
  const { args, headSha, resolved, checkOutput } = ctx;
  const timestamp = new Date().toISOString();
  const receiptLine = `${RECEIPT_PREFIX} check=${resolved.path} exit=0 sha=${headSha} at=${timestamp}`;

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
  // how a comment gets mangled by quoting or cut short.
  const scratchDir = join(REPO_ROOT, "_scratch");
  mkdirSync(scratchDir, { recursive: true });
  const commentFile = join(scratchDir, `verify-lane-receipt-${args.pr}-${stamp}.md`);
  writeFileSync(commentFile, comment, "utf-8");

  try {
    await forgePost(`/issues/${args.pr}/comments`, { body: comment });
  } catch (error) {
    throw new VerifyLaneError(
      "post-receipt",
      `Forgejo returned an error posting the receipt: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof ForgeApiError ? error.detail : "",
    );
  }
  step("post-receipt", `receipt comment posted to PR #${args.pr}`);
  return { timestamp, commentFile };
}

export function printBanner(
  ctx: LaneContext,
  pr: ForgePull,
  receipt: { timestamp: string; commentFile: string },
): void {
  process.stdout.write(
    [
      "",
      "─".repeat(72),
      "VERIFIED",
      "─".repeat(72),
      `  PR:        #${ctx.args.pr}${pr.html_url ? ` (${pr.html_url})` : ""}`,
      `  check:     ${ctx.resolved.path}`,
      `  exit:      0`,
      `  head SHA:  ${ctx.headSha}`,
      `  at:        ${receipt.timestamp}`,
      `  receipt:   posted as a PR comment`,
      "",
      "  This is the ONLY artifact merge-gate accepts, and it is bound to the SHA",
      "  above. If the PR is pushed to again, the receipt goes stale and the gate",
      "  refuses until verify-lane is re-run.",
      "",
      "─".repeat(72),
      ctx.teardown,
      "",
      `  Receipt body kept at: ${receipt.commentFile}`,
      "",
    ].join("\n"),
  );
}
