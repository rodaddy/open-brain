import { describe, expect, it } from "bun:test";
import {
  loadRepoFactsSection,
  stalenessDispositionFor,
} from "../agent-context-pack-repo-facts.ts";
import type { SectionReaderDeps } from "../agent-context-pack-sections.ts";

type Row = Record<string, unknown>;

const NOW = Date.parse("2026-07-22T00:00:00Z");

function factRow(overrides: Partial<Row> & { id: string }): Row {
  const { metadata: metaOverride, ...rest } = overrides;
  return {
    namespace: "rico",
    updated_at: "2026-07-20T10:00:00Z",
    metadata: {
      source_system: "qmd",
      repo: "rodaddy/open-brain",
      collection: "open-brain",
      path: "src/tools/repo-facts.ts",
      subject: "repoFactMetadata",
      fact_type: "api_contract",
      fact: "repo facts require symbol or subject",
      source_commit: "abc1234",
      source_url:
        "https://github.com/rodaddy/open-brain/blob/abc1234/src/tools/repo-facts.ts",
      verified_at: "2026-07-20T09:00:00Z",
      confidence: 1,
      staleness_policy: "stable_fact_verify_source",
      ...(metaOverride as Row | undefined),
    },
    ...rest,
  };
}

function readerFor(
  rows: Row[],
  capture?: { sql?: string; params?: unknown[] },
): SectionReaderDeps {
  return {
    query: async (sql, params) => {
      if (capture) {
        capture.sql = sql;
        capture.params = params;
      }
      return { rows };
    },
  };
}

describe("repo_facts exact repo binding", () => {
  it("binds the active repo exactly and echoes it back", async () => {
    const capture: { sql?: string; params?: unknown[] } = {};
    const frag = await loadRepoFactsSection(
      { namespace: "rico", repo: "rodaddy/open-brain", nowMs: NOW },
      readerFor([factRow({ id: "f1" })], capture),
    );
    expect(capture.sql).toContain("entity_type = 'repo_fact'");
    expect(capture.sql).toContain("metadata->>'repo' = $2");
    expect(capture.sql).toContain("namespace = $1");
    expect(capture.params?.[0]).toBe("rico");
    expect(capture.params?.[1]).toBe("rodaddy/open-brain");
    expect(frag.section).toMatchObject({
      repo: "rodaddy/open-brain",
      repo_bound: true,
      item_count: 1,
    });
  });

  it("returns the defined empty state with no query when there is no active repo", async () => {
    let queried = false;
    const frag = await loadRepoFactsSection(
      { namespace: "rico", repo: null, nowMs: NOW },
      {
        query: async () => {
          queried = true;
          return { rows: [] };
        },
      },
    );
    expect(queried).toBe(false);
    expect(frag.section).toMatchObject({
      repo: null,
      repo_bound: false,
      items: [],
      item_count: 0,
    });
    expect(frag.scopeDenials).toEqual([
      { source: "repo_facts", reasons: ["no_active_repo"] },
    ]);
  });

  it("with two repo scopes present, keeps only rows matching the active repo (in-process guard)", async () => {
    // Overlapping/adjacent repo scopes: the active bind is one repo; a row that
    // drifted to another repo scope must be dropped, never surfaced as fallback.
    const frag = await loadRepoFactsSection(
      { namespace: "rico", repo: "rodaddy/open-brain", nowMs: NOW },
      readerFor([
        factRow({ id: "match" }),
        factRow({ id: "other", metadata: { repo: "rodaddy/king-signals" } }),
      ]),
    );
    expect((frag.section?.items as Row[]).map((i) => i.id)).toEqual(["match"]);
    expect(frag.section?.item_count).toBe(1);
  });

  it("binds the active namespace and repo together as the exact scope", async () => {
    const capture: { sql?: string; params?: unknown[] } = {};
    await loadRepoFactsSection(
      { namespace: "king-capital", repo: "rodaddy/king-signals", nowMs: NOW },
      readerFor([], capture),
    );
    expect(capture.params?.[0]).toBe("king-capital");
    expect(capture.params?.[1]).toBe("rodaddy/king-signals");
  });

  it("never falls back to another repo: an unmatched repo yields empty items", async () => {
    // The DB predicate would normally exclude the row; the in-process guard is
    // the belt-and-suspenders proof that a drifted metadata.repo cannot leak.
    const frag = await loadRepoFactsSection(
      { namespace: "rico", repo: "rodaddy/open-brain", nowMs: NOW },
      readerFor([
        factRow({ id: "wrong", metadata: { repo: "someone/other-repo" } }),
      ]),
    );
    expect(frag.section?.item_count).toBe(0);
    expect(frag.section?.items).toEqual([]);
  });
});

