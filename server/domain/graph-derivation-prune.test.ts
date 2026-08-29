/**
 * Stale-edge prune coverage for `deriveGraphFromMetadata` (#346): when a term
 * drops out of a derivation the shared entity NODE survives and only this
 * anchor's obsolete anchor->term EDGE is soft-deleted. Split out of
 * graph-derivation.test.ts so each suite stays a readable size.
 */
import { describe, expect, it } from "bun:test";
import { deriveGraphFromMetadata } from "./graph-derivation.ts";
import { expectDefined } from "../../scripts/test-support/expect-defined.ts";
import { auth, baseInput, FakeGraph } from "./graph-derivation-test-helpers.ts";

const ANCHOR_CANONICAL = "thought:11111111-1111-4111-8111-111111111111";

/** The row addressed by `canonical`, asserted present. */
function rowByCanonical(g: FakeGraph, canonical: string) {
  return expectDefined(
    g.rows.find((r) => r.canonical_id === canonical),
    `entity ${canonical}`,
  );
}

/** The derived topic node named `name`, asserted present. */
function topicRow(g: FakeGraph, name: string) {
  return expectDefined(
    g.rows.find((r) => r.entity_type === "topic" && r.name === name),
    `topic ${name}`,
  );
}

function liveLinkCount(g: FakeGraph): number {
  return [...g.links.values()].filter((l) => !l.archived).length;
}

async function droppedTermEdgeIsArchivedAndStaysGoneOnRerun() {
  // Regression for #346 stale-edge convergence. Initial derivation has two
  // topics; the second derivation drops one. The dropped topic's ENTITY NODE
  // is shared and must survive (another anchor may reference it), but the
  // obsolete anchor->term `mentions` EDGE must be soft-deleted so the
  // search-brain graph join (archived_at IS NULL) stops returning it. A third
  // derivation with the same shrunk set must be a no-op — nothing new to prune.
  const g = new FakeGraph();

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

  const anchorRow = rowByCanonical(g, ANCHOR_CANONICAL);
  const indexingRow = topicRow(g, "indexing");
  const indexingKey = `team-kb|entity|${anchorRow.id}|entity|${indexingRow.id}|mentions`;
  // Both edges start live.
  expect(liveLinkCount(g)).toBe(2);
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
  expect(liveLinkCount(g)).toBe(1);

  // Rerun the SAME shrunk set: unchanged content => no re-prune, no re-derive.
  const again = await deriveGraphFromMetadata(
    g,
    auth,
    baseInput({ metadata: { topics: ["migrations"], people: [] } }),
  );
  expect(again.status).toBe("unchanged");
  expect(again.links_archived).toBe(0);
  // Still exactly one live edge; the archived indexing edge did not revive.
  expect(liveLinkCount(g)).toBe(1);
  expect(g.links.get(indexingKey)?.archived).toBe(true);
}

async function onlyThisAnchorsEdgesAreTouched() {
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
  expect(liveLinkCount(g)).toBe(3); // A->migrations, A->indexing, B->indexing

  // Anchor A drops "indexing". Only A->indexing is archived; B->indexing lives.
  const anchorA = rowByCanonical(g, ANCHOR_CANONICAL);
  const anchorB = rowByCanonical(g, `thought:${otherAnchorId}`);
  const indexingRow = topicRow(g, "indexing");

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
}

describe("deriveGraphFromMetadata", () => {
  it(
    "stale-edge prune: a dropped term's anchor->term edge is archived and stays gone on rerun",
    droppedTermEdgeIsArchivedAndStaysGoneOnRerun,
  );
  it(
    "stale-edge prune: only THIS anchor's edges are touched, never a sibling anchor's",
    onlyThisAnchorsEdgesAreTouched,
  );
});
