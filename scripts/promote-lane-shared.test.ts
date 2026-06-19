import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { parseArgs, runSharedPromoter } from "./promote-lane-shared.ts";
import { sharedNamespaceConfig } from "../src/shared-namespace.ts";

// ── Cursor-stall + dry-run-embedding coverage (Issue #161, hybrid timing) ──
//
// runSharedPromoter creates its OWN pool via createPool(), which reads
// DB_HOST/DB_USER/DB_NAME/DB_PORT/DB_PASSWORD from the environment (NOT a
// connection string). So before each DB-gated test we parse
// OPENBRAIN_TEST_DATABASE_URL into those env vars. A separate, URL-built Pool is
// used here only for seeding and assertions.
//
// SME HARD RULE (docs/sme/correctness.md): SQL write-path behavior — cursor
// advancement persisted to the state file, the JOIN/cursor predicates, and the
// metadata jsonb shape — CANNOT be caught by a mock pool. These tests run the
// real query through real Postgres and are env-gated so the default suite stays
// infra-free. Run with:
//   OPENBRAIN_TEST_DATABASE_URL=postgres://user:pass@host:5432/db \
//     bun test scripts/promote-lane-shared.test.ts
const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;

const DEFAULT_MIN = 24;
// minLen <= len < minLen*1.5 → manual-review. minLen=24 → [24, 36).
const MANUAL_REVIEW_CONTENT = "x".repeat(30); // len 30, in the ambiguity band.
// len >= minLen*1.5 (>=36) and a shareable type → share.
const SHARE_CONTENT =
  "This is a substantive shared-worthy decision about the schema design choices.";

