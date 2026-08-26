// Tests for verify-lane's deps-at-head reconciliation (#775).
//
// These exercise ONLY the pure decision function and the git comparison it is
// fed. They never call gh, never run lane-bootstrap, and never post a receipt —
// importing scripts/verify-lane.ts is safe because main() runs behind an
// `import.meta.main` guard.
//
// WHAT THE DEFECT WAS. lane-bootstrap cuts the verification worktree from a
// base ref and installs deps THERE; verify-lane then hard-resets the same
// worktree onto the PR head without reinstalling. Any PR that adds a
// dependency was verified against the base's node_modules and could never earn
// a receipt (measured twice on PR #771, which adds oxlint).
//
// EVERY GIT CALL IN THIS FILE IS FENCED. See `gitEnv` below: a fixture that is
// not a repository makes git walk UP to the first enclosing one, and this file
// runs inside a checkout. The fence is belt AND braces because a single
// unpinned call is enough to corrupt the branch under development — which is
// exactly what happened while authoring this file.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decideDepsAtHead, DEPENDENCY_MANIFESTS } from "./verify-lane.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Repo-relative, matching src/operator-doctor.test.ts:29 — `_scratch/` is
// already excluded by .gitignore:119. NOT a hardcoded `/Volumes/...` default:
// that is the operator's Mac, and CI died on `EACCES: permission denied, mkdir
// '/Volumes'` on the Linux runner.
const SCRATCH_DIR = join(REPO_ROOT, "_scratch", "verify-lane-deps");
const ARCHIVE_DIR = join(REPO_ROOT, "_scratch", "_archive", "verify-lane-deps");

/**
 * Environment fence for every git invocation against a fixture.
 *
 * `--git-dir`/`--work-tree` flags pin the target, but they are only as good as
 * the next person remembering to pass them. These variables would override or
 * redirect a git call that lost its flags, so they are cleared outright, and
 * GIT_CEILING_DIRECTORIES makes the upward discovery walk stop at the fixture's
 * parent — so even a fully unflagged `git` cannot reach the enclosing checkout.
 */
function gitEnv(fixtureParent: string): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
  ]) {
    delete env[key];
  }
  env.GIT_CEILING_DIRECTORIES = fixtureParent;
  return env as NodeJS.ProcessEnv;
}

describe("DEPENDENCY_MANIFESTS", () => {
  it("covers both files that decide what bun install produces", () => {
    // A manifest missing from this list is a manifest whose change is invisible
    // to the comparison, which is the original defect in a narrower form.
    expect([...DEPENDENCY_MANIFESTS]).toEqual(["package.json", "bun.lock"]);
  });
});

describe("decideDepsAtHead", () => {
  const BOOT = "1111111111111111111111111111111111111111";
  const HEAD = "2222222222222222222222222222222222222222";

  it("reinstalls, and says so, when git reports a difference (status 1)", () => {
    const decision = decideDepsAtHead({
      bootstrapSha: BOOT,
      headSha: HEAD,
      diffStatus: 1,
    });
    expect(decision.outcome).toBe("reinstall");
    expect(decision.detail).toContain("reinstalled");
    expect(decision.detail).toContain(BOOT);
    expect(decision.detail).toContain(HEAD);
  });

  it("skips the install, and still says so, when git reports no difference (status 0)", () => {
    // Nothing is adjusted silently: the no-op path must ALSO produce a line,
    // or a reader cannot tell "checked, identical" from "never checked".
    const decision = decideDepsAtHead({
      bootstrapSha: BOOT,
      headSha: HEAD,
      diffStatus: 0,
    });
    expect(decision.outcome).toBe("unchanged");
    expect(decision.detail).toContain("unchanged");
    expect(decision.detail).toContain(BOOT);
  });

  // THE FAIL-CLOSED BRANCH. This is why the function takes the raw exit code
  // rather than a boolean: with a boolean the status handling lived at the call
  // site, untested, and a mutant that ignored it passed everything.
  it("THROWS on any status outside {0,1} rather than assuming 'unchanged'", () => {
    for (const status of [2, 128, 129, -1]) {
      expect(() =>
        decideDepsAtHead({ bootstrapSha: BOOT, headSha: HEAD, diffStatus: status }),
      ).toThrow(/Refusing to guess/);
    }
  });

  it("THROWS when the status is null (the command never produced one)", () => {
    expect(() =>
      decideDepsAtHead({ bootstrapSha: BOOT, headSha: HEAD, diffStatus: null }),
    ).toThrow(/Refusing to guess/);
  });

  it("names the bootstrap commit, not a mutable ref", () => {
    // P1-a: diffing against `origin/main` silently skips the install whenever
    // that ref advances between bootstrap and the compare. The step line must
    // therefore quote the SHA that was actually installed from.
    const decision = decideDepsAtHead({
      bootstrapSha: BOOT,
      headSha: HEAD,
      diffStatus: 0,
    });
    expect(decision.detail).toContain(BOOT);
    expect(decision.detail).not.toContain("origin/main");
  });
});

