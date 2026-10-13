import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { testScratchDir } from "./test-support/scratch-dir.ts";
import { servingProcessSpec } from "./local-clone.ts";
import { waitForOutput } from "./test-support/wait-for-output.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const scratch = testScratchDir("local-clone-node-runtime-");
const launched = new Set<ChildProcess>();
const exitPromises = new Map<ChildProcess, Promise<number | null>>();
const stdoutOf = new Map<ChildProcess, () => string>();
const bash = process.platform === "darwin" ? "/opt/homebrew/bin/bash" : "bash";
// Logged by the wrapper only after its TERM/INT traps are installed (issue 1700).
const TRAPS_READY = "forwarding TERM and INT to launcher pid";

async function waitFor(
  read: () => Promise<string> | string,
  text: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await read()).includes(text)) return;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${text}`);
}

function waitForLine(file: string, text: string): Promise<void> {
  return waitFor(() => readFile(file, "utf8").catch(() => ""), text);
}

function waitForStdout(child: ChildProcess, text: string): Promise<void> {
  const read = stdoutOf.get(child);
  if (!read) throw new Error("stdout was not captured at spawn");
  // Event-driven, no clock (issue 1700): a clock jump cannot time it out.
  return waitForOutput(child, read, text);
}

async function fixture(name: string): Promise<{ root: string; receipt: string }> {
  const root = path.join(scratch, name);
  const runtime = path.join(root, "app");
  const receipt = path.join(root, "receipt.jsonl");
  await mkdir(path.join(runtime, "server"), { recursive: true });
  await mkdir(path.join(runtime, "scripts"), { recursive: true });
  await writeFile(path.join(runtime, "server/main.ts"), "// fixture\n");
  await writeFile(
    path.join(runtime, "scripts/local-clone.ts"),
    `import { appendFile } from "node:fs/promises";
const receipt = process.env.FIXTURE_RECEIPT;
const mode = process.argv[2];
// Handlers first: the receipt row is the test's proof they exist (issue 1700).
const stop = async (signal) => { await appendFile(receipt, JSON.stringify({ signal }) + "\\n"); process.exit(Number(process.env.FIXTURE_START_EXIT ?? 0)); };
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));
await appendFile(receipt, JSON.stringify({ mode, cwd: process.cwd(), clone: process.env.OPENBRAIN_LOCAL_CLONE, ppid: process.ppid }) + "\\n");
if (mode === "--verify") process.exit(Number(process.env.FIXTURE_VERIFY_EXIT ?? 0));
setInterval(() => {}, 1000);
`,
  );
  await writeFile(
    path.join(root, "local-clone.env"),
    `OPENBRAIN_LOCAL_CLONE=1\nFIXTURE_RECEIPT=${receipt}\n`,
  );
  await chmod(path.join(root, "local-clone.env"), 0o600);
  return { root, receipt };
}

function startWrapper(root: string, extra: NodeJS.ProcessEnv = {}): ChildProcess {
  const child = spawn(bash, ["scripts/local-clone-autostart.sh"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...extra,
      OPENBRAIN_LOCAL_CLONE_ROOT: root,
      OPENBRAIN_RUNTIME_DIR: path.join(root, "app"),
      NODE_BIN: process.execPath,
      BUN_BIN: "/usr/bin/false",
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    out += chunk;
  });
  child.stderr?.resume();
  stdoutOf.set(child, () => out);
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  launched.add(child);
  exitPromises.set(child, exit);
  return child;
}

function exited(child: ChildProcess): Promise<number | null> {
  const exit = exitPromises.get(child);
  if (!exit) throw new Error("exit promise was not armed at spawn");
  return exit;
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

afterEach(async () => {
  for (const child of launched) {
    signalGroup(child, "SIGTERM");
  }
  await Promise.race([Promise.all([...launched].map(exited)), delay(500)]);
  for (const child of launched) {
    signalGroup(child, "SIGKILL");
  }
  launched.clear();
  exitPromises.clear();
  stdoutOf.clear();
});

describe("local clone Node runtime boundaries", () => {
  it("passes the TypeScript entrypoint directly to Node", () => {
    expect(servingProcessSpec()).toEqual({
      executable: process.execPath,
      arguments: ["server/main.ts"],
    });
  });

  it("refuses startup when the Node preflight fails", async () => {
    const run = await fixture("preflight-failure");
    const child = startWrapper(run.root, { FIXTURE_VERIFY_EXIT: "17" });
    expect(await exited(child)).toBe(1);
    const rows = (await readFile(run.receipt, "utf8"))
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      mode: "--verify",
      cwd: path.join(run.root, "app"),
      clone: "1",
      ppid: child.pid,
    });
  });

  it("keeps Bash as parent, runs verify then start, and forwards TERM with child exit", async () => {
    const run = await fixture("signal-forwarding");
    const child = startWrapper(run.root, { FIXTURE_START_EXIT: "23" });
    // Both sides must be ready before TERM: the wrapper's traps (its log line)
    // and the launcher's handlers (the fixture writes --start after them).
    await waitForStdout(child, TRAPS_READY);
    await waitForLine(run.receipt, '"mode":"--start"');
    const exit = exited(child);
    child.kill("SIGTERM");
    expect(await exit).toBe(23);
    const rows = (await readFile(run.receipt, "utf8"))
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row));
    expect(rows.map((row) => row.mode).filter(Boolean)).toEqual([
      "--verify",
      "--start",
    ]);
    expect(rows.find((row) => row.mode === "--start")?.ppid).toBe(child.pid);
    expect(rows.at(-1)).toEqual({ signal: "SIGTERM" });
  });

  it("deploy source uses pinned Node/npm commands and remains valid Bash", async () => {
    const wrapper = await readFile(
      path.join(repoRoot, "scripts/local-clone-autostart.sh"),
      "utf8",
    );
    const deploy = await readFile(
      path.join(repoRoot, "scripts/local-clone-deploy.sh"),
      "utf8",
    );
    expect(deploy).toContain(
      'NODE_BIN="${NODE_BIN:-/opt/homebrew/opt/node@24/bin/node}"',
    );
    expect(deploy).toContain(
      'NPM_CLI="${NPM_CLI:-/opt/homebrew/opt/node@24/lib/node_modules/npm/bin/npm-cli.js}"',
    );
    expect(deploy).toContain('(cd "$STAGING_DIR" && "$NODE_BIN" "$NPM_CLI" ci)');
    expect(deploy).toContain('(cd "$STAGING_DIR" && "$NODE_BIN" scripts/migrate.ts)');
    expect(deploy).not.toMatch(/^BUN_BIN=/m);
    expect(wrapper).toContain(`case "$(uname -s)" in`);
    expect(wrapper).toContain(
      `Darwin) mode="$(/usr/bin/stat -f '%Lp' "\${ENV_FILE}")" ;;`,
    );
    expect(wrapper).toContain(`*) mode="$(stat -c '%a' "\${ENV_FILE}")" ;;`);
    expect(
      spawnSync(bash, ["-n", "scripts/local-clone-deploy.sh"], {
        cwd: repoRoot,
      }).status,
    ).toBe(0);
  });
});
