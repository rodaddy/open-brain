import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { runSharedPromoter } from "./promote-lane-shared.ts";
import { requireTestDatabaseUrl } from "./test-support/require-test-database.ts";
import { createPromoterHarness } from "./test-support/promote-lane-shared-helpers.ts";

// ── Cursor-stall coverage (Issue #161, hybrid timing) ──
//
// runSharedPromoter creates its OWN pool via createPool(), which reads
// DB_HOST/DB_USER/DB_NAME/DB_PORT/DB_PASSWORD from the environment (NOT a
// connection string). So before each test the harness parses the test database
// URL into those variables. A separate, URL-built Pool is used here only for
// seeding and assertions.
//
// SME HARD RULE (docs/sme/correctness.md): SQL write-path behavior -- cursor
// advancement persisted to the state file, the JOIN/cursor predicates, and the
// metadata jsonb shape -- CANNOT be caught by a mock pool. These tests run the
// real query through real Postgres, and per issue #878 they DEMAND the test
// database rather than skipping themselves when it is absent.
const databaseUrl = requireTestDatabaseUrl();
const pool = new Pool({ connectionString: databaseUrl });

describe("runSharedPromoter cursor-stall fix (live Postgres)", () => {
  const h = createPromoterHarness(pool, databaseUrl);
  let tmpDir: string;
  let stateFile: string;

  test("candidate-only rows are not shared-kb nominations", async () => {
    const laneId = await h.seedLane();
    await pool.query(
      `INSERT INTO ob_session_events
         (lane_id, event_type, content, importance, metadata, content_hash, created_by, created_at)
       VALUES ($1, 'correction', $2, 'warm', $3::jsonb, $4, 'test', $5::timestamptz)`,
      [
        laneId,
        "User correction: treat share candidates as review-only unless explicitly nominated.",
        JSON.stringify({
          memory_lifecycle_action: "candidate",
          candidate_type: "negative_example",
          candidate_reason: "User corrected unsafe auto-promotion assumption.",
          candidate_confidence: 0.95,
        }),
        "candidate-only-event-hash",
        "2026-01-01T00:00:00Z",
      ],
    );
    await pool.query(
      `INSERT INTO thoughts
         (content, namespace, extracted_metadata, created_by, created_at)
       VALUES ($1, $2, $3::jsonb, 'test', $4::timestamptz)`,
      [
        "Candidate-only thought should not be promoted by presence alone.",
        h.ns,
        JSON.stringify({
          share_candidate: true,
          memory_lifecycle_action: "candidate",
          candidate_type: "code_repo_fact",
          candidate_reason: "Needs explicit nomination before sharing.",
        }),
        "2026-01-02T00:00:00Z",
      ],
    );

    const receipt = await runSharedPromoter(h.makeArgs(true, stateFile));
    expect(receipt.scanned).toBe(0);

    const { rows: sharedCopies } = await pool.query(
      `SELECT id FROM thoughts
        WHERE namespace = $1
          AND content = 'Candidate-only thought should not be promoted by presence alone.'`,
      [h.ns + "-shared"],
    );
    expect(sharedCopies.length).toBe(0);
  });

  beforeEach(async () => {
    h.applyDbEnv();
    // Defend against a PRIOR crashed test leaving residue that a namespace-wide
    // scan (nominatedTableRows has no namespace filter) would re-pick up.
    await h.cleanupNs();
    // DEV_TMP (macOS dev) when set; otherwise the OS temp dir so this runs on
    // the Linux CI runner (the Mac /Volumes path does not exist there).
    tmpDir = mkdtempSync(join(process.env.DEV_TMP ?? tmpdir(), "promote-lane-shared-"));
    stateFile = join(tmpDir, "state.json");
  });

  afterEach(async () => {
    await h.cleanupNs();
    h.restoreDbEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await pool.end();
  });
});
