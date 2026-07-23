/**
 * Focused regression: the legacy-KB decision importer inserts a `context`
 * (weight/occurrences provenance) and tags, but historically hashed only
 * `title\nrationale`. The embedding-repair registry recomputes the decision
 * source hash from title + rationale + context + alternatives + tags, so every
 * legacy decision was immediately `source_drift`. The importer now hashes the
 * shared canonical text over the exact fields it inserts.
 */
import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type pg from "pg";
import { importDecisions } from "../import-legacy-kb.ts";
import { contentHash } from "../../src/embedding.ts";
import { EMBEDDING_TARGETS } from "../../src/embedding-targets.ts";

function createMockPool() {
  const calls: unknown[][] = [];
  const pool = {
    query: async (...args: unknown[]) => {
      calls.push(args);
      return { rows: [], rowCount: 1 };
    },
  } as unknown as pg.Pool;
  return { pool, calls };
}

describe("import-legacy-kb importDecisions -> canonical, no source_drift", () => {
  it("stores a content_hash the decisions registry reproduces from the inserted row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ob-legacy-kb-"));
    try {
      const entry = {
        date: "2026-01-01",
        lastSeen: "2026-01-01",
        occurrences: 3,
        weight: 80,
        title: "Prefer pgvector halfvec",
        summary:
          "Storing embeddings as halfvec(768) halves the index footprint.",
        tags: ["db", "vectors"],
      };
      const filePath = join(dir, "decisions-v2.json");
      await Bun.write(filePath, JSON.stringify([entry]));

      const { pool, calls } = createMockPool();
      const result = await importDecisions(pool, filePath);
      expect(result.imported).toBe(1);

      const [, params] = calls[0] as [string, unknown[]];
      // INSERT columns: title, rationale, tags, context, created_by, created_at,
      // namespace, content_hash
      const title = params[0] as string;
      const rationale = params[1] as string;
      const tags = params[2] as string[];
      const context = params[3] as string;
      const storedHash = params[7] as string;

      const insertedRow = {
        title,
        rationale,
        context,
        tags,
        alternatives: [] as string[],
      };
      const registryHash = EMBEDDING_TARGETS.decisions!.sourceHash(insertedRow);
      expect(storedHash).toBe(registryHash);

      // The old title\nrationale-only hash omitted the stored context/tags and
      // must no longer be produced.
      const oldHash = contentHash(`${title}\n${rationale}`);
      expect(storedHash).not.toBe(oldHash);
      // context/tags genuinely participate (proves the omission was real).
      expect(context).toContain("Legacy import");
      expect(tags.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
