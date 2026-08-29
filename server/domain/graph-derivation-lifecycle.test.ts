/**
 * Derivation status lifecycle for `deriveGraphFromMetadata`: the new /
 * unchanged / changed receipts and the graph-stability guarantee on a forced
 * re-derive. Split out of graph-derivation.test.ts so each suite stays a
 * readable size; the anchor-identity and prune coverage live in
 * graph-derivation-anchor-identity.test.ts and graph-derivation-prune.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { deriveGraphFromMetadata } from "./graph-derivation.ts";
import { expectDefined } from "../../scripts/test-support/expect-defined.ts";
import { auth, baseInput, FakeGraph } from "./graph-derivation-test-helpers.ts";

const ANCHOR_CANONICAL = "thought:11111111-1111-4111-8111-111111111111";

async function derivesAnchorEntitiesAndEdgesOnFirstRun() {
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
}

async function identicalRerunSkipsAllWrites() {
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
    "metadata ->> 'derivation_hash' AS derivation_hash",
  );
}

async function forcedRederiveWithIdenticalContentAddsNoDuplicates() {
  const g = new FakeGraph();
  const first = await deriveGraphFromMetadata(g, auth, baseInput());
  // Simulate a stale prior derivation (e.g. an older hash version) so the
  // next run takes the "changed" branch even though the content is identical.
  // The anchor is addressed by its stable canonical id, not its display name.
  const anchorRow = expectDefined(
    g.rows.find((r) => r.canonical_id === ANCHOR_CANONICAL),
    "anchor row",
  );
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
}

async function newMetadataTermAddsANodeAndReportsPreviousHash() {
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
}

async function caseInsensitiveIdentityCollapsesToOneNode() {
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
}

describe("deriveGraphFromMetadata", () => {
  it(
    "status=new: derives anchor + entities + edges on first run",
    derivesAnchorEntitiesAndEdgesOnFirstRun,
  );
  it(
    "status=unchanged: identical metadata re-run skips all writes (idempotent)",
    identicalRerunSkipsAllWrites,
  );
  it(
    "rerun is graph-stable: forced re-derive with identical content adds no duplicates",
    forcedRederiveWithIdenticalContentAddsNoDuplicates,
  );
  it(
    "status=changed: new metadata term adds a node and reports previous hash",
    newMetadataTermAddsANodeAndReportsPreviousHash,
  );
  it(
    "case-insensitive identity: 'Rico' and 'rico' collapse to one node",
    caseInsensitiveIdentityCollapsesToOneNode,
  );
});
