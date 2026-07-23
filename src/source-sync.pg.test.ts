/**
 * Live-Postgres functional coverage for resumable file-source synchronization
 * (Issue #338), exercised against the real migration-030 schema and the real
 * transaction/checkpoint path in syncSource.
 *
 * Gated on OPENBRAIN_TEST_DATABASE_URL (repo convention): skips when unset so a
 * DB-less run passes, while the CI db-integration job runs it against Postgres.
 *
 * What is proven end to end (behavioral input -> output, never SQL shape):
 *  1. A full uninterrupted sync applies the reconciliation plan and leaves the
 *     expected live manifest (add/edit/rename/delete).
 *  2. A rename preserves the durable file_id across the path move.
 *  3. A sync SPLIT across invocations via apply_budget checkpoints its progress,
 *     stays `running` mid-way, then resumes and completes — and the resumed final
 *     manifest is IDENTICAL to an uninterrupted run over the same observation,
 *     with no duplicated files (idempotent at-least-once).
 *  4. Re-running a completed sync over the same observation is a no-op.
 *  5. Namespace isolation: two namespaces that registered the same external
 *     location keep entirely separate manifests; a sync in one never touches the
 *     other.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import type { Pool } from "pg";
import { runMigrations } from "./db/migrate.ts";
import { registerSource, updateSource } from "./source-registry.ts";
import {
  observationHash,
  syncSource,
  type SourceObservation,
} from "./source-sync.ts";
import type { AuthInfo } from "./types.ts";

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;

const H = (n: number): string => n.toString(16).padStart(64, "0");

function obs(files: Array<[string, string]>): SourceObservation {
  return {
    files: files.map(([path, content_hash]) => ({ path, content_hash })),
  };
}

// A token-sourced admin identity: can register+approve and write any namespace.
function admin(): AuthInfo {
  return { role: "admin", clientId: "lane338-admin", namespaceSource: "token" };
}

dbDescribe("resumable file-source sync (live Postgres)", () => {
  let pool: Pool;
  // Unique namespaces per run so cleanup owns exactly these rows.
  const nsA = "lane338-ns-a";
  const nsB = "lane338-ns-b";

  beforeAll(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: DB_URL });
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await runMigrations(pool);
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  async function cleanup(): Promise<void> {
    // Sync-run and manifest rows FK-cascade from ob_sources; deleting the source
    // rows this suite created clears everything it owns in both namespaces.
    await pool.query(
      "DELETE FROM ob_sources WHERE namespace = ANY($1::text[])",
      [[nsA, nsB]],
    );
  }

  beforeEach(cleanup);

  /** Register + approve a git source in `namespace`, returning its id. */
  async function approvedSource(
    namespace: string,
    externalId: string,
  ): Promise<string> {
    const reg = await registerSource(pool, admin(), {
      source_kind: "git",
      external_id: externalId,
      target_namespace: namespace,
      approved: true,
    });
    if (!reg.ok || !reg.data) throw new Error("register failed");
    return reg.data.id;
  }

  /** The live manifest (path -> {file_id, content_hash}) for a source. */
  async function liveManifest(
    namespace: string,
    sourceId: string,
  ): Promise<Map<string, { file_id: string; content_hash: string }>> {
    const { rows } = await pool.query(
      `SELECT file_id, path, content_hash FROM ob_source_files
        WHERE source_id = $1 AND namespace = $2 AND state = 'live'`,
      [sourceId, namespace],
    );
    const out = new Map<string, { file_id: string; content_hash: string }>();
    for (const r of rows) {
      out.set(r.path as string, {
        file_id: r.file_id as string,
        content_hash: r.content_hash as string,
      });
    }
    return out;
  }

  it("applies a full add/edit/rename/delete plan and leaves the expected manifest", async () => {
    const sourceId = await approvedSource(nsA, "git://acme/repo-full");

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

    const m1 = await liveManifest(nsA, sourceId);
    const renamedId = m1.get("old.ts")!.file_id;

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

    const m2 = await liveManifest(nsA, sourceId);
    expect([...m2.keys()].sort()).toEqual([
      "edit.ts",
      "fresh.ts",
      "keep.ts",
      "new.ts",
    ]);
    // Rename preserved the durable file_id; old path is gone.
    expect(m2.get("new.ts")!.file_id).toBe(renamedId);
    expect(m2.has("old.ts")).toBe(false);
    // Edit kept identity, changed hash.
    expect(m2.get("edit.ts")!.content_hash).toBe(H(20));
    expect(m2.get("edit.ts")!.file_id).toBe(m1.get("edit.ts")!.file_id);
  });

  it("checkpoints a split run and resumes to the SAME manifest as an uninterrupted run", async () => {
    const interrupted = await approvedSource(nsA, "git://acme/repo-resume");
    const straight = await approvedSource(nsA, "git://acme/repo-straight");

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
    expect((await liveManifest(nsA, interrupted)).size).toBe(2);

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
    const mResumed = await liveManifest(nsA, interrupted);
    const mBaseline = await liveManifest(nsA, straight);
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
  });

  it("serializes concurrent syncs of one source on the eligible-source row lock (no hybrid corpus, no checkpoint regress)", async () => {
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
    const sourceId = await approvedSource(nsA, "git://acme/repo-serialize");

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
      expect((await liveManifest(nsA, sourceId)).size).toBe(0);

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
    const m = await liveManifest(nsA, sourceId);
    expect([...m.keys()].sort()).toEqual(["a.ts", "b.ts"]);
    expect(m.get("a.ts")!.content_hash).toBe(H(1));
    expect(m.get("b.ts")!.content_hash).toBe(H(2));

    // Checkpoint did not regress: it equals the plan length for the completed run.
    const { rows: ckpt } = await pool.query(
      `SELECT plan, checkpoint_index, status FROM ob_source_sync_runs
        WHERE source_id = $1 AND namespace = $2`,
      [sourceId, nsA],
    );
    expect(ckpt.length).toBe(1);
    expect(ckpt[0].status).toBe("completed");
    expect(ckpt[0].checkpoint_index).toBe((ckpt[0].plan as unknown[]).length);
  });

  it("two concurrent differing observations serialize to one non-hybrid manifest", async () => {
    // A stronger end-to-end race: two syncs of the SAME source with DIFFERENT
    // observations launched together. The lock forces a total order. Whichever
    // commits first seeds the manifest; the second re-diffs against THAT manifest
    // (not the empty one it might have seen unlocked). The final live manifest is
    // therefore exactly one observation's corpus reconciled onto the other — never
    // a hybrid union of two independently-planned add sets, and never a duplicated
    // path. We don't fix which order wins (that's Postgres' lock queue); we prove
    // the outcome is a consistent single-writer result either way.
    const sourceId = await approvedSource(nsA, "git://acme/repo-race");

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
    const m = await liveManifest(nsA, sourceId);
    const keys = [...m.keys()].sort();
    const isCorpus1 =
      keys.length === 2 && keys[0] === "only1.ts" && keys[1] === "shared.ts";
    const isCorpus2 =
      keys.length === 2 && keys[0] === "only2.ts" && keys[1] === "shared.ts";
    expect(isCorpus1 || isCorpus2).toBe(true);
    expect(m.get("shared.ts")!.content_hash).toBe(H(1));

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
  });

  it("re-running a completed sync over the same observation mutates nothing (fresh no-op plan)", async () => {
    const sourceId = await approvedSource(nsA, "git://acme/repo-noop");
    const observation = obs([
      ["a.ts", H(1)],
      ["b.ts", H(2)],
    ]);
    const first = await syncSource(pool, admin(), sourceId, observation, {
      target_namespace: nsA,
    });
    // Fresh plan on an empty manifest: two adds, nothing unchanged yet.
    expect(first.data?.resumed).toBe(false);
    expect(first.data?.counts.unchanged).toBe(0);
    expect(first.data?.status).toBe("completed");
    const firstRunId = first.data?.run_id;

    const m1 = await liveManifest(nsA, sourceId);
    const idsBefore = new Map(
      [...m1.entries()].map(([p, v]) => [p, v.file_id]),
    );

    const again = await syncSource(pool, admin(), sourceId, observation, {
      target_namespace: nsA,
    });
    expect(again.ok).toBe(true);
    expect(again.data?.status).toBe("completed");
    // The first run is COMPLETED history and is not resumable, so this is a FRESH
    // run (not a reuse of the terminal run). A fresh run cannot regress the
    // manifest — only running runs are resumable — which is exactly the guard the
    // A->B->A revert case depends on.
    expect(again.data?.resumed).toBe(false);
    expect(again.data?.run_id).not.toBe(firstRunId);
    // The fresh plan diffs the current manifest, which already matches the
    // observation exactly: zero mutating ops, both files reported unchanged.
    expect(again.data?.counts).toMatchObject({
      added: 0,
      edited: 0,
      renamed: 0,
      deleted: 0,
      unchanged: 2,
    });

    // Behaviorally a no-op: the manifest is byte-for-byte unchanged, including
    // every durable file_id (no delete+re-add churn).
    const m2 = await liveManifest(nsA, sourceId);
    expect([...m2.keys()].sort()).toEqual(["a.ts", "b.ts"]);
    for (const [path, v] of m2) {
      expect(v.content_hash).toBe(m1.get(path)!.content_hash);
      expect(v.file_id).toBe(idsBefore.get(path)!);
    }
    // No live path duplicated by the second run.
    const { rows: dup } = await pool.query(
      `SELECT path, COUNT(*) AS n FROM ob_source_files
        WHERE source_id = $1 AND namespace = $2 AND state = 'live'
        GROUP BY path HAVING COUNT(*) > 1`,
      [sourceId, nsA],
    );
    expect(dup.length).toBe(0);
  });

  it("a fresh no-op plan over an already-synced manifest reports unchanged", async () => {
    const sourceId = await approvedSource(nsA, "git://acme/repo-freshnoop");
    // Seed the manifest.
    await syncSource(
      pool,
      admin(),
      sourceId,
      obs([
        ["a.ts", H(1)],
        ["b.ts", H(2)],
      ]),
      { target_namespace: nsA },
    );

    // A DISTINCT observation (different hash → fresh plan) whose file set exactly
    // matches the live manifest. No ops are emitted, and because it is a fresh
    // plan the receipt carries the full unchanged count — proving counts.unchanged
    // is plumbed through, not discarded.
    const noop = await syncSource(
      pool,
      admin(),
      sourceId,
      obs([
        ["a.ts", H(1)],
        ["b.ts", H(2)],
        // add a third file so the observation hash differs from the seed run,
        // forcing a fresh plan rather than a resume of the seed run.
        ["c.ts", H(3)],
      ]),
      { target_namespace: nsA },
    );
    expect(noop.data?.resumed).toBe(false);
    expect(noop.data?.counts).toMatchObject({
      added: 1, // c.ts is the only op
      edited: 0,
      renamed: 0,
      deleted: 0,
      unchanged: 2, // a.ts and b.ts matched — plumbed into the receipt
    });
  });

  it("reverting to an earlier observation (A->B->A) plans a fresh run and restores manifest A exactly", async () => {
    // A completed run is terminal HISTORY, not a resumable checkpoint. When a
    // source reverts to a corpus it already synced (A -> B -> A), the recurring
    // observation A must NOT reopen A's old completed run — that run's checkpoint
    // is at plan end, so reusing it would re-apply only its tail and leave the
    // intermediate B edit (b.ts at H(9)) in place while reporting completed. It
    // must instead plan a FRESH run against the CURRENT (B) manifest, which emits
    // the edit that restores A, and preserve the prior completed run as history.
    const sourceId = await approvedSource(nsA, "git://acme/repo-revert");

    const obsA = obs([
      ["a.ts", H(1)],
      ["b.ts", H(2)],
    ]);
    const obsB = obs([
      ["a.ts", H(1)],
      ["b.ts", H(9)],
    ]);

    // A: two adds, completes.
    const runA1 = await syncSource(pool, admin(), sourceId, obsA, {
      target_namespace: nsA,
    });
    expect(runA1.data?.status).toBe("completed");
    expect(runA1.data?.counts.added).toBe(2);
    const runA1Id = runA1.data?.run_id;

    // B: edit b.ts H(2) -> H(9), completes. Manifest now diverged from A.
    const runB = await syncSource(pool, admin(), sourceId, obsB, {
      target_namespace: nsA,
    });
    expect(runB.data?.status).toBe("completed");
    expect(runB.data?.counts).toMatchObject({ edited: 1, added: 0 });
    expect((await liveManifest(nsA, sourceId)).get("b.ts")!.content_hash).toBe(
      H(9),
    );

    // A again: SAME observation hash as runA1, but runA1 is completed history.
    // This must create a fresh run that edits b.ts back H(9) -> H(2).
    const runA2 = await syncSource(pool, admin(), sourceId, obsA, {
      target_namespace: nsA,
    });
    expect(runA2.ok).toBe(true);
    expect(runA2.data?.status).toBe("completed");
    // Fresh run, not a resume of history.
    expect(runA2.data?.resumed).toBe(false);
    // A fresh plan diffed the current (B) manifest: exactly the one edit that
    // reverts b.ts, one unchanged (a.ts), no re-adds.
    expect(runA2.data?.counts).toMatchObject({
      added: 0,
      edited: 1,
      renamed: 0,
      deleted: 0,
      unchanged: 1,
    });

    // A DISTINCT run row was created — not the completed one reopened.
    const runA2Id = runA2.data?.run_id;
    expect(runA2Id).toBeDefined();
    expect(runA2Id).not.toBe(runA1Id);

    // The final live manifest matches observation A EXACTLY (paths + hashes).
    const finalManifest = await liveManifest(nsA, sourceId);
    expect([...finalManifest.keys()].sort()).toEqual(["a.ts", "b.ts"]);
    expect(finalManifest.get("a.ts")!.content_hash).toBe(H(1));
    expect(finalManifest.get("b.ts")!.content_hash).toBe(H(2));
    // No duplicate live rows.
    const { rows: dup } = await pool.query(
      `SELECT path, COUNT(*) AS n FROM ob_source_files
        WHERE source_id = $1 AND namespace = $2 AND state = 'live'
        GROUP BY path HAVING COUNT(*) > 1`,
      [sourceId, nsA],
    );
    expect(dup.length).toBe(0);

    // History is preserved: TWO run rows exist for observation A's hash — the
    // original completed run AND the fresh one — and the original still exists,
    // completed, untouched.
    const obsAHash = observationHash(obsA);
    const { rows: runRows } = await pool.query(
      `SELECT id, status FROM ob_source_sync_runs
        WHERE source_id = $1 AND namespace = $2 AND observation_hash = $3
        ORDER BY created_at ASC`,
      [sourceId, nsA, obsAHash],
    );
    expect(runRows.length).toBe(2);
    const original = runRows.find((r) => r.id === runA1Id);
    expect(original).toBeDefined();
    expect(original!.status).toBe("completed");
  });

  it("isolates manifests per namespace for the same external location", async () => {
    // The SAME external id registered independently in two namespaces.
    const ext = "git://acme/shared-repo";
    const srcA = await approvedSource(nsA, ext);
    const srcB = await approvedSource(nsB, ext);

    await syncSource(pool, admin(), srcA, obs([["a.ts", H(1)]]), {
      target_namespace: nsA,
    });
    await syncSource(
      pool,
      admin(),
      srcB,
      obs([
        ["b.ts", H(2)],
        ["c.ts", H(3)],
      ]),
      { target_namespace: nsB },
    );

    const mA = await liveManifest(nsA, srcA);
    const mB = await liveManifest(nsB, srcB);
    expect([...mA.keys()]).toEqual(["a.ts"]);
    expect([...mB.keys()].sort()).toEqual(["b.ts", "c.ts"]);

    // A sync targeting srcA's id under nsB must not resolve srcA (namespace-bound
    // eligibility): the id is not registered in nsB.
    const cross = await syncSource(pool, admin(), srcA, obs([["x.ts", H(9)]]), {
      target_namespace: nsB,
    });
    expect(cross.ok).toBe(false);
    expect(cross.code).toBe("source_not_found");
    // srcA's own manifest is untouched by the cross-namespace attempt.
    expect((await liveManifest(nsA, srcA)).size).toBe(1);
  });

  it("rejects a sync into a namespace the caller cannot write", async () => {
    const sourceId = await approvedSource(nsA, "git://acme/repo-authz");
    // A header-scoped identity bound to a different namespace cannot write nsA.
    const headerBound: AuthInfo = {
      role: "agent",
      clientId: "someone-else",
      namespaceSource: "header",
    };
    const res = await syncSource(
      pool,
      headerBound,
      sourceId,
      obs([["a.ts", H(1)]]),
      { target_namespace: nsA },
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe("namespace_denied");
  });

  it("skips syncing a paused (non-active) source", async () => {
    const sourceId = await approvedSource(nsA, "git://acme/repo-paused");
    // Pause it via the registry update path.
    const { rows } = await pool.query(
      `SELECT revision FROM ob_sources WHERE id = $1`,
      [sourceId],
    );
    await updateSource(pool, admin(), {
      id: sourceId,
      target_namespace: nsA,
      expected_revision: rows[0].revision as number,
      lifecycle_state: "paused",
    });
    const res = await syncSource(
      pool,
      admin(),
      sourceId,
      obs([["a.ts", H(1)]]),
      {
        target_namespace: nsA,
      },
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe("source_not_eligible");
  });
});
