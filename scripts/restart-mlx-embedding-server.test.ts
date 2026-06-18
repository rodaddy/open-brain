import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const scriptPath = join(import.meta.dir, "restart-mlx-embedding-server.sh");
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ob-mlx-restart-"));
  tempRoots.push(root);
  return root;
}

function runScript(root: string, extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", [scriptPath], {
    env: {
      ...process.env,
      HOME: join(root, "home"),
      MLX_EMBED_RUNTIME_DIR: join(root, "runtime"),
      MLX_EMBED_DAEMON: join(root, "missing-daemon"),
      MLX_EMBED_HEALTH_RETRIES: "1",
      MLX_EMBED_HEALTH_SLEEP_SECONDS: "0",
      MLX_EMBED_RESTART_SETTLE_SECONDS: "0",
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("restart-mlx-embedding-server.sh", () => {
  it("cleans a stale partial default lock and exits non-zero when restart cannot run", () => {
    const root = makeTempRoot();
    const runtime = join(root, "runtime");
    const lockDir = join(runtime, "open-brain-mlx-embed-restart.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "started_at"), "1\n");

    const result = runScript(root);

    expect(result.status).toBe(1);
    expect(result.error).toBeUndefined();
    expect(existsSync(lockDir)).toBe(false);
  });

  it("does not remove an env-overridden stale lock without the script sentinel", () => {
    const root = makeTempRoot();
    const lockDir = join(root, "custom.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "started_at"), "1\n");

    const result = runScript(root, {
      MLX_EMBED_RESTART_LOCK: lockDir,
    });

    expect(result.status).toBe(1);
    expect(result.error).toBeUndefined();
    expect(existsSync(lockDir)).toBe(true);
  });

  it("fails clearly when the configured curl binary is not executable", () => {
    const root = makeTempRoot();

    const result = runScript(root, {
      MLX_EMBED_CURL: join(root, "missing-curl"),
    });

    expect(result.status).toBe(1);
    expect(result.error).toBeUndefined();
    expect(readFileSync(join(root, "runtime", "mlx-embedding-server.err.log"), "utf8")).toContain(
      "curl not found or not executable",
    );
  });
});
