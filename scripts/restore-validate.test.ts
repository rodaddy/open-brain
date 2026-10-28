import { afterAll, describe, expect, it } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { testScratchDir } from "./test-support/scratch-dir.ts";
import { runPgRestore, validateMigrationsMatchRepo } from "./restore.ts";
import { validatePostRestore } from "./restore.ts";
import { expectDefined } from "./test-support/expect-defined.ts";
import {
  CONTENT_SENTINEL,
  NS_SENTINEL,
  makeLeakyThrowingDb,
  makeManifest,
  makeRecordingRestoredDb,
  makeRestoredDb,
} from "./test-support/restore-test-support.ts";

// ---------------------------------------------------------------------------
// Post-restore validation with a fake Queryable
// ---------------------------------------------------------------------------

describe("validatePostRestore", () => {
  it("all validations pass on an exact-match restored db", async () => {
    const results = await validatePostRestore(makeRestoredDb(), makeManifest());
    expect(results.every((r) => r.verdict === "ok")).toBe(true);
    const names = results.map((r) => r.name);
    expect(names).toContain("applied_migrations_match_manifest");
    expect(names).toContain("row_count:thoughts");
    expect(names).toContain("archived_count:thoughts");
    expect(names).toContain("distinct_namespace_count");
    expect(names).toContain("namespace_predicate_columns");
    expect(names).toContain("pgvector_extension");
    expect(names).toContain("embedding_column_dimension");
  });

  it("keeps pre-forward applied history exact to the manifest", async () => {
    const results = await validatePostRestore(
      makeRestoredDb({ applied: ["001_init.sql", "005_fts_hybrid"] }),
      makeManifest({
        applied: ["001_init.sql", "005_fts_hybrid.sql"],
      }),
    );
    expect(
      results.find((r) => r.name === "applied_migrations_match_manifest")?.verdict,
    ).toBe("fail");
  });

  it("row count mismatch fails that table's validation", async () => {
    const results = await validatePostRestore(
      makeRestoredDb({ counts: { thoughts: 4 } }),
      makeManifest(),
    );
    const rowCheck = results.find((r) => r.name === "row_count:thoughts");
    expect(rowCheck?.verdict).toBe("fail");
  });

  it("missing table after restore fails", async () => {
    const results = await validatePostRestore(
      makeRestoredDb({ existingTables: ["ob_session_lanes"] }),
      makeManifest(),
    );
    const rowCheck = results.find((r) => r.name === "row_count:thoughts");
    expect(rowCheck?.verdict).toBe("fail");
    expect(rowCheck?.detail).toContain("missing");
  });

  it("archived rows must stay archived (count mismatch fails)", async () => {
    const results = await validatePostRestore(
      makeRestoredDb({ archived: { thoughts: 0 } }),
      makeManifest(),
    );
    const archivedCheck = results.find((r) => r.name === "archived_count:thoughts");
    expect(archivedCheck?.verdict).toBe("fail");
  });

  it("distinct namespace count mismatch fails", async () => {
    const results = await validatePostRestore(
      makeRestoredDb({ distinctNamespaces: 1 }),
      makeManifest(),
    );
    const nsCheck = results.find((r) => r.name === "distinct_namespace_count");
    expect(nsCheck?.verdict).toBe("fail");
  });

  it("missing pgvector extension or wrong embedding dimension fails", async () => {
    const noVector = await validatePostRestore(
      makeRestoredDb({ hasVector: false }),
      makeManifest(),
    );
    expect(noVector.find((r) => r.name === "pgvector_extension")?.verdict).toBe("fail");

    const wrongDim = await validatePostRestore(
      makeRestoredDb({ embeddingColType: "halfvec(1536)" }),
      makeManifest(),
    );
    expect(wrongDim.find((r) => r.name === "embedding_column_dimension")?.verdict).toBe(
      "fail",
    );
  });
});

describe("validatePostRestore against a tampered manifest", () => {
  it("rejects non-identifier manifest table names without interpolating them", async () => {
    const { db, queries } = makeRecordingRestoredDb();
    const manifest = makeManifest({
      row_counts: { "thoughts; DROP TABLE thoughts--": 5 },
      archived_row_counts: {},
    });
    const results = await validatePostRestore(db, manifest);
    const bad = results.find((r) => r.name.startsWith("row_count:thoughts;"));
    expect(bad?.verdict).toBe("fail");
    expect(bad?.detail).toContain("identifier");
    expect(queries.join("\n")).not.toContain("DROP TABLE");
  });

  it("fails closed on manifest count keys outside the allowlists", async () => {
    const { db, queries } = makeRecordingRestoredDb();
    // Valid identifiers, but NOT allowlisted tables — a tampered manifest
    // must fail validation, not be silently skipped or interpolated.
    const manifest = makeManifest({
      row_counts: { thoughts: 5, pg_shadow_probe: 1 },
      archived_row_counts: { thoughts: 1, sneaky_archive_table: 2 },
    });
    const results = await validatePostRestore(db, manifest);
    const rowBad = results.find((r) => r.name === "row_count:pg_shadow_probe");
    expect(rowBad?.verdict).toBe("fail");
    expect(rowBad?.detail).toContain("allowlisted");
    const archBad = results.find(
      (r) => r.name === "archived_count:sneaky_archive_table",
    );
    expect(archBad?.verdict).toBe("fail");
    expect(archBad?.detail).toContain("allowlisted");
    // The unknown names never reach an interpolated query.
    expect(queries.join("\n")).not.toContain("pg_shadow_probe");
    expect(queries.join("\n")).not.toContain("sneaky_archive_table");
    // Allowlisted tables still validate normally.
    expect(results.find((r) => r.name === "row_count:thoughts")?.verdict).toBe("ok");
  });
});

