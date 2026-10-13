#!/usr/bin/env node
/**
 * verify-lane — the SCRIPT layer. Controller verification as a deterministic
 * command, and the only thing that may issue a merge receipt.
 *
 *   node scripts/verify-lane.ts <pr-number> [--check <path>] [--fresh-db]
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
 *     receipt against the SHA Forgejo reports as the PR's current head. That is a
 *     string comparison, which is the only kind of check that cannot be talked
 *     out of a refusal.
 *
 *   - The pull request itself is READ FROM THE FORGEJO API (`scripts/forge-api.ts`,
 *     issue 1011), not from `gh`: this repo's origin is git.example.internal and
 *     `gh` does not reach it. The head SHA, the body the done-means check is
 *     resolved from, and the receipt comment all go through that one client.
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
 * contains no delete path. The one exception is the per-run `--fresh-db`
 * database, dropped by exact, prefix-guarded name in
 * `scripts/verify-lane-db.ts` (issue 1667).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  VerifyLaneError,
  capture,
  note,
  requireShellCheckPath,
  resolveCheck,
  step,
  usage,
} from "./verify-lane-io.ts";
import {
  type Args,
  type LaneContext,
  bootstrapWorktree,
  checkoutHead,
  postReceipt,
  printBanner,
  readAncestry,
  readHeadSha,
  readPullRequest,
  recheckHead,
  runCheck,
} from "./verify-lane-support.ts";
import {
  createFreshDbGuard,
  installFreshDbSignalTeardown,
  withFreshDbTeardown,
} from "./verify-lane-db.ts";

/**
 * The set of files whose contents decide what `npm ci` produces. A
 * difference in ANY of them between the bootstrap ref and the PR head means
 * the `node_modules` lane-bootstrap installed does not describe the head.
 */
export const DEPENDENCY_MANIFESTS = ["package.json", "package-lock.json"] as const;

export type DepsAtHeadOutcome = "reinstall" | "unchanged";

export interface DepsAtHeadDecision {
  /** What to do: reinstall the head's dependencies, or leave them alone. */
  outcome: DepsAtHeadOutcome;
  /** The `deps-at-head` step line, printed on BOTH paths. */
  detail: string;
}

/**
 * Decide whether the verification worktree needs its dependencies reinstalled
 * for the PR head.
 *
 * WHY THIS EXISTS (#775). lane-bootstrap cuts the worktree from a base ref and
 * installs deps THERE; this script then hard-resets the same worktree onto the
 * PR head. The SOURCE moves and `node_modules` does not, so any PR that adds or
 * bumps a dependency was verified against the base's dependency tree. Measured
 * twice on PR #771 (head 2d67702), which adds `oxlint`: the done-means check
 * died on `MISSING TOOL: .../node_modules/.bin/oxlint` and NO receipt was
 * posted, while a second `bun install --frozen-lockfile` in that same worktree
 * installed the 2 missing packages and the identical check passed.
 *
 * THE COMPARISON IS PINNED TO A SHA, NOT A REF (review round 1, P1-a).
 * `bootstrapSha` is the worktree's HEAD read immediately after lane-bootstrap
 * returns — the commit whose dependencies are actually installed. Diffing
 * against the mutable `origin/main` instead would silently skip the install
 * whenever that ref advanced between bootstrap and this compare (any fetch or
 * merge in between), because the newly-advanced main could match the head's
 * manifests while the INSTALLED tree does not.
 *
 * THIS FUNCTION OWNS THE STATUS HANDLING, deliberately. `diffStatus` is the RAW
 * exit code of `git diff --quiet <bootstrapSha> <headSha> -- <manifests>`: 0
 * means identical, 1 means they differ, and anything else means git could not
 * answer (bad ref, missing object, not a repository). Taking the raw code
 * rather than a pre-digested boolean is what makes the fail-closed branch
 * TESTABLE — with a boolean, the `status !== 0 && status !== 1` logic lived at
 * the call site and a mutant that ignored it passed every test.
 *
 * Reading an unusable comparison as "unchanged" would reintroduce the original
 * defect exactly when git cannot compare, so that case THROWS.
 *
 * NOTHING IS ADJUSTED SILENTLY (AGENTS.md Coding Standards): both non-throwing
 * outcomes produce a line, so the transcript always says which path ran.
 */
