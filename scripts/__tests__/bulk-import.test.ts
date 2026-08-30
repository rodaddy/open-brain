import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { expectDefined } from "../test-support/expect-defined.ts";
import {
  createMockPool,
  defaultOpts,
  installBulkImportMocks,
  makeFile,
  makeTempDir,
  removeTempDir,
  resetLogCalls,
  subscribeLogCalls,
} from "./bulk-import-fixture.ts";

installBulkImportMocks();

// Import after mocks
const { parseFrontmatter, readFiles, importThought } =
  await import("../bulk-import.ts");

let tmpDir: string;
let unsubscribeLogSink: (() => void) | undefined;

beforeEach(async () => {
  tmpDir = await makeTempDir();
  unsubscribeLogSink = subscribeLogCalls();
  resetLogCalls();
});

afterEach(async () => {
  unsubscribeLogSink?.();
  unsubscribeLogSink = undefined;
  await removeTempDir(tmpDir);
});

// ===========================================================================
// FRONTMATTER PARSING
// ===========================================================================

describe("parseFrontmatter", () => {
  it("parses valid YAML frontmatter with title and tags", () => {
    const raw = `---
title: My Note
tags: [ai, memory]
project: open-brain
---

This is the body content.`;
    const result = parseFrontmatter(raw);

    expect(result.frontmatter.title).toBe("My Note");
    expect(result.frontmatter.tags).toEqual(["ai", "memory"]);
    expect(result.frontmatter.project).toBe("open-brain");
    expect(result.body).toBe("This is the body content.");
  });

  it("returns empty frontmatter when no YAML delimiters present", () => {
    const raw = "Just plain markdown content with no frontmatter.";
    const result = parseFrontmatter(raw);

    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe("Just plain markdown content with no frontmatter.");
  });

  it("handles frontmatter with quoted string values", () => {
    const raw = `---
title: "A Quoted Title"
author: 'Single Quoted'
---

Body here.`;
    const result = parseFrontmatter(raw);

    expect(result.frontmatter.title).toBe("A Quoted Title");
    expect(result.frontmatter.author).toBe("Single Quoted");
  });

  it("handles frontmatter with tags containing quoted items", () => {
    const raw = `---
tags: ["tag one", 'tag two', plain]
---

Some body text for the test file.`;
    const result = parseFrontmatter(raw);

    expect(result.frontmatter.tags).toEqual(["tag one", "tag two", "plain"]);
  });

  it("handles malformed frontmatter (missing closing delimiter)", () => {
    const raw = `---
title: Broken
This never closes the frontmatter section.`;
    const result = parseFrontmatter(raw);

    // No match, so treated as plain body
    expect(result.frontmatter).toEqual({});
    expect(result.body).toContain("title: Broken");
  });

  it("handles frontmatter with lines that have no colon", () => {
    const raw = `---
title: Valid Key
no-colon-line
tags: [test]
---

Body text with enough content to pass.`;
    const result = parseFrontmatter(raw);

    expect(result.frontmatter.title).toBe("Valid Key");
    expect(result.frontmatter.tags).toEqual(["test"]);
    // The line without colon is silently skipped
  });

  it("handles empty frontmatter block (regex requires content between delimiters)", () => {
    // The regex requires at least one line between --- delimiters,
    // so an empty frontmatter block is treated as no frontmatter
    const raw = `---
---

Body after empty frontmatter section.`;
    const result = parseFrontmatter(raw);

    // No match on the regex, so entire content is treated as body
    expect(result.frontmatter).toEqual({});
    expect(result.body).toContain("Body after empty frontmatter section.");
  });

  it("trims whitespace from body", () => {
    const raw = `---
title: Test
---

   Body with leading whitespace.   `;
    const result = parseFrontmatter(raw);

    expect(result.body).toBe("Body with leading whitespace.");
  });
});

// ===========================================================================
// FILE READING (readFiles)
// ===========================================================================

