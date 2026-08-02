/**
 * Append-only migration history tests.
 * Design authority: `docs/sme/correctness.md` requires an exact prefix before
 * forward migration so a missing middle file can never run after a later file.
 */
import { describe, expect, it } from "bun:test";
import { pendingMigrationFiles } from "./migrations.ts";

const REPOSITORY = ["001_init.sql", "002_policy.sql", "003_indexes.sql"];

describe("append-only migration history", () => {
  it("returns only the valid unapplied suffix", () => {
    expect(pendingMigrationFiles(["001_init.sql"], REPOSITORY)).toEqual([
      "002_policy.sql",
      "003_indexes.sql",
    ]);
    expect(pendingMigrationFiles(REPOSITORY, REPOSITORY)).toEqual([]);
  });

  it("fails closed on a missing middle migration", () => {
    expect(() => pendingMigrationFiles(["001_init.sql", "003_indexes.sql"], REPOSITORY))
      .toThrow("database_migration_history_interleaved");
  });

  it("fails closed on an unknown migration ledger entry", () => {
    expect(() => pendingMigrationFiles(["000_unknown.sql"], REPOSITORY))
      .toThrow("database_migration_history_unknown");
  });

  it("accepts only the two recorded duplicate legacy markers", () => {
    const repository = ["005_fts_hybrid.sql", "011_chunking.sql", "012_next.sql"];
    expect(pendingMigrationFiles([
      "005_fts_hybrid",
      "005_fts_hybrid.sql",
      "010_chunking.sql",
      "011_chunking.sql",
    ], repository)).toEqual(["012_next.sql"]);
  });
});