export function decideDepsAtHead(input: {
  bootstrapSha: string;
  headSha: string;
  diffStatus: number | null;
}): DepsAtHeadDecision {
  const manifests = DEPENDENCY_MANIFESTS.join(", ");
  const { bootstrapSha, headSha, diffStatus } = input;

  if (diffStatus !== 0 && diffStatus !== 1) {
    throw new VerifyLaneError(
      "deps-at-head",
      `git diff --quiet ${bootstrapSha} ${headSha} -- ${manifests} exited ` +
        `${diffStatus === null ? "null" : diffStatus}. Refusing to guess whether ` +
        "the head's dependencies are installed: reading an unusable comparison " +
        'as "unchanged" is the original defect (#775) with an extra step.',
    );
  }

  if (diffStatus === 1) {
    return {
      outcome: "reinstall",
      detail:
        `reinstalled: lockfile differs from the bootstrap commit ` +
        `(${manifests} changed between ${bootstrapSha} and ${headSha})`,
    };
  }
  return {
    outcome: "unchanged",
    detail:
      `unchanged: lockfile matches the bootstrap commit ` +
      `(${manifests} identical between ${bootstrapSha} and ${headSha}, so the ` +
      `deps installed at ${bootstrapSha} already describe ${headSha})`,
  };
}
/** The node@24 keg's npm: the fallback when the running node has no sibling npm. */
export const KEG_NPM = "/opt/homebrew/opt/node@24/bin/npm";

/**
 * The npm to bootstrap with (issues 1510, 1503): the one beside the running
 * node, so a PATH without node@24 cannot pick a missing or wrong-version npm.
 */
export function resolveNpm(
  execPath: string = process.execPath,
  exists: (path: string) => boolean = existsSync,
): string {
  const sibling = join(dirname(execPath), "npm");
  return exists(sibling) ? sibling : KEG_NPM;
}

/**
 * `npm ci` in `cwd` with the resolved npm. On failure, print one visible
 * `VERIFY-LANE BOOTSTRAP FAILED: <step> exit <code>` line, then rethrow so
 * main() still reports the detail and exits 1.
 */
export function runNpmCi(
  stepName: string,
  cwd: string,
  npm: string = resolveNpm(),
): void {
  try {
    capture(stepName, npm, ["ci"], { cwd });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = /exited (\S+)$/.exec(message)?.[1] ?? "spawn-error";
    process.stderr.write(`VERIFY-LANE BOOTSTRAP FAILED: ${stepName} exit ${code}\n`);
    throw err;
  }
}