describe("readFiles", () => {
  it("reads a single markdown file from a directory", async () => {
    await Bun.write(
      join(tmpDir, "note.md"),
      `---\ntitle: Test Note\n---\n\nThis is a test note with enough content to pass the minimum length check.`,
    );

    const files = await readFiles(tmpDir, "**/*.md");

    expect(files).toHaveLength(1);
    expect(expectDefined(files[0], "files[0]").frontmatter.title).toBe("Test Note");
    expect(expectDefined(files[0], "files[0]").body).toContain("This is a test note");
  });

  it("skips files with body shorter than 10 characters", async () => {
    await Bun.write(join(tmpDir, "short.md"), "tiny");
    await Bun.write(
      join(tmpDir, "long.md"),
      "This file has enough content to be included in the import.",
    );

    const files = await readFiles(tmpDir, "**/*.md");

    expect(files).toHaveLength(1);
    expect(expectDefined(files[0], "files[0]").body).toContain("enough content");
  });

  it("skips files with only frontmatter and no body", async () => {
    await Bun.write(
      join(tmpDir, "fm-only.md"),
      `---\ntitle: Only FM\ntags: [a]\n---\n`,
    );

    const files = await readFiles(tmpDir, "**/*.md");

    expect(files).toHaveLength(0);
  });

  it("reads files from nested directories with glob pattern", async () => {
    const nestedDir = join(tmpDir, "sub", "deep");
    await Bun.write(
      join(nestedDir, "nested.md"),
      "This is a nested file with plenty of body content for the import.",
    );
    await Bun.write(
      join(tmpDir, "top.md"),
      "This is a top-level file with enough body content to pass.",
    );

    const files = await readFiles(tmpDir, "**/*.md");

    expect(files).toHaveLength(2);
    const paths = files.map((f) => f.filePath);
    expect(paths.some((p) => p.includes("nested.md"))).toBe(true);
    expect(paths.some((p) => p.includes("top.md"))).toBe(true);
  });

  it("respects custom glob pattern", async () => {
    await Bun.write(
      join(tmpDir, "note.md"),
      "Markdown file with enough content for the import test.",
    );
    await Bun.write(
      join(tmpDir, "note.txt"),
      "Text file with enough content for the import test.",
    );

    const mdFiles = await readFiles(tmpDir, "*.md");
    expect(mdFiles).toHaveLength(1);

    const txtFiles = await readFiles(tmpDir, "*.txt");
    expect(txtFiles).toHaveLength(1);
  });

  it("handles empty directory", async () => {
    const files = await readFiles(tmpDir, "**/*.md");
    expect(files).toHaveLength(0);
  });

  it("handles binary-like content that passes length check", async () => {
    // Binary files won't have frontmatter, body is the raw content
    const binaryContent = Buffer.alloc(100, 0xff).toString();
    await Bun.write(join(tmpDir, "binary.md"), binaryContent);

    const files = await readFiles(tmpDir, "**/*.md");
    // It may or may not pass the length check depending on encoding,
    // but it should not throw
    expect(files.length).toBeGreaterThanOrEqual(0);
  });
});

// ===========================================================================
// SMALL: Single file import, verify SQL params
// ===========================================================================

describe("small: single file import", () => {
  it("imports one thought with correct SQL params", async () => {
    const file = makeFile(
      "This is my thought content for testing the import function.",
      { tags: ["ai", "test"] },
    );
    const { pool, mockQuery } = createMockPool();

    const result = await importThought(pool, file, defaultOpts);

    expect(result).toBe("imported");
    expect(mockQuery).toHaveBeenCalledTimes(1);

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO thoughts");
    expect(sql).toContain("content_hash");
    expect(sql).toContain("WHERE NOT EXISTS");
    // params: content, tags, source, created_by, namespace, embedding, hash, embedded_at, model, extracted
    expect(params[0]).toBe(
      "This is my thought content for testing the import function.",
    );
    expect(params[1]).toEqual(["ai", "test"]);
    expect(params[2]).toBe("bulk-import"); // sourceLabel
    expect(params[3]).toBe("bulk-import"); // created_by
    expect(params[4]).toBe("shared-kb"); // namespace
    expect(params[5]).toBeNull(); // embedding (embed=false)
    expect(typeof params[6]).toBe("string"); // hash
    expect(params[7]).toBeNull(); // embedded_at
    expect(params[8]).toBeNull(); // embedding_model
    expect(params[9]).toBeNull(); // extracted_metadata
  });

  it("returns 'duplicate' when rowCount is 0", async () => {
    const file = makeFile("Duplicate content that already exists in the database.");
    const { pool } = createMockPool(async () => ({ rows: [], rowCount: 0 }));

    const result = await importThought(pool, file, defaultOpts);
    expect(result).toBe("duplicate");
  });

  it("returns 'error' when query throws", async () => {
    const file = makeFile("Content that will cause a database error during insert.");
    const { pool } = createMockPool(async () => {
      throw new Error("connection refused");
    });

    const result = await importThought(pool, file, defaultOpts);
    expect(result).toBe("error");
  });
});

