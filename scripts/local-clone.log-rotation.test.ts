import { afterEach, describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { testScratchDir } from "./test-support/scratch-dir.ts";
import { pipeChildOutputToRotatingLogs } from "./local-clone-log-rotation.ts";

// Issues 1526 and 754: the server child's output must be bounded by the app's
// rotating file sink, not left to launchd's unbounded redirect.
const MAX_BYTES = 1_000_000; // the sink's 1 MB default

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = testScratchDir("local-clone-log-rotation-");
  dirs.push(dir);
  return dir;
}

function writeBytes(stream: PassThrough, total: number): void {
  const line = `${"x".repeat(999)}\n`; // 1000 bytes per line
  let written = 0;
  while (written < total) {
    stream.write(line);
    written += line.length;
  }
  stream.end();
}

describe("pipeChildOutputToRotatingLogs (issue 1526)", () => {
  it("keeps every autostart log file at or under 1 MB when the child writes > 2.5 MB", async () => {
    const dir = freshDir();
    const child = { stdout: new PassThrough(), stderr: new PassThrough() };
    const done = pipeChildOutputToRotatingLogs(child, dir);
    writeBytes(child.stdout, 2_600_000);
    writeBytes(child.stderr, 2_600_000);
    await done;

    for (const base of ["autostart.out.log", "autostart.err.log"]) {
      const active = join(dir, base);
      expect(statSync(active).size).toBeLessThanOrEqual(MAX_BYTES);
      const rolled = readdirSync(dir).filter((name) => name.startsWith(`${base}.`));
      expect(rolled.length).toBeGreaterThanOrEqual(2);
    }
    const files = readdirSync(dir);
    expect(files.length).toBeGreaterThan(2);
    for (const name of files) {
      expect(statSync(join(dir, name)).size).toBeLessThanOrEqual(MAX_BYTES);
    }
  });

  it("holds a partial line until its newline and flushes a trailing one at end", async () => {
    const dir = freshDir();
    const child = { stdout: new PassThrough(), stderr: null };
    const done = pipeChildOutputToRotatingLogs(child, dir);
    child.stdout.write("hel");
    child.stdout.write("lo\nwor");
    child.stdout.end("ld");
    await done;
    expect(readFileSync(join(dir, "autostart.out.log"), "utf8")).toBe("hello\nworld\n");
    expect(readdirSync(dir)).toEqual(["autostart.out.log"]);
  });
});
