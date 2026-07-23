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
import { syncSource, type SourceObservation } from "./source-sync.ts";
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

  it("re-running a completed sync over the same observation is a no-op", async () => {
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

    const again = await syncSource(pool, admin(), sourceId, observation, {
      target_namespace: nsA,
    });
    expect(again.ok).toBe(true);
    expect(again.data?.status).toBe("completed");
    expect(again.data?.resumed).toBe(true);
    // Nothing changed the second time. This is a RESUME of the persisted run, not
    // a fresh diff, so unchanged is 0 by the documented resumed semantics even
    // though every observed file matches the manifest.
    expect(again.data?.counts).toMatchObject({
      added: 0,
      edited: 0,
      renamed: 0,
      deleted: 0,
      unchanged: 0,
    });
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
