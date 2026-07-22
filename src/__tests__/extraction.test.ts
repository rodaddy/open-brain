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
    // but always emits a title + content_hash for real text.
    const a = await extractMetadata(LONG_TEXT);
    const b = await extractMetadata(LONG_TEXT);
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
    expect(a?.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a?.hash_version).toBe("sha256.v1");
    expect(a?.byte_length).toBe(new TextEncoder().encode(LONG_TEXT).byteLength);
    expect(a?.title).toBe(LONG_TEXT);
    // Semantic fields stay empty under the default; they are model territory.
    expect(a?.topics).toEqual([]);
    expect(a?.people).toEqual([]);
    // The digest itself is opaque -- it never equals or embeds the source text.
    expect(a?.content_hash).not.toContain(LONG_TEXT.slice(20, 40));
    expect(a?.content_hash?.length).toBe(64);
  });

  it("derives a bounded title from the first non-empty line", async () => {
    const text = "  \n\n  First real line as title\nsecond line\nthird";
    const result = await extractMetadata(text);
    expect(result?.title).toBe("First real line as title");
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
    // deterministic content_hash/title is the point of issue #337.
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
    // strip the content_hash/title issue #337 requires. The provider's error
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
    // A provider that tries to inject its own content_hash/title is stripped by
    // the strict schema; the structural fields are always computed here from the
    // actual text, so a provider can never forge them.
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
    expect(result?.title).toBe(LONG_TEXT);
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
      "WHERE id = $3 AND namespace = $4 AND archived_at IS NULL",
    );
    // params: [enrichedTags, extractedJson, entryId, namespace]
    expect(params[2]).toBe("entry-1");
    expect(params[3]).toBe("alice");
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
});
