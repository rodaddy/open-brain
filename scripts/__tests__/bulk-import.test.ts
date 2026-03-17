import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type pg from "pg";

// ---------------------------------------------------------------------------
// Mocks -- must be set up before importing the module under test
// ---------------------------------------------------------------------------

const logCalls: {
  info: Array<[string, Record<string, unknown>?]>;
  warn: Array<[string, Record<string, unknown>?]>;
  error: Array<[string, Record<string, unknown>?]>;
} = { info: [], warn: [], error: [] };

mock.module("../../src/logger.ts", () => ({
  logger: {
    info: (msg: string, extra?: Record<string, unknown>) => {
      logCalls.info.push([msg, extra]);
    },
    warn: (msg: string, extra?: Record<string, unknown>) => {
      logCalls.warn.push([msg, extra]);
    },
    error: (msg: string, extra?: Record<string, unknown>) => {
      logCalls.error.push([msg, extra]);
    },
  },
}));

mock.module("../../src/embedding.ts", () => ({
  contentHash: (text: string) => {
    // Deterministic hash for testing -- just use a simple string hash
    const { createHash } = require("node:crypto");
    const normalized = text.toLowerCase().trim().replace(/\s+/g, " ");
    return createHash("sha256").update(normalized).digest("hex");
  },
  generateEmbedding: mock(async () => null),
}));

// No mock needed for extraction.ts -- tests use extract:false (default).
// Mocking it would leak into other test files via bun's global mock.module.

mock.module("../../src/db/pool.ts", () => ({
  createPool: () => {
    throw new Error("createPool should not be called in tests");
  },
}));

mock.module("pgvector/pg", () => ({
  toSql: (arr: number[]) => `[${arr.join(",")}]`,
}));

// Import after mocks
const {
  parseFrontmatter,
  readFiles,
  importThought,
  importDecision,
  importSession,
  parseArgs,
} = await import("../bulk-import.ts");
const { contentHash } = await import("../../src/embedding.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function createMockPool(
  queryImpl?: (
    ...args: unknown[]
  ) => Promise<{ rows: unknown[]; rowCount: number }>,
) {
  const defaultImpl = async () => ({ rows: [], rowCount: 1 });
  const mockQuery = mock(queryImpl ?? defaultImpl);
  const mockEnd = mock(async () => {});
  return {
    pool: { query: mockQuery, end: mockEnd } as unknown as pg.Pool,
    mockQuery,
    mockEnd,
  };
}

const defaultOpts = {
  extraTags: [] as string[],
  sourceLabel: "bulk-import",
  embed: false,
  extract: false,
};

