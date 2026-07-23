import { describe, expect, it } from "bun:test";
import {
  CrossNamespaceEndpointError,
  deriveGraphFromMetadata,
  type DeriveGraphInput,
  type GraphDerivationPool,
} from "./graph-derivation.ts";
import { logger } from "./logger.ts";
import type { AuthInfo } from "./types.ts";

/**
 * Capture every field the primitive hands the logger during `fn`, then restore
 * the real logger. Used by the content-free sentinel tests: the derivation
 * primitive must never emit a namespace value, a content/derivation hash value,
 * an anchor id, or any extracted term through observability. Only stable
 * categories (anchor_type / status) and structural counts may leave the server.
 */
async function captureLoggerFields(
  fn: () => Promise<void>,
): Promise<Record<string, unknown>[]> {
  const captured: Record<string, unknown>[] = [];
  const original = {
    info: logger.info,
    debug: logger.debug,
    warn: logger.warn,
    error: logger.error,
  };
  const record = (extra?: Record<string, unknown>) => {
    if (extra) captured.push(extra);
  };
  logger.info = (_m, extra) => record(extra);
  logger.debug = (_m, extra) => record(extra);
  logger.warn = (_m, extra) => record(extra);
  logger.error = (_m, extra) => record(extra);
  try {
    await fn();
  } finally {
    logger.info = original.info;
    logger.debug = original.debug;
    logger.warn = original.warn;
    logger.error = original.error;
  }
  return captured;
}

/** Postgres-style unique-violation surfaced when an unarbitrated index collides. */
class FakeUniqueViolation extends Error {
  code = "23505";
  constructor(public constraint: string) {
    super(`duplicate key value violates unique constraint "${constraint}"`);
    this.name = "FakeUniqueViolation";
  }
}

interface FakeEntityRow {
  id: string;
  namespace: string;
  entity_type: string;
  name: string;
  canonical_id: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Realistic in-memory stand-in for the ob_entities / ob_links graph.
 *
 * It models the graph as a flat row set and honors BOTH partial-unique indexes
 * migration 017 defines on ob_entities, not just one:
 *   - idx_ob_entities_lookup_unique (namespace, entity_type, lower(name))
 *     WHERE archived_at IS NULL
 *   - idx_ob_entities_canonical    (namespace, entity_type, canonical_id)
 *     WHERE canonical_id IS NOT NULL AND archived_at IS NULL
 * plus the (namespace, from,to,relation) link identity, all scoped to a single
 * namespace. An INSERT resolves the row addressed by its declared ON CONFLICT
 * arbiter; if the resulting row would collide on the OTHER unique index, that is
 * an UNARBITRATED violation and throws a 23505 exactly as Postgres would. This
 * is what lets the rename regression below observe the canonical-index breach
 * that a name-only fake would silently swallow. `is_new` mirrors `(xmax = 0)`.
 */
class FakeGraph implements GraphDerivationPool {
  rows: FakeEntityRow[] = [];
  // Link rows keyed by the (namespace, from, to, relation) live identity. The
  // stored value carries archived state so the prune UPDATE (soft-delete) and
  // the partial-unique WHERE archived_at IS NULL revive-on-conflict are both
  // observable, exactly like the real ob_links table under migration 017.
  links = new Map<
    string,
    {
      id: string;
      namespace: string;
      from_id: string;
      to_id: string;
      relation: string;
      archived: boolean;
    }
  >();
  calls: Array<{ sql: string; params: unknown[] }> = [];
  private seq = 0;

  private nextId(prefix: string): string {
    this.seq += 1;
    const n = String(this.seq).padStart(12, "0");
    return `00000000-0000-4000-8000-${n}` + prefix.slice(0, 0);
  }

  /** Active row matching the lower(name) partial-unique index, if any. */
  private byName(
    ns: string,
    type: string,
    name: string,
  ): FakeEntityRow | undefined {
    return this.rows.find(
      (r) =>
        r.namespace === ns &&
        r.entity_type === type &&
        r.name.toLowerCase() === name.toLowerCase(),
    );
  }

