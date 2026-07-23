import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import {
  GRAPH_DERIVATION_JOB_KIND,
  GraphDerivationTerminalError,
  SOURCE_ANCHOR_ENTITY_TYPE,
  makeGraphDerivationHandler,
  selectSourcesNeedingDerivation,
  type GraphDerivationPayload,
} from "./graph-derivation-handler.ts";
import { type MaintenanceJob } from "./maintenance-queue.ts";
import type { AuthInfo } from "./types.ts";

/**
 * Live-Postgres regression for the #346 maintenance integration.
 *
 * The in-memory FakeSourcePool in graph-derivation-handler.test.ts models the
 * selection join and snapshot guard by hand. This suite proves the NOVEL SQL
 * against the REAL schema and REAL partial-index arbitration:
 *   - selectSourcesNeedingDerivation()'s ob_sources ⋈ ob_entities anchor join,
 *     including the `IS DISTINCT FROM` new/unchanged/changed comparison and the
 *     approved+active+hash-shaped filter,
 *   - the handler's snapshot guard against a live ob_sources row,
 *   - end-to-end derivation into the real ob_entities / ob_links graph, and
 *   - the anchor content_hash stamp that makes selection converge (unchanged →
 *     empty sweep) and reruns idempotent.
 *
 * Env-gated exactly like the other live suites: skipped unless
 * OPENBRAIN_TEST_DATABASE_URL points at a migrated database.
 */
const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;

