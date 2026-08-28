/**
 * Live-Postgres functional coverage for resumable file-source synchronization
 * (Issue #338): the idempotence and isolation half. Split from
 * src/source-sync.pg.test.ts, which keeps the plan/checkpoint/concurrency half.
 *
 * The suite requires the test database rather than skipping itself when it is
 * absent (Issue #878): requireTestDatabaseUrl() throws at module scope so a
 * database-less run fails loudly instead of reporting a false green.
 *
 * What is proven end to end (behavioral input -> output, never SQL shape):
 *  1. Re-running a completed sync over the same observation is a no-op.
 *  2. A fresh no-op plan reports its unchanged count through the receipt.
 *  3. Reverting to an earlier observation (A->B->A) plans a fresh run rather
 *     than reopening completed history, and restores manifest A exactly.
 *  4. Namespace isolation: two namespaces that registered the same external
 *     location keep entirely separate manifests; a sync in one never touches
 *     the other.
 *  5. Authorization and lifecycle eligibility both refuse a sync.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../scripts/test-support/require-test-database.ts";
import { runMigrations } from "./db/migrate.ts";
import { updateSource } from "./source-registry.ts";
import { observationHash, syncSource } from "./source-sync.ts";
import {
  admin,
  approvedSource,
  cleanupNamespaces,
  expectDefined,
  H,
  liveManifest,
  obs,
} from "./source-sync-test-helpers.ts";
import type { AuthInfo } from "./types.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

// Unique namespaces per run so cleanup owns exactly these rows.
const nsA = "lane338-idem-ns-a";
const nsB = "lane338-idem-ns-b";

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

async function reRunCompletedSyncIsNoOp(): Promise<void> {
  const sourceId = await approvedSource(pool, nsA, "git://acme/repo-noop");
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

  const m1 = await liveManifest(pool, nsA, sourceId);
  const idsBefore = new Map([...m1.entries()].map(([p, v]) => [p, v.file_id]));

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
  const m2 = await liveManifest(pool, nsA, sourceId);
  expect([...m2.keys()].sort()).toEqual(["a.ts", "b.ts"]);
  for (const [path, v] of m2) {
    expect(v.content_hash).toBe(expectDefined(m1.get(path), "m1 entry").content_hash);
    expect(v.file_id).toBe(expectDefined(idsBefore.get(path), "idsBefore entry"));
  }
  // No live path duplicated by the second run.
  const { rows: dup } = await pool.query(
    `SELECT path, COUNT(*) AS n FROM ob_source_files
      WHERE source_id = $1 AND namespace = $2 AND state = 'live'
      GROUP BY path HAVING COUNT(*) > 1`,
    [sourceId, nsA],
  );
  expect(dup.length).toBe(0);
}

async function freshNoOpPlanReportsUnchanged(): Promise<void> {
  const sourceId = await approvedSource(pool, nsA, "git://acme/repo-freshnoop");
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
}

async function revertPlansFreshRun(): Promise<void> {
  // A completed run is terminal HISTORY, not a resumable checkpoint. When a
  // source reverts to a corpus it already synced (A -> B -> A), the recurring
  // observation A must NOT reopen A's old completed run — that run's checkpoint
  // is at plan end, so reusing it would re-apply only its tail and leave the
  // intermediate B edit (b.ts at H(9)) in place while reporting completed. It
  // must instead plan a FRESH run against the CURRENT (B) manifest, which emits
  // the edit that restores A, and preserve the prior completed run as history.
  const sourceId = await approvedSource(pool, nsA, "git://acme/repo-revert");

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
  expect(
    expectDefined(
      (await liveManifest(pool, nsA, sourceId)).get("b.ts"),
      "manifest b.ts",
    ).content_hash,
  ).toBe(H(9));

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
  const finalManifest = await liveManifest(pool, nsA, sourceId);
  expect([...finalManifest.keys()].sort()).toEqual(["a.ts", "b.ts"]);
  expect(
    expectDefined(finalManifest.get("a.ts"), "finalManifest a.ts").content_hash,
  ).toBe(H(1));
  expect(
    expectDefined(finalManifest.get("b.ts"), "finalManifest b.ts").content_hash,
  ).toBe(H(2));
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
  expect(expectDefined(original, "original run row").status).toBe("completed");
}

async function isolatesManifestsPerNamespace(): Promise<void> {
  // The SAME external id registered independently in two namespaces.
  const ext = "git://acme/shared-repo";
  const srcA = await approvedSource(pool, nsA, ext);
  const srcB = await approvedSource(pool, nsB, ext);

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

  const mA = await liveManifest(pool, nsA, srcA);
  const mB = await liveManifest(pool, nsB, srcB);
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
  expect((await liveManifest(pool, nsA, srcA)).size).toBe(1);
}

async function rejectsUnwritableNamespace(): Promise<void> {
  const sourceId = await approvedSource(pool, nsA, "git://acme/repo-authz");
  // A header-scoped identity bound to a different namespace cannot write nsA.
  const headerBound: AuthInfo = {
    role: "agent",
    clientId: "someone-else",
    namespaceSource: "header",
  };
  const res = await syncSource(pool, headerBound, sourceId, obs([["a.ts", H(1)]]), {
    target_namespace: nsA,
  });
  expect(res.ok).toBe(false);
  expect(res.code).toBe("namespace_denied");
}

async function skipsPausedSource(): Promise<void> {
  const sourceId = await approvedSource(pool, nsA, "git://acme/repo-paused");
  // Pause it via the registry update path.
  const { rows } = await pool.query(`SELECT revision FROM ob_sources WHERE id = $1`, [
    sourceId,
  ]);
  await updateSource(pool, admin(), {
    id: sourceId,
    target_namespace: nsA,
    expected_revision: rows[0].revision as number,
    lifecycle_state: "paused",
  });
  const res = await syncSource(pool, admin(), sourceId, obs([["a.ts", H(1)]]), {
    target_namespace: nsA,
  });
  expect(res.ok).toBe(false);
  expect(res.code).toBe("source_not_eligible");
}

describe("resumable file-source sync idempotence and isolation (live Postgres)", () => {
  it(
    "re-running a completed sync over the same observation mutates nothing (fresh no-op plan)",
    reRunCompletedSyncIsNoOp,
  );

  it(
    "a fresh no-op plan over an already-synced manifest reports unchanged",
    freshNoOpPlanReportsUnchanged,
  );

  it(
    "reverting to an earlier observation (A->B->A) plans a fresh run and restores manifest A exactly",
    revertPlansFreshRun,
  );

  it(
    "isolates manifests per namespace for the same external location",
    isolatesManifestsPerNamespace,
  );

  it(
    "rejects a sync into a namespace the caller cannot write",
    rejectsUnwritableNamespace,
  );

  it("skips syncing a paused (non-active) source", skipsPausedSource);
});