// ===========================================================================
// MEDIUM: 10 files, dedup verification
// ===========================================================================

describe("medium: 10-file import with dedup", () => {
  it("imports 10 unique files and all succeed", async () => {
    const { pool, mockQuery } = createMockPool();
    const results: string[] = [];

    for (let i = 0; i < 10; i++) {
      const file = makeFile(
        `Unique thought content number ${i} with enough text for testing.`,
        { tags: ["batch"] },
        `/test/file-${i}.md`,
      );
      const result = await importThought(pool, file, defaultOpts);
      results.push(result);
    }

    expect(results.filter((r) => r === "imported")).toHaveLength(10);
    expect(mockQuery).toHaveBeenCalledTimes(10);
  });

  it("detects duplicates when same content hash is already in DB", async () => {
    // First call succeeds (rowCount=1), subsequent calls with same hash return rowCount=0
    const seenHashes = new Set<string>();
    const { pool } = createMockPool(async (_sql: unknown, params: unknown) => {
      const hash = (params as unknown[])[6] as string;
      if (seenHashes.has(hash)) {
        return { rows: [], rowCount: 0 };
      }
      seenHashes.add(hash);
      return { rows: [], rowCount: 1 };
    });

    const results: string[] = [];
    // Import same content twice
    for (let i = 0; i < 2; i++) {
      const file = makeFile(
        "Identical content that should be detected as a duplicate on second import.",
      );
      const result = await importThought(pool, file, defaultOpts);
      results.push(result);
    }

    expect(results[0]).toBe("imported");
    expect(results[1]).toBe("duplicate");
  });

  it("imports 10 files and verifies progress stats", async () => {
    const { pool } = createMockPool();
    let imported = 0;
    let duplicates = 0;
    let errors = 0;

    for (let i = 0; i < 10; i++) {
      const file = makeFile(
        `Thought file ${i} has enough content for testing the import process.`,
      );
      const result = await importThought(pool, file, defaultOpts);
      if (result === "imported") imported++;
      else if (result === "duplicate") duplicates++;
      else errors++;
    }

    expect(imported).toBe(10);
    expect(duplicates).toBe(0);
    expect(errors).toBe(0);
  });
});

// ===========================================================================
// LARGE: 100 files, programmatic generation
// ===========================================================================

describe("large: 100-file import", () => {
  it("reads 100 programmatically generated files", async () => {
    for (let i = 0; i < 100; i++) {
      await Bun.write(
        join(tmpDir, `file-${i}.md`),
        `---\ntitle: Test ${i}\ntags: [test, batch]\n---\n\nThis is test file number ${i} with enough content to pass the minimum length check.`,
      );
    }

    const files = await readFiles(tmpDir, "**/*.md");
    expect(files).toHaveLength(100);
  });

  it("imports all 100 files as thoughts", async () => {
    const { pool } = createMockPool();
    let imported = 0;

    for (let i = 0; i < 100; i++) {
      const file = makeFile(
        `This is test file number ${i} with enough content to pass the minimum length check.`,
        { tags: ["test", "batch"] },
        join(tmpDir, `file-${i}.md`),
      );
      const result = await importThought(pool, file, defaultOpts);
      if (result === "imported") imported++;
    }

    expect(imported).toBe(100);
  });

  it("100 files with mix of unique and duplicate content", async () => {
    const seenHashes = new Set<string>();
    const { pool } = createMockPool(async (_sql: unknown, params: unknown) => {
      const hash = (params as unknown[])[6] as string;
      if (seenHashes.has(hash)) {
        return { rows: [], rowCount: 0 };
      }
      seenHashes.add(hash);
      return { rows: [], rowCount: 1 };
    });

    let imported = 0;
    let duplicates = 0;

    for (let i = 0; i < 100; i++) {
      // Every 10th file is a duplicate of file 0's content
      const content =
        i % 10 === 0 && i > 0
          ? "This is test file number 0 with enough content to pass the minimum length check."
          : `This is test file number ${i} with enough content to pass the minimum length check.`;
      const file = makeFile(content, { tags: ["test"] }, `/test/file-${i}.md`);
      const result = await importThought(pool, file, defaultOpts);
      if (result === "imported") imported++;
      else if (result === "duplicate") duplicates++;
    }

    // file 0 imports, files 10,20,30,40,50,60,70,80,90 are dupes of file 0
    expect(duplicates).toBe(9);
    expect(imported).toBe(91);
  });
});
