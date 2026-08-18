import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const PACKAGE_SCRIPT = join(import.meta.dir, "core01-package-runtime.sh");
// Repo-relative _scratch, the same convention operator-doctor.test.ts uses:
// writable in every environment that can check the repo out (a hardcoded
// host path here failed with EACCES on the CI runner, where the darwin/linux
// workspace roots do not exist or are not writable).
const TEMP_WORKSPACE =
  process.env.OPENBRAIN_TEMP_WORKSPACE ??
  join(import.meta.dir, "..", "_scratch", "core01-package-runtime");
const TEMP_ROOT = join(TEMP_WORKSPACE, "_scratch");
const ARCHIVE_ROOT = join(TEMP_WORKSPACE, "_archive");
const ownedTempDirs: string[] = [];

type ProcessEnv = Record<string, string | undefined>;

const GIT_ENV_KEYS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_SYSTEM",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_TEMPLATE_DIR",
  "GIT_WORK_TREE",
] as const;

async function run(
  command: string[],
  options: { cwd: string; env: ProcessEnv },
): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, output: stdout + stderr };
}

async function git(
  cwd: string,
  env: ProcessEnv,
  ...args: string[]
): Promise<string> {
  const result = await run(["git", ...args], { cwd, env });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.output}`);
  }
  return result.output.trim();
}

afterEach(async () => {
  await mkdir(ARCHIVE_ROOT, { recursive: true });
  for (const ownedDir of ownedTempDirs.splice(0)) {
    await rename(ownedDir, join(ARCHIVE_ROOT, basename(ownedDir)));
  }
});

describe("core01 runtime packaging", () => {
  test("replaces a stale source stamp with the packaged checkout revision", async () => {
    await mkdir(TEMP_ROOT, { recursive: true });
    const root = await mkdtemp(join(TEMP_ROOT, "core01-package-runtime-"));
    ownedTempDirs.push(root);
    const source = join(root, "source");
    const staging = join(root, "staging");
    const home = join(root, "home");
    await Promise.all([mkdir(source), mkdir(staging), mkdir(home)]);

    const env: ProcessEnv = { ...process.env };
    for (const key of GIT_ENV_KEYS) delete env[key];
    for (const key of Object.keys(env)) {
      if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) delete env[key];
    }
    Object.assign(env, {
      HOME: home,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    });
    await git(source, env, "init", "-b", "fixture-main");
    await git(source, env, "config", "user.name", "Core01 Package Test");
    await git(
      source,
      env,
      "config",
      "user.email",
      "core01-package@example.invalid",
    );
    await writeFile(join(source, "fixture.txt"), "packaged content\n");
    await git(source, env, "add", "fixture.txt");
    await git(source, env, "commit", "-m", "package fixture");
    const sha = await git(source, env, "rev-parse", "HEAD");
    const shortSha = await git(source, env, "rev-parse", "--short", "HEAD");

    await writeFile(
      join(source, ".deployed-revision"),
      "sha=stale-local-clone\nshort_sha=stale\n",
    );

    const result = await run(["bash", PACKAGE_SCRIPT, source, staging], {
      cwd: root,
      env,
    });

    // The packaging script is no longer silent (issue #675): it announces the
    // revision it exports, and any uncommitted path it is NOT deploying. The
    // old `output: ""` assertion encoded the tar-the-working-tree behavior,
    // where there was nothing to say because everything shipped. This fixture
    // deliberately leaves an untracked `.deployed-revision` in the source, so
    // the dirty announcement firing here is the announcement working.
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(`exporting ${shortSha}`);
    expect(result.output).toContain("they are NOT deployed");
    expect(await readFile(join(staging, "fixture.txt"), "utf8")).toBe(
      "packaged content\n",
    );
    const stamp = await readFile(
      join(staging, ".deployed-revision"),
      "utf8",
    );
    expect(stamp).toContain(`sha=${sha}\n`);
    expect(stamp).toContain(`short_sha=${shortSha}\n`);
    expect(stamp).not.toContain("stale-local-clone");
  });

  // Issue #675 (cutover-blocker B4): this script used to `tar -C $REPO_DIR`,
  // so a dirty file on the runner shipped to production with every gate
  // passing — the ref gate only asserts a git-HISTORY property and is a no-op
  // outside CI. `git archive` reads git object storage, which makes the
  // working tree structurally invisible rather than merely excluded.
  //
  // Asserted on staged CONTENT, deliberately: a source-level check for the
  // string "git archive" would pass for a script that mentions it and still
  // tars. Three flavors of dirty, because they fail differently — an untracked
  // file has no git object at all, a modified tracked file has a STALE one
  // (the dangerous case: something does ship, just not what is on disk), and a
  // staged-but-uncommitted file is in the index yet still not in the commit.
  test("exports the COMMIT, so no flavor of uncommitted work reaches staging", async () => {
    await mkdir(TEMP_ROOT, { recursive: true });
    const root = await mkdtemp(join(TEMP_ROOT, "core01-package-dirty-"));
    ownedTempDirs.push(root);
    const source = join(root, "source");
    const staging = join(root, "staging");
    const home = join(root, "home");
    await Promise.all([mkdir(source), mkdir(staging), mkdir(home)]);

    const env: ProcessEnv = { ...process.env };
    for (const key of GIT_ENV_KEYS) delete env[key];
    for (const key of Object.keys(env)) {
      if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) delete env[key];
    }
    Object.assign(env, {
      HOME: home,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    });
    await git(source, env, "init", "-b", "fixture-main");
    await git(source, env, "config", "user.name", "Core01 Package Test");
    await git(
      source,
      env,
      "config",
      "user.email",
      "core01-package@example.invalid",
    );
    await writeFile(join(source, "tracked.txt"), "COMMITTED_CONTENT\n");
    await git(source, env, "add", "tracked.txt");
    await git(source, env, "commit", "-m", "committed revision");
    const shortSha = await git(source, env, "rev-parse", "--short", "HEAD");

    // 1. modified tracked file — the committed version must ship, not this one
    await writeFile(join(source, "tracked.txt"), "DIRTY_EDIT_MARKER\n");
    // 2. untracked file — must not appear at all
    await writeFile(join(source, "untracked.txt"), "UNTRACKED_MARKER\n");
    // 3. staged but uncommitted — in the index, still not in the commit
    await writeFile(join(source, "staged.txt"), "STAGED_MARKER\n");
    await git(source, env, "add", "staged.txt");

    const result = await run(["bash", PACKAGE_SCRIPT, source, staging], {
      cwd: root,
      env,
    });
    expect(result.exitCode).toBe(0);

    expect(await readFile(join(staging, "tracked.txt"), "utf8")).toBe(
      "COMMITTED_CONTENT\n",
    );
    expect(existsSync(join(staging, "untracked.txt"))).toBe(false);
    expect(existsSync(join(staging, "staged.txt"))).toBe(false);

    // Not shipping it is correct; doing it silently is the defect
    // (AGENTS.md "nothing is adjusted silently"). All three paths are named.
    expect(result.output).toContain("they are NOT deployed");
    expect(result.output).toContain("tracked.txt");
    expect(result.output).toContain("untracked.txt");
    expect(result.output).toContain("staged.txt");

    const stamp = await readFile(join(staging, ".deployed-revision"), "utf8");
    expect(stamp).toContain(`short_sha=${shortSha}\n`);
  });

  // An unknown ref must fail BEFORE anything is written — a deploy that dies
  // halfway through staging leaves a partial tree the swap would happily move
  // into place.
  test("refuses an unresolvable ref without writing staging", async () => {
    await mkdir(TEMP_ROOT, { recursive: true });
    const root = await mkdtemp(join(TEMP_ROOT, "core01-package-badref-"));
    ownedTempDirs.push(root);
    const source = join(root, "source");
    const staging = join(root, "staging");
    const home = join(root, "home");
    await Promise.all([mkdir(source), mkdir(staging), mkdir(home)]);

    const env: ProcessEnv = { ...process.env };
    for (const key of GIT_ENV_KEYS) delete env[key];
    for (const key of Object.keys(env)) {
      if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) delete env[key];
    }
    Object.assign(env, {
      HOME: home,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    });
    await git(source, env, "init", "-b", "fixture-main");
    await git(source, env, "config", "user.name", "Core01 Package Test");
    await git(
      source,
      env,
      "config",
      "user.email",
      "core01-package@example.invalid",
    );
    await writeFile(join(source, "tracked.txt"), "committed\n");
    await git(source, env, "add", "tracked.txt");
    await git(source, env, "commit", "-m", "committed revision");

    const result = await run(
      ["bash", PACKAGE_SCRIPT, source, staging, "no-such-ref-675"],
      { cwd: root, env },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("not a commit: no-such-ref-675");
    expect(existsSync(join(staging, "tracked.txt"))).toBe(false);
    expect(existsSync(join(staging, ".deployed-revision"))).toBe(false);
  });
});
