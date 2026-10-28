import { describe, expect, test, vi } from "vitest";
import { fuseLocally, type RankedRow } from "./fusion.ts";

function row(
  id: string,
  options: {
    tier?: string;
    lexicalCoverage?: number;
    queryLexemeCount?: number;
  } = {},
): RankedRow {
  return {
    key: `thought:${id}`,
    source_type: "thought",
    id,
    tier: options.tier ?? "warm",
    created_at: "2026-09-15T12:00:00.000Z",
    usefulness: 0.5,
    lexical_coverage: options.lexicalCoverage,
    query_lexeme_count: options.queryLexemeCount,
  };
}

function lexicalRow(id: string, tier = "hot"): RankedRow {
  return row(id, { tier, lexicalCoverage: 1, queryLexemeCount: 4 });
}

function fullLexicalRow(id: string): RankedRow {
  return row(id, { lexicalCoverage: 4, queryLexemeCount: 4 });
}

describe("independent recall fusion ordering", () => {
  test("keeps single rank two above dual rank twenty, which beats single rank five", () => {
    const corroborated = fullLexicalRow("weak-corroborated");
    const vectorRows = Array.from({ length: 20 }, (_, index) => {
      if (index === 1) return row("strong-single");
      if (index === 4) return row("weaker-single");
      if (index === 19) return corroborated;
      return row(`vector-${String(index + 1)}`);
    });
    const lexicalRows = Array.from({ length: 20 }, (_, index) =>
      index === 19 ? corroborated : lexicalRow(`lexical-${String(index + 1)}`, "warm"),
    );
    const result = fuseLocally(vectorRows, lexicalRows, 50, false);

    expect(result.indexOf("thought:strong-single")).toBeLessThan(
      result.indexOf("thought:weak-corroborated"),
    );
    expect(result.indexOf("thought:weak-corroborated")).toBeLessThan(
      result.indexOf("thought:weaker-single"),
    );
  });

  test("uses stable identity when the clock advances between score reads", () => {
    let now = Date.parse("2026-09-15T12:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now++);
    try {
      expect(fuseLocally([row("b")], [fullLexicalRow("a")], 2, false)).toEqual([
        "thought:a",
        "thought:b",
      ]);
    } finally {
      clock.mockRestore();
    }
  });
});
