import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseReflexAbFixture } from "../reflex-ab-fixtures.ts";
import { parseReflexPointersPayload } from "../transport.ts";

// Fixture-validation + payload-parse tests for the reflex A/B gate (#335).
// These prove the fixture's referential integrity guards fire (so the gate can
// never seed a fixture whose known/net-new/forbidden lists disagree with the
// corpus) and that the transport payload parser fails closed content-free on a
// malformed body while normalizing containers on a well-formed one.

const SHIPPED = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../fixtures/reflex-ab-v1.json"),
    "utf8",
  ),
);

/** A minimal structurally-valid fixture, cloned and perturbed per test. */
function baseFixture() {
  return {
    schema_version: 1,
    fixture_id: "reflex-ab-unit",
    description: "unit",
    query: "q",
    corpus: [
      {
        id: "k1",
        table: "thoughts",
        namespace_role: "primary",
        prior_known: true,
        content: "k1",
        tags: [],
      },
      {
        id: "n1",
        table: "thoughts",
        namespace_role: "primary",
        content: "n1",
        tags: [],
      },
      {
        id: "neg1",
        table: "thoughts",
        namespace_role: "negative",
        content: "neg1",
        tags: [],
      },
    ],
    prior_known_ids: ["k1"],
    net_new_ids: ["n1"],
    forbidden_ids: ["neg1"],
  };
}

describe("reflex A/B fixture validation", () => {
  it("parses the shipped fixture with known/net-new/forbidden roles intact", () => {
    const fixture = parseReflexAbFixture(SHIPPED);
    expect(fixture.fixture_id).toBe("open-brain-reflex-ab-v1");
    expect(fixture.prior_known_ids.length).toBeGreaterThan(0);
    expect(fixture.net_new_ids.length).toBeGreaterThan(0);
    // Every prior_known id is a primary-role, prior_known-flagged entry.
    for (const id of fixture.prior_known_ids) {
      const entry = fixture.corpus.find((c) => c.id === id)!;
      expect(entry.namespace_role).toBe("primary");
      expect(entry.prior_known).toBe(true);
    }
    // No net_new id is prior_known; forbidden ids are negative-role.
    for (const id of fixture.net_new_ids) {
      expect(fixture.prior_known_ids).not.toContain(id);
    }
    for (const id of fixture.forbidden_ids) {
      const entry = fixture.corpus.find((c) => c.id === id)!;
      expect(entry.namespace_role).toBe("negative");
    }
  });

  it("accepts the minimal base fixture", () => {
    expect(() => parseReflexAbFixture(baseFixture())).not.toThrow();
  });

  it("rejects a prior_known id that is not flagged prior_known on its entry", () => {
    const f = baseFixture();
    f.corpus[0]!.prior_known = false;
    expect(() => parseReflexAbFixture(f)).toThrow(/prior_known: true/);
  });

  it("rejects a prior_known id pointing at a negative-role entry", () => {
    const f = baseFixture();
    f.prior_known_ids = ["neg1"];
    expect(() => parseReflexAbFixture(f)).toThrow(/must be a primary-role/);
  });

  it("rejects a net_new id that is also prior_known", () => {
    const f = baseFixture();
    f.net_new_ids = ["k1"];
    // k1 is a prior_known entry, so the prior_known-loop disjointness check fires
    // first: an id cannot be both prior_known and net_new.
    expect(() => parseReflexAbFixture(f)).toThrow(
      /cannot be both prior_known and net_new/,
    );
  });

  it("rejects a forbidden id pointing at a primary-role entry", () => {
    const f = baseFixture();
    f.forbidden_ids = ["n1"];
    expect(() => parseReflexAbFixture(f)).toThrow(/must be a negative-role/);
  });

  it("rejects a corpus entry flagged prior_known but absent from prior_known_ids", () => {
    const f = baseFixture();
    // Add a primary seed flagged prior_known but listed in NEITHER prior_known_ids
    // NOR net_new_ids: a silently-known seed the gate would never suppress.
    f.corpus.push({
      id: "k2",
      table: "thoughts",
      namespace_role: "primary",
      prior_known: true,
      content: "k2",
      tags: [],
    });
    expect(() => parseReflexAbFixture(f)).toThrow(
      /missing from prior_known_ids/,
    );
  });

  it("rejects a duplicate corpus id", () => {
    const f = baseFixture();
    f.corpus.push({ ...f.corpus[1]!, prior_known: false });
    expect(() => parseReflexAbFixture(f)).toThrow(/duplicate corpus id/);
  });

  it("rejects an unknown prior_known reference", () => {
    const f = baseFixture();
    f.prior_known_ids = ["does-not-exist"];
    expect(() => parseReflexAbFixture(f)).toThrow(/unknown id/);
  });
});

describe("parseReflexPointersPayload", () => {
  it("fails closed content-free on a non-object body", () => {
    expect(() => parseReflexPointersPayload("[]")).toThrow(
      /agent_reflex_pointers:malformed-payload/,
    );
    expect(() => parseReflexPointersPayload("not json")).toThrow(
      /agent_reflex_pointers:malformed-payload/,
    );
  });

  it("normalizes missing containers to their empty forms", () => {
    const parsed = parseReflexPointersPayload(JSON.stringify({ status: "ok" }));
    expect(parsed.status).toBe("ok");
    expect(parsed.placement).toBe("");
    expect(parsed.pointers).toEqual({});
    expect(parsed.citations).toEqual([]);
    expect(parsed.budget).toEqual({});
    expect(parsed.warnings.scope_denials).toEqual([]);
    expect(parsed.warnings.degraded_sources).toEqual([]);
    expect(parsed.warnings.truncation).toEqual([]);
  });

  it("preserves a well-formed reflex payload's structural fields", () => {
    const body = {
      status: "ok",
      placement: "client_owned",
      pointers: {
        label: "pointers",
        items: [{ id: "srv-1", citation_id: "brain_record:thought:srv-1" }],
        item_count: 1,
      },
      citations: [{ id: "brain_record:thought:srv-1", kind: "pointer" }],
      budget: { whole_pack: { content_char_limit: 999 } },
      warnings: { scope_denials: [], degraded_sources: [], truncation: [] },
    };
    const parsed = parseReflexPointersPayload(JSON.stringify(body));
    expect(parsed.placement).toBe("client_owned");
    expect((parsed.pointers.items as unknown[]).length).toBe(1);
    expect(parsed.citations.length).toBe(1);
  });
});
