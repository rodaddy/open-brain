import { afterAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { testScratchDir } from "./test-support/scratch-dir.ts";
import { runPgDump } from "./backup.ts";
import { expectDefined } from "./test-support/expect-defined.ts";

const tempDirs: string[] = [];

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = testScratchDir("ob298-backup-");
  tempDirs.push(dir);
  return dir;
}

const STDERR_ROW_SENTINEL = "LEAK-SENTINEL-PGDUMP-ROW-CONTENT";

/** Points OPENBRAIN_PG_DUMP_BIN at a scratch fake for the body of `fn`. */
async function withFakePgDump<T>(scriptBody: string, fn: () => Promise<T>): Promise<T> {
  const dir = await tempDir();
  const fakeTool = join(dir, "fake-pg-dump.ts");
  await writeFile(fakeTool, scriptBody);
  const prev = process.env.OPENBRAIN_PG_DUMP_BIN;
  process.env.OPENBRAIN_PG_DUMP_BIN = `${process.execPath} ${fakeTool}`;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.OPENBRAIN_PG_DUMP_BIN;
    else process.env.OPENBRAIN_PG_DUMP_BIN = prev;
  }
}

describe("runPgDump failure handling", () => {
  it("removes the partial dump file on failure so a retry is not blocked by --force", async () => {
    // Fake pg_dump: writes partial dump bytes to stdout, then fails with
    // stderr that carries literal row content.
    const script = [
      `process.stdout.write("partial-dump-bytes-before-failure");`,
      `console.error('pg_dump: error: query failed: ERROR:  canceling statement');`,
      `console.error('CONTEXT:  COPY thoughts, line 7: "${STDERR_ROW_SENTINEL}"');`,
      `process.exit(1);`,
      "",
    ].join("\n");
    await withFakePgDump(script, async () => {
      const outDir = await tempDir();
      const dumpPath = join(outDir, "openbrain.dump");
      let thrown: Error | null = null;
      try {
        await runPgDump({
          host: "127.0.0.1",
          port: 5432,
          user: "drill",
          password: ["dump-secret", "pw"].join("-"),
          dbName: "never_connected",
          dumpPath,
          snapshot: "00000003-0000001B-1",
        });
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown).not.toBeNull();
      // Partial dump removed: a retry without --force is not blocked.
      expect(existsSync(dumpPath)).toBe(false);
      // Error is exit code + sanitized class only — receipt-safe.
      const message = expectDefined(thrown, "runPgDump error").message;
      expect(message).toContain("pg_dump exited with code 1");
      expect(message).toContain("query failed");
      expect(message).not.toContain(STDERR_ROW_SENTINEL);
      expect(message).not.toContain('"');
      expect(message).not.toContain("CONTEXT");
      expect(message).not.toContain("dump-secret-pw");
    });
  });

  it("a successful dump keeps the file", async () => {
    const script = [
      `process.stdout.write("full-dump-bytes");`,
      `process.exit(0);`,
      "",
    ].join("\n");
    await withFakePgDump(script, async () => {
      const outDir = await tempDir();
      const dumpPath = join(outDir, "openbrain.dump");
      await runPgDump({
        host: "127.0.0.1",
        port: 5432,
        user: "drill",
        password: undefined,
        dbName: "never_connected",
        dumpPath,
        snapshot: "00000003-0000001B-1",
      });
      expect(await readFile(dumpPath, "utf8")).toBe("full-dump-bytes");
    });
  });

  it("passes the exported snapshot as a distinct pg_dump option and value", async () => {
    const dir = await tempDir();
    const argvPath = join(dir, "argv.json");
    const script = [
      `import { writeFileSync } from "node:fs";`,
      `writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));`,
      `process.stdout.write("dump");`,
      "",
    ].join("\n");
    await withFakePgDump(script, async () => {
      const dumpPath = join(await tempDir(), "openbrain.dump");
      const snapshot = "00000003-0000001B-1 --no-data";
      await runPgDump({
        host: "127.0.0.1",
        port: 5432,
        user: "drill",
        password: undefined,
        dbName: "never_connected",
        dumpPath,
        snapshot,
      });
      const argv = JSON.parse(await readFile(argvPath, "utf8")) as string[];
      const snapshotIndex = argv.indexOf("--snapshot");
      expect(snapshotIndex).toBeGreaterThanOrEqual(0);
      expect(argv[snapshotIndex + 1]).toBe(snapshot);
      expect(argv).not.toContain(`--snapshot=${snapshot}`);
      expect(argv).not.toContain("--no-data");
      expect(argv).toContain("-Fc");
    });
  });
});