describe("repo_facts source refs and staleness", () => {
  it("carries source_commit and source_url on the item and citation", async () => {
    const frag = await loadRepoFactsSection(
      { namespace: "rico", repo: "rodaddy/open-brain", nowMs: NOW },
      readerFor([factRow({ id: "f1" })]),
    );
    const item = (frag.section?.items as Row[])[0]!;
    expect(item.source_commit).toBe("abc1234");
    expect(item.source_url).toContain("github.com");
    expect(frag.citations[0]).toMatchObject({
      kind: "repo_fact",
      source_commit: "abc1234",
    });
  });

  it("excludes facts missing source refs (uncitable to a commit)", async () => {
    const frag = await loadRepoFactsSection(
      { namespace: "rico", repo: "rodaddy/open-brain", nowMs: NOW },
      readerFor([
        factRow({
          id: "no-refs",
          metadata: { source_url: null, source_commit: null },
        }),
      ]),
    );
    expect(frag.section?.item_count).toBe(0);
  });

  it("maps each staleness_policy to a deterministic disposition", () => {
    expect(
      stalenessDispositionFor("stable_fact_verify_source", null, NOW),
    ).toBe("source_pinned");
    expect(stalenessDispositionFor("commit_pinned", null, NOW)).toBe(
      "commit_pinned",
    );
    expect(stalenessDispositionFor("volatile_pointer_only", null, NOW)).toBe(
      "pointer_only",
    );
    expect(stalenessDispositionFor("bogus", null, NOW)).toBe("unknown_policy");
    expect(stalenessDispositionFor(null, null, NOW)).toBe("unknown_policy");
  });

  it("marks refresh_required facts refresh_due only past the horizon", () => {
    const fresh = "2026-07-21T00:00:00Z";
    const stale = "2026-05-01T00:00:00Z";
    expect(stalenessDispositionFor("refresh_required", fresh, NOW)).toBe(
      "current",
    );
    expect(stalenessDispositionFor("refresh_required", stale, NOW)).toBe(
      "refresh_due",
    );
    expect(stalenessDispositionFor("refresh_required", null, NOW)).toBe(
      "refresh_due",
    );
  });

  it("surfaces the disposition on the assembled item", async () => {
    const frag = await loadRepoFactsSection(
      { namespace: "rico", repo: "rodaddy/open-brain", nowMs: NOW },
      readerFor([
        factRow({
          id: "f1",
          metadata: {
            staleness_policy: "refresh_required",
            verified_at: "2026-05-01T00:00:00Z",
          },
        }),
      ]),
    );
    expect((frag.section?.items as Row[])[0]!.staleness_disposition).toBe(
      "refresh_due",
    );
  });
});

describe("repo_facts budgets, order, and degradation", () => {
  it("caps items to the budget and flags truncation", async () => {
    const rows = Array.from({ length: 4 }, (_, i) =>
      factRow({ id: `f${i}`, updated_at: `2026-07-2${i}T10:00:00Z` }),
    );
    const frag = await loadRepoFactsSection(
      {
        namespace: "rico",
        repo: "rodaddy/open-brain",
        nowMs: NOW,
        budget: { maxItems: 2 },
      },
      readerFor(rows),
    );
    expect(frag.section?.item_count).toBe(2);
    expect((frag.section?.items as Row[]).map((i) => i.id)).toEqual([
      "f0",
      "f1",
    ]);
    expect(frag.section?.truncated).toBe(true);
  });

  it("truncates over-long fact bodies to the char budget", async () => {
    const frag = await loadRepoFactsSection(
      {
        namespace: "rico",
        repo: "rodaddy/open-brain",
        nowMs: NOW,
        budget: { maxItemChars: 8 },
      },
      readerFor([factRow({ id: "f1", metadata: { fact: "y".repeat(40) } })]),
    );
    expect(((frag.section?.items as Row[])[0]!.fact as string).length).toBe(8);
    expect(frag.section?.truncated).toBe(true);
  });

  it("degrades content-free when the database query throws", async () => {
    const frag = await loadRepoFactsSection(
      { namespace: "rico", repo: "rodaddy/open-brain", nowMs: NOW },
      {
        query: async () => {
          throw new Error("statement timeout on 10.71.20.49");
        },
      },
    );
    expect(frag.section).toBeUndefined();
    expect(frag.degradedSources).toEqual([
      { source: "repo_facts", reason: "database_unavailable" },
    ]);
    expect(JSON.stringify(frag)).not.toContain("10.71.20.49");
  });
});
