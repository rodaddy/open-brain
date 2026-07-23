import { describe, it, expect } from "bun:test";
import {
  coerceStringArray,
  decisionCanonicalText,
  sessionEmbedText,
  sessionSourceHashInput,
} from "./embedding-canonical.ts";

/**
 * Writer-parity tests: the canonical builders MUST reproduce, byte for byte, the
 * exact inline formula each live write path used before it was refactored to call
 * these helpers. These reference formulas are copied from the writers as they
 * stood; if a writer's formula legitimately changes, update BOTH the helper and
 * the reference here in lockstep. A drift between the helper and a writer would
 * make the embedding-repair registry flag freshly written rows as stale.
 */

// --- Reference formulas (transcribed from the pre-refactor write paths) -----

/**
 * log-decision.ts / rest-api.ts POST /decisions formula.
 *
 * The tag segment is deterministic: the ON CONFLICT merge stores
 * `array_agg(DISTINCT tag)` (deduped, arbitrarily ordered), so the canonical
 * text dedupes + sorts tags to keep the source hash stable across merges
 * (#345/#356). This reference mirrors that: every other field keeps its raw
 * write-path formula; only tags are normalized.
 */
function decisionReference(args: {
  title: string;
  rationale: string;
  context?: string;
  alternatives?: string[];
  tags?: string[];
}): string {
  const parts = [args.title, args.rationale];
  if (args.context) parts.push(args.context);
  if (args.alternatives?.length) parts.push(args.alternatives.join(", "));
  const tags = [...new Set(args.tags ?? [])].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  if (tags.length) parts.push(tags.join(" "));
  return parts.join("\n");
}

/** session-save.ts / rest-api.ts POST /sessions inline hash formula. */
function sessionHashReference(args: {
  summary: string;
  project?: string;
}): string {
  return args.summary + "|" + (args.project ?? "");
}

/** session-save.ts / rest-api.ts POST /sessions inline embed formula. */
function sessionEmbedReference(args: {
  summary: string;
  key_decisions?: string[];
  next_steps?: string[];
  blockers?: string[];
}): string {
  const embedParts = [args.summary];
  if (args.key_decisions?.length)
    embedParts.push(args.key_decisions.join(". "));
  if (args.next_steps?.length) embedParts.push(args.next_steps.join(". "));
  if (args.blockers?.length) embedParts.push(args.blockers.join(". "));
  return embedParts.join("\n");
}

describe("coerceStringArray", () => {
  it("passes through a string array", () => {
    expect(coerceStringArray(["a", "b"])).toEqual(["a", "b"]);
  });
  it("parses a JSON-encoded array string (jsonb-as-text edge case)", () => {
    expect(coerceStringArray('["a","b"]')).toEqual(["a", "b"]);
  });
  it("collapses null / non-array / unparseable to []", () => {
    expect(coerceStringArray(null)).toEqual([]);
    expect(coerceStringArray(undefined)).toEqual([]);
    expect(coerceStringArray(42)).toEqual([]);
    expect(coerceStringArray("not json")).toEqual([]);
    expect(coerceStringArray({ a: 1 })).toEqual([]);
  });
  it("drops non-string entries defensively", () => {
    expect(coerceStringArray(["a", 1, null, "b"])).toEqual(["a", "b"]);
  });
});

describe("decisionCanonicalText matches the write path exactly", () => {
  const cases = [
    { title: "T", rationale: "R" },
    { title: "T", rationale: "R", context: "C" },
    { title: "T", rationale: "R", alternatives: ["A", "B"] },
    { title: "T", rationale: "R", tags: ["x", "y"] },
    {
      title: "Use Bun",
      rationale: "fast",
      context: "greenfield",
      alternatives: ["Node", "Deno"],
      tags: ["runtime", "perf"],
    },
    // Empty optional arrays must be omitted, exactly like the `?.length` guards.
    { title: "T", rationale: "R", alternatives: [], tags: [] },
  ];
  for (const [i, c] of cases.entries()) {
    it(`case ${i}`, () => {
      expect(decisionCanonicalText(c)).toBe(decisionReference(c));
    });
  }
});

