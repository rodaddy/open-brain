import { describe, it, expect } from "bun:test";
import { extractMetadata, mergeTags } from "../extraction.ts";
import type { ExtractedMetadata } from "../extraction.ts";

describe("extractMetadata", () => {
  it("returns null for empty or short text", async () => {
    await expect(extractMetadata("")).resolves.toBeNull();
    await expect(extractMetadata("too short")).resolves.toBeNull();
  });

  it("returns null for long text because runtime extraction is disabled", async () => {
    const result = await extractMetadata(
      "This is a sufficiently long text for extraction, but extraction is disabled.",
    );

    expect(result).toBeNull();
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
