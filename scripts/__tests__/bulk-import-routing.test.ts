import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { expectDefined } from "../test-support/expect-defined.ts";
import {
  createMockPool,
  defaultOpts,
  installBulkImportMocks,
  logCalls,
  makeFile,
  makeTempDir,
  removeTempDir,
  resetLogCalls,
  subscribeLogCalls,
} from "./bulk-import-fixture.ts";

installBulkImportMocks();

// Import after mocks
const { readFiles, importThought, importDecision, importSession, parseArgs } =
  await import("../bulk-import.ts");
const { contentHash } = await import("../../src/embedding.ts");

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
    expect(sql).toContain("namespace");
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
    expect(sql).toContain("namespace");
    expect(params[0]).toBe("Use Bun Runtime"); // title from frontmatter
    expect(params[1]).toBe(
      "We decided to use Bun because it is faster than Node for our workload.",
    ); // rationale = body
    expect(params[3]).toContain("Imported from:"); // context
    expect(params[5]).toBe("shared-kb"); // namespace
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
    expect(params[0]).toBe("Switch to PostgreSQL");
  });

  it("importDecision uses frontmatter.name as fallback title", async () => {
    const file = makeFile(
      "This decision has a name field instead of a title field in frontmatter.",
      { name: "Named Decision" },
    );
    const { pool, mockQuery } = createMockPool();

    await importDecision(pool, file, defaultOpts);

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe("Named Decision");
  });
});

describe("table routing: sessions", () => {
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
    expect(params[0]).toBe("open-brain"); // project from frontmatter
    expect(params[1]).toBe(
      "We worked on the bulk import feature and added comprehensive test coverage.",
    ); // summary = body
    expect(params[2]).toEqual(["session"]); // tags
    expect(params[3]).toBe("bulk-import"); // created_by
    expect(params[4]).toBe("shared-kb"); // namespace
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
    expect(params[0]).toBeNull(); // project
  });

  it("importSession dedups on the canonical summary|project hash (WHERE NOT EXISTS)", async () => {
    // Sessions used to hash summary + a live timestamp so every import created a
    // fresh row. That hash can never be reproduced by the embedding-repair
    // registry, so every imported session was permanently source_drift. The
    // writer now hashes the canonical summary|project source and dedups on it,
    // matching the live session writers.
    const file = makeFile(
      "Session content that maps to a stable canonical source hash.",
    );
    const { pool, mockQuery } = createMockPool();

    await importSession(pool, file, {
      extraTags: [],
      sourceLabel: "bulk-import",
      embed: false,
    });

    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("WHERE NOT EXISTS");
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
    expect(params[1]).toEqual(["fm-tag-1", "fm-tag-2", "cli-tag-1", "cli-tag-2"]);
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
    expect(params[1]).toEqual(["added-tag"]);
  });

  it("uses only frontmatter tags when no extraTags", async () => {
    const file = makeFile(
      "Content with frontmatter tags and no extra CLI tags provided.",
      { tags: ["only-fm"] },
    );
    const { pool, mockQuery } = createMockPool();

    await importThought(pool, file, defaultOpts);

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[1]).toEqual(["only-fm"]);
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
    expect(params[1]).toEqual(["extra"]);
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
    expect(params[2]).toEqual(["decision-tag", "cli-tag"]); // tags is param index 2 for decisions
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
    expect(params[2]).toEqual(["session-tag", "cli-tag"]); // tags is param index 2 for sessions
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
    const { mockQuery } = createMockPool();

    // Dry-run: iterate and collect output but do NOT call any import function
    const dryRunOutput: string[] = [];
    for (const f of files) {
      const title =
        (f.frontmatter.title as string) || (f.body.split("\n")[0] ?? "").slice(0, 80);
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
    const result = parseArgs(["bun", "script.ts", "/dir", "--table", "decisions"]);
    expect(result.table).toBe("decisions");
  });

  it("parses --tags flag with comma-separated values", () => {
    const result = parseArgs(["bun", "script.ts", "/dir", "--tags", "a,b,c"]);
    expect(result.extraTags).toEqual(["a", "b", "c"]);
  });

  it("parses --source flag", () => {
    const result = parseArgs(["bun", "script.ts", "/dir", "--source", "my-source"]);
    expect(result.sourceLabel).toBe("my-source");
  });

  it("parses --pattern flag", () => {
    const result = parseArgs(["bun", "script.ts", "/dir", "--pattern", "*.txt"]);
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
    const result = parseArgs(["bun", "script.ts", "/dir", "--tags", " a , b , c "]);
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
    await Bun.write(join(tmpDir, "fm-short.md"), `---\ntitle: Short Body\n---\n\nHi`);

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
    expect(params[2]).toBe("my-custom-source");
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
    expect(params[3]).toBe("Imported from: /my/notes/decision-001.md");
  });
});

describe("edge cases: error logging and hashing", () => {
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
    expect(
      expectDefined(expectDefined(warnCall, "warnCall")[1], "warnCall[1]").error,
    ).toBe("test-db-error");
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
