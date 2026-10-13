import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testScratchDir } from "./test-support/scratch-dir.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const deployScript = path.join(repoRoot, "scripts/local-clone-deploy.sh");
const bash = process.platform === "darwin" ? "/opt/homebrew/bin/bash" : "bash";

async function archiveFunction(): Promise<string> {
  const source = await readFile(deployScript, "utf8");
  const match = source.match(/archive_runtime_slot\(\) \{[\s\S]*?\n\}/);
  if (!match) throw new Error("archive_runtime_slot is missing");
  return match[0];
}

async function listeningPidFunction(): Promise<string> {
  const source = await readFile(deployScript, "utf8");
  const match = source.match(/listening_pid\(\) \{[\s\S]*?\n\}/);
  if (!match) throw new Error("listening_pid is missing");
  return match[0];
}

async function runArchive(root: string, slot: string, reason: string) {
  const runtime = path.join(root, "app");
  const script = `set -euo pipefail
CLONE_ROOT="$1"
RUNTIME_DIR="$2"
STAGING_DIR="${runtime}.next"
PREVIOUS_DIR="${runtime}.previous"
ARCHIVE_DIR="${root}/runtime-history"
log() { printf '%s\\n' "$1"; }
fatal() { printf 'FATAL: %s\\n' "$1" >&2; exit 1; }
${await archiveFunction()}
archive_runtime_slot "$3" "$4"
`;
  return spawnSync(
    bash,
    ["-c", script, "archive-fixture", root, runtime, slot, reason],
    {
      encoding: "utf8",
    },
  );
}

describe("local clone runtime-slot archival", () => {
  it("retains every generated slot snapshot and leaves each slot reusable", async () => {
    const root = testScratchDir("local-clone-archive-");
    const slots = ["app.next", "app.previous", "app.failed", "app.rollback-discard"];

    for (const slotName of slots) {
      const slot = path.join(root, slotName);
      await mkdir(slot, { recursive: true });
      await writeFile(path.join(slot, "sentinel.txt"), slotName);
      const result = await runArchive(root, slot, `replace ${slotName}`);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        `${slot} -> ${path.join(root, "runtime-history")}`,
      );
      await mkdir(slot);
    }

    const archived = await readdir(path.join(root, "runtime-history"));
    expect(archived).toHaveLength(4);
    for (const slotName of slots) {
      const archivedSlot = archived.find((name) => name.startsWith(`${slotName}.`));
      expect(archivedSlot).toBeDefined();
      if (!archivedSlot) throw new Error(`missing archived slot for ${slotName}`);
      expect(
        await readFile(
          path.join(root, "runtime-history", archivedSlot, "sentinel.txt"),
          "utf8",
        ),
      ).toBe(slotName);
    }
  });

  it("rejects a symlinked generated slot without moving its target", async () => {
    const root = testScratchDir("local-clone-archive-symlink-");
    const target = path.join(root, "owned-target");
    const slot = path.join(root, "app.failed");
    await mkdir(target);
    await writeFile(path.join(target, "sentinel.txt"), "preserved");
    await symlink(target, slot);

    const result = await runArchive(root, slot, "preserve failed runtime");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refusing symlink runtime slot");
    expect(await readFile(path.join(target, "sentinel.txt"), "utf8")).toBe("preserved");
  });
});

describe("local clone listener detection", () => {
  it("treats lsof's no-listener exit as an empty successful result", async () => {
    const root = testScratchDir("local-clone-listener-");
    const bin = path.join(root, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "lsof"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    const script = `set -euo pipefail
${await listeningPidFunction()}
pid="$(listening_pid 3100)"
printf 'pid=%s\\n' "\${pid:-<none>}"
`;
    const result = spawnSync(bash, ["-c", script], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("pid=<none>\n");
  });
});