describe("decisionCanonicalText tag order is deterministic (#345/#356)", () => {
  // Regression: the ON CONFLICT merge stores array_agg(DISTINCT tag), whose
  // order Postgres does not guarantee. If the canonical text folded tags in raw
  // order, a merged row's recomputed source hash would disagree with the stored
  // one and the repair registry would flag false source_drift. These prove the
  // tag segment is invariant under permutation and duplication.
  const base = { title: "T", rationale: "R" };

  it("reversed tag order yields the identical canonical text", () => {
    const forward = decisionCanonicalText({
      ...base,
      tags: ["alpha", "beta", "gamma"],
    });
    const reversed = decisionCanonicalText({
      ...base,
      tags: ["gamma", "beta", "alpha"],
    });
    expect(reversed).toBe(forward);
  });

  it("duplicate tags collapse and do not change the canonical text", () => {
    const clean = decisionCanonicalText({ ...base, tags: ["alpha", "beta"] });
    const dup = decisionCanonicalText({
      ...base,
      tags: ["beta", "alpha", "alpha", "beta"],
    });
    expect(dup).toBe(clean);
  });

  it("any permutation of a merged set hashes to one deterministic string", () => {
    const set = ["runtime", "perf", "infra"];
    const permutations = [
      ["runtime", "perf", "infra"],
      ["infra", "runtime", "perf"],
      ["perf", "infra", "runtime"],
      // A duplicated merge (array_agg keeps DISTINCT but any order):
      ["perf", "runtime", "infra", "perf"],
    ];
    const texts = new Set(
      permutations.map((tags) => decisionCanonicalText({ ...base, tags })),
    );
    expect(texts.size).toBe(1);
    // And it folds the deterministic sorted order, not any input order.
    expect(decisionCanonicalText({ ...base, tags: set })).toBe(
      "T\nR\n" + [...set].sort().join(" "),
    );
  });

  it("empty and whitespace-preserving tags stay stable (no fabricated drift)", () => {
    // Empty set omits the segment entirely, matching the ?.length guard.
    expect(decisionCanonicalText({ ...base, tags: [] })).toBe("T\nR");
  });
});

describe("sessionSourceHashInput matches the write path exactly", () => {
  const cases = [
    { summary: "s" },
    { summary: "s", project: "ob" },
    { summary: "s", project: "" },
  ];
  for (const [i, c] of cases.entries()) {
    it(`case ${i}`, () => {
      expect(sessionSourceHashInput(c)).toBe(sessionHashReference(c));
    });
  }
  it("null project degrades to empty string like project ?? ''", () => {
    expect(sessionSourceHashInput({ summary: "s", project: null })).toBe("s|");
  });
});

describe("sessionEmbedText matches the write path exactly", () => {
  const cases = [
    { summary: "s" },
    { summary: "s", key_decisions: ["d1", "d2"] },
    { summary: "s", next_steps: ["n1"] },
    { summary: "s", blockers: ["b1", "b2"] },
    {
      summary: "s",
      key_decisions: ["d1"],
      next_steps: ["n1"],
      blockers: ["b1"],
    },
    // Empty arrays omitted, matching the `?.length` guards.
    { summary: "s", key_decisions: [], next_steps: [], blockers: [] },
  ];
  for (const [i, c] of cases.entries()) {
    it(`case ${i}`, () => {
      expect(sessionEmbedText(c)).toBe(sessionEmbedReference(c));
    });
  }
  it("session_wrap (no blockers field) omits the blockers segment", () => {
    // session_wrap has no blockers; passing none must equal the reference with
    // blockers absent, not an empty trailing segment.
    const wrapArgs = {
      summary: "s",
      key_decisions: ["d1"],
      next_steps: ["n1"],
    };
    expect(sessionEmbedText(wrapArgs)).toBe(sessionEmbedReference(wrapArgs));
    expect(sessionEmbedText(wrapArgs)).toBe("s\nd1\nn1");
  });
});
