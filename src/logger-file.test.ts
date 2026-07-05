import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveWorkerLogPath } from "./logger.ts";

// Black-box: the logger reads LOG_FILE / LOG_MAX_BYTES / LOG_MAX_FILES /
// OPEN_BRAIN_WORKER_NAME once at module load, so exercise the real env wiring
// in child processes. Assert only observable outcomes: files on disk stay
// bounded and per-worker. No writes escape the temp dir.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ob-logger-file-"));
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function loggerDriver(lines: number, blob: number): string {
  return `
    import { logger } from ${JSON.stringify(join(import.meta.dir, "logger.ts"))};
    for (let i = 0; i < ${lines}; i += 1) {
      logger.info("session-event", { i, blob: "y".repeat(${blob}) });
    }
  `;
}

function spawnLogger(env: Record<string, string>, driver: string) {
  return Bun.spawn(["bun", "run", "-"], {
    stdin: new TextEncoder().encode(driver),
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, LOG_LEVEL: "info", ...env },
  });
}

test("logger honors LOG_FILE with a size cap and rotation", async () => {
  const logPath = join(dir, "open-brain.log");
  const maxBytes = 32 * 1024;
  const maxFiles = 3;

  const proc = spawnLogger(
    {
      LOG_FILE: logPath,
      LOG_MAX_BYTES: String(maxBytes),
      LOG_MAX_FILES: String(maxFiles),
      OPEN_BRAIN_WORKER_NAME: "",
    },
    loggerDriver(4000, 60),
  );
  const code = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  expect(code).toBe(0);
  // No crash noise from the logger path.
  expect(stderr).not.toContain("Error");

  const files = readdirSync(dir).filter(
    (n) => n === "open-brain.log" || n.startsWith("open-brain.log."),
  );
  // Active + at most maxFiles rotated.
  expect(files.length).toBeGreaterThan(1); // proves rotation actually happened
  expect(files.length).toBeLessThanOrEqual(maxFiles + 1);

  for (const name of files) {
    const size = statSync(join(dir, name)).size;
    expect(size).toBeLessThanOrEqual(maxBytes + 1024);
  }
});

test("two workers sharing one configured LOG_FILE get divergent per-worker files", async () => {
  // Regression for the multi-worker race: run-two-worker.ts spawns children
  // that inherit the same LOG_FILE but each gets a distinct
  // OPEN_BRAIN_WORKER_NAME. The logger must derive divergent effective paths
  // so the workers never share an active file or rotation chain.
  const logPath = join(dir, "open-brain.log");
  const maxBytes = 16 * 1024;

  const workers = ["open-brain-worker-1", "open-brain-worker-2"];
  const procs = workers.map((name) =>
    spawnLogger(
      {
        LOG_FILE: logPath,
        LOG_MAX_BYTES: String(maxBytes),
        LOG_MAX_FILES: "2",
        OPEN_BRAIN_WORKER_NAME: name,
      },
      loggerDriver(2000, 60),
    ),
  );
  const codes = await Promise.all(procs.map((p) => p.exited));
  expect(codes).toEqual([0, 0]);

  const files = readdirSync(dir);
  // The shared configured path itself is never written.
  expect(files).not.toContain("open-brain.log");
  // Each worker has its own active file and rotation chain.
  for (const name of workers) {
    const mine = files.filter((f) => f.startsWith(`open-brain.${name}.log`));
    expect(mine.length).toBeGreaterThan(1); // rotated at least once
    expect(mine).toContain(`open-brain.${name}.log`);
    for (const f of mine) {
      expect(statSync(join(dir, f)).size).toBeLessThanOrEqual(maxBytes + 1024);
    }
  }
});

test("logger without LOG_FILE writes no log files", async () => {
  const proc = spawnLogger({ LOG_FILE: "" }, loggerDriver(1, 10));
  await proc.exited;
  // Nothing was created in the temp dir.
  expect(readdirSync(dir)).toEqual([]);
});

test("deriveWorkerLogPath diverges per worker and never escapes the directory", () => {
  const base = "/var/log/open-brain.log";
  const one = deriveWorkerLogPath(base, "open-brain-worker-1");
  const two = deriveWorkerLogPath(base, "open-brain-worker-2");
  expect(one).toBe("/var/log/open-brain.open-brain-worker-1.log");
  expect(two).toBe("/var/log/open-brain.open-brain-worker-2.log");
  expect(one).not.toBe(two);

  // No worker name (or blank) leaves the configured path untouched.
  expect(deriveWorkerLogPath(base, undefined)).toBe(base);
  expect(deriveWorkerLogPath(base, "  ")).toBe(base);

  // Extension-less paths get a plain suffix.
  expect(deriveWorkerLogPath("/var/log/obrain", "w1")).toBe(
    "/var/log/obrain.w1",
  );

  // Path-traversal characters in a worker name cannot change the directory.
  const hostile = deriveWorkerLogPath(base, "../../etc/passwd");
  expect(hostile.startsWith("/var/log/")).toBe(true);
  expect(hostile).not.toContain("/etc/");
});