dbDescribe("graph derivation maintenance integration (live Postgres)", () => {
  const pool = new Pool({ connectionString: DB_URL });
  const ns = "test-graph-derivation-maint";
  const otherNs = "test-graph-derivation-maint-other";
  const auth: AuthInfo = {
    role: "admin",
    clientId: "test-graph-derivation-maint",
    namespaceSource: "token",
  };

  const hashA = "a".repeat(64);
  const hashB = "b".repeat(64);

  async function cleanup(): Promise<void> {
    for (const namespace of [ns, otherNs]) {
      await pool.query("DELETE FROM ob_links WHERE namespace = $1", [
        namespace,
      ]);
      await pool.query("DELETE FROM ob_entities WHERE namespace = $1", [
        namespace,
      ]);
      await pool.query("DELETE FROM ob_sources WHERE namespace = $1", [
        namespace,
      ]);
    }
  }

  async function insertSource(
    namespace: string,
    over: Partial<{
      approval_state: string;
      lifecycle_state: string;
      content_hash: string | null;
      title: string | null;
      external_id: string;
    }> = {},
  ): Promise<{ id: string; revision: number; external_id: string }> {
    const externalId = over.external_id ?? `ext-${namespace}`;
    const { rows } = await pool.query(
      `INSERT INTO ob_sources
         (namespace, source_kind, external_id, title,
          approval_state, lifecycle_state, content_hash, created_by)
       VALUES ($1, 'git', $2, $3, $4, $5, $6, 'tester')
       RETURNING id, revision, external_id`,
      [
        namespace,
        externalId,
        over.title ?? "release plan",
        over.approval_state ?? "approved",
        over.lifecycle_state ?? "active",
        over.content_hash === undefined ? hashA : over.content_hash,
      ],
    );
    return {
      id: rows[0].id as string,
      revision: rows[0].revision as number,
      external_id: rows[0].external_id as string,
    };
  }

  function jobFor(
    payload: GraphDerivationPayload,
    namespace: string,
  ): MaintenanceJob {
    return {
      id: "job-live",
      kind: GRAPH_DERIVATION_JOB_KIND,
      version: 1,
      payload: payload as unknown as Record<string, unknown>,
      idempotencyKey: "k",
      state: "running",
      runAfter: new Date("2026-07-22T12:00:00.000Z"),
      leaseToken: "00000000-0000-4000-8000-000000000009",
      leaseUntil: new Date("2026-07-22T12:00:30.000Z"),
      attempts: 1,
      maxAttempts: 3,
      backoffBaseMs: 1_000,
      backoffMaxMs: 4_000,
      lastErrorCategory: null,
      terminalAt: null,
      deadLetteredAt: null,
      namespace,
      provenance: null,
      createdAt: new Date("2026-07-22T12:00:00.000Z"),
      updatedAt: new Date("2026-07-22T12:00:00.000Z"),
    };
  }

  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("selects a new approved source, skips pending/retired/foreign, derives, then no-ops", async () => {
    const newSource = await insertSource(ns, { external_id: "new-src" });
    await insertSource(ns, {
      external_id: "pending-src",
      approval_state: "pending",
    });
    await insertSource(ns, {
      external_id: "retired-src",
      lifecycle_state: "retired",
    });
    await insertSource(ns, { external_id: "nohash-src", content_hash: null });
    await insertSource(otherNs, { external_id: "foreign-src" });

    // Namespace-scoped selection: only the one new, approved, active, hashed
    // source in `ns` is returned.
    const selected = await selectSourcesNeedingDerivation(pool, [ns]);
    expect(selected.length).toBe(1);
    expect(selected[0]!.id).toBe(newSource.id);
    expect(selected[0]!.derived_content_hash).toBeNull();

    // Derive it via the handler.
    const handler = makeGraphDerivationHandler({ pool, auth });
    await handler(
      jobFor(
        {
          source_id: newSource.id,
          source_kind: "git",
          external_id: newSource.external_id,
          content_hash: hashA,
          revision: newSource.revision,
          metadata: { topics: ["Migrations", "pgvector"], people: ["Rico"] },
        },
        ns,
      ),
    );

    // The anchor entity exists, stamped with the content hash.
    const anchor = await pool.query(
      `SELECT metadata ->> 'content_hash' AS content_hash
         FROM ob_entities
        WHERE namespace = $1 AND entity_type = $2 AND canonical_id = $3
          AND archived_at IS NULL`,
      [
        ns,
        SOURCE_ANCHOR_ENTITY_TYPE,
        `${SOURCE_ANCHOR_ENTITY_TYPE}:${newSource.id}`,
      ],
    );
    expect(anchor.rows.length).toBe(1);
    expect(anchor.rows[0].content_hash).toBe(hashA);

    // 3 term entities (2 topics + 1 person) + anchor, and 3 mentions edges.
    const terms = await pool.query(
      "SELECT COUNT(*)::int AS n FROM ob_entities WHERE namespace = $1",
      [ns],
    );
    expect(terms.rows[0].n).toBe(4);
    const edges = await pool.query(
      "SELECT COUNT(*)::int AS n FROM ob_links WHERE namespace = $1 AND relation = 'mentions'",
      [ns],
    );
    expect(edges.rows[0].n).toBe(3);

    // Unchanged now: selection returns nothing for this source.
    const afterSelect = await selectSourcesNeedingDerivation(pool, [ns]);
    expect(afterSelect.length).toBe(0);

    // Rerun the exact job: converges, no duplicate nodes/edges.
    await handler(
      jobFor(
        {
          source_id: newSource.id,
          source_kind: "git",
          external_id: newSource.external_id,
          content_hash: hashA,
          revision: newSource.revision,
          metadata: { topics: ["Migrations", "pgvector"], people: ["Rico"] },
        },
        ns,
      ),
    );
    const termsAfter = await pool.query(
      "SELECT COUNT(*)::int AS n FROM ob_entities WHERE namespace = $1",
      [ns],
    );
    expect(termsAfter.rows[0].n).toBe(4);
    const edgesAfter = await pool.query(
      "SELECT COUNT(*)::int AS n FROM ob_links WHERE namespace = $1",
      [ns],
    );
    expect(edgesAfter.rows[0].n).toBe(3);
  });

  it("changed content hash is re-selected and derived without duplicating the anchor", async () => {
    const src = await insertSource(ns, { external_id: "changing-src" });
    const handler = makeGraphDerivationHandler({ pool, auth });

    await handler(
      jobFor(
        {
          source_id: src.id,
          source_kind: "git",
          external_id: src.external_id,
          content_hash: hashA,
          revision: src.revision,
          metadata: { topics: ["Migrations"], people: [] },
        },
        ns,
      ),
    );

    // Observe new content: bump the source's content_hash (and revision, as the
    // registry would). It becomes selectable again as `changed`.
    const bumped = await pool.query(
      `UPDATE ob_sources SET content_hash = $1, revision = revision + 1
        WHERE id = $2 AND namespace = $3
        RETURNING revision`,
      [hashB, src.id, ns],
    );
    const newRevision = bumped.rows[0].revision as number;

    const selected = await selectSourcesNeedingDerivation(pool, [ns]);
    expect(selected.length).toBe(1);
    expect(selected[0]!.derived_content_hash).toBe(hashA);

    await handler(
      jobFor(
        {
          source_id: src.id,
          source_kind: "git",
          external_id: src.external_id,
          content_hash: hashB,
          revision: newRevision,
          metadata: { topics: ["Migrations", "pgvector"], people: [] },
        },
        ns,
      ),
    );

    // Exactly one anchor row (renamed/updated in place), stamped with hashB.
    const anchor = await pool.query(
      `SELECT COUNT(*)::int AS n, MAX(metadata ->> 'content_hash') AS content_hash
         FROM ob_entities
        WHERE namespace = $1 AND entity_type = $2 AND canonical_id = $3
          AND archived_at IS NULL`,
      [ns, SOURCE_ANCHOR_ENTITY_TYPE, `${SOURCE_ANCHOR_ENTITY_TYPE}:${src.id}`],
    );
    expect(anchor.rows[0].n).toBe(1);
    expect(anchor.rows[0].content_hash).toBe(hashB);
  });

  it("changed bytes but identical terms still converges (content_hash stamp refreshes)", async () => {
    // The corner case the in-memory sentinel guards, proven live: a source's
    // bytes change (new content_hash + revision) while its extracted terms stay
    // identical, so the derivation node set — and thus derivation_hash — is
    // unchanged. The run takes the primitive's `unchanged` node path but MUST
    // refresh the anchor's stamped content_hash, or the source is re-selected on
    // every sweep forever.
    const src = await insertSource(ns, { external_id: "same-terms-src" });
    const handler = makeGraphDerivationHandler({ pool, auth });
    await handler(
      jobFor(
        {
          source_id: src.id,
          source_kind: "git",
          external_id: src.external_id,
          content_hash: hashA,
          revision: src.revision,
          metadata: { topics: ["Migrations"], people: [] },
        },
        ns,
      ),
    );

    // Bump ONLY the content hash + revision; keep the same extracted terms.
    const bumped = await pool.query(
      `UPDATE ob_sources SET content_hash = $1, revision = revision + 1
        WHERE id = $2 AND namespace = $3 RETURNING revision`,
      [hashB, src.id, ns],
    );
    const newRevision = bumped.rows[0].revision as number;

    // Selectable as changed (source hash B <> stamped hash A).
    const selectedBefore = await selectSourcesNeedingDerivation(pool, [ns]);
    expect(selectedBefore.length).toBe(1);
    expect(selectedBefore[0]!.derived_content_hash).toBe(hashA);

    await handler(
      jobFor(
        {
          source_id: src.id,
          source_kind: "git",
          external_id: src.external_id,
          content_hash: hashB,
          revision: newRevision,
          metadata: { topics: ["Migrations"], people: [] },
        },
        ns,
      ),
    );

    // The anchor's stamped content_hash advanced to B even though the node set
    // (and derivation_hash) never changed. The sweep now skips this source.
    const anchor = await pool.query(
      `SELECT metadata ->> 'content_hash' AS content_hash
         FROM ob_entities
        WHERE namespace = $1 AND entity_type = $2 AND canonical_id = $3
          AND archived_at IS NULL`,
      [ns, SOURCE_ANCHOR_ENTITY_TYPE, `${SOURCE_ANCHOR_ENTITY_TYPE}:${src.id}`],
    );
    expect(anchor.rows[0].content_hash).toBe(hashB);
    const selectedAfter = await selectSourcesNeedingDerivation(pool, [ns]);
    expect(selectedAfter.length).toBe(0);
  });

  it("snapshot guard: a stale-revision job derives nothing against the live row", async () => {
    const src = await insertSource(ns, { external_id: "stale-src" });
    const handler = makeGraphDerivationHandler({ pool, auth });
    await expect(
      handler(
        jobFor(
          {
            source_id: src.id,
            source_kind: "git",
            external_id: src.external_id,
            content_hash: hashA,
            revision: src.revision + 99,
          },
          ns,
        ),
      ),
    ).rejects.toThrow();

    // Nothing derived: no anchor entity was written.
    const anchor = await pool.query(
      "SELECT COUNT(*)::int AS n FROM ob_entities WHERE namespace = $1",
      [ns],
    );
    expect(anchor.rows[0].n).toBe(0);
  });

  it("no derived edge crosses the namespace boundary", async () => {
    const here = await insertSource(ns, { external_id: "iso-here" });
    const there = await insertSource(otherNs, { external_id: "iso-there" });
    const handler = makeGraphDerivationHandler({ pool, auth });
    await handler(
      jobFor(
        {
          source_id: here.id,
          source_kind: "git",
          external_id: here.external_id,
          content_hash: hashA,
          revision: here.revision,
          metadata: { topics: ["Shared Topic"], people: [] },
        },
        ns,
      ),
    );
    await handler(
      jobFor(
        {
          source_id: there.id,
          source_kind: "git",
          external_id: there.external_id,
          content_hash: hashA,
          revision: there.revision,
          metadata: { topics: ["Shared Topic"], people: [] },
        },
        otherNs,
      ),
    );

    // Every edge sits entirely within one namespace on both endpoints.
    const crossing = await pool.query(
      `SELECT COUNT(*)::int AS n
         FROM ob_links l
         JOIN ob_entities f ON f.id = l.from_id
         JOIN ob_entities t ON t.id = l.to_id
        WHERE l.namespace = ANY($1::text[])
          AND (f.namespace <> l.namespace OR t.namespace <> l.namespace)`,
      [[ns, otherNs]],
    );
    expect(crossing.rows[0].n).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Mutation-sensitive regressions for the coupled P1 atomicity findings.
  //
  // These are the tests the pre-fix code fails: they mutate real graph state
  // through a real failure/race, not a hand-modeled fake. Finding A: a failure
  // AFTER the anchor/hash mutation but BEFORE completion must roll the whole
  // derivation back — no partial hash/nodes/links — so a retry converges rather
  // than being falsely short-circuited by a completed hash. Finding B: an old
  // job must never overwrite a newer committed graph; the FOR UPDATE snapshot
  // guard serializes it so it either runs before the source advances or observes
  // drift and terminal-stops.
  // -------------------------------------------------------------------------

  /**
   * Wrap a pool so the client it hands out throws exactly once, on the first
   * statement whose SQL contains `failOn`. Everything else — including
   * BEGIN/COMMIT/ROLLBACK and every other statement — passes straight through to
   * a real checked-out client, so the transaction the handler opens is genuine
   * and the injected failure lands mid-derivation on real Postgres state. This
   * injects the failure without touching production code: the handler still runs
   * its own BEGIN/guard/derive/COMMIT; we only make one inner statement fail.
   *
   * Two harness-safety rules the override MUST honor, or it corrupts the shared
   * `pool` for every later query in the suite:
   *  - Forward ALL arguments verbatim (`...args`), so the callback form
   *    `client.query(text, values, cb)` that `pool.query()` uses internally
   *    still resolves. An override that only accepts `(sql, params)` and returns
   *    a Promise silently drops the callback, and every later `pool.query()` on
   *    the reused connection hangs forever.
   *  - Restore the pristine `query` when the client is released back to the
   *    pool. The client we mutate is a POOLED connection; leaving the override
   *    on it poisons whatever code checks it out next.
   */
  function poolFailingAfter(
    real: Pool,
    failOn: string,
  ): Pick<Pool, "connect"> & { armed: boolean } {
    const wrapper = {
      armed: true,
      connect: async () => {
        const client = await real.connect();
        const realQuery = client.query.bind(client);
        const realRelease = client.release.bind(client);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (client as any).query = ((...args: unknown[]) => {
          const sql = args[0];
          if (wrapper.armed && String(sql).includes(failOn)) {
            wrapper.armed = false;
            throw new Error("injected mid-derivation failure");
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (realQuery as any)(...args);
        }) as never;
        // Un-patch on release so the pooled connection returns to the pool with
        // its original query/release, never the failure-injecting override.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (client as any).release = ((...args: unknown[]) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (client as any).query = realQuery;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (client as any).release = realRelease;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (realRelease as any)(...args);
        }) as never;
        return client;
      },
    };
    return wrapper as Pick<Pool, "connect"> & { armed: boolean };
  }

  it("rollback atomicity: a failure after the hash stamp leaves no partial graph, and retry converges", async () => {
    const src = await insertSource(ns, { external_id: "rollback-src" });

    // Inject a failure on the stale-edge prune UPDATE — the LAST derivation
    // statement, which runs AFTER the anchor upsert has already stamped both the
    // derivation_hash and the content_hash and after every term node + mentions
    // edge has been inserted. Pre-fix (statements auto-committed on the pool),
    // those writes would survive and the stamped hash would falsely short-
    // circuit the retry. With the fix they all live in one transaction.
    const failingPool = poolFailingAfter(
      pool,
      "UPDATE ob_links\n        SET archived_at = NOW()",
    );
    const failingHandler = makeGraphDerivationHandler({
      pool: failingPool as unknown as Pool,
      auth,
    });

    await expect(
      failingHandler(
        jobFor(
          {
            source_id: src.id,
            source_kind: "git",
            external_id: src.external_id,
            content_hash: hashA,
            revision: src.revision,
            metadata: { topics: ["Migrations", "pgvector"], people: ["Rico"] },
          },
          ns,
        ),
      ),
    ).rejects.toThrow("injected mid-derivation failure");

    // ROLLBACK proof: nothing landed. No anchor, no term nodes, no edges — and
    // crucially NO stamped hash for a retry to short-circuit past.
    const entitiesAfterFail = await pool.query(
      "SELECT COUNT(*)::int AS n FROM ob_entities WHERE namespace = $1",
      [ns],
    );
    expect(entitiesAfterFail.rows[0].n).toBe(0);
    const linksAfterFail = await pool.query(
      "SELECT COUNT(*)::int AS n FROM ob_links WHERE namespace = $1",
      [ns],
    );
    expect(linksAfterFail.rows[0].n).toBe(0);
    const anchorAfterFail = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ob_entities
        WHERE namespace = $1 AND entity_type = $2 AND canonical_id = $3`,
      [ns, SOURCE_ANCHOR_ENTITY_TYPE, `${SOURCE_ANCHOR_ENTITY_TYPE}:${src.id}`],
    );
    expect(anchorAfterFail.rows[0].n).toBe(0);
    // The source is still selectable (never derived), proving no partial hash.
    const stillNeeded = await selectSourcesNeedingDerivation(pool, [ns]);
    expect(stillNeeded.length).toBe(1);
    expect(stillNeeded[0]!.id).toBe(src.id);

    // Retry on the healthy pool: the derivation now converges fully.
    const handler = makeGraphDerivationHandler({ pool, auth });
    await handler(
      jobFor(
        {
          source_id: src.id,
          source_kind: "git",
          external_id: src.external_id,
          content_hash: hashA,
          revision: src.revision,
          metadata: { topics: ["Migrations", "pgvector"], people: ["Rico"] },
        },
        ns,
      ),
    );
    const entitiesAfterRetry = await pool.query(
      "SELECT COUNT(*)::int AS n FROM ob_entities WHERE namespace = $1",
      [ns],
    );
    // anchor + 2 topics + 1 person = 4 nodes; 3 mentions edges.
    expect(entitiesAfterRetry.rows[0].n).toBe(4);
    const linksAfterRetry = await pool.query(
      "SELECT COUNT(*)::int AS n FROM ob_links WHERE namespace = $1 AND relation = 'mentions'",
      [ns],
    );
    expect(linksAfterRetry.rows[0].n).toBe(3);
    const anchorAfterRetry = await pool.query(
      `SELECT metadata ->> 'content_hash' AS content_hash
         FROM ob_entities
        WHERE namespace = $1 AND entity_type = $2 AND canonical_id = $3
          AND archived_at IS NULL`,
      [ns, SOURCE_ANCHOR_ENTITY_TYPE, `${SOURCE_ANCHOR_ENTITY_TYPE}:${src.id}`],
    );
    expect(anchorAfterRetry.rows[0].content_hash).toBe(hashA);
    // Fully converged now: no longer selectable.
    const afterRetrySelect = await selectSourcesNeedingDerivation(pool, [ns]);
    expect(afterRetrySelect.length).toBe(0);
  });

  it("serialized interleave: an old job cannot overwrite a newer committed graph and terminal-stops on drift", async () => {
    // The source starts at revision R / hash A. The registry then advances it to
    // revision R+1 / hash B (new bytes AND new terms). A fresh job for (B, R+1)
    // derives the newer graph. The OLD job for (A, R) — still in the queue — must
    // never overwrite that newer graph: its FOR UPDATE guard re-reads the live
    // row under the (A, R) predicate, matches zero rows, and terminal-stops.
    const src = await insertSource(ns, { external_id: "interleave-src" });
    const oldRevision = src.revision;
    const handler = makeGraphDerivationHandler({ pool, auth });

    // Old job runs first and commits the A-graph (one topic: "OldTopic").
    await handler(
      jobFor(
        {
          source_id: src.id,
          source_kind: "git",
          external_id: src.external_id,
          content_hash: hashA,
          revision: oldRevision,
          metadata: { topics: ["OldTopic"], people: [] },
        },
        ns,
      ),
    );

    // The registry observes new content and advances the source (hash + revision
    // bump, exactly as source-registry.ts does on a content change).
    const bumped = await pool.query(
      `UPDATE ob_sources SET content_hash = $1, revision = revision + 1
        WHERE id = $2 AND namespace = $3 RETURNING revision`,
      [hashB, src.id, ns],
    );
    const newRevision = bumped.rows[0].revision as number;

    // A fresh job for the newer snapshot derives the B-graph ("NewTopic").
    await handler(
      jobFor(
        {
          source_id: src.id,
          source_kind: "git",
          external_id: src.external_id,
          content_hash: hashB,
          revision: newRevision,
          metadata: { topics: ["NewTopic"], people: [] },
        },
        ns,
      ),
    );

    // The graph now reflects the NEWER snapshot: anchor stamped hashB, a live
    // anchor->NewTopic edge, and the stale anchor->OldTopic edge pruned.
    async function graphState() {
      const anchor = await pool.query(
        `SELECT id, metadata ->> 'content_hash' AS content_hash,
                metadata ->> 'derivation_hash' AS derivation_hash
           FROM ob_entities
          WHERE namespace = $1 AND entity_type = $2 AND canonical_id = $3
            AND archived_at IS NULL`,
        [
          ns,
          SOURCE_ANCHOR_ENTITY_TYPE,
          `${SOURCE_ANCHOR_ENTITY_TYPE}:${src.id}`,
        ],
      );
      const liveTopics = await pool.query(
        `SELECT e.name
           FROM ob_links l
           JOIN ob_entities e ON e.id = l.to_id
          WHERE l.namespace = $1 AND l.from_id = $2 AND l.relation = 'mentions'
            AND l.archived_at IS NULL
          ORDER BY e.name`,
        [ns, anchor.rows[0].id],
      );
      return {
        contentHash: anchor.rows[0].content_hash as string,
        derivationHash: anchor.rows[0].derivation_hash as string,
        liveTopics: liveTopics.rows.map((r) => r.name as string),
      };
    }
    const newer = await graphState();
    expect(newer.contentHash).toBe(hashB);
    expect(newer.liveTopics).toEqual(["NewTopic"]);

    // Now replay the OLD job for (A, R). It is obsolete: the live row is (B, R+1).
    // The FOR UPDATE snapshot guard matches zero rows -> terminal-stop. It must
    // NOT overwrite the newer graph or re-stamp the old hash.
    await expect(
      handler(
        jobFor(
          {
            source_id: src.id,
            source_kind: "git",
            external_id: src.external_id,
            content_hash: hashA,
            revision: oldRevision,
            metadata: { topics: ["OldTopic"], people: [] },
          },
          ns,
        ),
      ),
    ).rejects.toBeInstanceOf(GraphDerivationTerminalError);

    // The committed graph is UNCHANGED — still the newer B-snapshot. No stale
    // overwrite: the anchor still stamps hashB and OldTopic did not revive.
    const afterOldReplay = await graphState();
    expect(afterOldReplay.contentHash).toBe(hashB);
    expect(afterOldReplay.derivationHash).toBe(newer.derivationHash);
    expect(afterOldReplay.liveTopics).toEqual(["NewTopic"]);

    // Finally, prove the serialization comes from the HANDLER'S OWN guard, not a
    // hand-taken lock: while a real handler derivation is mid-transaction (its
    // FOR UPDATE guard holding the source row), a competing registry UPDATE on
    // that same row must BLOCK until the handler commits. Pre-fix — no
    // transaction, no FOR UPDATE — the competing UPDATE would proceed
    // immediately and advance the snapshot out from under the in-flight job.
    //
    // We slow the handler's transaction from the inside by delaying its first
    // derivation write (the anchor upsert), which runs AFTER the FOR UPDATE
    // guard has locked the row and BEFORE COMMIT. That widens the window during
    // which the row lock is held so the race is observable deterministically.
    const src2 = await insertSource(ns, {
      external_id: "lock-serialize-src",
      title: "lock serialization source",
    });
    let updateResolved = false;
    const slowPool = {
      connect: async () => {
        const client = await pool.connect();
        const realQuery = client.query.bind(client);
        const realRelease = client.release.bind(client);
        let delayed = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (client as any).query = (async (...args: unknown[]) => {
          // Delay once, on the first anchor upsert — inside the transaction,
          // after the guard's FOR UPDATE has taken the row lock.
          if (!delayed && String(args[0]).includes("INSERT INTO ob_entities")) {
            delayed = true;
            await new Promise((r) => setTimeout(r, 300));
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (realQuery as any)(...args);
        }) as never;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (client as any).release = ((...a: unknown[]) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (client as any).query = realQuery;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (client as any).release = realRelease;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (realRelease as any)(...a);
        }) as never;
        return client;
      },
    };
    const slowHandler = makeGraphDerivationHandler({
      pool: slowPool as unknown as Pool,
      auth,
    });
    const derivation = slowHandler(
      jobFor(
        {
          source_id: src2.id,
          source_kind: "git",
          external_id: src2.external_id,
          content_hash: hashA,
          revision: src2.revision,
          metadata: { topics: ["LockTopic"], people: [] },
        },
        ns,
      ),
    );
    // Let the handler reach its in-transaction delay (guard row lock held).
    await new Promise((r) => setTimeout(r, 100));
    // A competing registry update on the locked row must BLOCK, not proceed.
    const competing = pool
      .query(
        `UPDATE ob_sources SET content_hash = $1, revision = revision + 1
          WHERE id = $2 AND namespace = $3`,
        [hashB, src2.id, ns],
      )
      .then(() => {
        updateResolved = true;
      });
    // Still inside the handler's transaction: the competing UPDATE is blocked.
    await new Promise((r) => setTimeout(r, 100));
    expect(updateResolved).toBe(false);
    // Handler commits and releases the lock; the competing update now completes.
    await derivation;
    await competing;
    expect(updateResolved).toBe(true);
  });
});
