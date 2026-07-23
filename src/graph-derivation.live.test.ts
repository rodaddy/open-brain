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
      `SELECT id, name FROM ob_entities
        WHERE namespace = $1 AND entity_type = $2 AND canonical_id = $3
          AND archived_at IS NULL`,
      [ns, anchorType, anchorCanonical],
    );
    expect(beforeRes.rows.length).toBe(1);
    const anchorIdBefore: string = beforeRes.rows[0].id;
    expect(beforeRes.rows[0].name).toBe("release plan");

    // Second derivation: SAME anchor (same canonical id), NEW display name, plus
    // a new term so the run takes the write path (a pure rename with identical
    // metadata short-circuits to `unchanged`). Pre-fix this raised
    // "duplicate key value violates unique constraint idx_ob_entities_canonical".
    const renamed = await deriveGraphFromMetadata(
      { query: pool.query.bind(pool) },
      auth,
      {
        anchorType,
        anchorId,
        anchorName: "Release Plan v2",
        namespace: ns,
        metadata: { topics: ["Migrations", "pgvector"], people: [] },
      },
    );
    expect(renamed.status).toBe("changed");

    // The canonical index still points at exactly one active row — the SAME id,
    // renamed in place. No duplicate anchor row, no unique violation.
    const afterRes = await pool.query(
      `SELECT id, name FROM ob_entities
        WHERE namespace = $1 AND entity_type = $2 AND canonical_id = $3
          AND archived_at IS NULL`,
      [ns, anchorType, anchorCanonical],
    );
    expect(afterRes.rows.length).toBe(1);
    expect(afterRes.rows[0].id).toBe(anchorIdBefore);
    expect(afterRes.rows[0].name).toBe("Release Plan v2");

    // Re-running the exact same (renamed) input is idempotent and content-free.
    const again = await deriveGraphFromMetadata(
      { query: pool.query.bind(pool) },
      auth,
      {
        anchorType,
        anchorId,
        anchorName: "Release Plan v2",
        namespace: ns,
        metadata: { topics: ["Migrations", "pgvector"], people: [] },
      },
    );
    expect(again.status).toBe("unchanged");
    expect(JSON.stringify(again)).not.toContain("Release Plan");
  });
});
