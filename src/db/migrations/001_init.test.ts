// Integration test -- requires PostgreSQL with pgvector. Set DB_NAME_TEST or uses open_brain_test.
// Skips gracefully if database is unreachable.
import { describe, it, expect, afterAll } from "bun:test";
import { createPool } from "../pool.ts";
import { runMigrations } from "../migrate.ts";
import type pg from "pg";

const TEST_DB = process.env.DB_NAME_TEST || "open_brain_test";

let pool: pg.Pool;
let canConnect = false;

// Top-level await: check connectivity BEFORE describe.skipIf evaluates
try {
  pool = createPool({ database: TEST_DB });
  await pool.query("SELECT 1");
  canConnect = true;

  // Clean slate: drop all tables
  await pool.query(`
    DROP TABLE IF EXISTS ob_links CASCADE;
    DROP TABLE IF EXISTS ob_entities CASCADE;
    DROP TABLE IF EXISTS thoughts CASCADE;
    DROP TABLE IF EXISTS decisions CASCADE;
    DROP TABLE IF EXISTS relationships CASCADE;
    DROP TABLE IF EXISTS projects CASCADE;
    DROP TABLE IF EXISTS sessions CASCADE;
    DROP TABLE IF EXISTS _migrations CASCADE;
  `);

  // Apply migrations fresh
  await runMigrations(pool);
} catch {
  // canConnect stays false -- tests will skip
}

afterAll(async () => {
  if (!canConnect || !pool) return;
  await pool.query(`
    DROP TABLE IF EXISTS ob_links CASCADE;
    DROP TABLE IF EXISTS ob_entities CASCADE;
    DROP TABLE IF EXISTS thoughts CASCADE;
    DROP TABLE IF EXISTS decisions CASCADE;
    DROP TABLE IF EXISTS relationships CASCADE;
    DROP TABLE IF EXISTS projects CASCADE;
    DROP TABLE IF EXISTS sessions CASCADE;
    DROP TABLE IF EXISTS _migrations CASCADE;
  `);
  await pool.end();
});

const TABLES = [
  "thoughts",
  "decisions",
  "relationships",
  "projects",
  "sessions",
] as const;

