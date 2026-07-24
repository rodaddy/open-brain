import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RESTORE_REMOTE_APPROVAL_ENV,
  RESTORE_REMOTE_APPROVAL_VALUE,
  RESTORE_WIPE_APPROVAL_ENV,
  RESTORE_WIPE_APPROVAL_VALUE,
  assertRemoteApproval,
  assertWipeApproval,
  parseRestoreArgs,
  parseTargetDbUrl,
  prepareRestoreTarget,
  runPgRestore,
  targetHostRequiresRemoteApproval,
  validateMigrationsMatchRepo,
  validatePostRestore,
  writabilityProbe,
} from "./restore.ts";
import type { BackupManifestV1, Queryable } from "./backup-lib.ts";
import { DUMP_FILENAME, MANIFEST_SCHEMA_ID } from "./backup-lib.ts";

const CONTENT_SENTINEL = "SENTINEL-RESTORED-ROW-CONTENT";
const NS_SENTINEL = "SENTINEL-RESTORED-NAMESPACE";

// ---------------------------------------------------------------------------
// Target parsing
// ---------------------------------------------------------------------------

describe("parseTargetDbUrl", () => {
  it("parses a full postgres URL", () => {
    // Assembled at runtime so no credential-shaped URI literal lives in
    // source (secret scanners flag full user:pass URIs even when fake).
    const fakeCred = ["s%40", "crat"].join("");
    expect(
      parseTargetDbUrl(
        ["postgres:", "//alice:", fakeCred, "@db.example:5433/restore_db"].join(
          "",
        ),
      ),
    ).toEqual({
      host: "db.example",
      port: 5433,
      user: "alice",
      password: decodeURIComponent(fakeCred),
      dbName: "restore_db",
    });
  });
  it("defaults the port and allows password-less URLs", () => {
    expect(parseTargetDbUrl("postgresql://bob@127.0.0.1/scratch")).toEqual({
      host: "127.0.0.1",
      port: 5432,
      user: "bob",
      password: undefined,
      dbName: "scratch",
    });
  });
  it("rejects non-postgres schemes, missing db name, missing user", () => {
    expect(() => parseTargetDbUrl("mysql://u@h/db")).toThrow(/postgres/);
    expect(() => parseTargetDbUrl("postgres://u@h/")).toThrow(/database name/);
    expect(() => parseTargetDbUrl("postgres://h:5432/db")).toThrow(/user/);
    expect(() => parseTargetDbUrl("not a url")).toThrow(/invalid/);
  });
});

describe("parseRestoreArgs credential path", () => {
  it("a passwordless --target-db-url picks up DB_PASSWORD from the env", () => {
    const env = { DB_PASSWORD: ["env", "secret"].join("-") };
    const args = parseRestoreArgs(
      [
        "--dir",
        "/tmp/set",
        "--target-db-url",
        "postgres://bob@127.0.0.1/scratch",
      ],
      env,
    );
    expect(args.target.password).toBe(env.DB_PASSWORD);
  });
  it("an inline URL password wins over DB_PASSWORD (scratch/CI path)", () => {
    const inlineCred = ["url", "-pass"].join("");
    const args = parseRestoreArgs(
      [
        "--dir",
        "/tmp/set",
        "--target-db-url",
        ["postgres:", "//bob:", inlineCred, "@127.0.0.1/scratch"].join(""),
      ],
      { DB_PASSWORD: ["env", "secret"].join("-") },
    );
    expect(args.target.password).toBe(inlineCred);
  });
});

// ---------------------------------------------------------------------------
// Target emptiness / wipe-scope gate (FIX: wipe scope vs check scope)
// ---------------------------------------------------------------------------

interface SchemaCount {
  schemaname: string;
  count: number;
}