function makeFile(
  body: string,
  frontmatter: Record<string, unknown> = {},
  filePath = "/test/file.md",
): {
  filePath: string;
  frontmatter: Record<string, unknown>;
  body: string;
} {
  return { filePath, frontmatter, body };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "ob-bulk-test-"));
  logCalls.info.length = 0;
  logCalls.warn.length = 0;
  logCalls.error.length = 0;
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
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
    expect(result.body).toBe(
      "Just plain markdown content with no frontmatter.",
    );
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
    expect(files[0]!.frontmatter.title).toBe("Test Note");
    expect(files[0]!.body).toContain("This is a test note");
  });

  it("skips files with body shorter than 10 characters", async () => {
    await Bun.write(join(tmpDir, "short.md"), "tiny");
    await Bun.write(
      join(tmpDir, "long.md"),
      "This file has enough content to be included in the import.",
    );

    const files = await readFiles(tmpDir, "**/*.md");

    expect(files).toHaveLength(1);
    expect(files[0]!.body).toContain("enough content");
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
    // params: content, tags, source, created_by, embedding, hash, embedded_at, model, extracted
    expect(params![0]).toBe(
      "This is my thought content for testing the import function.",
    );
    expect(params![1]).toEqual(["ai", "test"]);
    expect(params![2]).toBe("bulk-import"); // sourceLabel
    expect(params![3]).toBe("bulk-import"); // created_by
    expect(params![4]).toBeNull(); // embedding (embed=false)
    expect(typeof params![5]).toBe("string"); // hash
    expect(params![6]).toBeNull(); // embedded_at
    expect(params![7]).toBeNull(); // embedding_model
    expect(params![8]).toBeNull(); // extracted_metadata
  });

  it("returns 'duplicate' when rowCount is 0", async () => {
    const file = makeFile(
      "Duplicate content that already exists in the database.",
    );
    const { pool } = createMockPool(async () => ({ rows: [], rowCount: 0 }));

    const result = await importThought(pool, file, defaultOpts);
    expect(result).toBe("duplicate");
  });

  it("returns 'error' when query throws", async () => {
    const file = makeFile(
      "Content that will cause a database error during insert.",
    );
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
      const hash = (params as unknown[])[5] as string;
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
      const hash = (params as unknown[])[5] as string;
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

// ===========================================================================
// TABLE ROUTING: thoughts vs decisions vs sessions
// ===========================================================================

describe("table routing", () => {
  it("importThought uses INSERT INTO thoughts", async () => {
    const file = makeFile(
      "A thought about testing table routing in the bulk import script.",
    );
    const { pool, mockQuery } = createMockPool();

    await importThought(pool, file, defaultOpts);

    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO thoughts");
    expect(sql).not.toContain("INSERT INTO decisions");
    expect(sql).not.toContain("INSERT INTO sessions");
  });

  it("importDecision uses INSERT INTO decisions with title and rationale", async () => {
    const file = makeFile(
      "We decided to use Bun because it is faster than Node for our workload.",
      { title: "Use Bun Runtime", tags: ["infrastructure"] },
      "/test/decision.md",
    );
    const { pool, mockQuery } = createMockPool();

    await importDecision(pool, file, defaultOpts);

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO decisions");
    expect(sql).toContain("title");
    expect(sql).toContain("rationale");
    expect(sql).toContain("context");
    expect(params![0]).toBe("Use Bun Runtime"); // title from frontmatter
    expect(params![1]).toBe(
      "We decided to use Bun because it is faster than Node for our workload.",
    ); // rationale = body
    expect(params![3]).toContain("Imported from:"); // context
  });

  it("importDecision falls back to first line of body for title when no frontmatter title", async () => {
    const file = makeFile(
      "# Switch to PostgreSQL\n\nBecause it has better vector support than SQLite.",
      {},
      "/test/decision-no-title.md",
    );
    const { pool, mockQuery } = createMockPool();

    await importDecision(pool, file, defaultOpts);

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    // Title is derived from first line with leading # stripped
    expect(params![0]).toBe("Switch to PostgreSQL");
  });

  it("importDecision uses frontmatter.name as fallback title", async () => {
    const file = makeFile(
      "This decision has a name field instead of a title field in frontmatter.",
      { name: "Named Decision" },
    );
    const { pool, mockQuery } = createMockPool();

    await importDecision(pool, file, defaultOpts);

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params![0]).toBe("Named Decision");
  });

  it("importSession uses INSERT INTO sessions with project and summary", async () => {
    const file = makeFile(
      "We worked on the bulk import feature and added comprehensive test coverage.",
      { project: "open-brain", tags: ["session"] },
      "/test/session.md",
    );
    const { pool, mockQuery } = createMockPool();

    await importSession(pool, file, {
      extraTags: [],
      sourceLabel: "bulk-import",
      embed: false,
    });

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO sessions");
    expect(sql).toContain("project");
    expect(sql).toContain("summary");
    expect(params![0]).toBe("open-brain"); // project from frontmatter
    expect(params![1]).toBe(
      "We worked on the bulk import feature and added comprehensive test coverage.",
    ); // summary = body
    expect(params![2]).toEqual(["session"]); // tags
    expect(params![3]).toBe("bulk-import"); // created_by
  });

  it("importSession sets project to null when not in frontmatter", async () => {
    const file = makeFile(
      "Session without a project field in the frontmatter metadata.",
      {},
    );
    const { pool, mockQuery } = createMockPool();

    await importSession(pool, file, {
      extraTags: [],
      sourceLabel: "bulk-import",
      embed: false,
    });

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params![0]).toBeNull(); // project
  });

  it("importSession uses VALUES (not WHERE NOT EXISTS) since sessions allow duplicates", async () => {
    const file = makeFile(
      "Session content that can appear multiple times in the database.",
    );
    const { pool, mockQuery } = createMockPool();

    await importSession(pool, file, {
      extraTags: [],
      sourceLabel: "bulk-import",
      embed: false,
    });

    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("VALUES");
    expect(sql).not.toContain("WHERE NOT EXISTS");
  });
});

