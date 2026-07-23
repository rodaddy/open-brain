import { afterAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { deriveGraphFromMetadata } from "./graph-derivation.ts";
import type { AuthInfo } from "./types.ts";

/**
 * Live-Postgres regression for the #346 P2 anchor-rename bug.
 *
 * The in-memory FakeGraph in graph-derivation.test.ts models both partial-unique
 * indexes by hand. This suite proves the fix against the REAL schema and REAL
 * partial-index arbitration: ob_entities carries
 *   idx_ob_entities_canonical    (namespace, entity_type, canonical_id)
 *     WHERE canonical_id IS NOT NULL AND archived_at IS NULL
 *   idx_ob_entities_lookup_unique(namespace, entity_type, lower(name))
 *     WHERE archived_at IS NULL
 * A rename of the same anchor (stable canonical id, new display name) must be a
 * safe in-place UPDATE and must not raise a 23505 on the canonical index.
 *
 * Env-gated exactly like search-brain-relational-retrieval.test.ts: skipped
 * unless OPENBRAIN_TEST_DATABASE_URL points at a migrated database.
 */
const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;

dbDescribe("deriveGraphFromMetadata anchor rename (live Postgres)", () => {
  const pool = new Pool({ connectionString: DB_URL });
  const ns = "test-graph-derivation-rename";
  const anchorType = "thought";
  const anchorId = "aa000000-0000-4000-8000-000000000346";
  const anchorCanonical = `${anchorType}:${anchorId}`;
  const auth: AuthInfo = {
    role: "admin",
    clientId: "test-graph-derivation",
    namespaceSource: "token",
  };

  async function cleanup(): Promise<void> {
    await pool.query("DELETE FROM ob_links WHERE namespace = $1", [ns]);
    await pool.query("DELETE FROM ob_entities WHERE namespace = $1", [ns]);
  }

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("renames the anchor in place without violating the canonical unique index", async () => {
    await cleanup();

    // First derivation: create the anchor under its original display name.
    const first = await deriveGraphFromMetadata(
      { query: pool.query.bind(pool) },
      auth,
      {
        anchorType,
        anchorId,
        anchorName: "release plan",
        namespace: ns,
        metadata: { topics: ["Migrations"], people: [] },
      },
    );
    expect(first.status).toBe("new");

    const beforeRes = await pool.query(
      `SELECT id, name, metadata ->> 'display_name' AS display_name
         FROM ob_entities
        WHERE namespace = $1 AND entity_type = $2 AND canonical_id = $3
          AND archived_at IS NULL`,
      [ns, anchorType, anchorCanonical],
    );
    expect(beforeRes.rows.length).toBe(1);
    const anchorIdBefore: string = beforeRes.rows[0].id;
    expect(beforeRes.rows[0].name).toBe(`release plan [${anchorCanonical}]`);
    expect(beforeRes.rows[0].display_name).toBe("release plan");

    // Second derivation: SAME anchor and derived terms, NEW display name only.
    // The derivation remains structurally `unchanged`, but the anchor's readable
    // storage name and exact display_name must still refresh in place.
    const renamed = await deriveGraphFromMetadata(
      { query: pool.query.bind(pool) },
      auth,
      {
        anchorType,
        anchorId,
        anchorName: "Release Plan v2",
        namespace: ns,
        metadata: { topics: ["Migrations"], people: [] },
      },
    );
    expect(renamed.status).toBe("unchanged");

    // The canonical index still points at exactly one active row — the SAME id,
    // renamed in place. No duplicate anchor row, no unique violation.
    const afterRes = await pool.query(
      `SELECT id, name, metadata ->> 'display_name' AS display_name
         FROM ob_entities
        WHERE namespace = $1 AND entity_type = $2 AND canonical_id = $3
          AND archived_at IS NULL`,
      [ns, anchorType, anchorCanonical],
    );
    expect(afterRes.rows.length).toBe(1);
    expect(afterRes.rows[0].id).toBe(anchorIdBefore);
    expect(afterRes.rows[0].name).toBe(`Release Plan v2 [${anchorCanonical}]`);
    expect(afterRes.rows[0].display_name).toBe("Release Plan v2");

    // Re-running the exact same (renamed) input is idempotent and content-free.
    const again = await deriveGraphFromMetadata(
      { query: pool.query.bind(pool) },
      auth,
      {
        anchorType,
        anchorId,
        anchorName: "Release Plan v2",
        namespace: ns,
        metadata: { topics: ["Migrations"], people: [] },
      },
    );
    expect(again.status).toBe("unchanged");
    expect(JSON.stringify(again)).not.toContain("Release Plan");
  });
});

/**
 * Live-Postgres regression for the #346 P2 duplicate-source-title collision.
 *
 * Two DISTINCT source anchors (distinct canonical ids) that share the same human
 * display title must both persist. Against the REAL idx_ob_entities_lookup_unique
 * (namespace, entity_type, lower(name)), storing the human title as the row name
 * makes the second anchor's INSERT raise a 23505 on that index (the canonical
 * upsert never arbitrates lower(name)). The fix stores a canonical-derived name
 * so lower(name) is unique exactly where canonical_id is, and preserves the
 * shared label in metadata.display_name.
 */
dbDescribe(
  "deriveGraphFromMetadata duplicate source titles (live Postgres)",
  () => {
    const pool = new Pool({ connectionString: DB_URL });
    const ns = "test-graph-derivation-dup-title";
    const anchorType = "source";
    const idA = "cc000000-0000-4000-8000-0000000003a1";
    const idB = "cc000000-0000-4000-8000-0000000003b2";
    const auth: AuthInfo = {
      role: "admin",
      clientId: "test-graph-derivation",
      namespaceSource: "token",
    };

    async function cleanup(): Promise<void> {
      await pool.query("DELETE FROM ob_links WHERE namespace = $1", [ns]);
      await pool.query("DELETE FROM ob_entities WHERE namespace = $1", [ns]);
    }

    afterAll(async () => {
      await cleanup();
      await pool.end();
    });

    it("stores two same-titled anchors without a lower(name) unique violation", async () => {
      await cleanup();
      const sharedTitle = "Q3 Release Plan";

      // First anchor: title T under canonical source:idA.
      const a = await deriveGraphFromMetadata(
        { query: pool.query.bind(pool) },
        auth,
        {
          anchorType,
          anchorId: idA,
          anchorName: sharedTitle,
          namespace: ns,
          metadata: { topics: ["Migrations"], people: [] },
        },
      );
      expect(a.status).toBe("new");

      // Second anchor: SAME title T under a DIFFERENT canonical source:idB.
      // Pre-fix this raised "duplicate key value violates unique constraint
      // idx_ob_entities_lookup_unique".
      const b = await deriveGraphFromMetadata(
        { query: pool.query.bind(pool) },
        auth,
        {
          anchorType,
          anchorId: idB,
          anchorName: sharedTitle,
          namespace: ns,
          metadata: { topics: ["Migrations"], people: [] },
        },
      );
      expect(b.status).toBe("new");

      // Both anchors persist as distinct active rows, each preserving the label.
      const anchors = await pool.query(
        `SELECT canonical_id, name, metadata ->> 'display_name' AS display_name
         FROM ob_entities
        WHERE namespace = $1 AND entity_type = $2
          AND canonical_id = ANY($3::text[]) AND archived_at IS NULL
        ORDER BY canonical_id`,
        [ns, anchorType, [`${anchorType}:${idA}`, `${anchorType}:${idB}`]],
      );
      expect(anchors.rows.length).toBe(2);
      for (const row of anchors.rows) {
        expect(row.display_name).toBe(sharedTitle);
      }
      // Stored names differ (canonical-derived), so lower(name) never collided.
      expect(anchors.rows[0].name).not.toBe(anchors.rows[1].name);
    });

    it("renames an anchor onto a sibling's title without a lower(name) collision", async () => {
      await cleanup();

      await deriveGraphFromMetadata({ query: pool.query.bind(pool) }, auth, {
        anchorType,
        anchorId: idA,
        anchorName: "Existing Title",
        namespace: ns,
        metadata: { topics: ["Migrations"], people: [] },
      });
      await deriveGraphFromMetadata({ query: pool.query.bind(pool) }, auth, {
        anchorType,
        anchorId: idB,
        anchorName: "Different Title",
        namespace: ns,
        metadata: { topics: ["Migrations"], people: [] },
      });

      // Rename B onto A's exact title, adding a term so the run takes the write
      // path. Pre-fix the rename would set name = "Existing Title" and collide
      // with A's row on lower(name).
      const renamed = await deriveGraphFromMetadata(
        { query: pool.query.bind(pool) },
        auth,
        {
          anchorType,
          anchorId: idB,
          anchorName: "Existing Title",
          namespace: ns,
          metadata: { topics: ["Migrations", "pgvector"], people: [] },
        },
      );
      expect(renamed.status).toBe("changed");

      const anchors = await pool.query(
        `SELECT canonical_id, metadata ->> 'display_name' AS display_name
         FROM ob_entities
        WHERE namespace = $1 AND entity_type = $2
          AND canonical_id = ANY($3::text[]) AND archived_at IS NULL
        ORDER BY canonical_id`,
        [ns, anchorType, [`${anchorType}:${idA}`, `${anchorType}:${idB}`]],
      );
      // Two distinct anchor rows, both now titled "Existing Title" via display_name.
      expect(anchors.rows.length).toBe(2);
      for (const row of anchors.rows) {
        expect(row.display_name).toBe("Existing Title");
      }
    });
  },
);

/**
 * Live-Postgres regression for the #346 stale-edge convergence bug.
 *
 * When an anchor's derived term set shrinks, the dropped term's anchor->term
 * `mentions` edge must be soft-deleted (archived_at set) so the search-brain
 * graph join (which filters archived_at IS NULL) stops returning it, while the
 * SHARED term entity node is left intact. A rerun of the shrunk set is a no-op.
 * Proven against the real partial-unique index and the real UPDATE semantics.
 */
dbDescribe("deriveGraphFromMetadata stale-edge prune (live Postgres)", () => {
  const pool = new Pool({ connectionString: DB_URL });
  const ns = "test-graph-derivation-prune";
  const anchorType = "thought";
  const anchorId = "bb000000-0000-4000-8000-000000000346";
  const anchorCanonical = `${anchorType}:${anchorId}`;
  const auth: AuthInfo = {
    role: "admin",
    clientId: "test-graph-derivation",
    namespaceSource: "token",
  };

  async function cleanup(): Promise<void> {
    await pool.query("DELETE FROM ob_links WHERE namespace = $1", [ns]);
    await pool.query("DELETE FROM ob_entities WHERE namespace = $1", [ns]);
  }

  async function anchorEntityId(): Promise<string> {
    const res = await pool.query(
      `SELECT id FROM ob_entities
        WHERE namespace = $1 AND entity_type = $2 AND canonical_id = $3
          AND archived_at IS NULL`,
      [ns, anchorType, anchorCanonical],
    );
    return res.rows[0].id as string;
  }

  async function topicId(name: string): Promise<string | undefined> {
    const res = await pool.query(
      `SELECT id FROM ob_entities
        WHERE namespace = $1 AND entity_type = 'topic' AND lower(name) = lower($2)
          AND archived_at IS NULL`,
      [ns, name],
    );
    return res.rows[0]?.id as string | undefined;
  }

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("archives the dropped term's edge, keeps the shared node, and no-ops on rerun", async () => {
    await cleanup();

    // Initial: topics [migrations, indexing] -> two live anchor->term edges.
    const first = await deriveGraphFromMetadata(
      { query: pool.query.bind(pool) },
      auth,
      {
        anchorType,
        anchorId,
        anchorName: "release plan",
        namespace: ns,
        metadata: { topics: ["migrations", "indexing"], people: [] },
      },
    );
    expect(first.status).toBe("new");
    expect(first.links_new).toBe(2);
    expect(first.links_archived).toBe(0);

    const anchor = await anchorEntityId();
    const indexingId = await topicId("indexing");
    expect(indexingId).toBeDefined();

    const liveBefore = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ob_links
        WHERE namespace = $1 AND from_id = $2 AND relation = 'mentions'
          AND archived_at IS NULL`,
      [ns, anchor],
    );
    expect(liveBefore.rows[0].n).toBe(2);

    // Changed: topics [migrations] -> the indexing edge is now stale.
    const changed = await deriveGraphFromMetadata(
      { query: pool.query.bind(pool) },
      auth,
      {
        anchorType,
        anchorId,
        anchorName: "release plan",
        namespace: ns,
        metadata: { topics: ["migrations"], people: [] },
      },
    );
    expect(changed.status).toBe("changed");
    expect(changed.links_archived).toBe(1);

    // The anchor->indexing edge is now archived (not hard-deleted).
    const staleEdge = await pool.query(
      `SELECT archived_at FROM ob_links
        WHERE namespace = $1 AND from_id = $2 AND to_id = $3
          AND relation = 'mentions'`,
      [ns, anchor, indexingId],
    );
    expect(staleEdge.rows.length).toBe(1);
    expect(staleEdge.rows[0].archived_at).not.toBeNull();

    // Exactly one live edge remains (anchor->migrations).
    const liveAfter = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ob_links
        WHERE namespace = $1 AND from_id = $2 AND relation = 'mentions'
          AND archived_at IS NULL`,
      [ns, anchor],
    );
    expect(liveAfter.rows[0].n).toBe(1);

    // The SHARED "indexing" entity node is untouched — only the link was pruned.
    const indexingStillLive = await topicId("indexing");
    expect(indexingStillLive).toBe(indexingId);

    // Rerun the SAME shrunk set: unchanged content, nothing new to prune.
    const again = await deriveGraphFromMetadata(
      { query: pool.query.bind(pool) },
      auth,
      {
        anchorType,
        anchorId,
        anchorName: "release plan",
        namespace: ns,
        metadata: { topics: ["migrations"], people: [] },
      },
    );
    expect(again.status).toBe("unchanged");
    expect(again.links_archived).toBe(0);

    // Still exactly one live edge; the archived edge did not revive.
    const liveFinal = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ob_links
        WHERE namespace = $1 AND from_id = $2 AND relation = 'mentions'
          AND archived_at IS NULL`,
      [ns, anchor],
    );
    expect(liveFinal.rows[0].n).toBe(1);
  });
});
