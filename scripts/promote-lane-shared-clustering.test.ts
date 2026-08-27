import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { runSharedPromoter } from "./promote-lane-shared.ts";
import { requireTestDatabaseUrl } from "./test-support/require-test-database.ts";
import {
  createPromoterHarness,
  expectDefined,
  MANUAL_REVIEW_CONTENT,
  SHARE_CONTENT,
  NEW_VEC,
  IN_BAND_VEC,
  FAR_VEC,
  DUP_VEC,
} from "./test-support/promote-lane-shared-helpers.ts";

// ── Thought-cluster supplementation (#173) and the cursor loops ──
//
// These drive the THOUGHTS promoteEntry path with DETERMINISTIC embeddings so
// the cosine distance between a promoted thought and a seeded shared-kb anchor
// is exact and controllable -- no embedding server needed. promoteEntry copies
// the source thought's `embedding` column verbatim into the shared-kb copy, so
// the promoted row's vector equals the source vector seeded here.
//
// Per issue #878 this file DEMANDS the test database rather than skipping
// itself when the variable is absent.
const databaseUrl = requireTestDatabaseUrl();
const pool = new Pool({ connectionString: databaseUrl });

describe("runSharedPromoter clustering and cursor loops (live Postgres)", () => {
  const h = createPromoterHarness(pool, databaseUrl);
  let tmpDir: string;
  let stateFile: string;

  test("clustering: in-band neighbour gets a 'supplements' link to the anchor", async () => {
    await clusteringInBandLinks(h, stateFile);
  });

  test("clustering: no in-band neighbour creates NO link (orphan cluster seed)", async () => {
    await h.seedSharedAnchor(
      "Distant shared anchor, different topic entirely.",
      FAR_VEC,
    );
    await h.seedThoughtWithEmbedding(SHARE_CONTENT, "2026-08-02T00:00:00Z", NEW_VEC);

    const receipt = await runSharedPromoter(h.makeArgs(true, stateFile));
    expect(
      expectDefined(receipt.sources.thoughts, "receipt.sources.thoughts").shared,
    ).toBe(1);
    expect(
      expectDefined(receipt.sources.thoughts, "receipt.sources.thoughts").clustered,
    ).toBe(0);
    expect(receipt.clustered).toBe(0);

    const { rows: copies } = await pool.query(
      `SELECT id FROM thoughts WHERE namespace = $1 AND content = $2`,
      [h.ns + "-shared", SHARE_CONTENT],
    );
    const links = await h.supplementsLinks(copies[0].id);
    expect(links.length).toBe(0);
  });

  test("clustering: an exact/near-dup neighbour (dist < 0.08) is NOT clustered", async () => {
    await clusteringDupNotClustered(h, stateFile);
  });

  test("clustering: dry-run creates NO link even with an in-band neighbour", async () => {
    await h.seedSharedAnchor("Dry-run anchor that would be in band.", IN_BAND_VEC);
    const srcId = await h.seedThoughtWithEmbedding(
      SHARE_CONTENT,
      "2026-08-04T00:00:00Z",
      NEW_VEC,
    );

    const receipt = await runSharedPromoter(h.makeArgs(false, stateFile));
    expect(receipt.dry_run).toBe(true);
    expect(
      expectDefined(receipt.sources.thoughts, "receipt.sources.thoughts").would_share,
    ).toBe(1);
    expect(receipt.clustered).toBe(0);

    // No promoted copy and therefore no link of any kind was created.
    const { rows: copies } = await pool.query(
      `SELECT id FROM thoughts WHERE namespace = $1 AND content = $2`,
      [h.ns + "-shared", SHARE_CONTENT],
    );
    expect(copies.length).toBe(0);
    // And no supplements link from the (un-promoted) source either.
    const links = await h.supplementsLinks(srcId);
    expect(links.length).toBe(0);
  });

  test("events loop: trailing manual-review event does NOT pin the cursor", async () => {
    await eventsTrailingManualReview(h, stateFile);
  });

  test("events loop: a deterministically-failing event does NOT pin the cursor (poison-pill fix)", async () => {
    await eventsPoisonPill(h, stateFile);
  });

  test("thoughts loop: trailing manual-review thought does NOT pin the cursor", async () => {
    await h.seedThought(SHARE_CONTENT, "2026-03-01T00:00:00Z");
    const manualId = await h.seedThought(MANUAL_REVIEW_CONTENT, "2026-03-02T00:00:00Z");

    const first = await runSharedPromoter(h.makeArgs(true, stateFile));
    const thoughtsReceipt1 = first.sources.thoughts;
    expect(thoughtsReceipt1).toBeDefined();
    expect(expectDefined(thoughtsReceipt1, "thoughtsReceipt1").scanned).toBe(2);
    expect(expectDefined(thoughtsReceipt1, "thoughtsReceipt1").manual_review).toBe(1);

    const cursor1 = h.readState(stateFile).cursors.thoughts;
    expect(cursor1?.id).toBe(manualId);

    const second = await runSharedPromoter(h.makeArgs(true, stateFile));
    expect(second.sources.thoughts?.scanned ?? 0).toBe(0);
  });

  test("dry-run does NOT call the embedding endpoint for events", async () => {
    await dryRunSkipsEmbedding(h, stateFile);
  });

  beforeEach(async () => {
    h.applyDbEnv();
    await h.cleanupNs();
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

type Harness = ReturnType<typeof createPromoterHarness>;

async function eventsTrailingManualReview(
  h: Harness,
  stateFile: string,
): Promise<void> {
  const laneId = await h.seedLane();
  // share event first (earlier), manual-review event last (trailing).
  await h.seedEvent(laneId, SHARE_CONTENT, "2026-01-01T00:00:00Z");
  const manualId = await h.seedEvent(
    laneId,
    MANUAL_REVIEW_CONTENT,
    "2026-01-02T00:00:00Z",
  );

  // First APPLY run: both rows processed, cursor must advance PAST the
  // trailing manual-review row even though manual-review is not promoted.
  const first = await runSharedPromoter(h.makeArgs(true, stateFile));
  const eventsReceipt1 = first.sources.ob_session_events;
  expect(eventsReceipt1).toBeDefined();
  expect(expectDefined(eventsReceipt1, "eventsReceipt1").scanned).toBe(2);
  expect(expectDefined(eventsReceipt1, "eventsReceipt1").shared).toBe(1);
  expect(expectDefined(eventsReceipt1, "eventsReceipt1").manual_review).toBe(1);

  // Cursor now sits on the manual-review row (the last processed row).
  const cursor1 = h.readState(stateFile).cursors.ob_session_events;
  expect(cursor1?.id).toBe(manualId);

  // Second APPLY run: the manual-review row keeps its share_candidate flag
  // (only terminal rejects clear it), so without the cursor fix it would be
  // re-scanned forever. With the fix, the cursor is past it → scanned 0.
  const second = await runSharedPromoter(h.makeArgs(true, stateFile));
  const eventsReceipt2 = second.sources.ob_session_events;
  // Either no events source recorded, or scanned excludes the pinned row.
  expect(eventsReceipt2?.scanned ?? 0).toBe(0);
}

async function eventsPoisonPill(h: Harness, stateFile: string): Promise<void> {
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
    const laneId = await h.seedLane();
    // First (earlier) event is the poison row that will throw on insert.
    const poisonId = await h.seedEvent(laneId, poisonContent, "2026-07-01T00:00:00Z");
    // Second (later) event is clean and share-worthy.
    const cleanId = await h.seedEvent(laneId, SHARE_CONTENT, "2026-07-02T00:00:00Z");

    // First APPLY run: poison row is scanned, classified share, then its
    // shared-kb insert throws. The sweep breaks AFTER advancing the cursor.
    const first = await runSharedPromoter(h.makeArgs(true, stateFile));
    const events1 = first.sources.ob_session_events;
    expect(events1).toBeDefined();
    expect(expectDefined(events1, "events1").scanned).toBe(1); // breaks after the failing row
    expect(expectDefined(events1, "events1").failed).toBe(1);
    expect(expectDefined(events1, "events1").shared).toBe(0);
    // Failure recorded for human follow-up, pinned to the poison row.
    const failure = first.failures.find((f) => f.id === poisonId);
    expect(failure).toBeDefined();
    expect(expectDefined(failure, "failure").source).toBe("ob_session_events");

    // KEY ASSERTION 1: cursor advanced PAST the failed row (not pinned).
    const cursor1 = h.readState(stateFile).cursors.ob_session_events;
    expect(cursor1?.id).toBe(poisonId);

    // Second APPLY run: forward progress. The poison row's nomination flag is
    // intentionally left set, but the cursor is now past it, so the runner
    // does NOT re-fetch it — it reaches the clean row and shares it.
    const second = await runSharedPromoter(h.makeArgs(true, stateFile));
    const events2 = second.sources.ob_session_events;
    expect(events2).toBeDefined();
    // KEY ASSERTION 2: the poison row is NOT re-scanned; only the clean row is.
    expect(expectDefined(events2, "events2").scanned).toBe(1);
    expect(expectDefined(events2, "events2").failed).toBe(0);
    expect(expectDefined(events2, "events2").shared).toBe(1);
    const cursor2 = h.readState(stateFile).cursors.ob_session_events;
    expect(cursor2?.id).toBe(cleanId);
  } finally {
    await pool.query("DROP TRIGGER IF EXISTS test_poison_thought_trg ON thoughts");
    await pool.query("DROP FUNCTION IF EXISTS test_poison_thought_insert()");
  }
}

async function dryRunSkipsEmbedding(h: Harness, stateFile: string): Promise<void> {
  // The events loop returns would_share BEFORE generateEmbedding when !apply.
  // To prove the embedding endpoint is not hit, point EMBEDDING_BASE_URL at an
  // unreachable host: a real generateEmbedding call would error or block on
  // connect. A clean dry-run with would_share>0 and no failures proves the
  // embedding call was structurally skipped (the only network call in this
  // loop is the embedding endpoint). DB connectivity is unaffected because the
  // runner's pool uses DB_HOST, not EMBEDDING_BASE_URL.
  const laneId = await h.seedLane();
  await h.seedEvent(laneId, SHARE_CONTENT, "2026-05-01T00:00:00Z");

  const savedEmbedUrl = process.env.EMBEDDING_BASE_URL;
  // 192.0.2.0/24 is TEST-NET-1 (RFC 5737) — guaranteed non-routable.
  process.env.EMBEDDING_BASE_URL = "http://192.0.2.1:1/v1";
  try {
    const receipt = await runSharedPromoter(h.makeArgs(false, stateFile));
    expect(receipt.dry_run).toBe(true);
    const events = receipt.sources.ob_session_events;
    expect(events).toBeDefined();
    expect(expectDefined(events, "events").would_share).toBe(1);
    // No write and no embedding-driven failure occurred.
    expect(expectDefined(events, "events").shared).toBe(0);
    expect(expectDefined(events, "events").failed).toBe(0);
    expect(receipt.failures.length).toBe(0);
  } finally {
    if (savedEmbedUrl === undefined) delete process.env.EMBEDDING_BASE_URL;
    else process.env.EMBEDDING_BASE_URL = savedEmbedUrl;
  }

  // Dry-run must NOT advance the persistent cursor (it only counts).
  const cursor = h.readState(stateFile).cursors.ob_session_events;
  expect(cursor?.id).toBeUndefined();
}

async function clusteringInBandLinks(h: Harness, stateFile: string): Promise<void> {
  const anchorId = await h.seedSharedAnchor(
    "Existing shared cluster anchor about schema.",
    IN_BAND_VEC,
  );
  await h.seedThoughtWithEmbedding(SHARE_CONTENT, "2026-08-01T00:00:00Z", NEW_VEC);

  const receipt = await runSharedPromoter(h.makeArgs(true, stateFile));
  const thoughts = receipt.sources.thoughts;
  expect(thoughts).toBeDefined();
  expect(expectDefined(thoughts, "thoughts").shared).toBe(1);
  expect(expectDefined(thoughts, "thoughts").clustered).toBe(1);
  expect(receipt.clustered).toBe(1);

  // Find the promoted copy in the shared ns and assert the supplements edge.
  const { rows: copies } = await pool.query(
    `SELECT id FROM thoughts
        WHERE namespace = $1 AND content = $2`,
    [h.ns + "-shared", SHARE_CONTENT],
  );
  expect(copies.length).toBe(1);
  const links = await h.supplementsLinks(copies[0].id);
  expect(links.length).toBe(1);
  const link = expectDefined(links[0], "links[0]");
  expect(link.to_id).toBe(anchorId);
  expect(link.metadata.auto_clustered).toBe(true);
  expect(Number(link.metadata.distance)).toBeCloseTo(0.15, 2);
}

async function clusteringDupNotClustered(h: Harness, stateFile: string): Promise<void> {
  // The anchor is within the dedup band (distance 0.04). Dedup here is
  // content_hash-only, so promoteEntry still promotes the new row, but
  // clustering must SKIP linking because it sits below EXACT_DUP_THRESHOLD.
  await h.seedSharedAnchor("Near-duplicate shared anchor close in space.", DUP_VEC);
  await h.seedThoughtWithEmbedding(SHARE_CONTENT, "2026-08-03T00:00:00Z", NEW_VEC);

  const receipt = await runSharedPromoter(h.makeArgs(true, stateFile));
  expect(
    expectDefined(receipt.sources.thoughts, "receipt.sources.thoughts").shared,
  ).toBe(1);
  expect(
    expectDefined(receipt.sources.thoughts, "receipt.sources.thoughts").clustered,
  ).toBe(0);

  const { rows: copies } = await pool.query(
    `SELECT id FROM thoughts WHERE namespace = $1 AND content = $2`,
    [h.ns + "-shared", SHARE_CONTENT],
  );
  const links = await h.supplementsLinks(copies[0].id);
  expect(links.length).toBe(0);
}