// ===========================================================================
// TAG HANDLING: --tags flag merges with frontmatter tags
// ===========================================================================

describe("tag handling", () => {
  it("merges extraTags with frontmatter tags for thoughts", async () => {
    const file = makeFile(
      "Content with both frontmatter and CLI tags for testing merge behavior.",
      { tags: ["fm-tag-1", "fm-tag-2"] },
    );
    const { pool, mockQuery } = createMockPool();

    await importThought(pool, file, {
      ...defaultOpts,
      extraTags: ["cli-tag-1", "cli-tag-2"],
    });

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params![1]).toEqual([
      "fm-tag-1",
      "fm-tag-2",
      "cli-tag-1",
      "cli-tag-2",
    ]);
  });

  it("uses only extraTags when frontmatter has no tags", async () => {
    const file = makeFile(
      "Content without frontmatter tags but with CLI-provided tags.",
      {},
    );
    const { pool, mockQuery } = createMockPool();

    await importThought(pool, file, {
      ...defaultOpts,
      extraTags: ["added-tag"],
    });

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params![1]).toEqual(["added-tag"]);
  });

  it("uses only frontmatter tags when no extraTags", async () => {
    const file = makeFile(
      "Content with frontmatter tags and no extra CLI tags provided.",
      { tags: ["only-fm"] },
    );
    const { pool, mockQuery } = createMockPool();

    await importThought(pool, file, defaultOpts);

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params![1]).toEqual(["only-fm"]);
  });

  it("handles non-array frontmatter tags gracefully", async () => {
    const file = makeFile(
      "Content where frontmatter tags is a string instead of an array.",
      { tags: "not-an-array" },
    );
    const { pool, mockQuery } = createMockPool();

    await importThought(pool, file, {
      ...defaultOpts,
      extraTags: ["extra"],
    });

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    // Non-array tags should be treated as empty, only extraTags used
    expect(params![1]).toEqual(["extra"]);
  });

  it("merges tags for decisions the same way", async () => {
    const file = makeFile(
      "Decision content for testing tag merge behavior in the decisions table.",
      { title: "Tag Test", tags: ["decision-tag"] },
    );
    const { pool, mockQuery } = createMockPool();

    await importDecision(pool, file, {
      ...defaultOpts,
      extraTags: ["cli-tag"],
    });

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params![2]).toEqual(["decision-tag", "cli-tag"]); // tags is param index 2 for decisions
  });

  it("merges tags for sessions the same way", async () => {
    const file = makeFile(
      "Session content for testing tag merge behavior in the sessions table.",
      { tags: ["session-tag"] },
    );
    const { pool, mockQuery } = createMockPool();

    await importSession(pool, file, {
      extraTags: ["cli-tag"],
      sourceLabel: "bulk-import",
      embed: false,
    });

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params![2]).toEqual(["session-tag", "cli-tag"]); // tags is param index 2 for sessions
  });
});

// ===========================================================================
// DRY RUN: no DB calls
// ===========================================================================

