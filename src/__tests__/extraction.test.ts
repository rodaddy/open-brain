import { afterEach, describe, it, expect } from "bun:test";
import type pg from "pg";
import {
  extractMetadata,
  mergeTags,
  backgroundExtract,
  setMetadataProvider,
  resetMetadataProvider,
} from "../extraction.ts";
import type { ExtractedMetadata, MetadataProvider } from "../extraction.ts";

const LONG_TEXT =
  "This is a sufficiently long text for extraction to run against.";

describe("extractMetadata", () => {
  afterEach(resetMetadataProvider);

  it("returns null for empty or short text", async () => {
    await expect(extractMetadata("")).resolves.toBeNull();
    await expect(extractMetadata("too short")).resolves.toBeNull();
  });

  it("produces deterministic structural metadata with the DEFAULT provider (no null stub)", async () => {
    // Regression for issue #337: representative approved input must yield stable
    // structured metadata from the zero-network default -- ingestion no longer
    // relies on an empty/null stub. The default contributes no semantic fields
    // but always emits a content_hash envelope for real text.
    const a = await extractMetadata(LONG_TEXT);
    const b = await extractMetadata(LONG_TEXT);
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
    expect(a?.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a?.hash_version).toBe("sha256.v1");
    expect(a?.byte_length).toBe(new TextEncoder().encode(LONG_TEXT).byteLength);
    expect(Object.keys(a ?? {})).not.toContain("title");
    // Semantic fields stay empty under the default; they are model territory.
    expect(a?.topics).toEqual([]);
    expect(a?.people).toEqual([]);
    // The digest itself is opaque -- it never equals or embeds the source text.
    expect(a?.content_hash).not.toContain(LONG_TEXT.slice(20, 40));
    expect(a?.content_hash?.length).toBe(64);
  });

  it("does not copy a source excerpt into extracted metadata", async () => {
    const marker = "MARKER_TITLE_ONLY";
    const result = await extractMetadata(
      `${marker}\nsecond line with more text`,
    );
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(Object.keys(result ?? {})).not.toContain("title");
  });

  it("extracts ISO dates deterministically and unions provider dates", async () => {
    setMetadataProvider({ extract: () => ({ dates: ["2020-01-01"] }) });
    const text = "Shipped on 2026-07-22 and reviewed 2026-07-23T10:00:00Z.";
    const result = await extractMetadata(text);
    expect(result?.dates).toEqual(
      expect.arrayContaining([
        "2020-01-01",
        "2026-07-22",
        "2026-07-23T10:00:00Z",
      ]),
    );
    // Deterministic + deduped across runs.
    const again = await extractMetadata(text);
    expect(again?.dates).toEqual(result?.dates);
  });

  it("is deterministic: same input + same provider yields identical output", async () => {
    setMetadataProvider({
      extract: () => ({ topics: ["TypeScript", "Bun"], people: ["Alice"] }),
    });
    const a = await extractMetadata(LONG_TEXT);
    const b = await extractMetadata(LONG_TEXT);
    expect(a).toEqual(b);
    expect(a?.topics).toEqual(["TypeScript", "Bun"]);
    expect(a?.people).toEqual(["Alice"]);
    expect(a?.action_items).toEqual([]);
    // Structural fields are present alongside the semantic ones.
    expect(a?.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("normalizes: trims, drops empties/non-strings, case-insensitive dedupe", async () => {
    setMetadataProvider({
      extract: () => ({
        topics: ["  TypeScript ", "typescript", "", 42, "Bun"],
        people: ["Alice", "alice"],
      }),
    });
    const result = await extractMetadata(LONG_TEXT);
    expect(result?.topics).toEqual(["TypeScript", "Bun"]);
    expect(result?.people).toEqual(["Alice"]);
  });

  it("strictly validates: an entirely wrong-shape output yields null", async () => {
    setMetadataProvider({ extract: () => "not an object" });
    expect(await extractMetadata(LONG_TEXT)).toBeNull();
    setMetadataProvider({ extract: () => 12345 });
    expect(await extractMetadata(LONG_TEXT)).toBeNull();
  });

  it("still yields deterministic structural metadata when a provider gives no semantic signal", async () => {
    // Empty semantic fields no longer collapse the whole result to null: the
    // deterministic content_hash envelope is the point of issue #337.
    setMetadataProvider({ extract: () => ({ topics: [], people: [] }) });
    const result = await extractMetadata(LONG_TEXT);
    expect(result).not.toBeNull();
    expect(result?.topics).toEqual([]);
    expect(result?.people).toEqual([]);
    expect(result?.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("caps each field so an adversarial provider cannot inflate output", async () => {
    const many = Array.from({ length: 100 }, (_, i) => `t${i}`);
    setMetadataProvider({ extract: () => ({ topics: many }) });
    const result = await extractMetadata(LONG_TEXT);
    expect(result?.topics.length).toBe(32);
  });

  it("fails open when a provider throws: no throw, no leaked secret, still deterministic", async () => {
    // Fail-open now means the throw is swallowed AND the deterministic
    // structural metadata still lands -- the semantic provider failing must not
    // strip the content_hash envelope issue #337 requires. The provider's error
    // message (which could carry source text) never appears in the result.
    const throwing: MetadataProvider = {
      extract: () => {
        throw new Error("SECRET SOURCE TEXT leaked into message");
      },
    };
    setMetadataProvider(throwing);
    const result = await extractMetadata(LONG_TEXT);
    expect(result).not.toBeNull();
    expect(result?.topics).toEqual([]);
    expect(result?.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toContain("SECRET SOURCE TEXT");
  });

  it("ignores unknown keys from a provider", async () => {
    setMetadataProvider({
      extract: () => ({ topics: ["ok"], evil: "ignored", people: [] }),
    });
    const result = await extractMetadata(LONG_TEXT);
    expect(result?.topics).toEqual(["ok"]);
    expect(result?.people).toEqual([]);
    expect(result?.action_items).toEqual([]);
    // The unknown key never appears in the durable structured output.
    expect(Object.keys(result ?? {})).not.toContain("evil");
  });

  it("does not let a provider assert the deterministic structural fields", async () => {
    // Provider attempts to inject a content hash or title are stripped. The
    // digest is computed from the actual text and no source excerpt is persisted.
    setMetadataProvider({
      extract: () => ({
        topics: ["ok"],
        content_hash: "deadbeef",
        title: "forged title",
      }),
    });
    const result = await extractMetadata(LONG_TEXT);
    expect(result?.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result?.content_hash).not.toBe("deadbeef");
    expect(Object.keys(result ?? {})).not.toContain("title");
  });
});

describe("mergeTags", () => {
  it("merges topics into existing tags", () => {
    const existing = ["existing"];
    const extracted: ExtractedMetadata = {
      topics: ["TypeScript", "testing"],
      people: [],
      action_items: [],
      dates: [],
    };

    const result = mergeTags(existing, extracted);

    expect(result).toEqual(["existing", "TypeScript", "testing"]);
  });

  it("prefixes people tags", () => {
    const extracted: ExtractedMetadata = {
      topics: [],
      people: ["Alice", "Bob"],
      action_items: [],
      dates: [],
    };

    const result = mergeTags([], extracted);

    expect(result).toEqual(["person:Alice", "person:Bob"]);
  });

  it("deduplicates case-insensitively", () => {
    const existing = ["typescript", "person:alice"];
    const extracted: ExtractedMetadata = {
      topics: ["TypeScript"],
      people: ["Alice"],
      action_items: [],
      dates: [],
    };

    const result = mergeTags(existing, extracted);

    expect(result).toEqual(["typescript", "person:alice"]);
  });

  it("returns existing tags when extraction is null", () => {
    expect(mergeTags(["existing"], null)).toEqual(["existing"]);
    expect(mergeTags([], null)).toEqual([]);
  });
});

describe("backgroundExtract namespace + archived binding", () => {
  afterEach(resetMetadataProvider);

  // A promise-resolving fake pool that captures the enrichment UPDATE so the
  // test can assert the exact WHERE predicate and params, and can await the
  // fire-and-forget update deterministically.
  function capturingPool() {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    let resolveDone: () => void;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        resolveDone();
        return { rows: [] };
      },
    } as unknown as pg.Pool;
    return { pool, calls, done };
  }

  it("binds the enrichment UPDATE to id + namespace + live rows", async () => {
    setMetadataProvider({ extract: () => ({ topics: ["typescript"] }) });
    const { pool, calls, done } = capturingPool();
    backgroundExtract(
      pool,
      "thoughts",
      "entry-1",
      "alice",
      "a long enough text body to extract from",
      [],
    );
    await done;
    expect(calls.length).toBe(1);
    const { sql, params } = calls[0]!;
    expect(sql).toContain(
      "WHERE t.id = $3 AND t.namespace = $4 AND t.archived_at IS NULL",
    );
    // params: [tagCandidates, extractedJson, entryId, namespace]
    expect(params[2]).toBe("entry-1");
    expect(params[3]).toBe("alice");
  });

  it("merges extracted tags against the LIVE row, not a stale JS snapshot (issue #337 clobber)", async () => {
    // Regression: the enrichment UPDATE must union the extracted tag candidates
    // onto the row's CURRENT tags column in SQL. If it instead rebuilt the whole
    // tags array in JS from the snapshot passed at write time, a tag a
    // concurrent same-content upsert merged in the interim would be clobbered.
    // We prove: (a) $1 carries ONLY the extracted candidates, not a
    // pre-merged full array, and (b) the SQL reads the live column
    // (unnest(t.tags)) rather than overwriting it with a bound param.
    setMetadataProvider({
      extract: () => ({ topics: ["Alpha"], people: ["Bob"] }),
    });
    const { pool, calls, done } = capturingPool();
    // A concurrent writer already added "concurrent-tag" to the row; the stale
    // snapshot handed to backgroundExtract does NOT include it.
    backgroundExtract(
      pool,
      "thoughts",
      "entry-1",
      "alice",
      "a long enough text body to extract from",
      ["stale-snapshot-tag"],
    );
    await done;
    const { sql, params } = calls[0]!;
    // $1 is exactly the extracted candidates (topics + person:-prefixed), in
    // order -- NOT a merge that folded in the stale snapshot tag.
    expect(params[0]).toEqual(["Alpha", "person:Bob"]);
    expect(params[0]).not.toContain("stale-snapshot-tag");
    // The UPDATE reads the live tags column and appends only novel candidates.
    expect(sql).toContain("unnest(t.tags)");
    expect(sql).toContain("SET tags = (");
    // It never overwrites tags with a bound array param ($1 stays the candidate
    // source, not the whole new tags value).
    expect(sql).not.toContain("SET tags = $1");
  });

  it("rejects a non-allowlisted table and never queries", async () => {
    setMetadataProvider({ extract: () => ({ topics: ["x"] }) });
    const { pool, calls } = capturingPool();
    backgroundExtract(
      pool,
      "secrets; DROP TABLE thoughts",
      "entry-1",
      "alice",
      "a long enough text body to extract from",
      [],
    );
    // Rejected synchronously before any extraction/query.
    expect(calls.length).toBe(0);
  });

  it("rejects a formerly-over-broad allowlist table (relationships) and never queries", async () => {
    // Regression for issue #337 P3: EXTRACTION_TABLES was narrowed to the only
    // tables that both have an extracted_metadata column and actually call
    // backgroundExtract (thoughts, decisions). A table that used to be in the
    // allowlist but was never a caller and has no extracted_metadata column
    // (relationships) must now be rejected before any query.
    setMetadataProvider({ extract: () => ({ topics: ["x"] }) });
    const { pool, calls } = capturingPool();
    backgroundExtract(
      pool,
      "relationships",
      "entry-1",
      "alice",
      "a long enough text body to extract from",
      [],
    );
    expect(calls.length).toBe(0);
  });
});
