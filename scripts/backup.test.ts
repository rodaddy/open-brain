import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPgDump } from "./backup.ts";

const tempDirs: string[] = [];

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ob298-backup-"));
  tempDirs.push(dir);
  return dir;
}

describe("runPgDump failure handling", () => {
  const STDERR_ROW_SENTINEL = "LEAK-SENTINEL-PGDUMP-ROW-CONTENT";

  async function withFakePgDump<T>(
    scriptBody: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const dir = await tempDir();
    const fakeTool = join(dir, "fake-pg-dump.ts");
    await Bun.write(fakeTool, scriptBody);
    const prev = process.env.OPENBRAIN_PG_DUMP_BIN;
    process.env.OPENBRAIN_PG_DUMP_BIN = `bun ${fakeTool}`;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.OPENBRAIN_PG_DUMP_BIN;
      else process.env.OPENBRAIN_PG_DUMP_BIN = prev;
    }
  }

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
        });
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown).not.toBeNull();
      // Partial dump removed: a retry without --force is not blocked.
      expect(await Bun.file(dumpPath).exists()).toBe(false);
      // Error is exit code + sanitized class only — receipt-safe.
      const message = thrown!.message;
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
      });
      expect(await Bun.file(dumpPath).text()).toBe("full-dump-bytes");
    });
  });
});
