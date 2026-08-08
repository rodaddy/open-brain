import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOURCE_ROOT = join(import.meta.dir, "..");
const DEPLOY_SCRIPT = join(SOURCE_ROOT, "scripts", "deployment_host-deploy-local.sh");
const GATE_SOURCE = join(SOURCE_ROOT, "scripts", "deploy-ref-gate.ts");
const PACKAGE_SOURCE = join(
  SOURCE_ROOT,
  "scripts",
  "deployment_host-package-runtime.sh",
);
const ownedTempDirs: string[] = [];
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

type ProcessEnv = Record<string, string | undefined>;
type GitRunner = (cwd: string, ...args: string[]) => Promise<string>;

interface GitFixture {
  checkout: string;
  env: ProcessEnv;
  git: GitRunner;
  mainSha: string;
  reachableTagSha: string;
  outsideTagSha: string;
  root: string;
}

interface DeployResult {
  exitCode: number;
  output: string;
  runtimeDir: string;
  stagingDir: string;
}

async function createIsolatedGitEnv(
  root: string,
  sourceEnv: ProcessEnv = process.env,
): Promise<ProcessEnv> {
  const home = join(root, "home");
  const xdgConfig = join(root, "xdg-config");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(xdgConfig, { recursive: true }),
  ]);

  const env: ProcessEnv = { ...sourceEnv };
  for (const key of GIT_ENV_KEYS) delete env[key];
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: xdgConfig,
    GIT_CONFIG_GLOBAL: join(xdgConfig, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

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

async function createGitFixture(
  sourceEnv: ProcessEnv = process.env,
): Promise<GitFixture> {
  const root = await mkdtemp(join(tmpdir(), "open-brain-deploy-ref-"));
  ownedTempDirs.push(root);
  const gitEnv = await createIsolatedGitEnv(join(root, "git-env"), sourceEnv);
  const runGit: GitRunner = (cwd, ...args) => git(cwd, gitEnv, ...args);

  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const checkout = join(root, "checkout");
  await mkdir(seed);
  await runGit(root, "init", "--bare", remote);
  await runGit(seed, "init", "-b", "fixture-main");
  await runGit(seed, "config", "user.name", "Deploy Gate Test");
  await runGit(seed, "config", "user.email", "deploy-gate@example.invalid");

  await writeFile(join(seed, "fixture.txt"), "reachable tag\n");
  await runGit(seed, "add", "fixture.txt");
  await runGit(seed, "commit", "-m", "reachable tag commit");
  const reachableTagSha = await runGit(seed, "rev-parse", "HEAD");
  await runGit(seed, "tag", "v1.0.0");

  await writeFile(join(seed, "fixture.txt"), "current main\n");
  await runGit(seed, "commit", "-am", "current main commit");
  const mainSha = await runGit(seed, "rev-parse", "HEAD");

  await runGit(seed, "switch", "--orphan", "outside-main");
  await writeFile(join(seed, "outside.txt"), "outside main ancestry\n");
  await runGit(seed, "add", "outside.txt");
  await runGit(seed, "commit", "-m", "outside main commit");
  const outsideTagSha = await runGit(seed, "rev-parse", "HEAD");
  await runGit(seed, "tag", "v9.9.9");

  await runGit(seed, "remote", "add", "origin", remote);
  await runGit(
    seed,
    "push",
    "origin",
    "fixture-main:main",
    "outside-main",
    "--tags",
  );
  await runGit(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  await runGit(root, "clone", remote, checkout);

  await mkdir(join(checkout, "scripts"));
  await writeFile(
    join(checkout, "scripts", "deploy-ref-gate.ts"),
    await Bun.file(GATE_SOURCE).text(),
  );
  // The deploy shell now delegates staging to this script, resolved from
  // REPO_DIR — the fixture checkout must carry it (executable) or the run
  // dies with exit 127 before the stage under test.
  const packageScript = join(checkout, "scripts", "deployment_host-package-runtime.sh");
  await writeFile(packageScript, await Bun.file(PACKAGE_SOURCE).text());
  await chmod(packageScript, 0o755);

  return {
    checkout,
    env: gitEnv,
    git: runGit,
    mainSha,
    reachableTagSha,
    outsideTagSha,
    root,
  };
}

async function invokeDeploy(
  fixture: GitFixture,
  metadata: Record<string, string>,
): Promise<DeployResult> {
  const runtimeDir = join(fixture.root, "runtime");
  const stagingDir = join(fixture.root, "staging");
  const envFile = join(fixture.root, "guaranteed-missing.env");
  const result = await run([DEPLOY_SCRIPT], {
    cwd: fixture.root,
    env: {
      ...fixture.env,
      BUN_BIN: process.execPath,
      REPO_DIR: fixture.checkout,
      ENV_FILE: envFile,
      RUNTIME_DIR: runtimeDir,
      STAGING_DIR: stagingDir,
      PREVIOUS_DIR: join(fixture.root, "previous"),
      QMD_PATH_VALUE: join(fixture.root, "qmd.ts"),
      SERVICE_LABEL: "invalid.test.open-brain",
      NATS_WORKER_LABEL: "invalid.test.open-brain-nats-worker",
      GITHUB_ACTIONS: undefined,
      GITHUB_EVENT_NAME: undefined,
      GITHUB_REF: undefined,
      FORGEJO_ACTIONS: undefined,
      DEPLOY_PROVIDER: metadata.DEPLOY_PROVIDER,
      DEPLOY_EVENT_NAME: metadata.DEPLOY_EVENT_NAME,
      DEPLOY_REF: metadata.DEPLOY_REF,
    },
  });
  return { ...result, runtimeDir, stagingDir };
}

function expectAllowedPreflight(result: DeployResult): void {
  const fatalLines = result.output
    .split("\n")
    .filter((line) => line.startsWith("FATAL:"));
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain("deploy ref gate PASSED:");
  expect(fatalLines).toHaveLength(1);
  expect(fatalLines[0]).toMatch(
    /FATAL: (\/Volumes\/ThunderBolt is not mounted|env file missing: )/,
  );
  expect(result.output).not.toContain("refusing deployment_host deploy");
  expect(existsSync(result.runtimeDir)).toBe(false);
  expect(existsSync(result.stagingDir)).toBe(false);
}

function expectGateRefusal(result: DeployResult, expectedReason: string): void {
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain(expectedReason);
  expect(result.output).not.toContain("deploy ref gate PASSED:");
  expect(result.output).not.toContain("env file missing:");
  expect(result.output).not.toContain("/path/to/open-brain is not mounted");
  expect(existsSync(result.runtimeDir)).toBe(false);
  expect(existsSync(result.stagingDir)).toBe(false);
}

afterEach(async () => {
  await Promise.all(
    ownedTempDirs
      .splice(0)
      .map((ownedDir) => rm(ownedDir, { recursive: true, force: true })),
  );
});

describe("deployment_host deploy shell ref-gate wiring", () => {
  it("isolates fixture Git commands from an enclosing worktree", async () => {
    const outerRoot = await mkdtemp(join(tmpdir(), "open-brain-git-env-"));
    ownedTempDirs.push(outerRoot);
    const owner = join(outerRoot, "owner");
    const linked = join(outerRoot, "linked");
    await mkdir(owner);

    const bootstrapEnv = await createIsolatedGitEnv(
      join(outerRoot, "bootstrap-env"),
    );
    const bootstrapGit: GitRunner = (cwd, ...args) =>
      git(cwd, bootstrapEnv, ...args);
    await bootstrapGit(owner, "init", "-b", "main");
    await bootstrapGit(owner, "config", "user.name", "Outer Repo Test");
    await bootstrapGit(
      owner,
      "config",
      "user.email",
      "outer-repo@example.invalid",
    );
    await writeFile(join(owner, "outer.txt"), "outer repository\n");
    await bootstrapGit(owner, "add", "outer.txt");
    await bootstrapGit(owner, "commit", "-m", "outer commit");
    await bootstrapGit(owner, "worktree", "add", "--detach", linked, "HEAD");

    const beforeHead = await bootstrapGit(owner, "rev-parse", "HEAD");
    const configPath = join(owner, ".git", "config");
    const beforeConfig = await readFile(configPath, "utf8");
    const inheritedGitDir = await bootstrapGit(
      linked,
      "rev-parse",
      "--absolute-git-dir",
    );
    const inheritedCommonDir = await bootstrapGit(
      linked,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    );
    const inheritedHome = join(outerRoot, "inherited-home");
    const inheritedTemplate = join(inheritedHome, "git-template");
    const inheritedHook = join(inheritedTemplate, "hooks", "pre-commit");
    await mkdir(join(inheritedTemplate, "hooks"), { recursive: true });
    await writeFile(
      join(inheritedHome, ".gitconfig"),
      "[commit]\n\tgpgsign = true\n",
    );
    await writeFile(inheritedHook, "#!/bin/sh\nexit 1\n");
    await chmod(inheritedHook, 0o755);
    const inheritedEnv: ProcessEnv = {
      ...process.env,
      GIT_COMMON_DIR: inheritedCommonDir,
      GIT_DIR: inheritedGitDir,
      GIT_INDEX_FILE: join(inheritedGitDir, "index"),
      GIT_TEMPLATE_DIR: inheritedTemplate,
      GIT_WORK_TREE: linked,
      HOME: inheritedHome,
      XDG_CONFIG_HOME: inheritedHome,
    };

    const fixture = await createGitFixture(inheritedEnv);
    expect(await fixture.git(fixture.checkout, "rev-parse", "HEAD")).toBe(
      fixture.mainSha,
    );
    expect(await bootstrapGit(owner, "rev-parse", "HEAD")).toBe(beforeHead);
    expect(await readFile(configPath, "utf8")).toBe(beforeConfig);
  });

  it("lets a current-main manual dispatch reach only host preflight", async () => {
    const fixture = await createGitFixture();
    await fixture.git(fixture.checkout, "checkout", fixture.mainSha);

    const result = await invokeDeploy(fixture, {
      DEPLOY_PROVIDER: "forgejo",
      DEPLOY_EVENT_NAME: "workflow_dispatch",
      DEPLOY_REF: "refs/heads/main",
    });

    expectAllowedPreflight(result);
  });

  it("lets a reachable version tag reach only host preflight", async () => {
    const fixture = await createGitFixture();
    await fixture.git(fixture.checkout, "checkout", fixture.reachableTagSha);

    const result = await invokeDeploy(fixture, {
      DEPLOY_PROVIDER: "forgejo",
      DEPLOY_EVENT_NAME: "push",
      DEPLOY_REF: "refs/tags/v1.0.0",
    });

    expectAllowedPreflight(result);
  });

  it("refuses a stale manual commit before env loading or staging", async () => {
    const fixture = await createGitFixture();
    await fixture.git(fixture.checkout, "checkout", fixture.reachableTagSha);

    const result = await invokeDeploy(fixture, {
      DEPLOY_PROVIDER: "forgejo",
      DEPLOY_EVENT_NAME: "workflow_dispatch",
      DEPLOY_REF: "refs/heads/main",
    });

    expectGateRefusal(result, "HEAD is not the current main tip");
  });

  it("refuses a tag outside main ancestry before env loading or staging", async () => {
    const fixture = await createGitFixture();
    await fixture.git(fixture.checkout, "checkout", fixture.outsideTagSha);

    const result = await invokeDeploy(fixture, {
      DEPLOY_PROVIDER: "forgejo",
      DEPLOY_EVENT_NAME: "push",
      DEPLOY_REF: "refs/tags/v9.9.9",
    });

    expectGateRefusal(result, "HEAD is not reachable from main");
  });

  it("refuses unsupported provider and event metadata before preflight", async () => {
    const fixture = await createGitFixture();
    await fixture.git(fixture.checkout, "checkout", fixture.mainSha);

    const unsupportedProvider = await invokeDeploy(fixture, {
      DEPLOY_PROVIDER: "gitlab",
      DEPLOY_EVENT_NAME: "workflow_dispatch",
      DEPLOY_REF: "refs/heads/main",
    });
    expectGateRefusal(unsupportedProvider, "unsupported provider: gitlab");

    const unsupportedEvent = await invokeDeploy(fixture, {
      DEPLOY_PROVIDER: "forgejo",
      DEPLOY_EVENT_NAME: "pull_request",
      DEPLOY_REF: "refs/heads/main",
    });
    expectGateRefusal(
      unsupportedEvent,
      "unsupported trigger: event=pull_request",
    );
  });
});
