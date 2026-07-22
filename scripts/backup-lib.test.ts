import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DUMP_FILENAME,
  MANIFEST_FILENAME,
  MANIFEST_SCHEMA_ID,
  ageHours,
  buildManifest,
  compareContractVersions,
  compareMigrationSets,
  evaluateStaleness,
  gatherDbInfo,
  parseManifest,
  redactSecret,
  resolvePgTool,
  sha256File,
  summarizeChildStderr,
  verifyBackupPath,
  verifyBackupSet,
  type BackupDbInfo,
  type BackupManifestV1,
  type CurrentRuntime,
  type Queryable,
} from "./backup-lib.ts";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ob298-test-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

const RUNTIME: CurrentRuntime = {
  repoMigrations: ["001_init.sql", "002_curation.sql", "003_extras.sql"],
  contractVersion: "2026-07-17.memory-tools.v22",
  embeddingModel: "test-embedding-model",
  embeddingDimensions: 768,
};

function makeDbInfo(overrides: Partial<BackupDbInfo> = {}): BackupDbInfo {
  return {
    appliedMigrations: [...RUNTIME.repoMigrations],
    pgvectorVersion: "0.8.2",
    rowCounts: { _migrations: 3, thoughts: 5, ob_session_lanes: 1 },
    archivedRowCounts: { thoughts: 1 },
    distinctNamespaces: 2,
    ...overrides,
  };
}

interface SetOverrides {
  dbInfo?: Partial<BackupDbInfo>;
  contractVersion?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  createdAt?: string;
  dumpBytes?: Uint8Array;
  mutateManifest?: (m: any) => any;
}

/** Write a structurally valid backup set into `dir` and return its manifest. */
async function writeSet(
  dir: string,
  overrides: SetOverrides = {},
): Promise<BackupManifestV1> {
  await mkdir(dir, { recursive: true });
  const dumpBytes =
    overrides.dumpBytes ??
    new TextEncoder().encode("fake-pg-dump-bytes-for-unit-tests");
  const dumpPath = join(dir, DUMP_FILENAME);
  await Bun.write(dumpPath, dumpBytes);
  const { sha256, bytes } = await sha256File(dumpPath);
  const manifest = buildManifest({
    dbInfo: makeDbInfo(overrides.dbInfo),
    source: { db_host: "127.0.0.1", db_port: 5432, db_name: "unit_db" },
    contract: {
      version: overrides.contractVersion ?? RUNTIME.contractVersion,
      schema_hash: "a".repeat(64),
    },
    embedding: {
      model: overrides.embeddingModel ?? RUNTIME.embeddingModel,
      dimensions: overrides.embeddingDimensions ?? RUNTIME.embeddingDimensions,
    },
    files: [{ name: DUMP_FILENAME, sha256, bytes }],
    createdAt: overrides.createdAt,
    hostname: "unit-host",
  });
  const written = overrides.mutateManifest
    ? overrides.mutateManifest(structuredClone(manifest))
    : manifest;
  await Bun.write(join(dir, MANIFEST_FILENAME), JSON.stringify(written));
  return manifest;
}

function verdictFor(
  result: {
    verdicts: Array<{ element: string; verdict: string; reason: string }>;
  },
  element: string,
): Array<{ verdict: string; reason: string }> {
  return result.verdicts
    .filter((v) => v.element === element)
    .map(({ verdict, reason }) => ({ verdict, reason }));
}

// ---------------------------------------------------------------------------
// Manifest build/parse round-trip
// ---------------------------------------------------------------------------