  /** Active row matching the canonical_id partial-unique index, if any. */
  private byCanonical(
    ns: string,
    type: string,
    canonical: string,
  ): FakeEntityRow | undefined {
    return this.rows.find(
      (r) =>
        r.namespace === ns &&
        r.entity_type === type &&
        r.canonical_id === canonical,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: GraphDerivationPool["query"] = (async (
    sql: string,
    params: unknown[] = [],
  ) => {
    this.calls.push({ sql, params });
    const text = String(sql);

    if (text.includes("SELECT metadata ->> 'derivation_hash'")) {
      const [ns, type, canonical] = params as [string, string, string];
      const found = this.byCanonical(ns, type, canonical);
      if (!found) return { rows: [] } as any;
      // Mirror the real SELECT: both hash keys read from the anchor metadata.
      // A jsonb ->> of an absent key is NULL, surfaced here as null.
      return {
        rows: [
          {
            derivation_hash: found.metadata["derivation_hash"] ?? null,
            content_hash: found.metadata["content_hash"] ?? null,
          },
        ],
      } as any;
    }

    // Content-hash refresh on the unchanged path: metadata || $4::jsonb merges
    // the new content_hash into the addressed anchor row without touching the
    // node/edge set. Mirrors the partial-index-scoped UPDATE.
    if (
      text.includes("UPDATE ob_entities") &&
      text.includes("metadata || $4::jsonb")
    ) {
      const [ns, type, canonical, patch] = params as [
        string,
        string,
        string,
        string,
      ];
      const row = this.byCanonical(ns, type, canonical);
      if (row) {
        row.metadata = {
          ...row.metadata,
          ...(JSON.parse(patch) as Record<string, unknown>),
        };
      }
      return { rows: [] } as any;
    }

    if (text.includes("INSERT INTO ob_entities")) {
      const [type, name, canonical, ns] = params as [
        string,
        string,
        string,
        string,
      ];
      // The anchor INSERT binds metadata as $5::jsonb; the derived-entity INSERT
      // uses an inline '{}'::jsonb literal and has no metadata param. Detect by
      // the SQL shape so we read the right slot.
      const meta = text.includes("$5::jsonb")
        ? (JSON.parse(params[4] as string) as Record<string, unknown>)
        : {};
      // Which partial-unique index does this INSERT arbitrate on?
      const arbitratesCanonical = text.includes(
        "ON CONFLICT (namespace, entity_type, canonical_id)",
      );
      const conflictRow = arbitratesCanonical
        ? this.byCanonical(ns, type, canonical)
        : this.byName(ns, type, name);

      if (conflictRow) {
        // DO UPDATE on the arbitrated row. The anchor upsert sets name = EXCLUDED.name;
        // the derived-term upsert leaves name as-is. Then re-check the OTHER index.
        if (arbitratesCanonical) conflictRow.name = name;
        conflictRow.metadata = { ...conflictRow.metadata, ...meta };
        // Post-update: the updated row must not collide with a DIFFERENT active row
        // on either unique index (mirrors a real UPDATE hitting the other constraint).
        const nameClash = this.byName(ns, type, conflictRow.name);
        if (nameClash && nameClash !== conflictRow) {
          throw new FakeUniqueViolation("idx_ob_entities_lookup_unique");
        }
        return {
          rows: [
            {
              id: conflictRow.id,
              is_new: false,
              namespace: conflictRow.namespace,
            },
          ],
        } as any;
      }

      // No arbitrated conflict -> INSERT. Postgres still enforces the OTHER
      // partial-unique index; a colliding row there is an unarbitrated violation.
      const canonicalClash = this.byCanonical(ns, type, canonical);
      if (canonicalClash) {
        throw new FakeUniqueViolation("idx_ob_entities_canonical");
      }
      const nameClash = this.byName(ns, type, name);
      if (nameClash) {
        throw new FakeUniqueViolation("idx_ob_entities_lookup_unique");
      }
      const id = this.nextId("e");
      this.rows.push({
        id,
        namespace: ns,
        entity_type: type,
        name,
        canonical_id: canonical,
        metadata: meta,
      });
      return { rows: [{ id, is_new: true, namespace: ns }] } as any;
    }

    if (text.includes("INSERT INTO ob_links")) {
      const [fromId, toId, relation, ns] = params as [
        string,
        string,
        string,
        string,
      ];
      const key = `${ns}|entity|${fromId}|entity|${toId}|${relation}`;
      const existing = this.links.get(key);
      if (existing) {
        // The ON CONFLICT ... WHERE archived_at IS NULL arbiter only matches a
        // LIVE edge. A previously-archived edge with the same identity is not
        // seen by the partial index, so the DO UPDATE revives it (archived_at =
        // NULL) — modeled here by clearing the archived flag. `xmax = 0` on a
        // conflict-resolved row is false either way (not a fresh insert).
        existing.archived = false;
        return {
          rows: [
            { id: existing.id, is_new: false, namespace: existing.namespace },
          ],
        } as any;
      }
      const id = this.nextId("l");
      this.links.set(key, {
        id,
        namespace: ns,
        from_id: fromId,
        to_id: toId,
        relation,
        archived: false,
      });
      return { rows: [{ id, is_new: true, namespace: ns }] } as any;
    }

    // Stale-edge prune (#346): soft-delete this anchor's live `mentions` edges
    // whose target dropped out of the derived set. Scoped by exact namespace +
    // anchor identity (from_type/from_id) + relation; the surviving-target list
    // is a bound uuid[] compared with NOT (to_id = ANY(...)). Returns the rows
    // it archived so the primitive can count and same-namespace-verify them.
    if (
      text.includes("UPDATE ob_links") &&
      text.includes("SET archived_at = NOW()")
    ) {
      const [ns, fromId, relation, survivors] = params as [
        string,
        string,
        string,
        string[],
      ];
      const keep = new Set(survivors);
      const archived: Array<{ namespace: string }> = [];
      for (const link of this.links.values()) {
        if (
          link.namespace === ns &&
          link.from_id === fromId &&
          link.relation === relation &&
          !link.archived &&
          !keep.has(link.to_id)
        ) {
          link.archived = true;
          archived.push({ namespace: link.namespace });
        }
      }
      return { rows: archived } as any;
    }

    throw new Error(`unexpected sql: ${text.slice(0, 60)}`);
  }) as any;
}

const auth: AuthInfo = {
  role: "admin",
  clientId: "skippy",
  namespaceSource: "token",
};

function baseInput(
  overrides: Partial<DeriveGraphInput> = {},
): DeriveGraphInput {
  return {
    anchorType: "thought",
    anchorId: "11111111-1111-4111-8111-111111111111",
    anchorName: "release plan",
    namespace: "team-kb",
    metadata: { topics: ["Migrations", "pgvector"], people: ["Rico"] },
    ...overrides,
  };
}

describe("deriveGraphFromMetadata", () => {
  it("status=new: derives anchor + entities + edges on first run", async () => {
    const g = new FakeGraph();
    const receipt = await deriveGraphFromMetadata(g, auth, baseInput());

    expect(receipt.status).toBe("new");
    expect(receipt.previous_hash).toBeUndefined();
    // anchor + 2 topics + 1 person = 4 entity upserts, all new.
    expect(receipt.entities_upserted).toBe(4);
    expect(receipt.entities_new).toBe(4);
    // 3 anchor->term edges.
    expect(receipt.links_upserted).toBe(3);
    expect(receipt.links_new).toBe(3);
    // content-free: no topic/person/anchor text in the receipt.
    expect(JSON.stringify(receipt)).not.toContain("Migrations");
    expect(JSON.stringify(receipt)).not.toContain("Rico");
    expect(JSON.stringify(receipt)).not.toContain("release plan");
  });

  it("status=unchanged: identical metadata re-run skips all writes (idempotent)", async () => {
    const g = new FakeGraph();
    await deriveGraphFromMetadata(g, auth, baseInput());
    const callsAfterFirst = g.calls.length;

    const receipt = await deriveGraphFromMetadata(g, auth, baseInput());
    expect(receipt.status).toBe("unchanged");
    expect(receipt.entities_upserted).toBe(0);
    expect(receipt.links_upserted).toBe(0);
    // Only the prior-hash SELECT ran; no INSERTs after the short-circuit.
    expect(g.calls.length).toBe(callsAfterFirst + 1);
    expect(g.calls.at(-1)?.sql).toContain(
      "SELECT metadata ->> 'derivation_hash'",
    );
  });

  it("rerun is graph-stable: forced re-derive with identical content adds no duplicates", async () => {
    const g = new FakeGraph();
    const first = await deriveGraphFromMetadata(g, auth, baseInput());
    // Simulate a stale prior derivation (e.g. an older hash version) so the
    // next run takes the "changed" branch even though the content is identical.
    // The anchor is addressed by its stable canonical id, not its display name.
    const anchorCanonical = "thought:11111111-1111-4111-8111-111111111111";
    const anchorRow = g.rows.find((r) => r.canonical_id === anchorCanonical)!;
    anchorRow.metadata = { derivation_hash: "stale-prior-hash" };
    const second = await deriveGraphFromMetadata(g, auth, baseInput());

    expect(second.status).toBe("changed");
    expect(second.previous_hash).toBe("stale-prior-hash");
    // Content is unchanged, so the re-derivation hash equals the first run's.
    expect(second.derivation_hash).toBe(first.derivation_hash);
    // Re-derivation upserts the same 4 entities / 3 links but none are new.
    expect(second.entities_upserted).toBe(4);
    expect(second.entities_new).toBe(0);
    expect(second.links_upserted).toBe(3);
    expect(second.links_new).toBe(0);
    // Graph size unchanged: no duplicate nodes or edges appeared.
    expect(g.links.size).toBe(3);
  });

  it("anchor rename: stable canonical id survives a display-name change without a unique violation", async () => {
    // Regression for #346 P2. The anchor's identity is its canonical id
    // (anchorType:anchorId), which is stable across runs, while the display name
    // can change (the thought was retitled). ob_entities carries two partial-
    // unique indexes and the anchor row must stay unique under BOTH:
    //   idx_ob_entities_canonical    (namespace, entity_type, canonical_id)
    //   idx_ob_entities_lookup_unique(namespace, entity_type, lower(name))
    // Arbitrating the anchor upsert on lower(name) would find no match after a
    // rename, attempt an INSERT, and violate the canonical index (23505). We
    // arbitrate on the canonical index so the rename is an in-place UPDATE.
    const g = new FakeGraph();
    const first = await deriveGraphFromMetadata(
      g,
      auth,
      baseInput({
        anchorName: "release plan",
        metadata: { topics: ["Migrations"], people: [] },
      }),
    );
    expect(first.status).toBe("new");

    const anchorCanonical = "thought:11111111-1111-4111-8111-111111111111";
    const before = g.rows.find((r) => r.canonical_id === anchorCanonical)!;
    const anchorIdBefore = before.id;
    // The stored name keeps the human label readable and appends the stable
    // canonical identity so lower(name) remains collision-safe.
    expect(before.name).toBe(`release plan [${anchorCanonical}]`);
    expect(before.metadata["display_name"]).toBe("release plan");
    const rowCountBefore = g.rows.length;

    // Re-derive the SAME anchor (same canonical id) under a NEW display name.
    // A pure rename with identical metadata short-circuits to `unchanged` (name
    // is not part of the derivation hash), so the collision only manifests on a
    // run that is ALSO a content change — the realistic P2 trigger. We add a
    // term so the run takes the write path. The fake throws a FakeUniqueViolation
    // on any unarbitrated index collision, so this resolving cleanly is the proof
    // the canonical arbiter is correct.
    const renamed = await deriveGraphFromMetadata(
      g,
      auth,
      baseInput({
        anchorName: "Release Plan v2",
        metadata: { topics: ["Migrations", "pgvector"], people: [] },
      }),
    );

    expect(renamed.status).toBe("changed");
    // The anchor row was UPDATED in place (same id), not duplicated. Both the
    // readable prefix and metadata display label follow the rename while the
    // canonical suffix keeps the stored name unique.
    const after = g.rows.find((r) => r.canonical_id === anchorCanonical)!;
    expect(after.id).toBe(anchorIdBefore);
    expect(after.name).toBe(`Release Plan v2 [${anchorCanonical}]`);
    expect(after.metadata["display_name"]).toBe("Release Plan v2");
    // Exactly one new row appeared: the added "pgvector" term. The anchor did
    // not duplicate — it was renamed in place.
    expect(g.rows.length).toBe(rowCountBefore + 1);
    expect(after.metadata["derivation_hash"]).toBe(renamed.derivation_hash);
  });

  it("duplicate source titles: two distinct anchors with the same display title coexist (no lower(name) collision)", async () => {
    // Regression for #346 P2. Two DISTINCT source anchors (distinct canonical
    // ids source:<id1> / source:<id2>) that share the same human display title
    // must both persist. Pre-fix the stored `name` WAS the title, so the second
    // anchor found no canonical conflict, attempted an INSERT, and collided on
    // idx_ob_entities_lookup_unique (namespace, entity_type, lower(name)) — a
    // 23505 that threw the whole derivation. The fix stores anchorStorageName
    // (canonical-derived), so lower(name) is unique exactly where canonical_id
    // is; the shared title lives in metadata.display_name on each anchor.
    const g = new FakeGraph();
    const sharedTitle = "Q3 Release Plan";
    const idA = "aaaaaaaa-1111-4111-8111-111111111111";
    const idB = "bbbbbbbb-2222-4222-8222-222222222222";

    const a = await deriveGraphFromMetadata(
      g,
      auth,
      baseInput({
        anchorType: "source",
        anchorId: idA,
        anchorName: sharedTitle,
        metadata: { topics: ["Migrations"], people: [] },
      }),
    );
    // The second source shares the exact title but is a different canonical id.
    // Pre-fix this call threw FakeUniqueViolation("idx_ob_entities_lookup_unique").
    const b = await deriveGraphFromMetadata(
      g,
      auth,
      baseInput({
        anchorType: "source",
        anchorId: idB,
        anchorName: sharedTitle,
        metadata: { topics: ["Migrations"], people: [] },
      }),
    );
    expect(a.status).toBe("new");
    expect(b.status).toBe("new");

    const anchorA = g.rows.find((r) => r.canonical_id === `source:${idA}`)!;
    const anchorB = g.rows.find((r) => r.canonical_id === `source:${idB}`)!;
    // Two distinct anchor rows survive; their stored names differ (canonical-
    // derived) so lower(name) never collides, and both preserve the shared label.
    expect(anchorA.id).not.toBe(anchorB.id);
    expect(anchorA.name).not.toBe(anchorB.name);
    expect(anchorA.name).toBe(`${sharedTitle} [source:${idA}]`);
    expect(anchorB.name).toBe(`${sharedTitle} [source:${idB}]`);
    expect(anchorA.metadata["display_name"]).toBe(sharedTitle);
    expect(anchorB.metadata["display_name"]).toBe(sharedTitle);
  });

  it("rename-to-existing-title: renaming an anchor onto a sibling's display title does not collide", async () => {
    // Regression for #346 P2. Anchor B is renamed so its display title becomes
    // IDENTICAL to anchor A's, on a run that also changes B's term set (the
    // realistic write-path trigger). Pre-fix the stored name would become the
    // title and collide with A on lower(name); with the fix the stored name is
    // canonical-derived and stable, so the rename is a clean in-place UPDATE and
    // only display_name converges on the shared label.
    const g = new FakeGraph();
    const idA = "aaaaaaaa-3333-4333-8333-333333333333";
    const idB = "bbbbbbbb-4444-4444-8444-444444444444";

    await deriveGraphFromMetadata(
      g,
      auth,
      baseInput({
        anchorType: "source",
        anchorId: idA,
        anchorName: "Existing Title",
        metadata: { topics: ["Migrations"], people: [] },
      }),
    );
    await deriveGraphFromMetadata(
      g,
      auth,
      baseInput({
        anchorType: "source",
        anchorId: idB,
        anchorName: "Different Title",
        metadata: { topics: ["Migrations"], people: [] },
      }),
    );

    // Rename B onto A's title, adding a term so the run takes the write path.
    const renamed = await deriveGraphFromMetadata(
      g,
      auth,
      baseInput({
        anchorType: "source",
        anchorId: idB,
        anchorName: "Existing Title",
        metadata: { topics: ["Migrations", "pgvector"], people: [] },
      }),
    );
    expect(renamed.status).toBe("changed");

    const anchorA = g.rows.find((r) => r.canonical_id === `source:${idA}`)!;
    const anchorB = g.rows.find((r) => r.canonical_id === `source:${idB}`)!;
    // Both anchors now carry the SAME display title, yet remain distinct rows
    // with distinct stored names — no lower(name) collision on the rename.
    expect(anchorA.metadata["display_name"]).toBe("Existing Title");
    expect(anchorB.metadata["display_name"]).toBe("Existing Title");
    expect(anchorA.id).not.toBe(anchorB.id);
    expect(anchorB.name).toBe(`Existing Title [source:${idB}]`);
  });

  it("anchor rename: the old lower(name)-only arbiter would raise a canonical unique violation", async () => {
    // Proves the fake genuinely models the canonical index the fix targets: an
    // INSERT that arbitrates ONLY on lower(name) (the pre-fix anchor shape) hits
    // idx_ob_entities_canonical when the same canonical id already exists under a
    // different name. This test fails on the OLD behavior and documents the exact
    // constraint the fix avoids.
    const g = new FakeGraph();
    const ns = "team-kb";
    const type = "thought";
    const canonical = "thought:renamed-anchor";

    // Seed an active anchor row via the canonical-arbiter upsert (the fixed shape).
    await g.query(
      `INSERT INTO ob_entities
         (entity_type, name, canonical_id, namespace, metadata, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (namespace, entity_type, canonical_id)
       WHERE canonical_id IS NOT NULL AND archived_at IS NULL
       DO UPDATE SET name = EXCLUDED.name, metadata = ob_entities.metadata || EXCLUDED.metadata,
         archived_at = NULL, updated_at = NOW()
       RETURNING id, (xmax = 0) AS is_new, namespace`,
      [type, "Old Name", canonical, ns, "{}", "skippy"],
    );

    // Now replay the PRE-FIX anchor upsert: same canonical id, a new name, but
    // arbitrating on lower(name). No name match -> INSERT -> canonical collision.
    await expect(
      g.query(
        `INSERT INTO ob_entities
           (entity_type, name, canonical_id, namespace, metadata, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (namespace, entity_type, lower(name))
         WHERE archived_at IS NULL
         DO UPDATE SET canonical_id = COALESCE(EXCLUDED.canonical_id, ob_entities.canonical_id),
           metadata = ob_entities.metadata || EXCLUDED.metadata, archived_at = NULL, updated_at = NOW()
         RETURNING id, (xmax = 0) AS is_new, namespace`,
        [type, "New Name", canonical, ns, "{}", "skippy"],
      ),
    ).rejects.toThrow("idx_ob_entities_canonical");
  });

  it("status=changed: new metadata term adds a node and reports previous hash", async () => {
    const g = new FakeGraph();
    const first = await deriveGraphFromMetadata(g, auth, baseInput());

    const changed = await deriveGraphFromMetadata(
      g,
      auth,
      baseInput({
        metadata: {
          topics: ["Migrations", "pgvector", "halfvec"],
          people: ["Rico"],
        },
      }),
    );
    expect(changed.status).toBe("changed");
    expect(changed.previous_hash).toBe(first.derivation_hash);
    expect(changed.derivation_hash).not.toBe(first.derivation_hash);
    // anchor + 3 topics + 1 person = 5; only the "halfvec" node is new.
    expect(changed.entities_upserted).toBe(5);
    expect(changed.entities_new).toBe(1);
    expect(changed.links_new).toBe(1);
  });

  it("stale-edge prune: a dropped term's anchor->term edge is archived and stays gone on rerun", async () => {
    // Regression for #346 stale-edge convergence. Initial derivation has two
    // topics; the second derivation drops one. The dropped topic's ENTITY NODE
    // is shared and must survive (another anchor may reference it), but the
    // obsolete anchor->term `mentions` EDGE must be soft-deleted so the
    // search-brain graph join (archived_at IS NULL) stops returning it. A third
    // derivation with the same shrunk set must be a no-op — nothing new to prune.
    const g = new FakeGraph();
    const anchorCanonical = "thought:11111111-1111-4111-8111-111111111111";

    // Initial: topics [migrations, indexing] -> 2 live anchor->term edges.
    const first = await deriveGraphFromMetadata(
      g,
      auth,
      baseInput({
        metadata: { topics: ["migrations", "indexing"], people: [] },
      }),
    );
    expect(first.status).toBe("new");
    expect(first.links_new).toBe(2);
    expect(first.links_archived).toBe(0);

    const anchorRow = g.rows.find((r) => r.canonical_id === anchorCanonical)!;
    const indexingRow = g.rows.find(
      (r) => r.entity_type === "topic" && r.name === "indexing",
    )!;
    const indexingKey = `team-kb|entity|${anchorRow.id}|entity|${indexingRow.id}|mentions`;
    // Both edges start live.
    expect([...g.links.values()].filter((l) => !l.archived).length).toBe(2);
    expect(g.links.get(indexingKey)?.archived).toBe(false);

    // Changed: topics [migrations] -> the indexing edge is now stale.
    const changed = await deriveGraphFromMetadata(
      g,
      auth,
      baseInput({ metadata: { topics: ["migrations"], people: [] } }),
    );
    expect(changed.status).toBe("changed");
    // Exactly one edge archived: anchor->indexing. The migrations edge stays.
    expect(changed.links_archived).toBe(1);
    // The shared "indexing" ENTITY NODE is NOT archived — only the link is.
    expect(
      g.rows.find((r) => r.entity_type === "topic" && r.name === "indexing"),
    ).toBeDefined();
    // The stale edge is no longer live; the migrations edge still is.
    expect(g.links.get(indexingKey)?.archived).toBe(true);
    expect([...g.links.values()].filter((l) => !l.archived).length).toBe(1);

    // Rerun the SAME shrunk set: unchanged content => no re-prune, no re-derive.
    const again = await deriveGraphFromMetadata(
      g,
      auth,
      baseInput({ metadata: { topics: ["migrations"], people: [] } }),
    );
    expect(again.status).toBe("unchanged");
    expect(again.links_archived).toBe(0);
    // Still exactly one live edge; the archived indexing edge did not revive.
    expect([...g.links.values()].filter((l) => !l.archived).length).toBe(1);
    expect(g.links.get(indexingKey)?.archived).toBe(true);
  });

  it("stale-edge prune: only THIS anchor's edges are touched, never a sibling anchor's", async () => {
    // The prune predicate is scoped by from_id = the derived anchor's entity id.
    // A different anchor that also mentions the dropped term must keep its edge
    // live: the prune deactivates obsolete anchor->term links for one anchor
    // only, never a shared node or a sibling anchor's edge.
    const g = new FakeGraph();
    const otherAnchorId = "22222222-2222-4222-8222-222222222222";

    // Anchor A and Anchor B both mention "indexing".
    await deriveGraphFromMetadata(
      g,
      auth,
      baseInput({
        metadata: { topics: ["migrations", "indexing"], people: [] },
      }),
    );
    await deriveGraphFromMetadata(
      g,
      auth,
      baseInput({
        anchorId: otherAnchorId,
        // A distinct display name: two anchor entities of the same type cannot
        // share (namespace, entity_type, lower(name)) under the lookup index.
        anchorName: "sibling plan",
        metadata: { topics: ["indexing"], people: [] },
      }),
    );
    const liveBefore = [...g.links.values()].filter((l) => !l.archived).length;
    expect(liveBefore).toBe(3); // A->migrations, A->indexing, B->indexing

    // Anchor A drops "indexing". Only A->indexing is archived; B->indexing lives.
    const anchorA = g.rows.find(
      (r) => r.canonical_id === "thought:11111111-1111-4111-8111-111111111111",
    )!;
    const anchorB = g.rows.find(
      (r) => r.canonical_id === `thought:${otherAnchorId}`,
    )!;
    const indexingRow = g.rows.find(
      (r) => r.entity_type === "topic" && r.name === "indexing",
    )!;

    const changed = await deriveGraphFromMetadata(
      g,
      auth,
      baseInput({ metadata: { topics: ["migrations"], people: [] } }),
    );
    expect(changed.links_archived).toBe(1);

    const aIndexing = g.links.get(
      `team-kb|entity|${anchorA.id}|entity|${indexingRow.id}|mentions`,
    );
    const bIndexing = g.links.get(
      `team-kb|entity|${anchorB.id}|entity|${indexingRow.id}|mentions`,
    );
    expect(aIndexing?.archived).toBe(true);
    expect(bIndexing?.archived).toBe(false);
  });

  it("case-insensitive identity: 'Rico' and 'rico' collapse to one node", async () => {
    const g = new FakeGraph();
    const receipt = await deriveGraphFromMetadata(
      g,
      auth,
      baseInput({
        metadata: { topics: [], people: ["Rico", "rico", " RICO "] },
      }),
    );
    // anchor + 1 person node.
    expect(receipt.entities_upserted).toBe(2);
    expect(receipt.links_upserted).toBe(1);
  });

  it("SQL predicate: every persisted write binds namespace as a parameter", async () => {
    const g = new FakeGraph();
    await deriveGraphFromMetadata(g, auth, baseInput());

    const writes = g.calls.filter((c) => c.sql.includes("INSERT INTO ob_"));
    expect(writes.length).toBeGreaterThan(0);
    for (const call of writes) {
      // Namespace-scoped conflict target on the exact partial-unique indexes.
      if (call.sql.includes("ob_entities")) {
        // The anchor upsert (identified by its $5::jsonb metadata bind) arbitrates
        // on the canonical partial-unique index so a rename is a safe UPDATE and
        // never violates idx_ob_entities_canonical. Derived-term upserts arbitrate
        // on lower(name) since their canonical is name-derived.
        if (call.sql.includes("$5::jsonb")) {
          expect(call.sql).toContain(
            "ON CONFLICT (namespace, entity_type, canonical_id)",
          );
          expect(call.sql).toContain(
            "WHERE canonical_id IS NOT NULL AND archived_at IS NULL",
          );
        } else {
          expect(call.sql).toContain(
            "ON CONFLICT (namespace, entity_type, lower(name))",
          );
          expect(call.sql).toContain("WHERE archived_at IS NULL");
        }
      } else {
        expect(call.sql).toContain(
          "ON CONFLICT (namespace, from_type, from_id, to_type, to_id, relation)",
        );
      }
      // namespace value is passed as a bound param, never interpolated.
      expect(call.params).toContain("team-kb");
    }
  });

  it("cross-namespace negative: unwritable namespace is rejected before any write", async () => {
    const g = new FakeGraph();
    const readonly: AuthInfo = { role: "readonly", clientId: "viewer" };
    await expect(
      deriveGraphFromMetadata(g, readonly, baseInput({ namespace: "team-kb" })),
    ).rejects.toBeInstanceOf(CrossNamespaceEndpointError);
    // No SQL issued at all — fail-closed before touching the graph.
    expect(g.calls.length).toBe(0);
  });

  it("cross-namespace negative: header-bound identity cannot derive into a foreign namespace", async () => {
    const g = new FakeGraph();
    const delegated: AuthInfo = {
      role: "agent",
      clientId: "tenant-a",
      namespaceSource: "header",
    };
    await expect(
      deriveGraphFromMetadata(
        g,
        delegated,
        baseInput({ namespace: "tenant-b" }),
      ),
    ).rejects.toBeInstanceOf(CrossNamespaceEndpointError);
    expect(g.calls.length).toBe(0);
  });

  it("cross-namespace negative: a row persisted under a foreign namespace aborts", async () => {
    const g = new FakeGraph();
    // Simulate schema drift: the entity INSERT returns a different namespace.
    const originalQuery = g.query;
    g.query = (async (sql: string, params: unknown[] = []) => {
      const res = await originalQuery(sql, params);
      if (String(sql).includes("INSERT INTO ob_entities")) {
        return { rows: [{ ...res.rows[0], namespace: "evil-ns" }] } as any;
      }
      return res;
    }) as any;

    await expect(
      deriveGraphFromMetadata(g, auth, baseInput()),
    ).rejects.toBeInstanceOf(CrossNamespaceEndpointError);
  });

  it("graph-search regression: derived edges match the relationalGraphSearch join shape", async () => {
    // The existing search-brain relational-graph join (tools/search-brain.ts)
    // seeds on an ob_entities row, then joins ob_links with:
    //   l.namespace = seed.namespace AND l.relation = $2 AND l.archived_at IS NULL
    //   AND l.from_id = seed.id (outbound direction)
    // then joins the target entity in the SAME namespace. This asserts every
    // edge we persist satisfies that join so derived edges stay retrievable and
    // never leak across the namespace boundary the join relies on.
    const g = new FakeGraph();
    await deriveGraphFromMetadata(g, auth, baseInput());

    const linkWrites = g.calls.filter((c) =>
      c.sql.includes("INSERT INTO ob_links"),
    );
    expect(linkWrites.length).toBe(3);

    const anchorInsert = g.calls.find(
      (c) =>
        c.sql.includes("INSERT INTO ob_entities") &&
        c.sql.includes("$5::jsonb"),
    );
    const anchorId = "00000000-0000-4000-8000-000000000001"; // first minted id

    for (const call of linkWrites) {
      const [fromId, toId, relation, ns] = call.params as [
        string,
        string,
        string,
        string,
      ];
      // Outbound from the anchor seed, same namespace on both endpoints.
      expect(fromId).toBe(anchorId);
      expect(ns).toBe("team-kb");
      // relation is the value the join filters on ($2); it is a bound param.
      expect(relation).toBe("mentions");
      // Endpoints are entity nodes (the join hydrates ob_entities targets).
      expect(call.sql).toContain("VALUES ('entity', $1, 'entity', $2,");
      // No self-edge (would violate the CHECK and the seed<>target join).
      expect(fromId).not.toBe(toId);
    }
    // The seed row the join matches on is the anchor entity, namespace-scoped.
    expect(anchorInsert?.params).toContain("team-kb");
    // Every target term was persisted in the derivation namespace, so the
    // target-entity same-namespace join can reach it.
    for (const row of g.rows) {
      if (row.namespace !== "team-kb") {
        throw new Error(
          `entity persisted outside derivation namespace: ${row.namespace}`,
        );
      }
    }
  });

  it("stamps anchorContentHash on the anchor so the maintenance sweep can converge", async () => {
    // Regression: the maintenance selection compares a source's content_hash to
    // the value stamped on its anchor. If the primitive never stamped it, the
    // sweep would re-select the same source forever. Assert the write path
    // records content_hash (distinct from derivation_hash) on the anchor row.
    const g = new FakeGraph();
    await deriveGraphFromMetadata(
      g,
      auth,
      baseInput({ anchorContentHash: "c".repeat(64) }),
    );
    const anchorCanonical = "thought:11111111-1111-4111-8111-111111111111";
    const anchor = g.rows.find((r) => r.canonical_id === anchorCanonical)!;
    expect(anchor.metadata["content_hash"]).toBe("c".repeat(64));
    // derivation_hash and content_hash are distinct keys, distinct values.
    expect(anchor.metadata["derivation_hash"]).not.toBe("c".repeat(64));
  });

  it("unchanged terms but changed source bytes: refreshes the stamped content_hash", async () => {
    // The convergence corner case: a source's bytes change (new content_hash)
    // while its extracted terms stay identical (same derivation_hash). The run
    // takes the `unchanged` node path but MUST refresh the anchor content_hash,
    // or the sweep re-selects this source on every pass.
    const g = new FakeGraph();
    await deriveGraphFromMetadata(
      g,
      auth,
      baseInput({ anchorContentHash: "a".repeat(64) }),
    );
    const anchorCanonical = "thought:11111111-1111-4111-8111-111111111111";
    const anchor = g.rows.find((r) => r.canonical_id === anchorCanonical)!;
    expect(anchor.metadata["content_hash"]).toBe("a".repeat(64));
    const callsAfterFirst = g.calls.length;

    // Same metadata (=> same derivation_hash, `unchanged`), new content hash.
    const receipt = await deriveGraphFromMetadata(
      g,
      auth,
      baseInput({ anchorContentHash: "b".repeat(64) }),
    );
    expect(receipt.status).toBe("unchanged");
    // No node/edge INSERTs — only the prior-hash SELECT and the stamp UPDATE.
    expect(receipt.entities_upserted).toBe(0);
    expect(receipt.links_upserted).toBe(0);
    expect(g.calls.length).toBe(callsAfterFirst + 2);
    expect(g.calls.at(-1)?.sql).toContain("UPDATE ob_entities");
    // The stamp now reflects the new source bytes; the sweep will skip it.
    expect(anchor.metadata["content_hash"]).toBe("b".repeat(64));
    // derivation_hash is untouched (terms unchanged).
    expect(receipt.derivation_hash).toBe(
      anchor.metadata["derivation_hash"] as string,
    );
  });

  it("unchanged terms AND unchanged source bytes: a true no-op, no stamp UPDATE", async () => {
    // When neither terms nor bytes changed, the unchanged path must not issue a
    // superfluous UPDATE — the whole point of the content-hash short-circuit.
    const g = new FakeGraph();
    await deriveGraphFromMetadata(
      g,
      auth,
      baseInput({ anchorContentHash: "a".repeat(64) }),
    );
    const callsAfterFirst = g.calls.length;
    const receipt = await deriveGraphFromMetadata(
      g,
      auth,
      baseInput({ anchorContentHash: "a".repeat(64) }),
    );
    expect(receipt.status).toBe("unchanged");
    // Exactly one extra call: the prior-hash SELECT. No stamp UPDATE.
    expect(g.calls.length).toBe(callsAfterFirst + 1);
    expect(g.calls.at(-1)?.sql).toContain(
      "SELECT metadata ->> 'derivation_hash'",
    );
  });

  it("content-free: anchorContentHash never leaks source text into the receipt", async () => {
    const g = new FakeGraph();
    const receipt = await deriveGraphFromMetadata(
      g,
      auth,
      baseInput({
        anchorContentHash: "d".repeat(64),
        metadata: { topics: ["Migrations"], people: ["Rico"] },
      }),
    );
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain("Migrations");
    expect(serialized).not.toContain("Rico");
    expect(serialized).not.toContain("release plan");
  });

  it("empty metadata: derives only the anchor node, no edges", async () => {
    const g = new FakeGraph();
    const receipt = await deriveGraphFromMetadata(
      g,
      auth,
      baseInput({ metadata: {} }),
    );
    expect(receipt.status).toBe("new");
    expect(receipt.entities_upserted).toBe(1);
    expect(receipt.links_upserted).toBe(0);
  });

  it("content-free logs: a new/changed derivation never logs namespace, hash, id, or terms", async () => {
    const g = new FakeGraph();
    const sensitiveHash = "c".repeat(64);
    const fields = await captureLoggerFields(async () => {
      await deriveGraphFromMetadata(
        g,
        auth,
        baseInput({ anchorContentHash: sensitiveHash }),
      );
    });
    // Something WAS logged (the graph_derivation_ok line) so the assertion is real.
    expect(fields.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(fields);
    // Namespace value, both hash notions, the anchor id, and every extracted
    // term are all forbidden in observability.
    expect(serialized).not.toContain("team-kb");
    expect(serialized).not.toContain(sensitiveHash);
    expect(serialized).not.toContain("11111111-1111-4111-8111-111111111111");
    expect(serialized).not.toContain("Migrations");
    expect(serialized).not.toContain("pgvector");
    expect(serialized).not.toContain("Rico");
    expect(serialized).not.toContain("release plan");
    // A derivation_hash is a 64-char lowercase sha256 hex; none may appear in
    // any logged field, regardless of which hash it is.
    for (const entry of fields) {
      for (const value of Object.values(entry)) {
        if (typeof value === "string") {
          expect(value).not.toMatch(/^[0-9a-f]{64}$/);
        }
      }
    }
  });

  it("content-free logs: an unchanged short-circuit never logs namespace or hash", async () => {
    const g = new FakeGraph();
    const sensitiveHash = "e".repeat(64);
    // Prime the anchor so the second run takes the unchanged path.
    await deriveGraphFromMetadata(
      g,
      auth,
      baseInput({ anchorContentHash: sensitiveHash }),
    );
    const fields = await captureLoggerFields(async () => {
      const receipt = await deriveGraphFromMetadata(
        g,
        auth,
        baseInput({ anchorContentHash: sensitiveHash }),
      );
      expect(receipt.status).toBe("unchanged");
    });
    const serialized = JSON.stringify(fields);
    expect(serialized).not.toContain("team-kb");
    expect(serialized).not.toContain(sensitiveHash);
    expect(serialized).not.toContain("11111111-1111-4111-8111-111111111111");
    for (const entry of fields) {
      for (const value of Object.values(entry)) {
        if (typeof value === "string") {
          expect(value).not.toMatch(/^[0-9a-f]{64}$/);
        }
      }
    }
  });
});