dbDescribe("runSharedPromoter cursor-stall fix (live Postgres)", () => {
  // Build a seeding/assertion pool from the URL.
  const pool = new Pool({ connectionString: DB_URL });
  const ns = "test-promote-lane-shared-live";
  let tmpDir: string;
  let stateFile: string;
  let savedEnv: Record<string, string | undefined>;

  // Translate the connection URL into the env vars createPool() expects so the
  // runner's internal pool targets the same test database.
  function applyDbEnv(url: string): void {
    const u = new URL(url);
    savedEnv = {
      DB_HOST: process.env.DB_HOST,
      DB_PORT: process.env.DB_PORT,
      DB_NAME: process.env.DB_NAME,
      DB_USER: process.env.DB_USER,
      DB_PASSWORD: process.env.DB_PASSWORD,
    };
    process.env.DB_HOST = u.hostname;
    process.env.DB_PORT = u.port || "5432";
    process.env.DB_NAME = u.pathname.replace(/^\//, "") || "open_brain";
    process.env.DB_USER = decodeURIComponent(u.username);
    process.env.DB_PASSWORD = decodeURIComponent(u.password);
  }

  function restoreDbEnv(): void {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  // The runner's events loop inserts promoted lane events into the REAL physical
  // shared-kb namespace (config.physicalSharedNamespace), not ns+"-shared", so we
  // resolve it the same way the runner does for an exhaustive cleanup.
  const sharedPhysicalNs = sharedNamespaceConfig().physicalSharedNamespace;

  async function cleanupNs(): Promise<void> {
    // Make cleanup namespace-exhaustive across EVERYTHING any test in this file
    // can create, deleting by namespace rather than by fragile source strings.
    //
    // Sources of residue per test:
    //  1. Seeded source thoughts  → namespace = ns
    //  2. promoteEntry-promoted thought/decision COPIES → namespace = ns+"-shared".
    //     These keep the SOURCE row's `source` value (NOT 'lane-shared-promotion')
    //     so a source-string predicate misses them entirely.
    //  3. Events + lanes → ob_session_events cascade-delete with ob_session_lanes.
    //  4. Promoted lane-event copies → namespace = sharedPhysicalNs (real shared-kb),
    //     source = 'lane-shared-promotion', provenance source_physical_namespace = ns.
    //
    // Lanes/events: delete lanes for the test ns (events cascade).
    await pool.query("DELETE FROM ob_session_lanes WHERE namespace = $1", [ns]);
    // Seeded source rows AND promoteEntry-promoted copies, by namespace.
    await pool.query(
      "DELETE FROM thoughts WHERE namespace = ANY($1::text[])",
      [[ns, ns + "-shared"]],
    );
    await pool.query(
      "DELETE FROM decisions WHERE namespace = ANY($1::text[])",
      [[ns, ns + "-shared"]],
    );
    // Promoted lane-event copies that land in the real shared-kb namespace are
    // scoped to THIS test's provenance so we never touch unrelated shared-kb rows.
    await pool.query(
      `DELETE FROM thoughts
       WHERE namespace = $1
         AND source = 'lane-shared-promotion'
         AND promoted_from->>'source_physical_namespace' = $2`,
      [sharedPhysicalNs, ns],
    );
    // Belt-and-suspenders: any promoted copy whose provenance target points at
    // this test's shared namespace, regardless of which physical ns it landed in.
    await pool.query(
      `DELETE FROM thoughts
       WHERE promoted_from->>'source_physical_namespace' = $1`,
      [ns],
    );
  }

  async function seedLane(): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO ob_session_lanes (session_key, namespace, status, created_by)
       VALUES ($1, $2, 'active', $3)
       RETURNING id`,
      ["promote-test-lane", ns, "test"],
    );
    return rows[0].id as string;
  }

  /** Seed an event. created_at is explicit so cursor ordering is deterministic. */
  async function seedEvent(
    laneId: string,
    content: string,
    createdAt: string,
  ): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO ob_session_events
         (lane_id, event_type, content, importance, metadata, content_hash, created_by, created_at)
       VALUES ($1, 'fact', $2, 'warm', $3::jsonb, $4, 'test', $5::timestamptz)
       RETURNING id`,
      [
        laneId,
        content,
        JSON.stringify({ share_candidate: true }),
        // unique-ish hash so ON CONFLICT (lane_id, content_hash) won't collide
        `hash-${content.length}-${createdAt}`,
        createdAt,
      ],
    );
    return rows[0].id as string;
  }

  async function seedThought(
    content: string,
    createdAt: string,
  ): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO thoughts
         (content, namespace, extracted_metadata, created_by, created_at)
       VALUES ($1, $2, $3::jsonb, 'test', $4::timestamptz)
       RETURNING id`,
      [content, ns, JSON.stringify({ share_candidate: true }), createdAt],
    );
    return rows[0].id as string;
  }

  function makeArgs(apply: boolean): ReturnType<typeof parseArgs> {
    const base = parseArgs([
      "--state-file",
      stateFile,
      "--min-content-length",
      String(DEFAULT_MIN),
      "--batch-size",
      "50",
      "--max-apply",
      "50",
      "--delay-ms",
      "0",
    ]);
    base.apply = apply;
    // Pin the target namespace away from real shared-kb to avoid cross-talk.
    base.targetNamespace = ns + "-shared";
    return base;
  }

  function readState(): {
    cursors: Record<string, { created_at?: string; id?: string }>;
  } {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  }

  beforeEach(async () => {
    applyDbEnv(DB_URL as string);
    // Defend against a PRIOR crashed test leaving residue that a namespace-wide
    // scan (nominatedTableRows has no namespace filter) would re-pick up.
    await cleanupNs();
    // DEV_TMP (macOS dev) when set; otherwise the OS temp dir so this runs on
    // the Linux CI runner (the Mac /Volumes path does not exist there).
    tmpDir = mkdtempSync(
      join(process.env.DEV_TMP ?? tmpdir(), "promote-lane-shared-"),
    );
    stateFile = join(tmpDir, "state.json");
  });

  afterEach(async () => {
    await cleanupNs();
    restoreDbEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await pool.end();
  });

  test("events loop: trailing manual-review event does NOT pin the cursor", async () => {
    const laneId = await seedLane();
    // share event first (earlier), manual-review event last (trailing).
    await seedEvent(laneId, SHARE_CONTENT, "2026-01-01T00:00:00Z");
    const manualId = await seedEvent(
      laneId,
      MANUAL_REVIEW_CONTENT,
      "2026-01-02T00:00:00Z",
    );

    // First APPLY run: both rows processed, cursor must advance PAST the
    // trailing manual-review row even though manual-review is not promoted.
    const first = await runSharedPromoter(makeArgs(true));
    const eventsReceipt1 = first.sources.ob_session_events;
    expect(eventsReceipt1).toBeDefined();
    expect(eventsReceipt1!.scanned).toBe(2);
    expect(eventsReceipt1!.shared).toBe(1);
    expect(eventsReceipt1!.manual_review).toBe(1);

    // Cursor now sits on the manual-review row (the last processed row).
    const cursor1 = readState().cursors.ob_session_events;
    expect(cursor1?.id).toBe(manualId);

    // Second APPLY run: the manual-review row keeps its share_candidate flag
    // (only terminal rejects clear it), so without the cursor fix it would be
    // re-scanned forever. With the fix, the cursor is past it → scanned 0.
    const second = await runSharedPromoter(makeArgs(true));
    const eventsReceipt2 = second.sources.ob_session_events;
    // Either no events source recorded, or scanned excludes the pinned row.
    expect(eventsReceipt2?.scanned ?? 0).toBe(0);
  });

  test("events loop: a deterministically-failing event does NOT pin the cursor (poison-pill fix)", async () => {
    // Poison-pill regression (Issue #161 hardening): in APPLY mode, when a row's
    // promotion throws inside the try/catch, the loop now advances the cursor
    // PAST the failed row before `break`-ing. Without that fix the cursor stays
    // pinned on the failing row, so it (and every row behind it) is re-fetched
    // on every subsequent run forever.
    //
    // FAILURE INJECTION: shareEventToSharedKb does `INSERT INTO thoughts ...`.
    // The thoughts schema offers no constraint the runner's own write violates
    // (the only unique index, (content_hash, namespace), is absorbed by the
    // INSERT's ON CONFLICT DO NOTHING). So we install a temporary BEFORE INSERT
    // trigger on `thoughts` that RAISEs only when content carries a sentinel
    // marker. This is a real, deterministic, server-side INSERT failure that the
    // runner cannot anticipate — exactly the poison-pill shape. The trigger is
    // test-managed and dropped in this test's finally block.
    const POISON = `POISON-${Date.now()} `;
    const poisonContent = POISON + SHARE_CONTENT; // share-worthy, but insert throws.

    await pool.query(`
      CREATE OR REPLACE FUNCTION test_poison_thought_insert()
      RETURNS trigger AS $fn$
      BEGIN
        IF position('${POISON.trim()}' IN NEW.content) > 0 THEN
          RAISE EXCEPTION 'poison-pill: deterministic insert failure';
        END IF;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;
    `);
    await pool.query(`
      DROP TRIGGER IF EXISTS test_poison_thought_trg ON thoughts;
      CREATE TRIGGER test_poison_thought_trg
        BEFORE INSERT ON thoughts
        FOR EACH ROW EXECUTE FUNCTION test_poison_thought_insert();
    `);

    try {
      const laneId = await seedLane();
      // First (earlier) event is the poison row that will throw on insert.
      const poisonId = await seedEvent(
        laneId,
        poisonContent,
        "2026-07-01T00:00:00Z",
      );
      // Second (later) event is clean and share-worthy.
      const cleanId = await seedEvent(
        laneId,
        SHARE_CONTENT,
        "2026-07-02T00:00:00Z",
      );

      // First APPLY run: poison row is scanned, classified share, then its
      // shared-kb insert throws. The sweep breaks AFTER advancing the cursor.
      const first = await runSharedPromoter(makeArgs(true));
      const events1 = first.sources.ob_session_events;
      expect(events1).toBeDefined();
      expect(events1!.scanned).toBe(1); // breaks after the failing row
      expect(events1!.failed).toBe(1);
      expect(events1!.shared).toBe(0);
      // Failure recorded for human follow-up, pinned to the poison row.
      const failure = first.failures.find((f) => f.id === poisonId);
      expect(failure).toBeDefined();
      expect(failure!.source).toBe("ob_session_events");

      // KEY ASSERTION 1: cursor advanced PAST the failed row (not pinned).
      const cursor1 = readState().cursors.ob_session_events;
      expect(cursor1?.id).toBe(poisonId);

      // Second APPLY run: forward progress. The poison row's nomination flag is
      // intentionally left set, but the cursor is now past it, so the runner
      // does NOT re-fetch it — it reaches the clean row and shares it.
      const second = await runSharedPromoter(makeArgs(true));
      const events2 = second.sources.ob_session_events;
      expect(events2).toBeDefined();
      // KEY ASSERTION 2: the poison row is NOT re-scanned; only the clean row is.
      expect(events2!.scanned).toBe(1);
      expect(events2!.failed).toBe(0);
      expect(events2!.shared).toBe(1);
      const cursor2 = readState().cursors.ob_session_events;
      expect(cursor2?.id).toBe(cleanId);
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS test_poison_thought_trg ON thoughts",
      );
      await pool.query(
        "DROP FUNCTION IF EXISTS test_poison_thought_insert()",
      );
    }
  });

  test("thoughts loop: trailing manual-review thought does NOT pin the cursor", async () => {
    await seedThought(SHARE_CONTENT, "2026-03-01T00:00:00Z");
    const manualId = await seedThought(
      MANUAL_REVIEW_CONTENT,
      "2026-03-02T00:00:00Z",
    );

    const first = await runSharedPromoter(makeArgs(true));
    const thoughtsReceipt1 = first.sources.thoughts;
    expect(thoughtsReceipt1).toBeDefined();
    expect(thoughtsReceipt1!.scanned).toBe(2);
    expect(thoughtsReceipt1!.manual_review).toBe(1);

    const cursor1 = readState().cursors.thoughts;
    expect(cursor1?.id).toBe(manualId);

    const second = await runSharedPromoter(makeArgs(true));
    expect(second.sources.thoughts?.scanned ?? 0).toBe(0);
  });

  test("dry-run does NOT call the embedding endpoint for events", async () => {
    // The events loop returns would_share BEFORE generateEmbedding when !apply.
    // To prove the embedding endpoint is not hit, point EMBEDDING_BASE_URL at an
    // unreachable host: a real generateEmbedding call would error or block on
    // connect. A clean dry-run with would_share>0 and no failures proves the
    // embedding call was structurally skipped (the only network call in this
    // loop is the embedding endpoint). DB connectivity is unaffected because the
    // runner's pool uses DB_HOST, not EMBEDDING_BASE_URL.
    const laneId = await seedLane();
    await seedEvent(laneId, SHARE_CONTENT, "2026-05-01T00:00:00Z");

    const savedEmbedUrl = process.env.EMBEDDING_BASE_URL;
    // 192.0.2.0/24 is TEST-NET-1 (RFC 5737) — guaranteed non-routable.
    process.env.EMBEDDING_BASE_URL = "http://192.0.2.1:1/v1";
    try {
      const receipt = await runSharedPromoter(makeArgs(false));
      expect(receipt.dry_run).toBe(true);
      const events = receipt.sources.ob_session_events;
      expect(events).toBeDefined();
      expect(events!.would_share).toBe(1);
      // No write and no embedding-driven failure occurred.
      expect(events!.shared).toBe(0);
      expect(events!.failed).toBe(0);
      expect(receipt.failures.length).toBe(0);
    } finally {
      if (savedEmbedUrl === undefined) delete process.env.EMBEDDING_BASE_URL;
      else process.env.EMBEDDING_BASE_URL = savedEmbedUrl;
    }

    // Dry-run must NOT advance the persistent cursor (it only counts).
    const cursor = readState().cursors.ob_session_events;
    expect(cursor?.id).toBeUndefined();
  });
});