describe("validatePostRestore content leak guard", () => {
  it("validation results are content-free (no row content or namespace names)", async () => {
    const results = await validatePostRestore(makeRestoredDb(), makeManifest());
    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain(CONTENT_SENTINEL);
    expect(serialized).not.toContain(NS_SENTINEL);
  });

  it("failing-query validations report code/name only — never err.message", async () => {
    const results = await validatePostRestore(makeLeakyThrowingDb(), makeManifest());
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.verdict === "fail")).toBe(true);
    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain(CONTENT_SENTINEL);
    expect(serialized).not.toContain(NS_SENTINEL);
    expect(serialized).toContain("query failed: 23505");
    expect(serialized).toContain("query failed: Error");
  });
});

describe("validateMigrationsMatchRepo", () => {
  it("passes when applied equals the repo set", async () => {
    const result = await validateMigrationsMatchRepo(makeRestoredDb(), [
      "001_init.sql",
      "002_curation.sql",
    ]);
    expect(result.verdict).toBe("ok");
  });
  it("fails when the head did not advance", async () => {
    const result = await validateMigrationsMatchRepo(makeRestoredDb(), [
      "001_init.sql",
      "002_curation.sql",
      "003_next.sql",
    ]);
    expect(result.verdict).toBe("fail");
  });
  it("ignores allowlisted legacy markers after canonical migrations apply", async () => {
    const repo = [
      "001_init.sql",
      "002_curation.sql",
      "005_fts_hybrid.sql",
      "011_chunking.sql",
    ];
    const db = makeRestoredDb({
      applied: [...repo, "005_fts_hybrid", "010_chunking.sql"],
    });
    expect((await validateMigrationsMatchRepo(db, repo)).verdict).toBe("ok");
  });
  it("fails post-forward validation for unknown and near-match markers", async () => {
    const repo = ["001_init.sql", "002_curation.sql"];
    expect(
      (
        await validateMigrationsMatchRepo(
          makeRestoredDb({ applied: [...repo, "005_fts_hybri"] }),
          repo,
        )
      ).verdict,
    ).toBe("fail");
  });
  it("fails post-forward validation when a legacy marker lacks its canonical migration", async () => {
    const repo = ["001_init.sql", "002_curation.sql", "005_fts_hybrid.sql"];
    const result = await validateMigrationsMatchRepo(
      makeRestoredDb({
        applied: ["001_init.sql", "002_curation.sql", "005_fts_hybrid"],
      }),
      repo,
    );
    expect(result.verdict).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// pg_restore stderr leak guard (fake child via OPENBRAIN_PG_RESTORE_BIN)
// ---------------------------------------------------------------------------

const leakTempDirs: string[] = [];

afterAll(async () => {
  for (const dir of leakTempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

const STDERR_ROW_SENTINEL = "LEAK-SENTINEL-STDERR-ROW-CONTENT";

/**
 * Writes a fake pg_restore that emits the stderr shape of a real mid-COPY
 * failure — literal row content in CONTEXT/COPY/DETAIL lines — and exits 1.
 */
async function writeLeakyPgRestore(): Promise<{
  fakeTool: string;
  dumpPath: string;
}> {
  const dir = testScratchDir("ob298-leak-");
  leakTempDirs.push(dir);
  const fakeTool = join(dir, "fake-pg-restore.ts");
  await writeFile(
    fakeTool,
    [
      `console.error('pg_restore: error: COPY failed for table "thoughts": ERROR:  value too long');`,
      `console.error('CONTEXT:  COPY thoughts, line 42: "${STDERR_ROW_SENTINEL} secret row body"');`,
      `console.error('DETAIL:  Key (content_hash)=(${STDERR_ROW_SENTINEL}) already exists.');`,
      `console.error('HINT:  do not leak ${STDERR_ROW_SENTINEL}');`,
      `process.exit(1);`,
      "",
    ].join("\n"),
  );
  const dumpPath = join(dir, "fake.dump");
  await writeFile(dumpPath, "fake-dump-bytes");
  return { fakeTool, dumpPath };
}

describe("runPgRestore stderr sanitization", () => {
  it("a mid-COPY failure surfaces exit code + error class only — no row content, no quoted fragments", async () => {
    const { fakeTool, dumpPath } = await writeLeakyPgRestore();

    const prev = process.env.OPENBRAIN_PG_RESTORE_BIN;
    process.env.OPENBRAIN_PG_RESTORE_BIN = `${process.execPath} ${fakeTool}`;
    try {
      let thrown: Error | null = null;
      try {
        await runPgRestore(
          {
            host: "127.0.0.1",
            port: 5432,
            user: "drill",
            password: ["drill-secret", "pw"].join("-"),
            dbName: "never_connected",
          },
          dumpPath,
        );
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown).not.toBeNull();
      const message = expectDefined(thrown, "runPgRestore error").message;
      // This message is what the restore receipt's `error` field carries.
      expect(message).toContain("pg_restore exited with code 1");
      expect(message).toContain("COPY failed for table");
      expect(message).not.toContain(STDERR_ROW_SENTINEL);
      expect(message).not.toContain('"'); // no quoted fragment survives
      expect(message).not.toContain("CONTEXT");
      expect(message).not.toContain("DETAIL");
      expect(message).not.toContain("drill-secret-pw");
    } finally {
      if (prev === undefined) delete process.env.OPENBRAIN_PG_RESTORE_BIN;
      else process.env.OPENBRAIN_PG_RESTORE_BIN = prev;
    }
  });
});
