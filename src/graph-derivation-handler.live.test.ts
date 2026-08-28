import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import {
  SOURCE_ANCHOR_ENTITY_TYPE,
  makeGraphDerivationHandler,
  selectSourcesNeedingDerivation,
} from "./graph-derivation-handler.ts";
import { requireTestDatabaseUrl } from "../scripts/test-support/require-test-database.ts";
import {
  auth,
  cleanup,
  expectDefined,
  hashA,
  hashB,
  insertSource,
  jobFor,
  ns,
  otherNs,
} from "./graph-derivation-handler-test-helpers.ts";

/**
 * Live-Postgres regression for the #346 maintenance integration: the selection
 * and convergence half (the isolation and atomicity half lives in
 * graph-derivation-handler-isolation.live.test.ts, split under #878).
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
 * The suite demands OPENBRAIN_TEST_DATABASE_URL through the shared helper
 * rather than skipping itself when it is absent.
 */
const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

async function selectsNewApprovedSourceThenNoOps(): Promise<void> {
  const newSource = await insertSource(pool, ns, { external_id: "new-src" });
  await insertSource(pool, ns, {
    external_id: "pending-src",
    approval_state: "pending",
  });
  await insertSource(pool, ns, {
    external_id: "retired-src",
    lifecycle_state: "retired",
  });
  await insertSource(pool, ns, { external_id: "nohash-src", content_hash: null });
  await insertSource(pool, otherNs, { external_id: "foreign-src" });

  // Namespace-scoped selection: only the one new, approved, active, hashed
  // source in `ns` is returned.
  const selected = await selectSourcesNeedingDerivation(pool, [ns]);
  expect(selected.length).toBe(1);
  expect(expectDefined(selected[0], "selected[0]").id).toBe(newSource.id);
  expect(expectDefined(selected[0], "selected[0]").derived_content_hash).toBeNull();

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
    [ns, SOURCE_ANCHOR_ENTITY_TYPE, `${SOURCE_ANCHOR_ENTITY_TYPE}:${newSource.id}`],
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
}

async function changedHashReselectedWithoutDuplicatingAnchor(): Promise<void> {
  const src = await insertSource(pool, ns, { external_id: "changing-src" });
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
  expect(expectDefined(selected[0], "selected[0]").derived_content_hash).toBe(hashA);

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
}

async function changedBytesIdenticalTermsStillConverges(): Promise<void> {
  // The corner case the in-memory sentinel guards, proven live: a source's
  // bytes change (new content_hash + revision) while its extracted terms stay
  // identical, so the derivation node set — and thus derivation_hash — is
  // unchanged. The run takes the primitive's `unchanged` node path but MUST
  // refresh the anchor's stamped content_hash, or the source is re-selected on
  // every sweep forever.
  const src = await insertSource(pool, ns, { external_id: "same-terms-src" });
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
  expect(
    expectDefined(selectedBefore[0], "selectedBefore[0]").derived_content_hash,
  ).toBe(hashA);

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
}

async function snapshotGuardStaleRevisionDerivesNothing(): Promise<void> {
  const src = await insertSource(pool, ns, { external_id: "stale-src" });
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
}

describe("graph derivation handler selection and convergence (live Postgres)", () => {
  beforeEach(async () => {
    await cleanup(pool);
  });
  afterAll(async () => {
    await cleanup(pool);
    await pool.end();
  });

  it(
    "selects a new approved source, skips pending/retired/foreign, derives, then no-ops",
    selectsNewApprovedSourceThenNoOps,
  );
  it(
    "changed content hash is re-selected and derived without duplicating the anchor",
    changedHashReselectedWithoutDuplicatingAnchor,
  );
  it(
    "changed bytes but identical terms still converges (content_hash stamp refreshes)",
    changedBytesIdenticalTermsStillConverges,
  );
  it(
    "snapshot guard: a stale-revision job derives nothing against the live row",
    snapshotGuardStaleRevisionDerivesNothing,
  );
});