describe.skipIf(!canConnect)("001_init migration", () => {
  describe("table existence", () => {
    it("should create all 5 data tables plus _migrations", async () => {
      const { rows } = await pool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name
      `);
      const tableNames = rows.map((r) => r.table_name as string);
      for (const table of [...TABLES, "_migrations"]) {
        expect(tableNames).toContain(table);
      }
    });
  });

  describe("embedding columns", () => {
    for (const table of TABLES) {
      it(`${table} should have halfvec(768) embedding column`, async () => {
        const { rows } = await pool.query(
          `
          SELECT t.typname, a.atttypmod
          FROM pg_attribute a
          JOIN pg_class c ON a.attrelid = c.oid
          JOIN pg_type t ON a.atttypid = t.oid
          WHERE c.relname = $1
            AND a.attname = 'embedding'
            AND NOT a.attisdropped
        `,
          [table],
        );
        expect(rows.length).toBe(1);
        expect(rows[0]!.typname).toBe("halfvec");
        expect(rows[0]!.atttypmod).toBe(768);
      });
    }
  });

  describe("HNSW indexes", () => {
    it("should have 5 HNSW indexes using halfvec_cosine_ops", async () => {
      const { rows } = await pool.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexdef ILIKE '%hnsw%'
        ORDER BY indexname
      `);
      expect(rows.length).toBe(5);
      for (const row of rows) {
        expect(row.indexdef).toContain("halfvec_cosine_ops");
        expect(row.indexdef).not.toContain("vector_cosine_ops");
      }
    });
  });

  describe("content_hash unique indexes", () => {
    it("should have unique content_hash indexes on all 5 tables", async () => {
      const { rows } = await pool.query(`
        SELECT
          ic.relname AS index_name,
          tc.relname AS table_name,
          ix.indisunique
        FROM pg_index ix
        JOIN pg_class ic ON ix.indexrelid = ic.oid
        JOIN pg_class tc ON ix.indrelid = tc.oid
        WHERE ic.relname LIKE '%content_hash%'
        ORDER BY tc.relname
      `);
      expect(rows.length).toBe(5);
      for (const row of rows) {
        expect(row.indisunique).toBe(true);
      }
    });
  });

  describe("projects table schema", () => {
    it("should have name, status, description, tags, and metadata columns", async () => {
      const { rows } = await pool.query(`
        SELECT column_name, data_type, udt_name
        FROM information_schema.columns
        WHERE table_name = 'projects'
          AND table_schema = 'public'
        ORDER BY ordinal_position
      `);
      const cols = new Map(
        rows.map((r) => [r.column_name as string, r] as const),
      );

      expect(cols.has("name")).toBe(true);
      expect(cols.has("status")).toBe(true);
      expect(cols.has("description")).toBe(true);
      expect(cols.has("tags")).toBe(true);
      expect(cols.get("tags")!.udt_name).toBe("_text"); // text array
      expect(cols.has("metadata")).toBe(true);
      expect(cols.get("metadata")!.data_type).toBe("jsonb");
    });

    it("should have a unique constraint on name", async () => {
      const { rows } = await pool.query(`
        SELECT ic.relname AS index_name, ix.indisunique
        FROM pg_index ix
        JOIN pg_class ic ON ix.indexrelid = ic.oid
        JOIN pg_class tc ON ix.indrelid = tc.oid
        WHERE tc.relname = 'projects'
          AND ic.relname LIKE '%name%'
      `);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.some((r) => r.indisunique === true)).toBe(true);
    });
  });

  describe("entity graph schema", () => {
    it("should create entity and link graph tables", async () => {
      const { rows } = await pool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('ob_entities', 'ob_links')
        ORDER BY table_name
      `);
      const tableNames = rows.map((r) => r.table_name as string);
      expect(tableNames).toEqual(["ob_entities", "ob_links"]);
    });

    it("should enforce canonical entities by namespace, type, and case-insensitive name", async () => {
      await pool.query(
        `INSERT INTO ob_entities (namespace, entity_type, name, canonical_id, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        ["test", "host", "CT235", "host:ct235", "test"],
      );

      await expect(
        pool.query(
          `INSERT INTO ob_entities (namespace, entity_type, name, created_by)
           VALUES ($1, $2, $3, $4)`,
          ["test", "host", "ct235", "test"],
        ),
      ).rejects.toThrow();

      await pool.query("DELETE FROM ob_entities WHERE namespace = $1", ["test"]);
    });

    it("should enforce allowed link relations and reject self-links", async () => {
      const inserted = await pool.query(
        `INSERT INTO ob_entities (namespace, entity_type, name, created_by)
         VALUES ($1, $2, $3, $4), ($1, $2, $5, $4)
         RETURNING id`,
        ["test", "workflow", "Open Brain", "test", "Hermes overlay"],
      );
      const [fromId, toId] = inserted.rows.map((r) => r.id as string);

      await pool.query(
        `INSERT INTO ob_links (namespace, from_type, from_id, to_type, to_id, relation, created_by)
         VALUES ('test', $1, $2, $3, $4, $5, $6)`,
        ["entity", fromId, "entity", toId, "depends_on", "test"],
      );

      await expect(
        pool.query(
          `INSERT INTO ob_links (namespace, from_type, from_id, to_type, to_id, relation, created_by)
           VALUES ('test', $1, $2, $3, $4, $5, $6)`,
          ["entity", fromId, "entity", toId, "mystery_relation", "test"],
        ),
      ).rejects.toThrow();

      await expect(
        pool.query(
          `INSERT INTO ob_links (namespace, from_type, from_id, to_type, to_id, relation, created_by)
           VALUES ('test', $1, $2, $3, $4, $5, $6)`,
          ["entity", fromId, "entity", fromId, "adjacent", "test"],
        ),
      ).rejects.toThrow();

      await pool.query("DELETE FROM ob_links WHERE created_by = $1", ["test"]);
      await pool.query("DELETE FROM ob_entities WHERE namespace = $1", ["test"]);
    });

    it("should have halfvec indexes for entities without changing legacy table indexes", async () => {
      const { rows } = await pool.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexdef ILIKE '%hnsw%'
        ORDER BY indexname
      `);
      expect(rows.length).toBeGreaterThanOrEqual(6);
      expect(rows.some((r) => r.indexname === "idx_ob_entities_embedding")).toBe(true);
      for (const row of rows) {
        expect(row.indexdef).toContain("halfvec_cosine_ops");
        expect(row.indexdef).not.toContain("vector_cosine_ops");
      }
    });
  });

  describe("_migrations tracking", () => {
    it("should record the applied migration", async () => {
      const { rows } = await pool.query("SELECT filename FROM _migrations");
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(
        rows.some((r) => (r.filename as string).includes("001_init.sql")),
      ).toBe(true);
    });
  });

  describe("vector round-trip", () => {
    it("should round-trip halfvec(768) as number[] not string", async () => {
      const testEmbedding = Array.from({ length: 768 }, () => 0.1);
      const testHash = "test_roundtrip_" + Date.now();

      // Insert
      // namespace explicit: migration 019 dropped the legacy 'collab' default
      // (#167), so inserts that omit namespace fail by design.
      await pool.query(
        `INSERT INTO thoughts (content, created_by, embedding, content_hash, namespace)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          "test round-trip",
          "test",
          JSON.stringify(testEmbedding),
          testHash,
          "test",
        ],
      );

      // Select
      const { rows } = await pool.query(
        "SELECT embedding FROM thoughts WHERE content_hash = $1",
        [testHash],
      );

      expect(rows.length).toBe(1);
      const embedding = rows[0]!.embedding;

      // Must be an array, not a string
      expect(Array.isArray(embedding)).toBe(true);
      expect(embedding.length).toBe(768);
      expect(typeof embedding[0]).toBe("number");

      // Cleanup
      await pool.query("DELETE FROM thoughts WHERE content_hash = $1", [
        testHash,
      ]);
    });
  });
});
