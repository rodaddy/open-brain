import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRotatingFileSink } from "./rotating-file.ts";

// Black-box: drive the sink through its public write() API in a throwaway temp
// dir and assert only observable outcomes (file sizes, retained file count,
// content survival). No test writes outside its own temp directory.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ob-rotating-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function rotatedFiles(basePath: string): string[] {
  const base = basePath.split("/").pop() as string;
  return readdirSync(dir)
    .filter((name) => name === base || name.startsWith(`${base}.`))
    .sort();
}

describe("createRotatingFileSink", () => {
  test("active file never exceeds the configured cap after heavy writing", () => {
    const path = join(dir, "app.log");
    const maxBytes = 64 * 1024; // 64KB cap
    const sink = createRotatingFileSink({ path, maxBytes, maxFiles: 3 });

    // Write well over 1MB total (>16x the cap) with varied line contents.
    let total = 0;
    for (let i = 0; i < 20000; i += 1) {
      const line = `event-${i} ${"x".repeat((i % 50) + 10)} tail-${i * 7}`;
      sink.write(line);
      total += Buffer.byteLength(line, "utf8") + 1;
    }
    expect(total).toBeGreaterThan(1_000_000);

    // Active file is bounded to ~cap (allow one line of slack for the write
    // that triggers rotation on the *next* call).
    const activeSize = statSync(path).size;
    expect(activeSize).toBeLessThanOrEqual(maxBytes + 1024);
  });

  test("retained rotated file count never exceeds maxFiles", () => {
    const path = join(dir, "app.log");
    const maxFiles = 3;
    const sink = createRotatingFileSink({
      path,
      maxBytes: 16 * 1024,
      maxFiles,
    });

    for (let i = 0; i < 8000; i += 1) {
      sink.write(`line ${i} ${"data".repeat(20)}`);
    }

    const files = rotatedFiles(path);
    // active + at most maxFiles rotated siblings.
    expect(files.length).toBeLessThanOrEqual(maxFiles + 1);
    // and rotated files are exactly the allowed suffixes.
    for (const name of files) {
      if (name.endsWith(".log")) continue;
      const suffix = Number.parseInt(name.split(".").pop() as string, 10);
      expect(suffix).toBeGreaterThanOrEqual(1);
      expect(suffix).toBeLessThanOrEqual(maxFiles);
    }
  });

  test("no rotated file exceeds the cap", () => {
    const path = join(dir, "app.log");
    const maxBytes = 32 * 1024;
    const sink = createRotatingFileSink({ path, maxBytes, maxFiles: 4 });

    for (let i = 0; i < 6000; i += 1) {
      sink.write(`payload-${i}-${"z".repeat(30)}`);
    }

    for (const name of rotatedFiles(path)) {
      const size = statSync(join(dir, name)).size;
      // A rotated file holds content accumulated up to just under the cap plus
      // the single line that tipped it over.
      expect(size).toBeLessThanOrEqual(maxBytes + 1024);
    }
  });

  test("content survives across rotation boundaries", () => {
    const path = join(dir, "app.log");
    const sink = createRotatingFileSink({
      path,
      maxBytes: 8 * 1024,
      maxFiles: 5,
    });

    // Unique markers spread across many rotations; the earliest ones will be
    // pruned, but a contiguous recent window must survive intact and in order.
    const written: string[] = [];
    for (let i = 0; i < 3000; i += 1) {
      const line = `marker#${i}#${"q".repeat(40)}`;
      written.push(line);
      sink.write(line);
    }

    // Concatenate active + rotated files in chronological order:
    // highest suffix is oldest, .1 is newer, active is newest.
    const base = "app.log";
    const rotated = readdirSync(dir)
      .filter((n) => n.startsWith(`${base}.`))
      .sort((a, b) => {
        const na = Number.parseInt(a.split(".").pop() as string, 10);
        const nb = Number.parseInt(b.split(".").pop() as string, 10);
        return nb - na; // oldest (largest suffix) first
      });
    const ordered = [...rotated, base];

    let combined = "";
    for (const name of ordered) {
      const full = join(dir, name);
      if (existsSync(full)) combined += readFileSync(full, "utf8");
    }

    const survivingLines = combined.split("\n").filter(Boolean);

    // The most recent lines must be present, in order, with no corruption.
    const recent = written.slice(-50);
    for (const line of recent) {
      expect(combined).toContain(line);
    }
    // Ordering: the last surviving line equals the last written line.
    expect(survivingLines[survivingLines.length - 1]).toBe(
      written[written.length - 1],
    );
  });

  test("maxFiles=0 keeps only the active file (no rotated siblings)", () => {
    const path = join(dir, "app.log");
    const sink = createRotatingFileSink({
      path,
      maxBytes: 4 * 1024,
      maxFiles: 0,
    });

    for (let i = 0; i < 4000; i += 1) {
      sink.write(`x${i}-${"a".repeat(20)}`);
    }

    const files = rotatedFiles(path);
    expect(files).toEqual(["app.log"]);
    expect(statSync(path).size).toBeLessThanOrEqual(4 * 1024 + 1024);
  });

  test("a single oversized line is bounded to its own file", () => {
    const path = join(dir, "app.log");
    const maxBytes = 1024;
    const sink = createRotatingFileSink({ path, maxBytes, maxFiles: 3 });

    sink.write("small-first-line");
    const huge = "H".repeat(10_000); // 10x the cap in one line
    sink.write(huge);
    sink.write("small-after");

    // The oversized line rotated the small line out, landing alone, and the
    // trailing small line rotated again — so no file mixes the huge line with
    // unrelated bulk. The active file stays small.
    expect(statSync(path).size).toBeLessThanOrEqual(maxBytes + 64);
    // The huge line is still recoverable somewhere.
    const base = "app.log";
    let found = false;
    for (const name of readdirSync(dir)) {
      if (name !== base && !name.startsWith(`${base}.`)) continue;
      if (readFileSync(join(dir, name), "utf8").includes(huge)) found = true;
    }
    expect(found).toBe(true);
  });
});
