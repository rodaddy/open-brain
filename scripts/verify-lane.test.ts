// Tests for verify-lane's deps-at-head reconciliation (#775).
//
// These exercise ONLY the pure decision function and the git comparison it is
// fed. They never call gh, never run lane-bootstrap, and never post a receipt —
// importing scripts/verify-lane.ts is safe because main() runs behind an
// `import.meta.main` guard.
//
// WHAT THE DEFECT WAS. lane-bootstrap cuts the verification worktree from
// origin/main and installs deps THERE; verify-lane then hard-resets the same
// worktree onto the PR head without reinstalling. Any PR that adds a
// dependency was verified against origin/main's node_modules and could never
// earn a receipt (measured twice on PR #771, which adds oxlint).
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { decideDepsAtHead, DEPENDENCY_MANIFESTS } from "./verify-lane.ts";

describe("DEPENDENCY_MANIFESTS", () => {
  it("covers both files that decide what bun install produces", () => {
    // A manifest missing from this list is a manifest whose change is invisible
    // to the comparison, which is the original defect in a narrower form.
    expect([...DEPENDENCY_MANIFESTS]).toEqual(["package.json", "bun.lock"]);
  });
});

describe("decideDepsAtHead", () => {
  it("reinstalls, and says so, when the manifests differ from the bootstrap ref", () => {
    const decision = decideDepsAtHead({
      baseRef: "origin/main",
      headSha: "2d67702",
      manifestsDiffer: true,
    });
    expect(decision.reinstall).toBe(true);
    expect(decision.detail).toContain("reinstalled");
    expect(decision.detail).toContain("differs from origin/main");
  });

  it("skips the install, and still says so, when the manifests match", () => {
    // Nothing is adjusted silently: the no-op path must ALSO produce a line,
    // or a reader cannot tell "checked, identical" from "never checked".
    const decision = decideDepsAtHead({
      baseRef: "origin/main",
      headSha: "2d67702",
      manifestsDiffer: false,
    });
    expect(decision.reinstall).toBe(false);
    expect(decision.detail).toContain("unchanged");
    expect(decision.detail).toContain("matches origin/main");
  });

  it("names the head SHA on both paths so the line is bound to a commit", () => {
    for (const manifestsDiffer of [true, false]) {
      const decision = decideDepsAtHead({
        baseRef: "origin/main",
        headSha: "deadbeef",
        manifestsDiffer,
      });
      expect(decision.detail).toContain("deadbeef");
    }
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

  // `-C <repo>` and an explicit --git-dir/--work-tree, NOT a bare cwd. A bare
  // `cwd` lets git walk UP to the first enclosing repository when the fixture
  // is not one — which is how a failed `git init` silently committed this
  // fixture's `base` and `docs only` commits into the surrounding worktree
  // during authoring, deleting every tracked file in it. Pinning the git dir
  // makes that walk impossible: git errors instead of finding a parent repo.
  const git = (args: string[]): string => {
    const r = spawnSync(
      "git",
      ["--git-dir", join(repo, ".git"), "--work-tree", repo, ...args],
      { cwd: repo, encoding: "utf-8" },
    );
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
    }
    return (r.stdout ?? "").trim();
  };

  beforeAll(() => {
    const base =
      process.env.OPENBRAIN_TEMP_WORKSPACE?.trim() ||
      process.env.DEV_TMP?.trim() ||
      "/Volumes/ThunderBolt/_tmp";
    const scratch = join(base, "open-brain", "_scratch");
    mkdirSync(scratch, { recursive: true });
    repo = mkdtempSync(join(scratch, "verify-lane-deps-test-"));

    // A branch that is deliberately NOT "main": the operator's global
    // protected-branch hook refuses commits there, including in a throwaway
    // repository, and the branch name is irrelevant to what this proves.
    // `init` runs before the fixture is a repo, so it cannot go through the
    // pinned helper above. Its success is ASSERTED rather than assumed: an
    // unchecked init is exactly what let every later git call escape upward.
    const init = spawnSync("git", ["-C", repo, "init", "--quiet", "-b", "fixture"], {
      encoding: "utf-8",
    });
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
    // No delete path: the scratch repo is left for the operator's sweep,
    // matching this repo's teardown-is-printed-never-executed rule.
    if (repo) process.stdout.write(`  scratch repo left at: ${repo}\n`);
  });

  const diffStatus = (from: string, to: string): number => {
    const r = spawnSync(
      "git",
      ["diff", "--quiet", from, to, "--", ...DEPENDENCY_MANIFESTS],
      { cwd: repo, encoding: "utf-8" },
    );
    return r.status ?? -1;
  };

  it("reports a difference when the head adds a devDependency", () => {
    const status = diffStatus(baseSha, addsDepSha);
    expect(status).toBe(1);
    expect(decideDepsAtHead({ baseRef: baseSha, headSha: addsDepSha, manifestsDiffer: status === 1 }).reinstall).toBe(true);
  });

  it("reports no difference when the head changes only unrelated files", () => {
    const status = diffStatus(baseSha, unrelatedSha);
    expect(status).toBe(0);
    expect(decideDepsAtHead({ baseRef: baseSha, headSha: unrelatedSha, manifestsDiffer: status === 1 }).reinstall).toBe(false);
  });
});
