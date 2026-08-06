import { afterEach, describe, expect, test } from "bun:test";
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

    expect(result).toEqual({ exitCode: 0, output: "" });
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
});
