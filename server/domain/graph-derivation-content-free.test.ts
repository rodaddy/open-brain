/**
 * Content-free receipt and observability sentinels for
 * `deriveGraphFromMetadata`, plus the anchor content-hash stamping the
 * maintenance sweep converges on. Split out of
 * graph-derivation-isolation.test.ts so each suite stays a readable size.
 */
import { describe, expect, it } from "bun:test";
import { deriveGraphFromMetadata } from "./graph-derivation.ts";
import { expectDefined } from "../../scripts/test-support/expect-defined.ts";
import {
  auth,
  baseInput,
  captureLoggerFields,
  FakeGraph,
} from "./graph-derivation-test-helpers.ts";

const ANCHOR_CANONICAL = "thought:11111111-1111-4111-8111-111111111111";

/** The anchor row for the shared fixture, asserted present. */
function anchorRow(g: FakeGraph) {
  return expectDefined(
    g.rows.find((r) => r.canonical_id === ANCHOR_CANONICAL),
    "anchor row",
  );
}

/**
 * A derivation_hash is a 64-char lowercase sha256 hex; none may appear in any
 * logged field, regardless of which hash it is.
 */
function expectNoHashValueInFields(fields: Record<string, unknown>[]) {
  for (const entry of fields) {
    for (const value of Object.values(entry)) {
      if (typeof value === "string") {
        expect(value).not.toMatch(/^[0-9a-f]{64}$/);
      }
    }
  }
}

async function stampsAnchorContentHashSoTheSweepCanConverge() {
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
  const anchor = anchorRow(g);
  expect(anchor.metadata["content_hash"]).toBe("c".repeat(64));
  // derivation_hash and content_hash are distinct keys, distinct values.
  expect(anchor.metadata["derivation_hash"]).not.toBe("c".repeat(64));
}

async function changedSourceBytesRefreshTheStampedContentHash() {
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
  const anchor = anchorRow(g);
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
  expect(receipt.derivation_hash).toBe(anchor.metadata["derivation_hash"] as string);
}

async function unchangedTermsAndBytesAreATrueNoOp() {
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
    "metadata ->> 'derivation_hash' AS derivation_hash",
  );
}

async function anchorContentHashNeverLeaksSourceTextIntoTheReceipt() {
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
}

async function aNewDerivationNeverLogsNamespaceHashIdOrTerms() {
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
  expectNoHashValueInFields(fields);
}

async function anUnchangedShortCircuitNeverLogsNamespaceOrHash() {
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
  expectNoHashValueInFields(fields);
}

describe("deriveGraphFromMetadata content-free receipts", () => {
  it(
    "stamps anchorContentHash on the anchor so the maintenance sweep can converge",
    stampsAnchorContentHashSoTheSweepCanConverge,
  );
  it(
    "unchanged terms but changed source bytes: refreshes the stamped content_hash",
    changedSourceBytesRefreshTheStampedContentHash,
  );
  it(
    "unchanged terms AND unchanged source bytes: a true no-op, no stamp UPDATE",
    unchangedTermsAndBytesAreATrueNoOp,
  );
  it(
    "content-free: anchorContentHash never leaks source text into the receipt",
    anchorContentHashNeverLeaksSourceTextIntoTheReceipt,
  );
  it(
    "content-free logs: a new/changed derivation never logs namespace, hash, id, or terms",
    aNewDerivationNeverLogsNamespaceHashIdOrTerms,
  );
  it(
    "content-free logs: an unchanged short-circuit never logs namespace or hash",
    anUnchangedShortCircuitNeverLogsNamespaceOrHash,
  );
});
