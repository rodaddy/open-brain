import { afterAll, describe, expect, it } from "vitest";
import { rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DUMP_FILENAME,
  MANIFEST_FILENAME,
  verifyBackupPath,
  verifyBackupSet,
} from "./backup-lib.ts";
import { expectDefined } from "./test-support/expect-defined.ts";
import {
  RUNTIME,
  cleanupTempDirs,
  tempDir,
  verdictFor,
  writeSet,
} from "./test-support/backup-fixtures.ts";

afterAll(cleanupTempDirs);

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
    await writeFile(
      join(dir, DUMP_FILENAME),
      new TextEncoder().encode("fake-pg-dump-bytes-for-unit-testX"),
    );
    const result = await verifyBackupSet(dir, RUNTIME);
    expect(result.status).toBe("failed");
    expect(verdictFor(result, `file:${DUMP_FILENAME}`).map((v) => v.reason)).toContain(
      "checksum_mismatch",
    );
  });

  it("a dump of the wrong byte length fails with size_mismatch", async () => {
    const dir = await tempDir();
    await writeSet(dir);
    await writeFile(join(dir, DUMP_FILENAME), new TextEncoder().encode("x"));
    const result = await verifyBackupSet(dir, RUNTIME);
    expect(result.status).toBe("failed");
    expect(verdictFor(result, `file:${DUMP_FILENAME}`).map((v) => v.reason)).toContain(
      "size_mismatch",
    );
  });

  it("deleted dump fails with missing", async () => {
    const dir = await tempDir();
    await writeSet(dir);
    await rm(join(dir, DUMP_FILENAME));
    const result = await verifyBackupSet(dir, RUNTIME);
    expect(result.status).toBe("failed");
    expect(verdictFor(result, `file:${DUMP_FILENAME}`).map((v) => v.reason)).toContain(
      "missing",
    );
  });
});

describe("verifyBackupSet manifest corruption classes", () => {
  it("missing manifest fails distinctly", async () => {
    const dir = await tempDir();
    await writeSet(dir);
    await rm(join(dir, MANIFEST_FILENAME));
    const result = await verifyBackupSet(dir, RUNTIME);
    expect(result.status).toBe("failed");
    expect(verdictFor(result, "manifest").map((v) => v.reason)).toContain("missing");
  });

  it("unparseable manifest JSON fails distinctly", async () => {
    const dir = await tempDir();
    await writeSet(dir);
    await writeFile(join(dir, MANIFEST_FILENAME), "{not json");
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
    const fieldReasons = verdictFor(result, "manifest_field").map((v) => v.reason);
    expect(fieldReasons.join(" ")).toContain("contract");
  });

  it("extra file in the set fails with unexpected_file", async () => {
    const dir = await tempDir();
    await writeSet(dir);
    await writeFile(join(dir, "stray.bin"), "stray");
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
    expect(verdictFor(result, `file:${DUMP_FILENAME}`).map((v) => v.reason)).toContain(
      "modified_after_manifest",
    );
  });

  it("inconsistent migrations head fails closed", async () => {
    const dir = await tempDir();
    await writeSet(dir, {
      mutateManifest: (m) => {
        const migrations = m.migrations as { head: string };
        migrations.head = "000_wrong.sql";
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
          expectDefined(RUNTIME.repoMigrations[0], "repo migration 0"),
          expectDefined(RUNTIME.repoMigrations[2], "repo migration 2"),
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
    await writeFile(join(dir, DUMP_FILENAME), "tampered");
    const result = await verifyBackupPath(root, RUNTIME, { maxAgeHours: 24 });
    // Failed set AND stale (no valid backup in window): staleness dominates.
    expect(result.stale).toBe(true);
    expect(result.status).toBe("stale");
    expect(expectDefined(result.sets[0], "first verified set").status).toBe("failed");
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
