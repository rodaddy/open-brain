/**
 * verify-lane io — the pieces of `scripts/verify-lane.ts` that only talk: the
 * error type, the usage text, the two step printers, the subprocess capture
 * helper, the done-means resolver, and the receipt prefix the merge gate
 * parses.
 *
 * Split out of `verify-lane.ts` alongside `verify-lane-support.ts` (issue 1011,
 * ruling M14) because the single file carried 518 code lines against the 500
 * ceiling in `.oxlintrc.json` and the pre-commit gate refused every commit that
 * staged it. The move is MECHANICAL: every symbol is verbatim and every string
 * it prints is byte-identical to the single-file version.
 *
 * Nothing here reads the repository, the network, or the environment beyond
 * `process.env` for a child process, which is what makes it the layer with no
 * ordering constraints — the steps in `verify-lane-support.ts` import from
 * here, never the other way round.
 */

import { spawnSync } from "node:child_process";

/** The first token of the receipt comment, parsed by `.claude/hooks/merge-gate.ts`. */
export const RECEIPT_PREFIX = "verify-lane receipt:";

/**
 * A named failure. `step` is the phase that failed and is printed in the
 * `[FAIL] <step>: <message>` line; `detail` is the operator-facing body.
 */
export class VerifyLaneError extends Error {
  readonly step: string;
  readonly detail: string;

  constructor(step: string, message: string, detail: string = "") {
    super(message);
    this.step = step;
    this.detail = detail;
  }
}

export function usage(): string {
  return [
    "verify-lane — re-run a PR's done-means check on its own head and receipt it.",
    "",
    "  node scripts/verify-lane.ts <pr-number> [--check <path>] [--fresh-db]",
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

export function step(name: string, detail: string): void {
  process.stdout.write(`  [ok]   ${name}: ${detail}\n`);
}

export function note(name: string, detail: string): void {
  process.stdout.write(`  [..]   ${name}: ${detail}\n`);
}

/** Run a command, capturing stdout. Named failure, no swallowed exit codes. */
export function capture(
  stepName: string,
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; input?: string },
): string {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd,
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
 * Refuse a done-means path that `bash` cannot run, BEFORE anything spawns it.
 *
 * WHY THIS EXISTS (issue 733). `runCheck` in `scripts/verify-lane-support.ts`
 * calls `spawnSync("bash", [checkPath])`. Nothing there asks what the file is,
 * so a PR whose `- Done-means:` line names a `.ts` or `.test.ts` file gets
 * TypeScript fed to bash, which parses it line by line and dies on the first
 * `import` with a syntax error at exit 2. verify-lane then prints
 * `<path> exited 2 at PR head <sha>` — indistinguishable from a real red check.
 * The lane reads that as "my work failed" when in fact nothing ran at all.
 *
 * Naming a test file is the natural mistake, not an exotic one: a lane's actual
 * evidence usually IS a test, so pointing the line at it is the obvious move.
 * The fix is therefore not just a refusal but the RECIPE — the wrapper script
 * that makes the test runnable by bash — printed verbatim, so the author does
 * not have to work out the convention from the surrounding files.
 *
 * This is a HARNESS ERROR, and it travels the same `VerifyLaneError` path every
 * other pre-check refusal uses (`resolveCheck` above, `requireCheckExists` in
 * the support module). No new exit value is introduced: `verify-lane.ts`'s top
 * level already turns a `VerifyLaneError` into a named `[FAIL] <step>:` line and
 * a non-zero exit, and a receipt is posted on NO path that throws. What matters
 * for the defect is that the refusal is distinguishable from a check verdict,
 * and a `[FAIL] done-means:` line naming the wrapper recipe is exactly that.
 *
 * A path with no extension is refused too. bash would happily run it, but a
 * done-means check that does not announce itself as a shell script is a guess,
 * and the convention every existing check in `scripts/done-means/` follows is
 * the `.sh` suffix.
 */
export function requireShellCheckPath(path: string): void {
  if (path.toLowerCase().endsWith(".sh")) return;

  throw new VerifyLaneError(
    "done-means",
    `${path} is not a shell script, and verify-lane runs the done-means check with bash.`,
    [
      "Nothing was run and nothing is receipted. bash would read this file line",
      "by line and exit on a syntax error, which verify-lane would then report as",
      "a failing check — a harness error wearing a verdict's clothes.",
      "",
      "Wrap it in a shell script and point the Done-means line at the wrapper:",
      "",
      "  1. Create scripts/done-means/<issue>-<slug>.sh containing:",
      "",
      `       npm run test:isolated -- ${path}`,
      "",
      "  2. Change the PR body's Verification line to name the wrapper:",
      "",
      "       - Done-means: scripts/done-means/<issue>-<slug>.sh",
    ].join("\n"),
  );
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
export function resolveCheck(
  body: string,
  flagCheck: string | null,
): { path: string; source: string } {
  // `- Done-means: <path>`, tolerant of leading whitespace and bullet spelling,
  // deliberately NOT tolerant of bold labels — lane-contract.md records that
  // bolded labels break `^-\s*Label:` matching, so the plain form is the one
  // lanes are told to write and the one this reads.
  const match = body.match(/^[ \t]*-[ \t]*Done-means:[ \t]*(\S+)[ \t]*$/m);
  const matched = match?.[1];
  if (matched !== undefined) {
    return { path: matched, source: "PR body '- Done-means:' line" };
  }
  if (flagCheck) return { path: flagCheck, source: "--check flag" };

  throw new VerifyLaneError(
    "done-means",
    "no done-means check could be resolved for this PR.",
    [
      "Nothing was verified, so nothing is being receipted. This is a refusal,",
      "not a pass: a verification run that exited 0 having run no check would",
      'hand merge-gate a receipt meaning "I ran nothing".',
      "",
      "Give it one of these:",
      "",
      "  1. Add a line to the PR body's Verification section:",
      "",
      "       - Done-means: scripts/done-means/<check>.sh",
      "",
      "     (plain bullet, no bold label — a bolded label breaks the match, and",
      "      an h3 inside a validator section silently cuts it short.)",
      "",
      "  2. Or name it on the command line:",
      "",
      "       node scripts/verify-lane.ts <pr-number> --check scripts/done-means/<check>.sh",
    ].join("\n"),
  );
}
