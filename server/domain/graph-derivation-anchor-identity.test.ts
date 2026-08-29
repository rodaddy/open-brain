/**
 * Anchor-identity coverage for `deriveGraphFromMetadata` (#346 P2): the anchor
 * is addressed by its stable canonical id while its display name is free to
 * change, so renames and duplicate titles never breach either partial-unique
 * index on ob_entities. Split out of graph-derivation.test.ts so each suite
 * stays a readable size.
 */
import { describe, expect, it } from "bun:test";
import { deriveGraphFromMetadata } from "./graph-derivation.ts";
import { expectDefined } from "../../scripts/test-support/expect-defined.ts";
import { auth, baseInput, FakeGraph } from "./graph-derivation-test-helpers.ts";

const ANCHOR_CANONICAL = "thought:11111111-1111-4111-8111-111111111111";

/** The anchor row addressed by `canonical`, asserted present. */
function anchorFor(g: FakeGraph, canonical: string) {
  return expectDefined(
    g.rows.find((r) => r.canonical_id === canonical),
    `anchor ${canonical}`,
  );
}

async function stableCanonicalIdSurvivesADisplayNameChange() {
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

  const before = anchorFor(g, ANCHOR_CANONICAL);
  const anchorIdBefore = before.id;
  // The stored name keeps the human label readable and appends the stable
  // canonical identity so lower(name) remains collision-safe.
  expect(before.name).toBe(`release plan [${ANCHOR_CANONICAL}]`);
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
  const after = anchorFor(g, ANCHOR_CANONICAL);
  expect(after.id).toBe(anchorIdBefore);
  expect(after.name).toBe(`Release Plan v2 [${ANCHOR_CANONICAL}]`);
  expect(after.metadata["display_name"]).toBe("Release Plan v2");
  // Exactly one new row appeared: the added "pgvector" term. The anchor did
  // not duplicate — it was renamed in place.
  expect(g.rows.length).toBe(rowCountBefore + 1);
  expect(after.metadata["derivation_hash"]).toBe(renamed.derivation_hash);
}

async function pureRenameRefreshesDisplayStateWhenTermsAreUnchanged() {
  const g = new FakeGraph();

  await deriveGraphFromMetadata(
    g,
    auth,
    baseInput({
      anchorName: "Original Title",
      metadata: { topics: ["Migrations"], people: [] },
    }),
  );

  const renamed = await deriveGraphFromMetadata(
    g,
    auth,
    baseInput({
      anchorName: "Renamed Only",
      metadata: { topics: ["Migrations"], people: [] },
    }),
  );

  expect(renamed.status).toBe("unchanged");
  const anchor = anchorFor(g, ANCHOR_CANONICAL);
  expect(anchor.name).toBe(`Renamed Only [${ANCHOR_CANONICAL}]`);
  expect(anchor.metadata["display_name"]).toBe("Renamed Only");
}

async function twoAnchorsWithTheSameDisplayTitleCoexist() {
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

  const anchorA = anchorFor(g, `source:${idA}`);
  const anchorB = anchorFor(g, `source:${idB}`);
  // Two distinct anchor rows survive; their stored names differ (canonical-
  // derived) so lower(name) never collides, and both preserve the shared label.
  expect(anchorA.id).not.toBe(anchorB.id);
  expect(anchorA.name).not.toBe(anchorB.name);
  expect(anchorA.name).toBe(`${sharedTitle} [source:${idA}]`);
  expect(anchorB.name).toBe(`${sharedTitle} [source:${idB}]`);
  expect(anchorA.metadata["display_name"]).toBe(sharedTitle);
  expect(anchorB.metadata["display_name"]).toBe(sharedTitle);
}

async function renamingAnchorOntoASiblingTitleDoesNotCollide() {
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

  const anchorA = anchorFor(g, `source:${idA}`);
  const anchorB = anchorFor(g, `source:${idB}`);
  // Both anchors now carry the SAME display title, yet remain distinct rows
  // with distinct stored names — no lower(name) collision on the rename.
  expect(anchorA.metadata["display_name"]).toBe("Existing Title");
  expect(anchorB.metadata["display_name"]).toBe("Existing Title");
  expect(anchorA.id).not.toBe(anchorB.id);
  expect(anchorB.name).toBe(`Existing Title [source:${idB}]`);
}

async function oldNameOnlyArbiterWouldRaiseACanonicalUniqueViolation() {
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
}

describe("deriveGraphFromMetadata", () => {
  it(
    "anchor rename: stable canonical id survives a display-name change without a unique violation",
    stableCanonicalIdSurvivesADisplayNameChange,
  );
  it(
    "pure anchor rename refreshes display state even when derived terms are unchanged",
    pureRenameRefreshesDisplayStateWhenTermsAreUnchanged,
  );
  it(
    "duplicate source titles: two distinct anchors with the same display title coexist (no lower(name) collision)",
    twoAnchorsWithTheSameDisplayTitleCoexist,
  );
  it(
    "rename-to-existing-title: renaming an anchor onto a sibling's display title does not collide",
    renamingAnchorOntoASiblingTitleDoesNotCollide,
  );
  it(
    "anchor rename: the old lower(name)-only arbiter would raise a canonical unique violation",
    oldNameOnlyArbiterWouldRaiseACanonicalUniqueViolation,
  );
});
