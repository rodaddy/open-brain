/**
 * Focused regression tests: the import writers must store a `content_hash` the
 * embedding-repair registry can reproduce, so a freshly imported row is NOT
 * immediately flagged as `source_drift`.
 *
 * These use the REAL normalizedContentHash / canonical builders / registry (no embedding
 * mock) so the equality being asserted is the exact one repair checks:
 *   stored content_hash === EMBEDDING_TARGETS[table].sourceHash(importedRow)
 *
 * Each test also pins the OLD divergent formula and asserts the writer no longer
 * produces it, so a regression back to the pre-fix hash fails loudly.
 */
import { describe, it, expect } from "vitest";
import type pg from "pg";
import { importDecision, importSession } from "../bulk-import.ts";
import { normalizedContentHash } from "../../server/embedding/provider.ts";
import { EMBEDDING_TARGETS } from "../../server/embedding/embedding-targets.ts";
import { expectDefined } from "../test-support/expect-defined.ts";

function createMockPool(
  queryImpl?: (...args: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>,
) {
  const impl = queryImpl ?? (async () => ({ rows: [], rowCount: 1 }));
  const calls: unknown[][] = [];
  const pool = {
    query: async (...args: unknown[]) => {
      calls.push(args);
      return impl(...args);
    },
    end: async () => {},
  } as unknown as pg.Pool;
  return { pool, calls };
}

function makeFile(
  body: string,
  frontmatter: Record<string, unknown> = {},
  filePath = "/notes/entry.md",
) {
  return { filePath, frontmatter, body };
}

const decisionOpts = {
  extraTags: [] as string[],
  sourceLabel: "bulk-import",
  embed: false,
  extract: false,
};

const sessionOpts = {
  extraTags: [] as string[],
  sourceLabel: "bulk-import",
  embed: false,
};

describe("bulk-import importDecision -> canonical, no source_drift", () => {
  it("stores a content_hash the decisions registry reproduces from the imported row", async () => {
    const { pool, calls } = createMockPool();
    const file = makeFile(
      "Rationale body explaining why we chose Bun over Node for the runtime.",
      { title: "Adopt Bun", tags: ["infra", "runtime"] },
      "/notes/adopt-bun.md",
    );

    await importDecision(pool, file, decisionOpts);

    const [, params] = calls[0] as [string, unknown[]];
    // INSERT columns: title, rationale, tags, context, created_by, namespace,
    // embedding, content_hash, embedded_at, embedding_model, extracted_metadata
    const title = params[0] as string;
    const rationale = params[1] as string;
    const tags = params[2] as string[];
    const context = params[3] as string;
    const storedHash = params[7] as string;

    // The imported row as the registry will project it (alternatives defaults to
    // [] in the DB). This is exactly what selectStale would recompute.
    const importedRow = {
      title,
      rationale,
      context,
      tags,
      alternatives: [] as string[],
    };
    const registryHash = expectDefined(
      EMBEDDING_TARGETS.decisions,
      "EMBEDDING_TARGETS.decisions",
    ).sourceHash(importedRow);
    expect(storedHash).toBe(registryHash);

    // Old divergent formula (title\nrationale, dropping context+tags) must no
    // longer be what we store.
    const oldHash = normalizedContentHash(`${title}\n${rationale}`);
    expect(storedHash).not.toBe(oldHash);
  });
});

describe("bulk-import importSession -> canonical, no source_drift", () => {
  it("stores a content_hash the sessions registry reproduces from the imported row", async () => {
    const { pool, calls } = createMockPool();
    const file = makeFile(
      "We finished the canonical embedding convergence work this session.",
      { project: "open-brain", tags: ["session"] },
      "/notes/session-1.md",
    );

    await importSession(pool, file, sessionOpts);

    const [, params] = calls[0] as [string, unknown[]];
    // INSERT columns: project, summary, tags, created_by, namespace, embedding,
    // content_hash, embedded_at, embedding_model
    const project = params[0] as string;
    const summary = params[1] as string;
    const storedHash = params[6] as string;

    const importedRow = {
      summary,
      project,
      key_decisions: [] as string[],
      next_steps: [] as string[],
      blockers: [] as string[],
    };
    const registryHash = expectDefined(
      EMBEDDING_TARGETS.sessions,
      "EMBEDDING_TARGETS.sessions",
    ).sourceHash(importedRow);
    expect(storedHash).toBe(registryHash);

    // Old formula folded a live timestamp into the hash -- unreproducible by the
    // registry. A hash of summary|<any ISO timestamp> must not equal what we now
    // store, and (proxy) the stored hash must equal summary|project.
    const canonicalHash = normalizedContentHash(`${summary}|${project}`);
    expect(storedHash).toBe(canonicalHash);
  });

  it("is deterministic across imports of the same summary|project (was timestamped)", async () => {
    const file = makeFile(
      "Identical session body imported twice must converge to one hash.",
      { project: "open-brain" },
    );
    const first = createMockPool();
    await importSession(first.pool, file, sessionOpts);
    const second = createMockPool();
    await importSession(second.pool, file, sessionOpts);

    const hashA = (first.calls[0] as [string, unknown[]])[1][6];
    const hashB = (second.calls[0] as [string, unknown[]])[1][6];
    expect(hashA).toBe(hashB);
  });
});