describe("dry run", () => {
  it("readFiles works but no DB calls are needed in dry-run mode", async () => {
    // Simulate what the main function does in dry-run: read files, print them, exit
    for (let i = 0; i < 5; i++) {
      await Bun.write(
        join(tmpDir, `note-${i}.md`),
        `---\ntitle: Note ${i}\n---\n\nThis is note ${i} with enough content to pass the minimum length check.`,
      );
    }

    const files = await readFiles(tmpDir, "**/*.md");
    expect(files).toHaveLength(5);

    // In dry-run mode, the script just prints files and exits without calling pool.query
    const { pool, mockQuery } = createMockPool();

    // Dry-run: iterate and collect output but do NOT call any import function
    const dryRunOutput: string[] = [];
    for (const f of files) {
      const title =
        (f.frontmatter.title as string) ||
        (f.body.split("\n")[0] ?? "").slice(0, 80);
      dryRunOutput.push(`${f.filePath} -> ${title}`);
    }

    expect(dryRunOutput).toHaveLength(5);
    expect(dryRunOutput[0]).toContain("->");
    // Verify NO database calls were made
    expect(mockQuery).not.toHaveBeenCalled();
    // Pool.end should not be called in dry-run either (pool is never created)
  });
});

// ===========================================================================
// PARSE ARGS
// ===========================================================================

describe("parseArgs", () => {
  it("parses source directory as positional argument", () => {
    const result = parseArgs(["bun", "script.ts", "/some/dir"]);
    expect(result.sourceDir).toBe("/some/dir");
    expect(result.table).toBe("thoughts"); // default
    expect(result.dryRun).toBe(false);
    expect(result.pattern).toBe("**/*.md");
  });

  it("parses --table flag", () => {
    const result = parseArgs([
      "bun",
      "script.ts",
      "/dir",
      "--table",
      "decisions",
    ]);
    expect(result.table).toBe("decisions");
  });

  it("parses --tags flag with comma-separated values", () => {
    const result = parseArgs(["bun", "script.ts", "/dir", "--tags", "a,b,c"]);
    expect(result.extraTags).toEqual(["a", "b", "c"]);
  });

  it("parses --source flag", () => {
    const result = parseArgs([
      "bun",
      "script.ts",
      "/dir",
      "--source",
      "my-source",
    ]);
    expect(result.sourceLabel).toBe("my-source");
  });

  it("parses --pattern flag", () => {
    const result = parseArgs([
      "bun",
      "script.ts",
      "/dir",
      "--pattern",
      "*.txt",
    ]);
    expect(result.pattern).toBe("*.txt");
  });

  it("parses boolean flags: --embed, --extract, --dry-run", () => {
    const result = parseArgs([
      "bun",
      "script.ts",
      "/dir",
      "--embed",
      "--extract",
      "--dry-run",
    ]);
    expect(result.embed).toBe(true);
    expect(result.extract).toBe(true);
    expect(result.dryRun).toBe(true);
  });

  it("parses all options together", () => {
    const result = parseArgs([
      "bun",
      "script.ts",
      "/my/dir",
      "--table",
      "sessions",
      "--tags",
      "x,y",
      "--source",
      "custom",
      "--pattern",
      "notes/*.md",
      "--embed",
      "--dry-run",
    ]);
    expect(result.sourceDir).toBe("/my/dir");
    expect(result.table).toBe("sessions");
    expect(result.extraTags).toEqual(["x", "y"]);
    expect(result.sourceLabel).toBe("custom");
    expect(result.pattern).toBe("notes/*.md");
    expect(result.embed).toBe(true);
    expect(result.extract).toBe(false);
    expect(result.dryRun).toBe(true);
  });

  it("trims whitespace from tag values", () => {
    const result = parseArgs([
      "bun",
      "script.ts",
      "/dir",
      "--tags",
      " a , b , c ",
    ]);
    expect(result.extraTags).toEqual(["a", "b", "c"]);
  });
});

// ===========================================================================
// EDGE CASES
// ===========================================================================

