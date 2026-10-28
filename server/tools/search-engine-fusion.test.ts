import { describe, expect, test, vi } from "vitest";
import { rrfArmContribution, rrfMerge } from "./search-engine-fusion.ts";
import type { SearchRow } from "./search-engine-types.ts";

const CREATED_AT = "2026-09-15T12:00:00.000Z";

function row(
  id: string,
  options: {
    sourceType?: string;
    tier?: string;
    lexicalCoverage?: number;
    queryLexemeCount?: number;
  } = {},
): SearchRow {
  return {
    id,
    source_type: options.sourceType ?? "thought",
    namespace: "test",
    content_preview: id,
    tags: null,
    created_by: "test",
    created_at: CREATED_AT,
    tier: options.tier ?? "warm",
    usefulness: 0.5,
    lexical_coverage: options.lexicalCoverage,
    query_lexeme_count: options.queryLexemeCount,
  };
}

function lexicalRow(id: string, tier = "hot"): SearchRow {
  return row(id, { tier, lexicalCoverage: 1, queryLexemeCount: 4 });
}

function fullLexicalRow(id: string, tier: string): SearchRow {
  return row(id, { tier, lexicalCoverage: 4, queryLexemeCount: 4 });
}

describe("hybrid strong-match ordering", () => {
  test("keeps a strong single-arm rank two above dual rank twenty, which beats single rank five", () => {
    const strong = row("strong-single");
    const weaker = row("weaker-single");
    const corroborated = lexicalRow("weak-corroborated", "warm");
    const vectorRows = Array.from({ length: 20 }, (_, index) => {
      if (index === 1) return strong;
      if (index === 4) return weaker;
      if (index === 19) return corroborated;
      return row(`vector-${String(index + 1)}`);
    });
    const lexicalRows = Array.from({ length: 20 }, (_, index) =>
      index === 19 ? corroborated : lexicalRow(`lexical-${String(index + 1)}`, "warm"),
    );

    const ids = rrfMerge(vectorRows, lexicalRows, 50).map(({ id }) => id);

    expect(ids.indexOf("strong-single")).toBeLessThan(ids.indexOf("weak-corroborated"));
    expect(ids.indexOf("weak-corroborated")).toBeLessThan(ids.indexOf("weaker-single"));
  });

  test("uses equal positional votes and awards the bonus only across distinct arms", () => {
    const partial = lexicalRow("partial", "warm");
    const full = fullLexicalRow("full", "warm");
    expect(rrfArmContribution(partial, 3, "lexical")).toBe(0.25);
    expect(rrfArmContribution(full, 3, "lexical")).toBe(0.25);
    expect(rrfArmContribution(partial, 3, "vector")).toBe(0.25);
    expect(() => rrfArmContribution(row("missing"), 3, "lexical")).toThrow(
      /Invalid hybrid lexical coverage metadata/,
    );

    const corroborated = fullLexicalRow("z-dual", "warm");
    const single = row("a-single");
    const ids = rrfMerge(
      [row("vector-first"), single, row("vector-third"), corroborated],
      [
        lexicalRow("lexical-first", "warm"),
        lexicalRow("lexical-second", "warm"),
        lexicalRow("lexical-third", "warm"),
        corroborated,
      ],
      8,
    ).map(({ id }) => id);

    expect(ids.indexOf("z-dual")).toBeLessThan(ids.indexOf("a-single"));
  });

  test("uses preference labels and then stable identity only after relevance ties", () => {
    const preferredIds = rrfMerge(
      [row("vector-first"), row("hot-z", { tier: "hot" })],
      [lexicalRow("lexical-first"), fullLexicalRow("cold-a", "cold")],
      4,
    ).map(({ id }) => id);
    expect(preferredIds.indexOf("hot-z")).toBeLessThan(preferredIds.indexOf("cold-a"));

    const stableIds = rrfMerge(
      [row("vector-first"), row("b")],
      [lexicalRow("lexical-first"), fullLexicalRow("a", "warm")],
      5,
    ).map(({ id }) => id);
    expect(stableIds.indexOf("a")).toBeLessThan(stableIds.indexOf("b"));
  });

  test("uses stable identity when the clock advances between score reads", () => {
    let now = Date.parse("2026-09-15T12:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now++);
    try {
      const ids = rrfMerge([row("b")], [fullLexicalRow("a", "warm")], 2).map(
        ({ id }) => id,
      );
      expect(ids).toEqual(["a", "b"]);
    } finally {
      clock.mockRestore();
    }
  });
});
