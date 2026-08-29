/**
 * Namespace-isolation coverage for `deriveGraphFromMetadata`: every persisted
 * write binds namespace as a parameter, an unwritable or foreign namespace is
 * rejected before any SQL, and derived edges keep the shape the search-brain
 * relational-graph join relies on. The content-hash stamping and content-free
 * observability sentinels live in graph-derivation-content-free.test.ts.
 */
import { describe, expect, it } from "bun:test";
import {
  CrossNamespaceEndpointError,
  deriveGraphFromMetadata,
  type GraphDerivationPool,
} from "./graph-derivation.ts";
import type { AuthInfo } from "../../src/types.ts";
import { auth, baseInput, FakeGraph } from "./graph-derivation-test-helpers.ts";

/** Assert one ob_entities write arbitrates on the index its shape implies. */
function expectEntityConflictTarget(sql: string) {
  // The anchor upsert (identified by its $5::jsonb metadata bind) arbitrates
  // on the canonical partial-unique index so a rename is a safe UPDATE and
  // never violates idx_ob_entities_canonical. Derived-term upserts arbitrate
  // on lower(name) since their canonical is name-derived.
  if (sql.includes("$5::jsonb")) {
    expect(sql).toContain("ON CONFLICT (namespace, entity_type, canonical_id)");
    expect(sql).toContain("WHERE canonical_id IS NOT NULL AND archived_at IS NULL");
  } else {
    expect(sql).toContain("ON CONFLICT (namespace, entity_type, lower(name))");
    expect(sql).toContain("WHERE archived_at IS NULL");
  }
}

async function everyPersistedWriteBindsNamespaceAsAParameter() {
  const g = new FakeGraph();
  await deriveGraphFromMetadata(g, auth, baseInput());

  const writes = g.calls.filter((c) => c.sql.includes("INSERT INTO ob_"));
  expect(writes.length).toBeGreaterThan(0);
  for (const call of writes) {
    // Namespace-scoped conflict target on the exact partial-unique indexes.
    if (call.sql.includes("ob_entities")) {
      expectEntityConflictTarget(call.sql);
    } else {
      expect(call.sql).toContain(
        "ON CONFLICT (namespace, from_type, from_id, to_type, to_id, relation)",
      );
    }
    // namespace value is passed as a bound param, never interpolated.
    expect(call.params).toContain("team-kb");
  }
}

async function unwritableNamespaceIsRejectedBeforeAnyWrite() {
  const g = new FakeGraph();
  const readonly: AuthInfo = { role: "readonly", clientId: "viewer" };
  await expect(
    deriveGraphFromMetadata(g, readonly, baseInput({ namespace: "team-kb" })),
  ).rejects.toBeInstanceOf(CrossNamespaceEndpointError);
  // No SQL issued at all — fail-closed before touching the graph.
  expect(g.calls.length).toBe(0);
}

async function headerBoundIdentityCannotDeriveIntoAForeignNamespace() {
  const g = new FakeGraph();
  const delegated: AuthInfo = {
    role: "agent",
    clientId: "tenant-a",
    namespaceSource: "header",
  };
  await expect(
    deriveGraphFromMetadata(g, delegated, baseInput({ namespace: "tenant-b" })),
  ).rejects.toBeInstanceOf(CrossNamespaceEndpointError);
  expect(g.calls.length).toBe(0);
}

async function aRowPersistedUnderAForeignNamespaceAborts() {
  const g = new FakeGraph();
  // Simulate schema drift: the entity INSERT returns a different namespace.
  const originalQuery = g.query;
  g.query = (async (sql: string, params: unknown[] = []) => {
    const res = await originalQuery(sql, params);
    if (String(sql).includes("INSERT INTO ob_entities")) {
      return { rows: [{ ...res.rows[0], namespace: "evil-ns" }] };
    }
    return res;
  }) as unknown as GraphDerivationPool["query"];

  await expect(deriveGraphFromMetadata(g, auth, baseInput())).rejects.toBeInstanceOf(
    CrossNamespaceEndpointError,
  );
}

async function derivedEdgesMatchTheRelationalGraphSearchJoinShape() {
  // The existing search-brain relational-graph join (tools/search-brain.ts)
  // seeds on an ob_entities row, then joins ob_links with:
  //   l.namespace = seed.namespace AND l.relation = $2 AND l.archived_at IS NULL
  //   AND l.from_id = seed.id (outbound direction)
  // then joins the target entity in the SAME namespace. This asserts every
  // edge we persist satisfies that join so derived edges stay retrievable and
  // never leak across the namespace boundary the join relies on.
  const g = new FakeGraph();
  await deriveGraphFromMetadata(g, auth, baseInput());

  const linkWrites = g.calls.filter((c) => c.sql.includes("INSERT INTO ob_links"));
  expect(linkWrites.length).toBe(3);

  const anchorInsert = g.calls.find(
    (c) => c.sql.includes("INSERT INTO ob_entities") && c.sql.includes("$5::jsonb"),
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
}

async function emptyMetadataDerivesOnlyTheAnchorNode() {
  const g = new FakeGraph();
  const receipt = await deriveGraphFromMetadata(g, auth, baseInput({ metadata: {} }));
  expect(receipt.status).toBe("new");
  expect(receipt.entities_upserted).toBe(1);
  expect(receipt.links_upserted).toBe(0);
}

describe("deriveGraphFromMetadata namespace isolation", () => {
  it(
    "SQL predicate: every persisted write binds namespace as a parameter",
    everyPersistedWriteBindsNamespaceAsAParameter,
  );
  it(
    "cross-namespace negative: unwritable namespace is rejected before any write",
    unwritableNamespaceIsRejectedBeforeAnyWrite,
  );
  it(
    "cross-namespace negative: header-bound identity cannot derive into a foreign namespace",
    headerBoundIdentityCannotDeriveIntoAForeignNamespace,
  );
  it(
    "cross-namespace negative: a row persisted under a foreign namespace aborts",
    aRowPersistedUnderAForeignNamespaceAborts,
  );
  it(
    "graph-search regression: derived edges match the relationalGraphSearch join shape",
    derivedEdgesMatchTheRelationalGraphSearchJoinShape,
  );
  it(
    "empty metadata: derives only the anchor node, no edges",
    emptyMetadataDerivesOnlyTheAnchorNode,
  );
});
