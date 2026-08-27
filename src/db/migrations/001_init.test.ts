/**
 * Schema proof for the 001_init migration, read back from a real catalog.
 *
 * Every assertion here queries `information_schema` / `pg_catalog` after the
 * migration has actually run. That is the point: the migration SQL can be read
 * by eye, but only the catalog says what the server built from it -- a
 * halfvec(768) column that silently became a vector, an HNSW index that came
 * back with `vector_cosine_ops`, a unique index that is not unique.
 *
 * REQUIRES `OPENBRAIN_TEST_DATABASE_URL`, and fails hard without it (operator
 * ruling 2026-08-27, issue #878). It must point at an isolated test/playground
 * database, never the dogfood database. `bun run test:isolated` sets it.
 *
 * The suite reads the schema the harness already built and does not migrate.
 * It used to drop its eight tables and re-run `runMigrations` itself, which
 * worked only against a hand-made database: on the migrated database the
 * harness hands it, that drop removes `_migrations` while leaving every LATER
 * migration's objects in place, so the replay collides on the first one it
 * meets again (`trg_session_lanes_updated_at` already exists). Dropping the
 * replay also means the file no longer destroys tables in whatever database
 * the variable happens to name.
 *
 * The suites below are top-level rather than nested inside one wrapper. Each is
 * an independent subject -- tables, columns, indexes, constraints, the graph
 * schema, the migration ledger, the round-trip -- over the one shared schema.
 * Flat also keeps every callback inside the nesting the lint config allows,
 * which a single wrapping describe blows past on its own.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import pgvector from "pgvector/pg";
import { requireTestDatabaseUrl } from "../../../scripts/test-support/require-test-database.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

// The type parsers are registered here rather than by importing `createPool`
// from `../pool.ts`, which does the same thing. `scripts/__tests__/bulk-import.
// test.ts` calls `mock.module` on that module, and bun's `mock.module` is
// GLOBAL -- it leaks into every other file in a whole-suite run, so importing
// the helper passes on its own and throws "createPool should not be called in
// tests" under `bun test`. Registration still has to happen: the round-trip
// suite below exists to prove halfvec comes back as number[] rather than the
// string an unregistered driver hands over.
pool.on("connect", async (client) => {
  await pgvector.registerTypes(client);
});

/** The five legacy data tables 001_init creates, each with its own embedding. */
const TABLES = [
  "thoughts",
  "decisions",
  "relationships",
  "projects",
  "sessions",
] as const;

afterAll(async () => {
  await pool.end();
});

describe("001_init table existence (live Postgres)", () => {
  it("creates all 5 data tables plus _migrations", async () => {
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

  it("records the applied migration in _migrations", async () => {
    const { rows } = await pool.query("SELECT filename FROM _migrations");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(
      rows.some((r) => (r.filename as string).includes("001_init.sql")),
    ).toBe(true);
  });
});

describe("001_init embedding columns (live Postgres)", () => {
  for (const table of TABLES) {
    it(`${table} has a halfvec(768) embedding column`, async () => {
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
      const [column] = rows;
      expect(column?.typname).toBe("halfvec");
      expect(column?.atttypmod).toBe(768);
    });
  }
});

describe("001_init indexes (live Postgres)", () => {
  it("puts an HNSW halfvec index on all 5 legacy data tables", async () => {
    const { rows } = await pool.query(
      `
      SELECT
        ic.relname AS index_name,
        tc.relname AS table_name,
        pg_get_indexdef(ix.indexrelid) AS indexdef
      FROM pg_index ix
      JOIN pg_class ic ON ix.indexrelid = ic.oid
      JOIN pg_class tc ON ix.indrelid = tc.oid
      WHERE tc.relname = ANY($1::text[])
        AND pg_get_indexdef(ix.indexrelid) ILIKE '%hnsw%'
      ORDER BY tc.relname
    `,
      [TABLES],
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual([...TABLES].sort());
    for (const row of rows) {
      expect(row.indexdef).toContain("halfvec_cosine_ops");
      expect(row.indexdef).not.toContain("vector_cosine_ops");
    }
  });

  it("makes the content_hash index unique on all 5 tables", async () => {
    const { rows } = await pool.query(
      `
      SELECT
        ic.relname AS index_name,
        tc.relname AS table_name,
        ix.indisunique
      FROM pg_index ix
      JOIN pg_class ic ON ix.indexrelid = ic.oid
      JOIN pg_class tc ON ix.indrelid = tc.oid
      WHERE ic.relname LIKE '%content_hash%'
        AND tc.relname = ANY($1::text[])
      ORDER BY tc.relname
    `,
      [TABLES],
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual([...TABLES].sort());
    for (const row of rows) {
      expect(row.indisunique).toBe(true);
    }
  });
});

describe("001_init projects table schema (live Postgres)", () => {
  it("has name, status, description, tags, and metadata columns", async () => {
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
    expect(cols.get("tags")?.udt_name).toBe("_text"); // text array
    expect(cols.get("metadata")?.data_type).toBe("jsonb");
  });

  it("has a unique constraint on name", async () => {
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

describe("001_init entity graph schema (live Postgres)", () => {
  it("creates the entity and link graph tables", async () => {
    const { rows } = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('ob_entities', 'ob_links')
      ORDER BY table_name
    `);
    const tableNames = rows.map((r) => r.table_name as string);
    expect(tableNames).toEqual(["ob_entities", "ob_links"]);
  });

  it("keeps entities canonical per namespace, type, and folded name", async () => {
    await pool.query(
      `INSERT INTO ob_entities (namespace, entity_type, name, canonical_id, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      ["test", "host", "CT235", "host:ct235", "test"],
    );

    // Same namespace and type, name differing only in case: the migration's
    // index folds it, so this is the SAME entity and the insert must be refused.
    await expect(
      pool.query(
        `INSERT INTO ob_entities (namespace, entity_type, name, created_by)
         VALUES ($1, $2, $3, $4)`,
        ["test", "host", "ct235", "test"],
      ),
    ).rejects.toThrow();

    await pool.query("DELETE FROM ob_entities WHERE namespace = $1", ["test"]);
  });

  it("allows only known link relations and rejects self-links", async () => {
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

  it("indexes entity embeddings without disturbing the legacy indexes", async () => {
    const { rows } = await pool.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexdef ILIKE '%hnsw%'
      ORDER BY indexname
    `);
    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(rows.some((r) => r.indexname === "idx_ob_entities_embedding")).toBe(
      true,
    );
    for (const row of rows) {
      expect(row.indexdef).toContain("halfvec_cosine_ops");
      expect(row.indexdef).not.toContain("vector_cosine_ops");
    }
  });
});

describe("001_init vector round-trip (live Postgres)", () => {
  it("returns halfvec(768) as number[] rather than a string", async () => {
    const testEmbedding = Array.from({ length: 768 }, () => 0.1);
    const testHash = `test_roundtrip_${Date.now()}`;

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

    const { rows } = await pool.query(
      "SELECT embedding FROM thoughts WHERE content_hash = $1",
      [testHash],
    );

    expect(rows.length).toBe(1);
    const embedding = rows[0]?.embedding;

    // The driver hands back a string unless the halfvec type is parsed, and a
    // string passes a naive length check at 768 characters -- so assert the
    // shape, not just the size.
    expect(Array.isArray(embedding)).toBe(true);
    expect(embedding.length).toBe(768);
    expect(typeof embedding[0]).toBe("number");

    await pool.query("DELETE FROM thoughts WHERE content_hash = $1", [
      testHash,
    ]);
  });
});
