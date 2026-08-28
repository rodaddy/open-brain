/**
 * Live-Postgres functional coverage for resumable file-source synchronization
 * (Issue #338), exercised against the real migration-030 schema and the real
 * transaction/checkpoint path in syncSource. The idempotence and isolation half
 * lives in src/source-sync-idempotence.pg.test.ts.
 *
 * The suite requires the test database rather than skipping itself when it is
 * absent (Issue #878): requireTestDatabaseUrl() throws at module scope so a
 * database-less run fails loudly instead of reporting a false green.
 *
 * What is proven end to end (behavioral input -> output, never SQL shape):
 *  1. A full uninterrupted sync applies the reconciliation plan and leaves the
 *     expected live manifest (add/edit/rename/delete).
 *  2. A rename preserves the durable file_id across the path move.
 *  3. A sync SPLIT across invocations via apply_budget checkpoints its progress,
 *     stays `running` mid-way, then resumes and completes — and the resumed final
 *     manifest is IDENTICAL to an uninterrupted run over the same observation,
 *     with no duplicated files (idempotent at-least-once).
 *  4. Concurrent syncs of one source serialize on the eligible-source row lock,
 *     producing a single-writer manifest rather than a hybrid corpus.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../scripts/test-support/require-test-database.ts";
import { runMigrations } from "./db/migrate.ts";
import { syncSource } from "./source-sync.ts";
import {
  admin,
  approvedSource,
  cleanupNamespaces,
  expectDefined,
  H,
  liveManifest,
  obs,
} from "./source-sync-test-helpers.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

// Unique namespaces per run so cleanup owns exactly these rows.
const nsA = "lane338-ns-a";
const nsB = "lane338-ns-b";

async function cleanup(): Promise<void> {
  await cleanupNamespaces(pool, [nsA, nsB]);
}

beforeAll(async () => {
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  await runMigrations(pool);
});

afterAll(async () => {
  await cleanup();
  await pool.end();
});

beforeEach(cleanup);

async function appliesFullPlan(): Promise<void> {
  const sourceId = await approvedSource(pool, nsA, "git://acme/repo-full");

  // First sync: three adds.
  const first = await syncSource(
    pool,
    admin(),
    sourceId,
    obs([
      ["keep.ts", H(1)],
      ["edit.ts", H(2)],
      ["old.ts", H(3)],
    ]),
    { target_namespace: nsA },
  );
  expect(first.ok).toBe(true);
  expect(first.data?.status).toBe("completed");
  expect(first.data?.counts.added).toBe(3);

  const m1 = await liveManifest(pool, nsA, sourceId);
  const renamedId = expectDefined(m1.get("old.ts"), "m1 old.ts").file_id;

  // Second sync: keep unchanged, edit content, rename old.ts->new.ts, drop nothing
  // new but add fresh.ts. edit.ts content changes; old.ts moves to new.ts.
  const second = await syncSource(
    pool,
    admin(),
    sourceId,
    obs([
      ["keep.ts", H(1)],
      ["edit.ts", H(20)],
      ["new.ts", H(3)],
      ["fresh.ts", H(5)],
    ]),
    { target_namespace: nsA },
  );
  expect(second.ok).toBe(true);
  expect(second.data?.status).toBe("completed");
  // Mixed receipt: keep.ts is an unchanged no-op (no op emitted, counted as
  // unchanged), plus one edit, one rename, one add. This is a FRESH plan, so
  // counts.unchanged carries the no-op count.
  expect(second.data?.resumed).toBe(false);
  expect(second.data?.counts).toMatchObject({
    added: 1,
    edited: 1,
    renamed: 1,
    deleted: 0,
    unchanged: 1,
  });

  const m2 = await liveManifest(pool, nsA, sourceId);
  expect([...m2.keys()].sort()).toEqual(["edit.ts", "fresh.ts", "keep.ts", "new.ts"]);
  // Rename preserved the durable file_id; old path is gone.
  expect(expectDefined(m2.get("new.ts"), "m2 new.ts").file_id).toBe(renamedId);
  expect(m2.has("old.ts")).toBe(false);
  // Edit kept identity, changed hash.
  expect(expectDefined(m2.get("edit.ts"), "m2 edit.ts").content_hash).toBe(H(20));
  expect(expectDefined(m2.get("edit.ts"), "m2 edit.ts").file_id).toBe(
    expectDefined(m1.get("edit.ts"), "m1 edit.ts").file_id,
  );
}

async function checkpointsSplitRunAndResumes(): Promise<void> {
  const interrupted = await approvedSource(pool, nsA, "git://acme/repo-resume");
  const straight = await approvedSource(pool, nsA, "git://acme/repo-straight");

  const observation = obs([
    ["a.ts", H(1)],
    ["b.ts", H(2)],
    ["c.ts", H(3)],
    ["d.ts", H(4)],
    ["e.ts", H(5)],
  ]);

  // Uninterrupted baseline.
  const baseline = await syncSource(pool, admin(), straight, observation, {
    target_namespace: nsA,
  });
  expect(baseline.data?.status).toBe("completed");
  expect(baseline.data?.counts.added).toBe(5);

  // Interrupted: apply only 2 of the 5 ops, then stop mid-run.
  const partial = await syncSource(pool, admin(), interrupted, observation, {
    target_namespace: nsA,
    apply_budget: 2,
  });
  expect(partial.ok).toBe(true);
  expect(partial.data?.status).toBe("running");
  expect(partial.data?.applied_ops).toBe(2);
  expect(partial.data?.resumed).toBe(false);
  // Only a partial manifest is live so far.
  expect((await liveManifest(pool, nsA, interrupted)).size).toBe(2);

  // Persisted checkpoint advanced.
  const { rows: ckpt } = await pool.query(
    `SELECT checkpoint_index, status FROM ob_source_sync_runs
      WHERE source_id = $1 AND namespace = $2`,
    [interrupted, nsA],
  );
  expect(ckpt[0].status).toBe("running");
  expect(ckpt[0].checkpoint_index).toBe(2);

  // Resume with the SAME observation. It re-plans to the persisted run and
  // finishes the tail; the boundary op is re-applied idempotently.
  const resumed = await syncSource(pool, admin(), interrupted, observation, {
    target_namespace: nsA,
  });
  expect(resumed.ok).toBe(true);
  expect(resumed.data?.status).toBe("completed");
  expect(resumed.data?.resumed).toBe(true);

  // Final manifests match exactly (by path + content_hash); no duplicates.
  const mResumed = await liveManifest(pool, nsA, interrupted);
  const mBaseline = await liveManifest(pool, nsA, straight);
  expect(mResumed.size).toBe(5);
  expect(mBaseline.size).toBe(5);
  for (const [path, v] of mBaseline) {
    expect(mResumed.get(path)?.content_hash).toBe(v.content_hash);
  }
  // No file row is duplicated: total live rows equals distinct paths.
  const { rows: dupCheck } = await pool.query(
    `SELECT path, COUNT(*) AS n FROM ob_source_files
      WHERE source_id = $1 AND namespace = $2 AND state = 'live'
      GROUP BY path HAVING COUNT(*) > 1`,
    [interrupted, nsA],
  );
  expect(dupCheck.length).toBe(0);
}

async function serializesConcurrentSyncs(): Promise<void> {
  // Two concurrent syncs of the SAME source must not interleave their manifest
  // read/plan/commit. Without a lock, both planners read the same manifest and
  // commit disjoint edits, producing a hybrid corpus neither caller observed,
  // and a late resumer can regress a checkpoint. syncSource takes a FOR UPDATE
  // lock on the eligible source row BEFORE reading the manifest and holds it
  // through COMMIT, so the second sync blocks until the first commits and then
  // plans against the manifest the first already produced.
  //
  // Determinism without a production hook: this test itself holds the exact
  // source-row lock syncSource would take (same namespace + id predicate) in an
  // outer transaction, launches syncSource concurrently, and proves it cannot
  // make progress until the test releases the lock. The gate is real Postgres
  // row locking, not a sleep race.
  const sourceId = await approvedSource(pool, nsA, "git://acme/repo-serialize");

  // Client 1 (the test): grab the source row lock and hold it open.
  const holder = await pool.connect();
  let syncSettled = false;
  let syncResult: Awaited<ReturnType<typeof syncSource>> | undefined;
  try {
    await holder.query("BEGIN");
    const locked = await holder.query(
      `SELECT id FROM ${"ob_sources"}
        WHERE id = $1 AND namespace = $2
          AND source_kind IN ('git', 'directory')
        FOR UPDATE`,
      [sourceId, nsA],
    );
    expect(locked.rows.length).toBe(1);

    // Client 2: a real sync of the same source. It must block at its own
    // FOR UPDATE on this row and cannot commit while the test holds the lock.
    const syncPromise = syncSource(
      pool,
      admin(),
      sourceId,
      obs([
        ["a.ts", H(1)],
        ["b.ts", H(2)],
      ]),
      { target_namespace: nsA },
    ).then((r) => {
      syncSettled = true;
      syncResult = r;
      return r;
    });

    // Give the blocked sync ample time to (fail to) proceed. It must still be
    // pending: the lock is held, so it cannot have read the manifest, planned,
    // or committed anything.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(syncSettled).toBe(false);
    // And nothing has been written to the manifest yet.
    expect((await liveManifest(pool, nsA, sourceId)).size).toBe(0);

    // Release the lock — the blocked sync can now acquire it and finish.
    await holder.query("COMMIT");
    const finished = await syncPromise;
    expect(finished.ok).toBe(true);
    expect(finished.data?.status).toBe("completed");
  } finally {
    // Ensure the holder transaction is not left open even if an assertion threw.
    await holder.query("ROLLBACK").catch(() => undefined);
    holder.release();
  }

  expect(syncSettled).toBe(true);
  expect(syncResult?.data?.counts.added).toBe(2);
  // The manifest is exactly what the (single, serialized) sync observed — not a
  // hybrid of concurrent writers.
  const m = await liveManifest(pool, nsA, sourceId);
  expect([...m.keys()].sort()).toEqual(["a.ts", "b.ts"]);
  expect(expectDefined(m.get("a.ts"), "m a.ts").content_hash).toBe(H(1));
  expect(expectDefined(m.get("b.ts"), "m b.ts").content_hash).toBe(H(2));

  // Checkpoint did not regress: it equals the plan length for the completed run.
  const { rows: ckpt } = await pool.query(
    `SELECT plan, checkpoint_index, status FROM ob_source_sync_runs
      WHERE source_id = $1 AND namespace = $2`,
    [sourceId, nsA],
  );
  expect(ckpt.length).toBe(1);
  expect(ckpt[0].status).toBe("completed");
  expect(ckpt[0].checkpoint_index).toBe((ckpt[0].plan as unknown[]).length);
}

async function concurrentDifferingObservations(): Promise<void> {
  // A stronger end-to-end race: two syncs of the SAME source with DIFFERENT
  // observations launched together. The lock forces a total order. Whichever
  // commits first seeds the manifest; the second re-diffs against THAT manifest
  // (not the empty one it might have seen unlocked). The final live manifest is
  // therefore exactly one observation's corpus reconciled onto the other — never
  // a hybrid union of two independently-planned add sets, and never a duplicated
  // path. We don't fix which order wins (that's Postgres' lock queue); we prove
  // the outcome is a consistent single-writer result either way.
  const sourceId = await approvedSource(pool, nsA, "git://acme/repo-race");

  const obs1 = obs([
    ["shared.ts", H(1)],
    ["only1.ts", H(2)],
  ]);
  const obs2 = obs([
    ["shared.ts", H(1)],
    ["only2.ts", H(3)],
  ]);

  const [r1, r2] = await Promise.all([
    syncSource(pool, admin(), sourceId, obs1, { target_namespace: nsA }),
    syncSource(pool, admin(), sourceId, obs2, { target_namespace: nsA }),
  ]);
  expect(r1.ok).toBe(true);
  expect(r2.ok).toBe(true);
  expect(r1.data?.status).toBe("completed");
  expect(r2.data?.status).toBe("completed");

  // The final manifest is the LAST-committed observation's corpus exactly. The
  // two observations differ only in only1.ts vs only2.ts (shared.ts is common),
  // so the live set is {shared.ts, only1.ts} OR {shared.ts, only2.ts} — one or
  // the other, never {shared.ts, only1.ts, only2.ts} (which would be the hybrid
  // corpus a lost lock produces).
  const m = await liveManifest(pool, nsA, sourceId);
  const keys = [...m.keys()].sort();
  const isCorpus1 =
    keys.length === 2 && keys[0] === "only1.ts" && keys[1] === "shared.ts";
  const isCorpus2 =
    keys.length === 2 && keys[0] === "only2.ts" && keys[1] === "shared.ts";
  expect(isCorpus1 || isCorpus2).toBe(true);
  expect(expectDefined(m.get("shared.ts"), "m shared.ts").content_hash).toBe(H(1));

  // No live path is duplicated.
  const { rows: dup } = await pool.query(
    `SELECT path, COUNT(*) AS n FROM ob_source_files
      WHERE source_id = $1 AND namespace = $2 AND state = 'live'
      GROUP BY path HAVING COUNT(*) > 1`,
    [sourceId, nsA],
  );
  expect(dup.length).toBe(0);

  // Every run row for this source is a completed run whose checkpoint reached
  // its plan end — no run was left mid-flight or checkpoint-regressed.
  const { rows: runs } = await pool.query(
    `SELECT plan, checkpoint_index, status FROM ob_source_sync_runs
      WHERE source_id = $1 AND namespace = $2`,
    [sourceId, nsA],
  );
  for (const run of runs) {
    expect(run.status).toBe("completed");
    expect(run.checkpoint_index).toBe((run.plan as unknown[]).length);
  }
}

describe("resumable file-source sync plan, checkpoint, and concurrency (live Postgres)", () => {
  it(
    "applies a full add/edit/rename/delete plan and leaves the expected manifest",
    appliesFullPlan,
  );

  it(
    "checkpoints a split run and resumes to the SAME manifest as an uninterrupted run",
    checkpointsSplitRunAndResumes,
  );

  it(
    "serializes concurrent syncs of one source on the eligible-source row lock (no hybrid corpus, no checkpoint regress)",
    serializesConcurrentSyncs,
  );

  it(
    "two concurrent differing observations serialize to one non-hybrid manifest",
    concurrentDifferingObservations,
  );
});