function makeTargetDb(schemas: SchemaCount[]): {
  db: Queryable;
  queries: string[];
} {
  const queries: string[] = [];
  const db: Queryable = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("pg_catalog.pg_tables")) {
        return { rows: schemas };
      }
      if (sql.startsWith("DROP SCHEMA") || sql.startsWith("CREATE SCHEMA")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query in fake target db: ${sql}`);
    },
  };
  return { db, queries };
}

const WIPE_APPROVED_ENV = {
  [RESTORE_WIPE_APPROVAL_ENV]: RESTORE_WIPE_APPROVAL_VALUE,
};

describe("prepareRestoreTarget", () => {
  it("refuses non-public user schemas even with wipe flag AND approval env", async () => {
    const { db, queries } = makeTargetDb([
      { schemaname: "public", count: 3 },
      { schemaname: "foo", count: 2 },
    ]);
    await expect(
      prepareRestoreTarget(db, true, WIPE_APPROVED_ENV),
    ).rejects.toThrow(/non-public user schemas/);
    // Fail-closed BEFORE any wipe: no DROP/CREATE ever issued.
    expect(queries.join("\n")).not.toContain("DROP SCHEMA");
    expect(queries.join("\n")).not.toContain("CREATE SCHEMA");
  });

  it("refuses non-public schemas even when public itself is empty", async () => {
    const { db } = makeTargetDb([{ schemaname: "foo", count: 1 }]);
    await expect(
      prepareRestoreTarget(db, true, WIPE_APPROVED_ENV),
    ).rejects.toThrow(/scratch databases or public-schema-only/);
  });

  it("refuses a non-empty public schema without --wipe-target", async () => {
    const { db, queries } = makeTargetDb([{ schemaname: "public", count: 3 }]);
    await expect(
      prepareRestoreTarget(db, false, WIPE_APPROVED_ENV),
    ).rejects.toThrow(/NOT empty .*schema public/);
    expect(queries.join("\n")).not.toContain("DROP SCHEMA");
  });

  it("refuses a non-empty public schema with the flag but without approval", async () => {
    const { db, queries } = makeTargetDb([{ schemaname: "public", count: 3 }]);
    await expect(prepareRestoreTarget(db, true, {})).rejects.toThrow(
      RESTORE_WIPE_APPROVAL_ENV,
    );
    expect(queries.join("\n")).not.toContain("DROP SCHEMA");
  });

  it("wipes ONLY schema public for an approved public-only target", async () => {
    const { db, queries } = makeTargetDb([{ schemaname: "public", count: 3 }]);
    await prepareRestoreTarget(db, true, WIPE_APPROVED_ENV);
    expect(queries).toContain("DROP SCHEMA IF EXISTS public CASCADE");
    expect(queries).toContain("CREATE SCHEMA public");
  });

  it("an empty target needs no wipe and no approval", async () => {
    const { db, queries } = makeTargetDb([]);
    await prepareRestoreTarget(db, false, {});
    expect(queries.join("\n")).not.toContain("DROP SCHEMA");
  });
});

// ---------------------------------------------------------------------------
// Approval gates (assertExecuteApproval pattern)
// ---------------------------------------------------------------------------

describe("restore approval gates", () => {
  it("wipe approval requires the exact env value", () => {
    expect(() => assertWipeApproval({})).toThrow(RESTORE_WIPE_APPROVAL_ENV);
    expect(() =>
      assertWipeApproval({ [RESTORE_WIPE_APPROVAL_ENV]: "yes" }),
    ).toThrow();
    expect(() =>
      assertWipeApproval({
        [RESTORE_WIPE_APPROVAL_ENV]: RESTORE_WIPE_APPROVAL_VALUE,
      }),
    ).not.toThrow();
  });

  it("remote approval requires the exact env value", () => {
    expect(() => assertRemoteApproval({})).toThrow(RESTORE_REMOTE_APPROVAL_ENV);
    expect(() =>
      assertRemoteApproval({
        [RESTORE_REMOTE_APPROVAL_ENV]: RESTORE_REMOTE_APPROVAL_VALUE,
      }),
    ).not.toThrow();
  });

  it("local hosts skip remote approval; anything else requires it", () => {
    expect(targetHostRequiresRemoteApproval("127.0.0.1")).toBe(false);
    expect(targetHostRequiresRemoteApproval("localhost")).toBe(false);
    expect(targetHostRequiresRemoteApproval("LOCALHOST")).toBe(false);
    expect(targetHostRequiresRemoteApproval("::1")).toBe(false);
    expect(targetHostRequiresRemoteApproval("10.71.1.21")).toBe(true);
    expect(targetHostRequiresRemoteApproval("core01.local")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Post-restore validation with a fake Queryable
// ---------------------------------------------------------------------------

function makeManifest(
  overrides: Partial<{
    row_counts: Record<string, number>;
    archived_row_counts: Record<string, number>;
    distinct_namespaces: number;
    applied: string[];
  }> = {},
): BackupManifestV1 {
  return {
    schema: MANIFEST_SCHEMA_ID,
    created_at: "2026-07-20T00:00:00.000Z",
    source: {
      db_host: "127.0.0.1",
      db_port: 5432,
      db_name: "unit_db",
      hostname: "unit-host",
    },
    migrations: {
      head: "002_curation.sql",
      applied: overrides.applied ?? ["001_init.sql", "002_curation.sql"],
    },
    contract: {
      version: "2026-07-17.memory-tools.v22",
      schema_hash: "a".repeat(64),
    },
    embedding: { model: "m", dimensions: 768, column_type: "halfvec" },
    pgvector_version: "0.8.2",
    files: [{ name: DUMP_FILENAME, sha256: "b".repeat(64), bytes: 10 }],
    row_counts: overrides.row_counts ?? { thoughts: 5 },
    archived_row_counts: overrides.archived_row_counts ?? { thoughts: 1 },
    namespace_inventory: {
      distinct_namespaces: overrides.distinct_namespaces ?? 2,
    },
  };
}

interface FakeDbState {
  applied: string[];
  counts: Record<string, number>;
  archived: Record<string, number>;
  distinctNamespaces: number;
  hasVector: boolean;
  embeddingColType: string | null;
  existingTables: string[];
  namespaceColumnTables: string[];
}

function makeRestoredDb(state: Partial<FakeDbState> = {}): Queryable {
  const s: FakeDbState = {
    applied: ["001_init.sql", "002_curation.sql"],
    counts: { thoughts: 5 },
    archived: { thoughts: 1 },
    distinctNamespaces: 2,
    hasVector: true,
    embeddingColType: "halfvec(768)",
    existingTables: ["thoughts", "ob_session_lanes"],
    namespaceColumnTables: ["thoughts", "ob_session_lanes"],
    ...state,
  };
  return {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes("FROM _migrations")) {
        return {
          rows: s.applied.map((filename) => ({
            filename,
            // Hostile shape: extra content the validator must never surface.
            content: CONTENT_SENTINEL,
          })),
        };
      }
      if (sql.includes("information_schema.tables")) {
        const table = String(params?.[0] ?? "");
        return { rows: s.existingTables.includes(table) ? [{ "1": 1 }] : [] };
      }
      if (
        sql.includes("information_schema.columns") &&
        sql.includes("'namespace'")
      ) {
        const table = String(params?.[0] ?? "");
        return {
          rows: s.namespaceColumnTables.includes(table) ? [{ "1": 1 }] : [],
        };
      }
      if (sql.includes("information_schema.columns")) {
        // namespace_predicate_columns spot check (fully parameterized)
        return { rows: [{ count: 2 }] };
      }
      if (sql.includes("archived_at IS NOT NULL")) {
        const table = sql.match(/FROM (\w+) WHERE/)?.[1] ?? "";
        return { rows: [{ count: s.archived[table] ?? 0 }] };
      }
      if (sql.includes(") AS ns")) {
        return {
          rows: [{ count: s.distinctNamespaces, namespace: NS_SENTINEL }],
        };
      }
      if (sql.includes("pg_extension")) {
        return { rows: s.hasVector ? [{ extversion: "0.8.2" }] : [] };
      }
      if (sql.includes("format_type")) {
        return {
          rows:
            s.embeddingColType === null
              ? []
              : [{ col_type: s.embeddingColType }],
        };
      }
      if (sql.startsWith("SELECT COUNT(*)::bigint AS count FROM ")) {
        const table = sql.match(/FROM (\w+)$/)?.[1] ?? "";
        return { rows: [{ count: s.counts[table] ?? 0 }] };
      }
      throw new Error(`unexpected query in fake restored db: ${sql}`);
    },
  };
}

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
      results.find((r) => r.name === "applied_migrations_match_manifest")
        ?.verdict,
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
    const archivedCheck = results.find(
      (r) => r.name === "archived_count:thoughts",
    );
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
    expect(noVector.find((r) => r.name === "pgvector_extension")?.verdict).toBe(
      "fail",
    );

    const wrongDim = await validatePostRestore(
      makeRestoredDb({ embeddingColType: "halfvec(1536)" }),
      makeManifest(),
    );
    expect(
      wrongDim.find((r) => r.name === "embedding_column_dimension")?.verdict,
    ).toBe("fail");
  });

  it("rejects non-identifier manifest table names without interpolating them", async () => {
    const queries: string[] = [];
    const db: Queryable = {
      async query(sql: string, params?: unknown[]) {
        queries.push(sql);
        return makeRestoredDb().query(sql, params);
      },
    };
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
    const queries: string[] = [];
    const db: Queryable = {
      async query(sql: string, params?: unknown[]) {
        queries.push(sql);
        return makeRestoredDb().query(sql, params);
      },
    };
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
    expect(results.find((r) => r.name === "row_count:thoughts")?.verdict).toBe(
      "ok",
    );
  });

  it("validation results are content-free (no row content or namespace names)", async () => {
    const results = await validatePostRestore(makeRestoredDb(), makeManifest());
    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain(CONTENT_SENTINEL);
    expect(serialized).not.toContain(NS_SENTINEL);
  });

  it("failing-query validations report code/name only — never err.message", async () => {
    // Hostile driver: every query throws an error whose MESSAGE carries row
    // and namespace content (as real pg errors do via DETAIL/CONTEXT), with
    // a pg-style code on some and none on others.
    let flip = false;
    const db: Queryable = {
      async query() {
        flip = !flip;
        const err = new Error(
          `duplicate key value ${CONTENT_SENTINEL} in namespace ${NS_SENTINEL}`,
        );
        if (flip) (err as Error & { code?: string }).code = "23505";
        throw err;
      },
    };
    const results = await validatePostRestore(db, makeManifest());
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

describe("runPgRestore stderr sanitization", () => {
  const STDERR_ROW_SENTINEL = "LEAK-SENTINEL-STDERR-ROW-CONTENT";

  it("a mid-COPY failure surfaces exit code + error class only — no row content, no quoted fragments", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ob298-leak-"));
    leakTempDirs.push(dir);
    const fakeTool = join(dir, "fake-pg-restore.ts");
    // Fake pg_restore: emits the stderr shape of a real mid-COPY failure,
    // with literal row content in CONTEXT/COPY/DETAIL lines, and exits 1.
    await Bun.write(
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
    await Bun.write(dumpPath, "fake-dump-bytes");

    const prev = process.env.OPENBRAIN_PG_RESTORE_BIN;
    process.env.OPENBRAIN_PG_RESTORE_BIN = `bun ${fakeTool}`;
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
      const message = thrown!.message;
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

describe("writabilityProbe", () => {
  it("runs BEGIN / temp insert / ROLLBACK and reports ok", async () => {
    const statements: string[] = [];
    const client = {
      async query(sql: string) {
        statements.push(sql);
        return {};
      },
    };
    const result = await writabilityProbe(client);
    expect(result.verdict).toBe("ok");
    expect(statements[0]).toBe("BEGIN");
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements.join(" ")).toContain("INSERT INTO ob_restore_probe");
  });

  it("reports fail and still rolls back when the insert fails", async () => {
    const statements: string[] = [];
    const client = {
      async query(sql: string) {
        statements.push(sql);
        if (sql.startsWith("INSERT")) throw new Error("read-only target");
        return {};
      },
    };
    const result = await writabilityProbe(client);
    expect(result.verdict).toBe("fail");
    expect(statements).toContain("ROLLBACK");
  });
});
