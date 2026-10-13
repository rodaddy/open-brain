/**
 * One shared resolver for a test's writable scratch directory.
 *
 * Two constraints govern where a test may write, and neither is visible at the
 * point of use — which is why every test file that hand-rolled this got at
 * least one of them subtly wrong:
 *
 *   * `os.tmpdir()`, `/tmp`, and `$TMPDIR` are sandbox-local. A runner, a Codex
 *     sandbox, and the host each see a DIFFERENT one, so a file written there
 *     is invisible to the others and vanishes without a signal. Development
 *     AGENTS.md makes this a hard rule; this module is how a test obeys it
 *     without having to remember it.
 *   * The override is read through `./ambient-env.ts`, not `process.env`.
 *     `server/**` may not touch `process.env` (`.oxlintrc.json`, the L2b rung),
 *     and that helper is the repo's one named, greppable reader living outside
 *     the rule's scope. The resolved value is identical either way; the
 *     difference is that one of them is greppable and the other is a lint
 *     failure waiting for a file to move.
 *
 * `scripts/done-means/1182-scratch-helper.sh` is the standing guard on both.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readAmbientEnv } from "./ambient-env.ts";

/**
 * The base under which every scratch directory is created when
 * `OPENBRAIN_TEST_SCRATCH_DIR` is unset: the repo's own gitignored `_scratch/`,
 * anchored to this module rather than the process cwd. The same pattern — and
 * the reason for it — is `server/logging/logging.test.ts`: an absolute
 * macOS-volume default fails on the Linux CI runner with
 * `EACCES: mkdir '/Volumes'`, while a repo-relative base is writable on every
 * host that can check the repo out. On the Mac, point
 * `OPENBRAIN_TEST_SCRATCH_DIR` at the temp workspace to keep scratch out of
 * the checkout entirely.
 */
const DEFAULT_SCRATCH_BASE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../_scratch/tests",
);

/** Resolves the scratch base — the ambient override when set, else the default. */
export function testScratchBase(): string {
  return readAmbientEnv("OPENBRAIN_TEST_SCRATCH_DIR") ?? DEFAULT_SCRATCH_BASE;
}

/**
 * Creates and returns a fresh scratch directory for one test.
 *
 * `prefix` names the caller so a leftover directory is attributable; the
 * returned path is unique per call, so two callers sharing a prefix never
 * collide. The base is created if absent — a caller should not have to know
 * whether it is the first test to run on a fresh machine.
 */
export function testScratchDir(prefix: string): string {
  const base = testScratchBase();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}
