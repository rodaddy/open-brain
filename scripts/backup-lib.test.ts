import { afterAll, describe, expect, it } from "vitest";
import {
  DUMP_FILENAME,
  MANIFEST_SCHEMA_ID,
  ageHours,
  buildManifest,
  compareContractVersions,
  compareMigrationSets,
  evaluateStaleness,
  parseManifest,
} from "./backup-lib.ts";
import {
  RUNTIME,
  cleanupTempDirs,
  makeDbInfo,
} from "./test-support/backup-fixtures.ts";

afterAll(cleanupTempDirs);

// ---------------------------------------------------------------------------
// Manifest build/parse round-trip
// ---------------------------------------------------------------------------

/** A manifest with the fields every round-trip case starts from. */
function baseManifest(schemaHash: string) {
  return buildManifest({
    dbInfo: makeDbInfo(),
    source: { db_host: "h", db_port: 5432, db_name: "d" },
    contract: {
      version: RUNTIME.contractVersion,
      schema_hash: schemaHash,
    },
    embedding: { model: "m", dimensions: 768 },
    files: [{ name: DUMP_FILENAME, sha256: "c".repeat(64), bytes: 42 }],
    createdAt: "2026-07-20T00:00:00.000Z",
    hostname: "host-a",
  });
}

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
    const base = baseManifest("a".repeat(64));
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
    const base = baseManifest("a".repeat(64));
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
    expect(parseManifest(JSON.parse(JSON.stringify(manifest))).errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Compatibility verdict matrix
// ---------------------------------------------------------------------------

const REPO = ["001_a.sql", "002_b.sql", "003_c.sql"];

const PRODUCTION_REPO = [
  "001_init.sql",
  "002_curation.sql",
  "003_extraction_metadata.sql",
  "004_contact_fields.sql",
  "005_fts_hybrid.sql",
  "006_cognitive_tiering.sql",
  "006_namespace.sql",
  "007_search_improvements.sql",
  "008_index_cleanup.sql",
  "009_agent_attribution.sql",
  "010_entity_links.sql",
  "011_chunking.sql",
  "012_session_lanes.sql",
  "013_session_events.sql",
  "014_namespace_scoped_uniqueness.sql",
  "015_session_id_namespace_scoped.sql",
  "016_promotion_provenance.sql",
  "017_entity_graph_lifecycle.sql",
  "018_link_relation_supplements.sql",
  "019_drop_collab_namespace_defaults.sql",
  "020_session_lane_namespace_hash.sql",
  "021_source_refs.sql",
  "022_mcp_tool_audit_log.sql",
  "023_session_event_transcript_citations.sql",
  "024_session_lane_content_hash_nonunique.sql",
  "025_normalize_legacy_development_lanes.sql",
  "026_maintenance_queue.sql",
  "027_source_registry.sql",
  "028_maintenance_jobs_lease_expired_compat.sql",
  "029_maintenance_jobs_terminal_category.sql",
  "030_source_sync.sql",
  "031_source_sync_runs_running_only_unique.sql",
];

const PRODUCTION_APPLIED = [
  ...PRODUCTION_REPO,
  "005_fts_hybrid",
  "010_chunking.sql",
].sort();

describe("migration compatibility matrix", () => {
  it("equal sets are equal", () => {
    expect(compareMigrationSets([...REPO], REPO)).toBe("equal");
  });
  it("older backup (exact sorted prefix) is restorable with migrations", () => {
    expect(compareMigrationSets(["001_a.sql", "002_b.sql"], REPO)).toBe(
      "restorable_with_migrations",
    );
    // Unsorted input still qualifies: the comparison sorts both sides.
    expect(compareMigrationSets(["002_b.sql", "001_a.sql"], REPO)).toBe(
      "restorable_with_migrations",
    );
  });
  it("empty applied list is restorable with migrations", () => {
    expect(compareMigrationSets([], REPO)).toBe("restorable_with_migrations");
  });
  it("interleaved / mid-sequence gap fails closed (subset is NOT enough)", () => {
    // 001,003 applied against repo 001,002,003: forward migration would run
    // 002 AFTER 003 already ran — out of order. Must be a distinct verdict.
    expect(compareMigrationSets(["001_a.sql", "003_c.sql"], REPO)).toBe(
      "incompatible_interleaved",
    );
    // Gap at the head: 002,003 without 001.
    expect(compareMigrationSets(["002_b.sql", "003_c.sql"], REPO)).toBe(
      "incompatible_interleaved",
    );
  });
  it("newer/unknown backup migrations fail closed", () => {
    expect(compareMigrationSets([...REPO, "004_future.sql"], REPO)).toBe(
      "unknown_migrations",
    );
    expect(compareMigrationSets(["999_rogue.sql"], REPO)).toBe("unknown_migrations");
  });
});

describe("legacy migration marker normalization", () => {
  it("normalizes both allowlisted legacy markers in a production-shaped history", () => {
    expect(compareMigrationSets(PRODUCTION_APPLIED, PRODUCTION_REPO)).toBe("equal");
  });

  it("normalizes each allowlisted legacy marker independently", () => {
    expect(
      compareMigrationSets([...PRODUCTION_REPO, "005_fts_hybrid"], PRODUCTION_REPO),
    ).toBe("equal");
    expect(
      compareMigrationSets([...PRODUCTION_REPO, "010_chunking.sql"], PRODUCTION_REPO),
    ).toBe("equal");
  });

  it("rejects near-matches, duplicates, and a missing canonical replacement", () => {
    expect(compareMigrationSets(["005_fts_hybrid.sql.bak"], PRODUCTION_REPO)).toBe(
      "unknown_migrations",
    );
    expect(compareMigrationSets(["010_chunking"], PRODUCTION_REPO)).toBe(
      "unknown_migrations",
    );
    expect(
      compareMigrationSets(["005_fts_hybrid", "005_fts_hybrid"], PRODUCTION_REPO),
    ).toBe("unknown_migrations");
    expect(
      compareMigrationSets(
        [
          ...PRODUCTION_REPO.filter((file) => file !== "005_fts_hybrid.sql"),
          "005_fts_hybrid",
        ],
        PRODUCTION_REPO,
      ),
    ).toBe("unknown_migrations");
    expect(
      compareMigrationSets(
        [
          ...PRODUCTION_REPO.filter((file) => file !== "011_chunking.sql"),
          "010_chunking.sql",
        ],
        PRODUCTION_REPO,
      ),
    ).toBe("unknown_migrations");
    expect(
      compareMigrationSets(
        [...PRODUCTION_REPO, "005_fts_hybrid"],
        PRODUCTION_REPO.filter((file) => file !== "005_fts_hybrid.sql"),
      ),
    ).toBe("unknown_migrations");
  });

  it("still rejects missing and interleaved canonical migrations", () => {
    expect(
      compareMigrationSets(
        PRODUCTION_REPO.filter((file) => file !== "008_index_cleanup.sql"),
        PRODUCTION_REPO,
      ),
    ).toBe("incompatible_interleaved");
  });
});

describe("contract compatibility matrix", () => {
  const current = "2026-07-17.memory-tools.v22";
  it("equal", () => {
    expect(compareContractVersions(current, current)).toBe("equal");
  });
  it("older date and older rev", () => {
    expect(compareContractVersions("2026-06-01.memory-tools.v20", current)).toBe(
      "older",
    );
    expect(compareContractVersions("2026-07-17.memory-tools.v9", current)).toBe(
      "older",
    );
  });
  it("newer date and newer rev (double-digit rev compare is numeric)", () => {
    expect(compareContractVersions("2026-08-01.memory-tools.v23", current)).toBe(
      "newer",
    );
    expect(compareContractVersions("2026-07-17.memory-tools.v100", current)).toBe(
      "newer",
    );
  });
  it("different family or garbage is unparseable (fail-closed)", () => {
    expect(compareContractVersions("2026-07-17.other-tools.v22", current)).toBe(
      "unparseable",
    );
    expect(compareContractVersions("not-a-version", current)).toBe("unparseable");
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
