import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOURCE_ROOT = join(import.meta.dir, "..");
const DEPLOY_SCRIPT = join(SOURCE_ROOT, "scripts", "core01-deploy-local.sh");
const GATE_SOURCE = join(SOURCE_ROOT, "scripts", "deploy-ref-gate.ts");
const ownedTempDirs: string[] = [];

interface GitFixture {
  checkout: string;
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

async function run(
  command: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env ?? process.env,
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

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await run(["git", ...args], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.output}`);
  }
  return result.output.trim();
}

async function createGitFixture(): Promise<GitFixture> {
  const root = await mkdtemp(join(tmpdir(), "open-brain-deploy-ref-"));
  ownedTempDirs.push(root);

  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const checkout = join(root, "checkout");
  await mkdir(seed);
  await git(root, "init", "--bare", remote);
  await git(seed, "init", "-b", "fixture-main");
  await git(seed, "config", "user.name", "Deploy Gate Test");
  await git(seed, "config", "user.email", "deploy-gate@example.invalid");

  await writeFile(join(seed, "fixture.txt"), "reachable tag\n");
  await git(seed, "add", "fixture.txt");
  await git(seed, "commit", "-m", "reachable tag commit");
  const reachableTagSha = await git(seed, "rev-parse", "HEAD");
  await git(seed, "tag", "v1.0.0");

  await writeFile(join(seed, "fixture.txt"), "current main\n");
  await git(seed, "commit", "-am", "current main commit");
  const mainSha = await git(seed, "rev-parse", "HEAD");

  await git(seed, "switch", "--orphan", "outside-main");
  await writeFile(join(seed, "outside.txt"), "outside main ancestry\n");
  await git(seed, "add", "outside.txt");
  await git(seed, "commit", "-m", "outside main commit");
  const outsideTagSha = await git(seed, "rev-parse", "HEAD");
  await git(seed, "tag", "v9.9.9");

  await git(seed, "remote", "add", "origin", remote);
  await git(
    seed,
    "push",
    "origin",
    "fixture-main:main",
    "outside-main",
    "--tags",
  );
  await git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  await git(root, "clone", remote, checkout);

  await mkdir(join(checkout, "scripts"));
  await writeFile(
    join(checkout, "scripts", "deploy-ref-gate.ts"),
    await Bun.file(GATE_SOURCE).text(),
  );

  return { checkout, mainSha, reachableTagSha, outsideTagSha, root };
}

async function invokeDeploy(
  fixture: GitFixture,
  metadata: Record<string, string>,
): Promise<DeployResult> {
  const runtimeDir = join(fixture.root, "runtime");
  const stagingDir = join(fixture.root, "staging");
  const envFile = join(fixture.root, "guaranteed-missing.env");
  const result = await run([DEPLOY_SCRIPT], {
    env: {
      ...process.env,
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
  expect(result.output).not.toContain("refusing core01 deploy");
  expect(existsSync(result.runtimeDir)).toBe(false);
  expect(existsSync(result.stagingDir)).toBe(false);
}

function expectGateRefusal(result: DeployResult, expectedReason: string): void {
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain(expectedReason);
  expect(result.output).not.toContain("deploy ref gate PASSED:");
  expect(result.output).not.toContain("env file missing:");
  expect(result.output).not.toContain("/Volumes/ThunderBolt is not mounted");
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

describe("core01 deploy shell ref-gate wiring", () => {
  it("lets a current-main manual dispatch reach only host preflight", async () => {
    const fixture = await createGitFixture();
    await git(fixture.checkout, "checkout", fixture.mainSha);

    const result = await invokeDeploy(fixture, {
      DEPLOY_PROVIDER: "forgejo",
      DEPLOY_EVENT_NAME: "workflow_dispatch",
      DEPLOY_REF: "refs/heads/main",
    });

    expectAllowedPreflight(result);
  });

  it("lets a reachable version tag reach only host preflight", async () => {
    const fixture = await createGitFixture();
    await git(fixture.checkout, "checkout", fixture.reachableTagSha);

    const result = await invokeDeploy(fixture, {
      DEPLOY_PROVIDER: "forgejo",
      DEPLOY_EVENT_NAME: "push",
      DEPLOY_REF: "refs/tags/v1.0.0",
    });

    expectAllowedPreflight(result);
  });

  it("refuses a stale manual commit before env loading or staging", async () => {
    const fixture = await createGitFixture();
    await git(fixture.checkout, "checkout", fixture.reachableTagSha);

    const result = await invokeDeploy(fixture, {
      DEPLOY_PROVIDER: "forgejo",
      DEPLOY_EVENT_NAME: "workflow_dispatch",
      DEPLOY_REF: "refs/heads/main",
    });

    expectGateRefusal(result, "HEAD is not the current main tip");
  });

  it("refuses a tag outside main ancestry before env loading or staging", async () => {
    const fixture = await createGitFixture();
    await git(fixture.checkout, "checkout", fixture.outsideTagSha);

    const result = await invokeDeploy(fixture, {
      DEPLOY_PROVIDER: "forgejo",
      DEPLOY_EVENT_NAME: "push",
      DEPLOY_REF: "refs/tags/v9.9.9",
    });

    expectGateRefusal(result, "HEAD is not reachable from main");
  });

  it("refuses unsupported provider and event metadata before preflight", async () => {
    const fixture = await createGitFixture();
    await git(fixture.checkout, "checkout", fixture.mainSha);

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