// --- 3b. dependencies AT THE HEAD (#775) ------------------------------------
// lane-bootstrap installed deps for BOOTSTRAP_REF; the reset above moved the
// source to the PR head without touching node_modules. Reconcile that here,
// or a PR that adds a dependency can never earn a receipt.
//
// `git diff --quiet` exits 0 for "no difference" and 1 for "differs", so a
// non-zero exit is a normal answer rather than a failure — it cannot go
// through capture(), which throws on any non-zero status. Any OTHER exit
// code (a bad ref, a missing object) is a real error and fails loudly, so
// this never silently decides "unchanged" because git could not compare.
export function installDepsAtHead(
  ctx: Pick<LaneContext, "headSha" | "worktreePath">,
  bootstrapSha: string,
): void {
  const { headSha, worktreePath } = ctx;
  const diff = spawnSync(
    "git",
    ["diff", "--quiet", bootstrapSha, headSha, "--", ...DEPENDENCY_MANIFESTS],
    { cwd: worktreePath, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (diff.error) {
    throw new VerifyLaneError(
      "deps-at-head",
      `could not compare dependency manifests: ${diff.error.message}`,
    );
  }

  // decideDepsAtHead owns the status handling, including the fail-closed branch
  // for any code outside {0, 1}. Passing the raw status keeps that logic inside
  // the unit-tested function instead of here (review round 1, P2).
  const depsDecision = decideDepsAtHead({
    bootstrapSha,
    headSha,
    diffStatus: diff.status,
  });
  if (depsDecision.outcome === "reinstall") {
    note("deps-at-head", `installing the head's dependencies in ${worktreePath}`);
    // Same fail-loud shape lane-bootstrap uses for its own deps step
    // (scripts/lane-bootstrap.ts): a partially-installed environment is not a
    // thing to verify against, so a non-zero install aborts before run-check.
    runNpmCi("deps-at-head", worktreePath);
  }
  step("deps-at-head", depsDecision.detail);
}
/**
 * One flag's handling. Table-driven so `parseArgs` stays a single loop over
 * data rather than an `else if` chain — same accepted flags, same errors, and
 * the complexity the chain accumulated (14, against a ceiling of 10) now lives
 * in the table instead of the control flow.
 */
interface FlagSpec {
  /** Consume the flag. Returns the index of the last argv slot it used. */
  apply: (index: number, argv: string[], out: Args) => number;
}

const FLAGS: Record<string, FlagSpec> = {
  "--check": {
    apply: (index, argv, out) => {
      out.check = argv[index + 1] ?? "";
      return index + 1;
    },
  },
  "--fresh-db": {
    apply: (index, _argv, out) => {
      out.freshDb = true;
      return index;
    },
  },
  "--help": {
    apply: (index) => {
      process.stdout.write(usage());
      process.exit(0);
      return index;
    },
  },
  "-h": {
    apply: (index) => {
      process.stdout.write(usage());
      process.exit(0);
      return index;
    },
  },
};

/** Place one non-flag argument: the first is the PR number, a second is an error. */
function applyPositional(arg: string, out: Args): void {
  if (!out.pr) {
    out.pr = arg;
    return;
  }
  throw new VerifyLaneError("args", `unexpected extra argument "${arg}".`, usage());
}

function parseArgs(argv: string[]): Args {
  const out: Args = { pr: "", check: null, freshDb: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const flag = FLAGS[arg];
    if (flag) {
      i = flag.apply(i, argv, out);
      continue;
    }
    if (arg.startsWith("-")) {
      throw new VerifyLaneError("args", `unknown argument "${arg}".`, usage());
    }
    applyPositional(arg, out);
  }

  if (!/^\d+$/.test(out.pr)) {
    throw new VerifyLaneError("args", "a PR number is required.", usage());
  }
  if (out.check !== null && !out.check.trim()) {
    throw new VerifyLaneError("args", "--check was given with no path.", usage());
  }

  return { pr: out.pr, check: out.check?.trim() ?? null, freshDb: out.freshDb };
}

/**
 * The six numbered steps, in order. Each one lives in
 * `scripts/verify-lane-support.ts` and names its own inputs; this function is
 * the sequence, and the sequence is the thing a reader has to be able to trust.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  process.stdout.write("verify-lane\n");
  process.stdout.write(`  PR:        #${args.pr}\n\n`);

  // --- 0. re-entry guard ----------------------------------------------------
  const alreadyVerifying = readAncestry(args);

  // --- 1. read the PR -------------------------------------------------------
  const pr = await readPullRequest(args);
  const headSha = readHeadSha(pr, args);

  // --- 2. resolve the check -------------------------------------------------
  const resolved = resolveCheck(pr.body ?? "", args.check);
  // Refuse a non-.sh path HERE, before the worktree is built and long before
  // anything hands it to bash (issue 733). Placing it at resolution time rather
  // than at the spawn means a mis-pointed Done-means line costs no bootstrap and
  // leaves no worktree behind for the operator to tear down.
  requireShellCheckPath(resolved.path);
  step("done-means", `${resolved.path} (from ${resolved.source})`);

  // The fresh database (issue 1667) is dropped on every exit after bootstrap
  // creates it: the finally below, plus exit/signal handlers for process.exit
  // and SIGINT/SIGTERM/SIGHUP. Only the name bootstrap printed is dropped.
  const dbGuard = createFreshDbGuard();
  installFreshDbSignalTeardown(dbGuard);

  await withFreshDbTeardown(dbGuard, async () => {
    // --- 3. fresh worktree, via lane-bootstrap ------------------------------
    const stamp = `${process.pid}${Date.now().toString(36)}`;
    const { worktreePath, bootstrapSha } = bootstrapWorktree(
      { args, headSha, resolved },
      stamp,
      (dbName) => dbGuard.adopt(dbName),
    );
    const freshDbDrop = dbGuard.dropLine();
    checkoutHead({ args, headSha, worktreePath });

    // --- 3b. dependencies AT THE HEAD (#775) -------------------------------
    installDepsAtHead({ headSha, worktreePath }, bootstrapSha);

    // --- 4. run the check ---------------------------------------------------
    const { checkOutput, teardown } = runCheck(
      { args, headSha, resolved, worktreePath, freshDbDrop },
      alreadyVerifying,
    );

    const ctx: LaneContext = {
      args,
      headSha,
      resolved,
      worktreePath,
      checkOutput,
      teardown,
      freshDbDrop,
    };

    // --- 5. re-read the head; refuse if the PR moved under us ---------------
    await recheckHead(ctx);

    // --- 6. post the receipt ------------------------------------------------
    const receipt = await postReceipt(ctx, stamp);
    printBanner(ctx, pr, receipt);
  });
}

if (import.meta.main) {
  await main().catch((err: unknown) => {
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
  });
}