// The decision is only as good as the signal feeding it, so drive the real
// `git diff --quiet` against a throwaway repository whose head adds a
// devDependency — the exact shape of PR #771.
describe("git diff --quiet over the dependency manifests", () => {
  let repo = "";
  let baseSha = "";
  let addsDepSha = "";
  let unrelatedSha = "";

  // Pin BOTH the git dir and the work tree, never a bare -C, and fence the
  // environment. With only -C, git walks UP to the first enclosing repository
  // when the fixture is not one — which is how a failed `git init` silently
  // committed this fixture's `base` and `docs only` commits into the
  // surrounding worktree during authoring, deleting every tracked file in it.
  const git = (args: string[]): string => {
    const r = spawnSync(
      "git",
      ["--git-dir", join(repo, ".git"), "--work-tree", repo, ...args],
      { cwd: repo, encoding: "utf-8", env: gitEnv(SCRATCH_DIR) },
    );
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
    }
    return (r.stdout ?? "").trim();
  };

  beforeAll(() => {
    mkdirSync(SCRATCH_DIR, { recursive: true });
    repo = mkdtempSync(join(SCRATCH_DIR, "fixture-"));

    // `init` is the one call that predates the repo, and it was previously the
    // ONLY unpinned git call in this file. Unpinned it would re-initialise
    // whatever an inherited GIT_DIR pointed at, BEFORE the missing-.git
    // assertion below could run. So it is pinned and fenced like every other
    // call, and its success is then ASSERTED on both the exit code and the
    // resulting .git — an unchecked init is what enables the escape at all.
    const init = spawnSync(
      "git",
      ["--git-dir", join(repo, ".git"), "--work-tree", repo, "init", "--quiet", "-b", "fixture"],
      { cwd: repo, encoding: "utf-8", env: gitEnv(SCRATCH_DIR) },
    );
    if (init.status !== 0) {
      throw new Error(`git init failed in ${repo}: ${init.stderr}`);
    }
    if (!existsSync(join(repo, ".git"))) {
      throw new Error(
        `git init reported success but ${join(repo, ".git")} does not exist. ` +
          "Refusing to run git here: every later call would walk up to the " +
          "enclosing repository and commit into it.",
      );
    }

    git(["config", "user.email", "test@example.invalid"]);
    git(["config", "user.name", "verify-lane test"]);
    git(["config", "core.hooksPath", join(repo, ".git", "no-hooks")]);
    git(["config", "commit.gpgsign", "false"]);

    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "t" }) + "\n");
    writeFileSync(join(repo, "bun.lock"), "lock-v1\n");
    writeFileSync(join(repo, "README.md"), "base\n");
    git(["add", "."]);
    git(["commit", "--quiet", "-m", "base"]);
    baseSha = git(["rev-parse", "HEAD"]);

    // A head that adds a devDependency — #771's shape.
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ name: "t", devDependencies: { oxlint: "1.0.0" } }) + "\n",
    );
    writeFileSync(join(repo, "bun.lock"), "lock-v1\noxlint\n");
    git(["add", "."]);
    git(["commit", "--quiet", "-m", "add oxlint"]);
    addsDepSha = git(["rev-parse", "HEAD"]);

    // A head that touches neither manifest.
    git(["reset", "--hard", "--quiet", baseSha]);
    writeFileSync(join(repo, "README.md"), "changed\n");
    git(["add", "."]);
    git(["commit", "--quiet", "-m", "docs only"]);
    unrelatedSha = git(["rev-parse", "HEAD"]);
  });

  afterAll(() => {
    // Archive with mv, never rm (AGENTS.md: an agent runs no recursive delete).
    // Fixtures accumulate inside the checkout otherwise, since _scratch/ is now
    // repo-relative.
    if (!repo || !existsSync(repo)) return;
    mkdirSync(ARCHIVE_DIR, { recursive: true });
    const dest = join(ARCHIVE_DIR, `${Date.now()}-${process.pid}`);
    renameSync(repo, dest);
    process.stdout.write(`  fixture archived to: ${dest}\n`);
  });

  const diffStatus = (from: string, to: string): number => {
    // Pinned and fenced like every other call in this file (review round 1, P2).
    const r = spawnSync(
      "git",
      [
        "--git-dir", join(repo, ".git"),
        "--work-tree", repo,
        "diff", "--quiet", from, to, "--", ...DEPENDENCY_MANIFESTS,
      ],
      { cwd: repo, encoding: "utf-8", env: gitEnv(SCRATCH_DIR) },
    );
    return r.status ?? -1;
  };

  it("reports a difference when the head adds a devDependency", () => {
    const status = diffStatus(baseSha, addsDepSha);
    expect(status).toBe(1);
    expect(
      decideDepsAtHead({ bootstrapSha: baseSha, headSha: addsDepSha, diffStatus: status })
        .outcome,
    ).toBe("reinstall");
  });

  it("reports no difference when the head changes only unrelated files", () => {
    const status = diffStatus(baseSha, unrelatedSha);
    expect(status).toBe(0);
    expect(
      decideDepsAtHead({ bootstrapSha: baseSha, headSha: unrelatedSha, diffStatus: status })
        .outcome,
    ).toBe("unchanged");
  });

  it("fails closed when the comparison names a commit that does not exist", () => {
    // A bad ref is the realistic way git answers with neither 0 nor 1, and it
    // must throw rather than be read as "manifests match".
    const status = diffStatus(baseSha, "0".repeat(40));
    expect(status).not.toBe(0);
    expect(status).not.toBe(1);
    expect(() =>
      decideDepsAtHead({ bootstrapSha: baseSha, headSha: "0".repeat(40), diffStatus: status }),
    ).toThrow(/Refusing to guess/);
  });
});
