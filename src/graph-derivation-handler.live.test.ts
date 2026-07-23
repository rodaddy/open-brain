import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import {
  GRAPH_DERIVATION_JOB_KIND,
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
});