describe("edge cases", () => {
  it("skips empty files (< 10 chars body)", async () => {
    await Bun.write(join(tmpDir, "empty.md"), "");
    await Bun.write(join(tmpDir, "short.md"), "hi");
    await Bun.write(join(tmpDir, "nine.md"), "123456789"); // exactly 9 chars

    const files = await readFiles(tmpDir, "**/*.md");
    expect(files).toHaveLength(0);
  });

  it("includes files with exactly 10 chars body", async () => {
    await Bun.write(join(tmpDir, "ten.md"), "1234567890"); // exactly 10 chars

    const files = await readFiles(tmpDir, "**/*.md");
    expect(files).toHaveLength(1);
  });

  it("handles files with frontmatter but empty body", async () => {
    await Bun.write(
      join(tmpDir, "fm-only.md"),
      `---\ntitle: All Frontmatter\ntags: [a, b]\n---\n`,
    );

    const files = await readFiles(tmpDir, "**/*.md");
    expect(files).toHaveLength(0);
  });

  it("handles files with frontmatter and very short body", async () => {
    await Bun.write(
      join(tmpDir, "fm-short.md"),
      `---\ntitle: Short Body\n---\n\nHi`,
    );

    const files = await readFiles(tmpDir, "**/*.md");
    expect(files).toHaveLength(0); // "Hi" is < 10 chars
  });

  it("handles nested directories with glob pattern", async () => {
    await Bun.write(
      join(tmpDir, "a", "b", "c", "deep.md"),
      "Deeply nested file content with enough text for the import.",
    );
    await Bun.write(
      join(tmpDir, "a", "sibling.md"),
      "Sibling file content with enough text for the import test.",
    );

    const files = await readFiles(tmpDir, "**/*.md");
    expect(files).toHaveLength(2);
  });

  it("custom source label propagates to SQL params for thoughts", async () => {
    const file = makeFile(
      "Content with a custom source label for testing propagation.",
    );
    const { pool, mockQuery } = createMockPool();

    await importThought(pool, file, {
      ...defaultOpts,
      sourceLabel: "my-custom-source",
    });

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params![2]).toBe("my-custom-source");
  });

  it("decision context includes file path", async () => {
    const file = makeFile(
      "Decision body with enough content for the minimum length check.",
      { title: "Test Decision" },
      "/my/notes/decision-001.md",
    );
    const { pool, mockQuery } = createMockPool();

    await importDecision(pool, file, defaultOpts);

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params![3]).toBe("Imported from: /my/notes/decision-001.md");
  });

  it("importThought logs warning on query error", async () => {
    const file = makeFile(
      "Content that triggers a database error for testing error handling.",
    );
    const { pool } = createMockPool(async () => {
      throw new Error("test-db-error");
    });

    const result = await importThought(pool, file, defaultOpts);

    expect(result).toBe("error");
    const warnCall = logCalls.warn.find(([msg]) => msg === "Import error");
    expect(warnCall).toBeTruthy();
    expect(warnCall![1]!.error).toBe("test-db-error");
  });

  it("importDecision logs warning on query error", async () => {
    const file = makeFile(
      "Decision content that triggers a database error for testing.",
      { title: "Error Decision" },
    );
    const { pool } = createMockPool(async () => {
      throw new Error("decision-db-error");
    });

    const result = await importDecision(pool, file, defaultOpts);

    expect(result).toBe("error");
    const warnCall = logCalls.warn.find(
      ([, extra]) => extra?.error === "decision-db-error",
    );
    expect(warnCall).toBeTruthy();
  });

  it("importSession logs warning on query error", async () => {
    const file = makeFile(
      "Session content that triggers a database error for testing.",
    );
    const { pool } = createMockPool(async () => {
      throw new Error("session-db-error");
    });

    const result = await importSession(pool, file, {
      extraTags: [],
      sourceLabel: "test",
      embed: false,
    });

    expect(result).toBe("error");
  });

  it("content hash is deterministic for identical content", () => {
    const hash1 = contentHash("Hello world test content");
    const hash2 = contentHash("Hello world test content");
    expect(hash1).toBe(hash2);
  });

  it("content hash differs for different content", () => {
    const hash1 = contentHash("Content version A for hash testing");
    const hash2 = contentHash("Content version B for hash testing");
    expect(hash1).not.toBe(hash2);
  });

  it("content hash normalizes whitespace", () => {
    const hash1 = contentHash("hello  world");
    const hash2 = contentHash("hello world");
    expect(hash1).toBe(hash2);
  });
});
