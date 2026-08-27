import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { executeSearch } from "../search-brain.ts";
import type { ToolDeps } from "../index.ts";
import { requireTestDatabaseUrl } from "../../../scripts/test-support/require-test-database.ts";
import { assertUtf8Harness, embed } from "./search-brain-fts-language-test-helpers.ts";

/**
 * Live-PostgreSQL coverage that language-aware FTS reaches every source field
 * migration 007 indexes (#341), split out of search-brain-fts-language.pg.test.ts
 * so each live suite owns one file.
 *
 * The imported helper demands a real Postgres at module scope rather than
 * letting the suite skip itself when the harness is absent (#878).
 */

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

const deps = { pool: pool as never, embedFn: embed };
const ns = "test-fts-language-all-tables";

const tableCases = [
  {
    table: "decisions" as const,
    ids: [
      "22000000-0000-4000-8000-000000000001",
      "22000000-0000-4000-8000-000000000002",
      "22000000-0000-4000-8000-000000000003",
      "22000000-0000-4000-8000-000000000004",
    ],
    seed: () =>
      pool.query(
        `INSERT INTO decisions
           (id, title, rationale, context, tags, namespace, created_by)
         VALUES
           ($2, 'Häuser', 'neutral rationale', NULL, '{}', $1, 'test'),
           ($3, 'neutral title 2', 'Häuser', NULL, '{}', $1, 'test'),
           ($4, 'neutral title 3', 'neutral rationale', 'Häuser', '{}', $1, 'test'),
           ($5, 'neutral title 4', 'neutral rationale', NULL, ARRAY['Häuser'], $1, 'test')`,
        [
          ns,
          "22000000-0000-4000-8000-000000000001",
          "22000000-0000-4000-8000-000000000002",
          "22000000-0000-4000-8000-000000000003",
          "22000000-0000-4000-8000-000000000004",
        ],
      ),
  },
  {
    table: "relationships" as const,
    ids: [
      "22000000-0000-4000-8000-000000000011",
      "22000000-0000-4000-8000-000000000012",
      "22000000-0000-4000-8000-000000000013",
    ],
    seed: () =>
      pool.query(
        `INSERT INTO relationships
           (id, person_name, context, tags, namespace, created_by)
         VALUES
           ($2, 'Häuser', NULL, '{}', $1, 'test'),
           ($3, 'neutral person 12', 'Häuser', '{}', $1, 'test'),
           ($4, 'neutral person 13', NULL, ARRAY['Häuser'], $1, 'test')`,
        [
          ns,
          "22000000-0000-4000-8000-000000000011",
          "22000000-0000-4000-8000-000000000012",
          "22000000-0000-4000-8000-000000000013",
        ],
      ),
  },
  {
    table: "projects" as const,
    ids: [
      "22000000-0000-4000-8000-000000000021",
      "22000000-0000-4000-8000-000000000022",
      "22000000-0000-4000-8000-000000000023",
    ],
    seed: () =>
      pool.query(
        `INSERT INTO projects
           (id, name, description, tags, namespace, created_by)
         VALUES
           ($2, 'Häuser', NULL, '{}', $1, 'test'),
           ($3, 'neutral project 22', 'Häuser', '{}', $1, 'test'),
           ($4, 'neutral project 23', NULL, ARRAY['Häuser'], $1, 'test')`,
        [
          ns,
          "22000000-0000-4000-8000-000000000021",
          "22000000-0000-4000-8000-000000000022",
          "22000000-0000-4000-8000-000000000023",
        ],
      ),
  },
  {
    table: "sessions" as const,
    ids: [
      "22000000-0000-4000-8000-000000000031",
      "22000000-0000-4000-8000-000000000032",
      "22000000-0000-4000-8000-000000000033",
      "22000000-0000-4000-8000-000000000034",
    ],
    seed: () =>
      pool.query(
        `INSERT INTO sessions
           (id, summary, next_steps, key_decisions, tags, namespace, created_by)
         VALUES
           ($2, 'Häuser', '{}', '{}', '{}', $1, 'test'),
           ($3, 'neutral summary 32', ARRAY['Häuser'], '{}', '{}', $1, 'test'),
           ($4, 'neutral summary 33', '{}', ARRAY['Häuser'], '{}', $1, 'test'),
           ($5, 'neutral summary 34', '{}', '{}', ARRAY['Häuser'], $1, 'test')`,
        [
          ns,
          "22000000-0000-4000-8000-000000000031",
          "22000000-0000-4000-8000-000000000032",
          "22000000-0000-4000-8000-000000000033",
          "22000000-0000-4000-8000-000000000034",
        ],
      ),
  },
];

async function cleanup(): Promise<void> {
  for (const { table } of tableCases.toReversed()) {
    await pool.query(`DELETE FROM ${table} WHERE namespace = $1`, [ns]);
  }
}

async function keywordIds(
  table: (typeof tableCases)[number]["table"],
  ftsConfig: "english" | "german",
): Promise<string[]> {
  const rows = await executeSearch(
    deps as ToolDeps,
    [table],
    "Haus",
    10,
    "keyword",
    undefined,
    0,
    ns,
    false,
    undefined,
    { ftsConfig },
  );
  return rows.map((row) => row.id);
}
describe("language-aware FTS covers every migration-007 source field (live Postgres)", () => {
  beforeAll(async () => {
    await assertUtf8Harness(pool);
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("finds an isolated German inflection in every indexed field", async () => {
    await cleanup();

    for (const tableCase of tableCases) {
      await tableCase.seed();

      const underGerman = await keywordIds(tableCase.table, "german");
      const underEnglish = await keywordIds(tableCase.table, "english");

      expect(underGerman.toSorted()).toEqual(tableCase.ids.toSorted());
      expect(underEnglish).toEqual([]);
    }
  });
});
