import { describe, expect, test } from "vitest";

import { contentHash, normalizedContentHash } from "./content-hash.ts";

/**
 * These digests were computed from the pre-refactor functions
 * (`server/tools/memory-helpers.ts` and `server/embedding/provider.ts` on
 * `origin/main`) and are hardcoded on purpose. They are dedupe keys behind
 * `ON CONFLICT (content_hash, namespace)`: if one of these assertions goes red,
 * the change under test re-partitions stored rows, and that is the finding —
 * not a stale expectation to update.
 */
describe("content-hash digests are pinned", () => {
  test("contentHash matches the pre-refactor raw digests", () => {
    expect(contentHash("Hello  World")).toBe(
      "60ab9317806dc4d589535de03f782620ae35c7c641c43e99e8823acf10cf11b3",
    );
    expect(contentHash("hello world")).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
    expect(contentHash("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(contentHash("  Mixed\tCase\n Text  ")).toBe(
      "a0e69891be7a4e8a821ceb75556afe749156eeac9da173041e006e44d72d5e0f",
    );
  });

  test("normalizedContentHash matches the pre-refactor normalized digests", () => {
    expect(normalizedContentHash("Hello  World")).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
    expect(normalizedContentHash("hello world")).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
    expect(normalizedContentHash("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(normalizedContentHash("  Mixed\tCase\n Text  ")).toBe(
      "3f837f6810deab310911c9dba75a15656072af71f5d3962ee41508b4088d647b",
    );
  });
});

describe("the two policies are deliberately different", () => {
  test("raw hashing treats case and spacing as significant", () => {
    expect(contentHash("Hello  World")).not.toBe(contentHash("hello world"));
  });

  test("normalized hashing folds case and collapses whitespace runs", () => {
    expect(normalizedContentHash("Hello  World")).toBe(
      normalizedContentHash("hello world"),
    );
    expect(normalizedContentHash("  HELLO\t\tworld\n")).toBe(
      normalizedContentHash("hello world"),
    );
  });

  test("the two disagree on exactly the inputs the normalizer folds", () => {
    expect(normalizedContentHash("Hello  World")).not.toBe(contentHash("Hello  World"));
    // Already lowercase, trimmed, single-spaced: nothing to fold, so they agree.
    expect(normalizedContentHash("hello world")).toBe(contentHash("hello world"));
  });
});
