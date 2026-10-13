import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { testScratchDir } from "./test-support/scratch-dir.ts";

const scratch = testScratchDir("backup-scheduled-node-runtime-");
const runner = new URL("./backup-scheduled-run.sh", import.meta.url).pathname;
const bash = process.platform === "darwin" ? "/opt/homebrew/bin/bash" : "bash";

function writeExecutable(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function runScenario(name: string, backupExit: number, verifyExits: string) {
  const root = join(scratch, name);
  const repo = join(root, "repo");
  const receipt = join(root, "calls.jsonl");
  const nodeProxy = join(root, "bin", "node");
  const envFile = join(root, "scheduled.env");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  writeExecutable(
    nodeProxy,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$NODE_RECEIPT"\nexec "${process.execPath}" "$@"\n`,
  );
  writeFileSync(
    join(repo, "scripts", "backup.ts"),
    `import { appendFileSync } from "node:fs"; appendFileSync(process.env.STEP_RECEIPT!, JSON.stringify({ step: "backup", argv: process.argv.slice(2), cwd: process.cwd(), path: process.env.PATH }) + "\\n"); process.exit(Number(process.env.BACKUP_EXIT));\n`,
  );
  writeFileSync(
    join(repo, "scripts", "backup-verify.ts"),
    `import { appendFileSync, readFileSync, writeFileSync } from "node:fs"; const state = process.env.VERIFY_STATE!; const exits = process.env.VERIFY_EXITS!.split(",").map(Number); let call = 0; try { call = Number(readFileSync(state, "utf8")); } catch {} writeFileSync(state, String(call + 1)); appendFileSync(process.env.STEP_RECEIPT!, JSON.stringify({ step: "verify", argv: process.argv.slice(2), cwd: process.cwd(), path: process.env.PATH }) + "\\n"); process.exit(exits[call] ?? 0);\n`,
  );
  writeFileSync(
    envFile,
    `NODE_BIN='${nodeProxy}'\nDB_NAME=fixture_db\nDB_HOST=fixture_host\nDB_USER=fixture_user\n`,
  );
  const result = spawnSync(bash, [runner], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENBRAIN_BACKUP_REPO_DIR: repo,
      OPENBRAIN_BACKUP_ROOT: join(root, "backups"),
      OPENBRAIN_BACKUP_ENV_FILE: envFile,
      BUN_BIN: join(root, "poison-bun"),
      NODE_RECEIPT: receipt,
      STEP_RECEIPT: join(root, "steps.jsonl"),
      VERIFY_STATE: join(root, "verify-state"),
      VERIFY_EXITS: verifyExits,
      BACKUP_EXIT: String(backupExit),
    },
  });
  const calls = readFileSync(receipt, "utf8").trim().split("\n");
  const steps = readFileSync(join(root, "steps.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as { step: string; argv: string[]; cwd: string; path: string },
    );
  return { result, calls, steps, repo, nodeProxy };
}

afterAll(async () => rm(scratch, { recursive: true, force: true }));

describe("scheduled backup Node runtime", () => {
  test("runs the exact three steps with the sourced Node runtime", () => {
    const { result, calls, steps, repo, nodeProxy } = runScenario("success", 0, "0,0");
    expect(result.status).toBe(0);
    expect(calls).toHaveLength(3);
    expect(steps.map(({ step }) => step)).toEqual(["backup", "verify", "verify"]);
    expect(steps[0]?.argv).toEqual(["--out", expect.stringContaining("fixture_db-")]);
    expect(steps[1]?.argv).toEqual(["--dir", expect.stringContaining("fixture_db-")]);
    expect(steps[2]?.argv).toEqual([
      "--dir",
      expect.stringContaining("backups"),
      "--max-age-hours",
      "26",
    ]);
    expect(steps.every(({ cwd }) => cwd === repo)).toBe(true);
    expect(steps.every(({ path }) => path.startsWith(`${dirname(nodeProxy)}:`))).toBe(
      true,
    );
    expect(result.stdout).toContain(`runtime node=${nodeProxy}`);
  });

  test.each([
    { label: "deploy overlap", backup: 4, verify: "0,0", exit: 4, names: ["backup"] },
    {
      label: "set verification failure",
      backup: 0,
      verify: "1,0",
      exit: 1,
      names: ["backup", "verify"],
    },
    {
      label: "stale root",
      backup: 0,
      verify: "0,3",
      exit: 3,
      names: ["backup", "verify", "verify"],
    },
  ])(
    "preserves $label exit and stops subsequent steps",
    ({ label, backup, verify, exit, names }) => {
      const { result, steps } = runScenario(label, backup, verify);
      expect(result.status).toBe(exit);
      expect(steps.map(({ step }) => step)).toEqual(names);
    },
  );
});