describe("manifest round-trip", () => {
  it("builds a schema-valid manifest and parses it back identically", () => {
    const manifest = buildManifest({
      dbInfo: makeDbInfo(),
      source: { db_host: "db.local", db_port: 5433, db_name: "open_brain" },
      contract: {
        version: RUNTIME.contractVersion,
        schema_hash: "b".repeat(64),
      },
      embedding: { model: "m", dimensions: 768 },
      files: [{ name: DUMP_FILENAME, sha256: "c".repeat(64), bytes: 42 }],
      createdAt: "2026-07-20T00:00:00.000Z",
      hostname: "host-a",
    });
    expect(manifest.schema).toBe(MANIFEST_SCHEMA_ID);
    expect(manifest.migrations.head).toBe("003_extras.sql");
    expect(manifest.namespace_inventory.distinct_namespaces).toBe(2);
    const reparsed = parseManifest(JSON.parse(JSON.stringify(manifest)));
    expect(reparsed.errors).toEqual([]);
    expect(reparsed.manifest).toEqual(manifest);
  });

  it("reports missing/invalid fields with paths", () => {
    const bad = {
      schema: MANIFEST_SCHEMA_ID,
      created_at: "2026-07-20T00:00:00.000Z",
    };
    const parsed = parseManifest(bad);
    expect(parsed.manifest).toBeNull();
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.errors.join(" ")).toContain("source");
  });

  it("rejects manifest file names that are not bare filenames (path traversal)", () => {
    const base = buildManifest({
      dbInfo: makeDbInfo(),
      source: { db_host: "h", db_port: 5432, db_name: "d" },
      contract: {
        version: RUNTIME.contractVersion,
        schema_hash: "a".repeat(64),
      },
      embedding: { model: "m", dimensions: 768 },
      files: [{ name: DUMP_FILENAME, sha256: "c".repeat(64), bytes: 42 }],
      createdAt: "2026-07-20T00:00:00.000Z",
      hostname: "host-a",
    });
    for (const evil of ["../x", "/abs", "a/b", "..", ".", "a\\b", ".hidden"]) {
      const raw = JSON.parse(JSON.stringify(base));
      raw.files[0].name = evil;
      const parsed = parseManifest(raw);
      expect(parsed.manifest).toBeNull();
      expect(parsed.errors.join(" ")).toContain("files");
    }
    for (const good of ["openbrain.dump", "extra-file_01.tar.gz", "a"]) {
      const raw = JSON.parse(JSON.stringify(base));
      raw.files[0].name = good;
      expect(parseManifest(raw).manifest).not.toBeNull();
    }
  });

  it("rejects a manifest whose row_counts lack the _migrations key", () => {
    const base = buildManifest({
      dbInfo: makeDbInfo(),
      source: { db_host: "h", db_port: 5432, db_name: "d" },
      contract: {
        version: RUNTIME.contractVersion,
        schema_hash: "a".repeat(64),
      },
      embedding: { model: "m", dimensions: 768 },
      files: [{ name: DUMP_FILENAME, sha256: "c".repeat(64), bytes: 42 }],
      createdAt: "2026-07-20T00:00:00.000Z",
      hostname: "host-a",
    });
    const raw = JSON.parse(JSON.stringify(base));
    delete raw.row_counts._migrations;
    const parsed = parseManifest(raw);
    expect(parsed.manifest).toBeNull();
    expect(parsed.errors.join(" ")).toContain("row_counts");
  });

  it("null migration head round-trips for an empty applied list", () => {
    const manifest = buildManifest({
      dbInfo: makeDbInfo({ appliedMigrations: [] }),
      source: { db_host: "h", db_port: 5432, db_name: "d" },
      contract: {
        version: RUNTIME.contractVersion,
        schema_hash: "d".repeat(64),
      },
      embedding: { model: "m", dimensions: 768 },
      files: [{ name: DUMP_FILENAME, sha256: "e".repeat(64), bytes: 1 }],
      hostname: "h",
    });
    expect(manifest.migrations.head).toBeNull();
    expect(parseManifest(JSON.parse(JSON.stringify(manifest))).errors).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// Compatibility verdict matrix
// ---------------------------------------------------------------------------

describe("migration compatibility matrix", () => {
  const repo = ["001_a.sql", "002_b.sql", "003_c.sql"];
  it("equal sets are equal", () => {
    expect(compareMigrationSets([...repo], repo)).toBe("equal");
  });
  it("older backup (exact sorted prefix) is restorable with migrations", () => {
    expect(compareMigrationSets(["001_a.sql", "002_b.sql"], repo)).toBe(
      "restorable_with_migrations",
    );
    // Unsorted input still qualifies: the comparison sorts both sides.
    expect(compareMigrationSets(["002_b.sql", "001_a.sql"], repo)).toBe(
      "restorable_with_migrations",
    );
  });
  it("empty applied list is restorable with migrations", () => {
    expect(compareMigrationSets([], repo)).toBe("restorable_with_migrations");
  });
  it("interleaved / mid-sequence gap fails closed (subset is NOT enough)", () => {
    // 001,003 applied against repo 001,002,003: forward migration would run
    // 002 AFTER 003 already ran — out of order. Must be a distinct verdict.
    expect(compareMigrationSets(["001_a.sql", "003_c.sql"], repo)).toBe(
      "incompatible_interleaved",
    );
    // Gap at the head: 002,003 without 001.
    expect(compareMigrationSets(["002_b.sql", "003_c.sql"], repo)).toBe(
      "incompatible_interleaved",
    );
  });
  it("newer/unknown backup migrations fail closed", () => {
    expect(compareMigrationSets([...repo, "004_future.sql"], repo)).toBe(
      "unknown_migrations",
    );
    expect(compareMigrationSets(["999_rogue.sql"], repo)).toBe(
      "unknown_migrations",
    );
  });
});

describe("contract compatibility matrix", () => {
  const current = "2026-07-17.memory-tools.v22";
  it("equal", () => {
    expect(compareContractVersions(current, current)).toBe("equal");
  });
  it("older date and older rev", () => {
    expect(
      compareContractVersions("2026-06-01.memory-tools.v20", current),
    ).toBe("older");
    expect(compareContractVersions("2026-07-17.memory-tools.v9", current)).toBe(
      "older",
    );
  });
  it("newer date and newer rev (double-digit rev compare is numeric)", () => {
    expect(
      compareContractVersions("2026-08-01.memory-tools.v23", current),
    ).toBe("newer");
    expect(
      compareContractVersions("2026-07-17.memory-tools.v100", current),
    ).toBe("newer");
  });
  it("different family or garbage is unparseable (fail-closed)", () => {
    expect(compareContractVersions("2026-07-17.other-tools.v22", current)).toBe(
      "unparseable",
    );
    expect(compareContractVersions("not-a-version", current)).toBe(
      "unparseable",
    );
  });
});

// ---------------------------------------------------------------------------
// Staleness math
// ---------------------------------------------------------------------------

describe("staleness math", () => {
  it("no max-age means never stale", () => {
    expect(evaluateStaleness([100], undefined)).toEqual({
      stale: false,
      newestValidAgeHours: 100,
    });
  });
  it("newest valid within window is fresh", () => {
    expect(evaluateStaleness([30, 5, 200], 24)).toEqual({
      stale: false,
      newestValidAgeHours: 5,
    });
  });
  it("newest valid beyond window is stale", () => {
    expect(evaluateStaleness([30, 25.5], 24).stale).toBe(true);
  });
  it("no valid backups at all is stale", () => {
    expect(evaluateStaleness([], 24)).toEqual({
      stale: true,
      newestValidAgeHours: null,
    });
    expect(evaluateStaleness([null], 24).stale).toBe(true);
  });
  it("a future-dated (negative) age cannot mask staleness", () => {
    // The -72h set is invalid (future-dated); the only real set is 500h old,
    // so a 24h window MUST report stale.
    expect(evaluateStaleness([-72, 500], 24)).toEqual({
      stale: true,
      newestValidAgeHours: 500,
    });
    expect(evaluateStaleness([-72], 24)).toEqual({
      stale: true,
      newestValidAgeHours: null,
    });
  });
  it("ageHours parses ISO timestamps and rejects garbage", () => {
    const now = new Date("2026-07-21T12:00:00.000Z");
    expect(ageHours("2026-07-21T00:00:00.000Z", now)).toBe(12);
    expect(ageHours("garbage", now)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Verify verdicts per corruption class
// ---------------------------------------------------------------------------

describe("verifyBackupSet corruption classes", () => {
  it("intact set passes with checksum_verified", async () => {
    const dir = await tempDir();
    await writeSet(dir);
    const result = await verifyBackupSet(dir, RUNTIME);
    expect(result.status).toBe("passed");
    expect(verdictFor(result, `file:${DUMP_FILENAME}`)).toEqual([
      { verdict: "ok", reason: "checksum_verified" },
    ]);
    expect(result.migration_compat).toBe("equal");
    expect(result.contract_compat).toBe("equal");
  });

  it("tampered dump bytes fail with checksum_mismatch", async () => {
    const dir = await tempDir();
    await writeSet(dir);
    // Same length, different content: size check passes, sha fails.
    await Bun.write(
      join(dir, DUMP_FILENAME),
      new TextEncoder().encode("fake-pg-dump-bytes-for-unit-testX"),
    );
    const result = await verifyBackupSet(dir, RUNTIME);
    expect(result.status).toBe("failed");
    expect(
      verdictFor(result, `file:${DUMP_FILENAME}`).map((v) => v.reason),
    ).toContain("checksum_mismatch");
  });

  it("truncated dump fails with size_mismatch", async () => {
    const dir = await tempDir();
    await writeSet(dir);
    await Bun.write(join(dir, DUMP_FILENAME), new TextEncoder().encode("x"));
    const result = await verifyBackupSet(dir, RUNTIME);
    expect(result.status).toBe("failed");
    expect(
      verdictFor(result, `file:${DUMP_FILENAME}`).map((v) => v.reason),
    ).toContain("size_mismatch");
  });

  it("deleted dump fails with missing", async () => {
    const dir = await tempDir();
    await writeSet(dir);
    await rm(join(dir, DUMP_FILENAME));
    const result = await verifyBackupSet(dir, RUNTIME);
    expect(result.status).toBe("failed");
    expect(
      verdictFor(result, `file:${DUMP_FILENAME}`).map((v) => v.reason),
    ).toContain("missing");
  });

  it("missing manifest fails distinctly", async () => {
    const dir = await tempDir();
    await writeSet(dir);
    await rm(join(dir, MANIFEST_FILENAME));
    const result = await verifyBackupSet(dir, RUNTIME);
    expect(result.status).toBe("failed");
    expect(verdictFor(result, "manifest").map((v) => v.reason)).toContain(
      "missing",
    );
  });

  it("unparseable manifest JSON fails distinctly", async () => {
    const dir = await tempDir();
    await writeSet(dir);
    await Bun.write(join(dir, MANIFEST_FILENAME), "{not json");
    const result = await verifyBackupSet(dir, RUNTIME);
    expect(verdictFor(result, "manifest").map((v) => v.reason)).toContain(
      "unparseable_json",
    );
  });

  it("unknown manifest schema id fails closed", async () => {
    const dir = await tempDir();
    await writeSet(dir, {
      mutateManifest: (m) => ({
        ...m,
        schema: "openbrain.backup_manifest.v99",
      }),
    });
    const result = await verifyBackupSet(dir, RUNTIME);
    expect(result.status).toBe("failed");
    expect(verdictFor(result, "manifest").map((v) => v.reason)).toContain(
      "unknown_schema_id",
    );
  });

  it("edited/removed manifest field fails with the field path", async () => {
    const dir = await tempDir();
    await writeSet(dir, {
      mutateManifest: (m) => {
        delete m.contract;
        return m;
      },
    });
    const result = await verifyBackupSet(dir, RUNTIME);
    expect(result.status).toBe("failed");
    const fieldReasons = verdictFor(result, "manifest_field").map(
      (v) => v.reason,
    );
    expect(fieldReasons.join(" ")).toContain("contract");
  });

  it("extra file in the set fails with unexpected_file", async () => {
    const dir = await tempDir();
    await writeSet(dir);
    await Bun.write(join(dir, "stray.bin"), "stray");
    const result = await verifyBackupSet(dir, RUNTIME);
    expect(result.status).toBe("failed");
    expect(verdictFor(result, "file:stray.bin").map((v) => v.reason)).toContain(
      "unexpected_file",
    );
  });

  it("dump mtime drift after manifest is reported distinctly (warn, sha intact)", async () => {
    const dir = await tempDir();
    await writeSet(dir);
    const future = new Date(Date.now() + 60_000);
    await utimes(join(dir, DUMP_FILENAME), future, future);
    const result = await verifyBackupSet(dir, RUNTIME);
    expect(result.status).toBe("warned");
    expect(
      verdictFor(result, `file:${DUMP_FILENAME}`).map((v) => v.reason),
    ).toContain("modified_after_manifest");
  });

  it("inconsistent migrations head fails closed", async () => {
    const dir = await tempDir();
    await writeSet(dir, {
      mutateManifest: (m) => {
        m.migrations.head = "000_wrong.sql";
        return m;
      },
    });
    const result = await verifyBackupSet(dir, RUNTIME);
    expect(result.status).toBe("failed");
    expect(verdictFor(result, "migrations").map((v) => v.reason)).toContain(
      "head_inconsistent_with_applied_list",
    );
  });
});

describe("verify compatibility verdicts", () => {
  it("older migration head verifies as restorable_with_migrations", async () => {
    const dir = await tempDir();
    await writeSet(dir, {
      dbInfo: { appliedMigrations: RUNTIME.repoMigrations.slice(0, 2) },
    });
    const result = await verifyBackupSet(dir, RUNTIME);
    expect(result.status).toBe("passed");
    expect(result.migration_compat).toBe("restorable_with_migrations");
  });

  it("unknown/newer migration head fails closed", async () => {
    const dir = await tempDir();
    await writeSet(dir, {
      dbInfo: {
        appliedMigrations: [...RUNTIME.repoMigrations, "099_future.sql"],
      },
    });
    const result = await verifyBackupSet(dir, RUNTIME);
    expect(result.status).toBe("failed");
    expect(result.migration_compat).toBe("unknown_migrations");
  });

  it("interleaved migration gap fails closed with a distinct reason", async () => {
    const dir = await tempDir();
    await writeSet(dir, {
      // 001 + 003 applied, 002 missing: a subset but NOT a sorted prefix.
      dbInfo: {
        appliedMigrations: [
          RUNTIME.repoMigrations[0]!,
          RUNTIME.repoMigrations[2]!,
        ],
      },
    });
    const result = await verifyBackupSet(dir, RUNTIME);
    expect(result.status).toBe("failed");
    expect(result.migration_compat).toBe("incompatible_interleaved");
    expect(verdictFor(result, "migrations").map((v) => v.reason)).toContain(
      "interleaved_migration_gap_fail_closed",
    );
  });

  it("future-dated created_at fails the set distinctly", async () => {
    const dir = await tempDir();
    await writeSet(dir, {
      createdAt: new Date(Date.now() + 72 * 3_600_000).toISOString(),
    });
    const result = await verifyBackupSet(dir, RUNTIME);
    expect(result.status).toBe("failed");
    expect(verdictFor(result, "created_at").map((v) => v.reason)).toContain(
      "future_dated_timestamp",
    );
  });

  it("older contract warns; newer contract fails closed", async () => {
    const olderDir = await tempDir();
    await writeSet(olderDir, { contractVersion: "2026-01-01.memory-tools.v1" });
    const older = await verifyBackupSet(olderDir, RUNTIME);
    expect(older.status).toBe("warned");
    expect(older.contract_compat).toBe("older");

    const newerDir = await tempDir();
    await writeSet(newerDir, {
      contractVersion: "2027-01-01.memory-tools.v99",
    });
    const newer = await verifyBackupSet(newerDir, RUNTIME);
    expect(newer.status).toBe("failed");
    expect(newer.contract_compat).toBe("newer");
  });

  it("embedding mismatch fails closed unless explicitly allowed", async () => {
    const dir = await tempDir();
    await writeSet(dir, { embeddingModel: "some-other-model" });
    const denied = await verifyBackupSet(dir, RUNTIME);
    expect(denied.status).toBe("failed");
    expect(verdictFor(denied, "embedding").map((v) => v.reason)).toContain(
      "model_or_dimension_mismatch_fail_closed",
    );
    const allowed = await verifyBackupSet(dir, RUNTIME, {
      allowEmbeddingMismatch: true,
    });
    expect(allowed.status).toBe("warned");
    expect(verdictFor(allowed, "embedding").map((v) => v.reason)).toContain(
      "mismatch_allowed_by_flag",
    );
  });

  it("embedding dimension mismatch also fails closed", async () => {
    const dir = await tempDir();
    await writeSet(dir, { embeddingDimensions: 1536 });
    const result = await verifyBackupSet(dir, RUNTIME);
    expect(result.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Directory (root) mode + staleness
// ---------------------------------------------------------------------------

describe("verifyBackupPath root mode and staleness", () => {
  it("verifies each set under a root and reports stale when newest is too old", async () => {
    const root = await tempDir();
    const oldAge = new Date(Date.now() - 100 * 3_600_000).toISOString();
    await writeSet(join(root, "set-old"), { createdAt: oldAge });
    const result = await verifyBackupPath(root, RUNTIME, { maxAgeHours: 24 });
    expect(result.sets.length).toBe(1);
    expect(result.status).toBe("stale");
    expect(result.stale).toBe(true);
  });

  it("fresh valid set under a root is not stale", async () => {
    const root = await tempDir();
    await writeSet(join(root, "set-old"), {
      createdAt: new Date(Date.now() - 100 * 3_600_000).toISOString(),
    });
    await writeSet(join(root, "set-fresh"), {
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const result = await verifyBackupPath(root, RUNTIME, { maxAgeHours: 24 });
    expect(result.sets.length).toBe(2);
    expect(result.stale).toBe(false);
    expect(result.status).toBe("passed");
    expect(result.newest_valid_age_hours).toBeLessThan(24);
  });

  it("a corrupt set does not count as a valid backup for staleness", async () => {
    const root = await tempDir();
    const dir = join(root, "set-corrupt");
    await writeSet(dir, {
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    await Bun.write(join(dir, DUMP_FILENAME), "tampered");
    const result = await verifyBackupPath(root, RUNTIME, { maxAgeHours: 24 });
    // Failed set AND stale (no valid backup in window): staleness dominates.
    expect(result.stale).toBe(true);
    expect(result.status).toBe("stale");
    expect(result.sets[0]!.status).toBe("failed");
  });

  it("an empty/absent root with max-age is stale, without max-age it is failed", async () => {
    const root = await tempDir();
    const stale = await verifyBackupPath(root, RUNTIME, { maxAgeHours: 24 });
    expect(stale.status).toBe("stale");
    const failed = await verifyBackupPath(root, RUNTIME);
    expect(failed.status).toBe("failed");
  });

  it("single-set mode with max-age applies staleness to that set", async () => {
    const dir = await tempDir();
    await writeSet(dir, {
      createdAt: new Date(Date.now() - 48 * 3_600_000).toISOString(),
    });
    const result = await verifyBackupPath(dir, RUNTIME, { maxAgeHours: 24 });
    expect(result.status).toBe("stale");
  });
});

// ---------------------------------------------------------------------------
// gatherDbInfo: counts only, content-free by construction
// ---------------------------------------------------------------------------

const NS_SENTINEL = "SENTINEL-NAMESPACE-ALPHA";
const CONTENT_SENTINEL = "SENTINEL-ROW-CONTENT-DO-NOT-LEAK";
const PASSWORD_SENTINEL = ["SENTINEL-DB", "PASSWORD-123"].join("-");

/**
 * Fake Queryable that deliberately RETURNS namespace names and row content in
 * its result rows (as a hostile driver could); gatherDbInfo must only ever
 * read counts/versions out of them.
 */
function makeFakeDb(): Queryable {
  return {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes("information_schema.tables")) {
        const table = String(params?.[0] ?? "");
        const exists = ["_migrations", "thoughts", "ob_session_lanes"].includes(
          table,
        );
        return { rows: exists ? [{ "1": 1 }] : [] };
      }
      if (sql.includes("information_schema.columns")) {
        const table = String(params?.[0] ?? "");
        return {
          rows: ["thoughts", "ob_session_lanes"].includes(table)
            ? [{ "1": 1 }]
            : [],
        };
      }
      if (sql.includes("FROM _migrations")) {
        return {
          rows: [
            { filename: "001_init.sql" },
            { filename: "002_curation.sql" },
          ],
        };
      }
      if (sql.includes("pg_extension")) {
        return { rows: [{ extversion: "0.8.2" }] };
      }
      if (sql.includes(") AS ns")) {
        // Hostile shape: count plus a namespace name in the same row.
        return { rows: [{ count: 2, namespace: NS_SENTINEL }] };
      }
      if (sql.includes("archived_at IS NOT NULL")) {
        return { rows: [{ count: 1, content: CONTENT_SENTINEL }] };
      }
      if (sql.startsWith("SELECT COUNT(*)::bigint AS count FROM ")) {
        return { rows: [{ count: 7, content: CONTENT_SENTINEL }] };
      }
      throw new Error(`unexpected query in fake db: ${sql}`);
    },
  };
}

describe("gatherDbInfo content freedom", () => {
  it("extracts counts only — no namespace names, row content, or credentials in the manifest", async () => {
    process.env.DB_PASSWORD_TEST_SENTINEL = PASSWORD_SENTINEL;
    const info = await gatherDbInfo(makeFakeDb());
    expect(info.appliedMigrations).toEqual([
      "001_init.sql",
      "002_curation.sql",
    ]);
    expect(info.distinctNamespaces).toBe(2);
    expect(info.rowCounts.thoughts).toBe(7);
    expect(info.archivedRowCounts.thoughts).toBe(1);

    const manifest = buildManifest({
      dbInfo: info,
      source: { db_host: "127.0.0.1", db_port: 5432, db_name: "unit_db" },
      contract: {
        version: RUNTIME.contractVersion,
        schema_hash: "f".repeat(64),
      },
      embedding: { model: "m", dimensions: 768 },
      files: [{ name: DUMP_FILENAME, sha256: "0".repeat(64), bytes: 10 }],
      hostname: "unit-host",
    });
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain(NS_SENTINEL);
    expect(serialized).not.toContain(CONTENT_SENTINEL);
    expect(serialized).not.toContain(PASSWORD_SENTINEL);
  });

  it("refuses to back up a database without _migrations tracking", async () => {
    const db: Queryable = {
      async query(sql: string) {
        if (sql.includes("information_schema.tables")) return { rows: [] };
        throw new Error("should not reach further queries");
      },
    };
    await expect(gatherDbInfo(db)).rejects.toThrow(/_migrations/);
  });
});

describe("verify result serialization content freedom", () => {
  it("verify verdicts carry no credentials even when env holds them", async () => {
    const dir = await tempDir();
    await writeSet(dir);
    const result = await verifyBackupSet(dir, RUNTIME);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(PASSWORD_SENTINEL);
    expect(serialized).not.toContain(NS_SENTINEL);
  });
});

// ---------------------------------------------------------------------------
// pg tool resolution + redaction
// ---------------------------------------------------------------------------

describe("pg tool resolution", () => {
  it("defaults to the bare tool name", () => {
    expect(resolvePgTool("pg_dump", {})).toEqual(["pg_dump"]);
    expect(resolvePgTool("pg_restore", {})).toEqual(["pg_restore"]);
  });
  it("splits docker-exec overrides into argv tokens (no shell)", () => {
    const container = ["ob", "ci"].join("");
    expect(
      resolvePgTool("pg_dump", {
        OPENBRAIN_PG_DUMP_BIN: [
          "docker exec -e PGPASSWORD",
          container,
          "pg_dump",
        ].join(" "),
      }),
    ).toEqual(["docker", "exec", "-e", "PGPASSWORD", container, "pg_dump"]);
  });
});

describe("summarizeChildStderr", () => {
  const ROW_SENTINEL = "SENTINEL-STDERR-ROW-CONTENT";
  it("keeps only the error class from a mid-COPY failure", () => {
    const stderr = [
      `pg_restore: error: COPY failed for table "thoughts": ERROR:  value too long`,
      `CONTEXT:  COPY thoughts, line 42: "${ROW_SENTINEL} secret row body"`,
      `DETAIL:  Key (content_hash)=(${ROW_SENTINEL}) already exists.`,
      `HINT:  something ${ROW_SENTINEL}`,
    ].join("\n");
    const summary = summarizeChildStderr(stderr);
    expect(summary).toBe("COPY failed for table");
    expect(summary).not.toContain(ROW_SENTINEL);
    expect(summary).not.toContain('"');
  });
  it("cuts at the first colon or quote of the class line", () => {
    expect(
      summarizeChildStderr(
        `pg_dump: error: connection to server at 'x' failed`,
      ),
    ).toBe("connection to server at");
    expect(summarizeChildStderr("something bad happened")).toBe(
      "something bad happened",
    );
  });
  it("handles empty and prefix-only stderr", () => {
    expect(summarizeChildStderr("")).toBe("no stderr output");
    expect(summarizeChildStderr("\n\n")).toBe("no stderr output");
    expect(summarizeChildStderr("pg_restore: error:")).toBe(
      "unclassifiable stderr",
    );
  });
});

describe("redactSecret", () => {
  it("strips every occurrence of the secret", () => {
    expect(
      redactSecret(
        `fail ${PASSWORD_SENTINEL} x ${PASSWORD_SENTINEL}`,
        PASSWORD_SENTINEL,
      ),
    ).toBe("fail [redacted] x [redacted]");
  });
  it("is a no-op for empty/undefined secrets", () => {
    expect(redactSecret("text", undefined)).toBe("text");
    expect(redactSecret("text", "")).toBe("text");
  });
});
