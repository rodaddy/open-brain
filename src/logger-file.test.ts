import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Black-box: the logger reads LOG_FILE / LOG_MAX_BYTES / LOG_MAX_FILES once at
// module load, so exercise the real env wiring in a child process. Assert the
// observable outcome: many logger.info() calls stay bounded on disk. No writes
// escape the temp dir.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ob-logger-file-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("logger honors LOG_FILE with a size cap and rotation", async () => {
  const logPath = join(dir, "open-brain.log");
  const maxBytes = 32 * 1024;
  const maxFiles = 3;

  const driver = `
    import { logger } from ${JSON.stringify(join(import.meta.dir, "logger.ts"))};
    for (let i = 0; i < 4000; i += 1) {
      logger.info("session-event", { i, blob: "y".repeat(60) });
    }
  `;

  const proc = Bun.spawn(["bun", "run", "-"], {
    stdin: new TextEncoder().encode(driver),
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      LOG_FILE: logPath,
      LOG_MAX_BYTES: String(maxBytes),
      LOG_MAX_FILES: String(maxFiles),
      LOG_LEVEL: "info",
    },
  });
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

test("logger without LOG_FILE writes no log files", async () => {
  const driver = `
    import { logger } from ${JSON.stringify(join(import.meta.dir, "logger.ts"))};
    logger.info("no-file-sink", { ok: true });
  `;
  const proc = Bun.spawn(["bun", "run", "-"], {
    stdin: new TextEncoder().encode(driver),
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, LOG_FILE: "", LOG_LEVEL: "info" },
  });
  await proc.exited;
  // Nothing was created in the temp dir.
  expect(readdirSync(dir)).toEqual([]);
});
