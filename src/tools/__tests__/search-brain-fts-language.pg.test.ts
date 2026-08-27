import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { executeSearch } from "../search-brain.ts";
import type { ToolDeps } from "../index.ts";
import { requireTestDatabaseUrl } from "../../../scripts/test-support/require-test-database.ts";
import {
  assertUtf8Harness,
  embed,
  THOUGHTS_ONLY,
} from "./search-brain-fts-language-test-helpers.ts";

/**
 * Live-PostgreSQL functional ranking coverage for language-aware FTS (#341).
 *
 * These require a real Postgres with the migrations applied (the stored english
 * search_vector column and the bundled snowball text-search configs), which the
 * imported helper demands at module scope rather than skipping the suite when
 * the harness is absent (#878). They prove the actual retrieval benefit:
 * content that only matches once its language is stemmed correctly is found
 * under the language-aware config and NOT under a mismatched english config --
 * the before/after that motivates the change.
 *
 * The two sibling files hold the other halves of the original suite: the
 * migration-007 source-field coverage and the declared-language end-to-end
 * chain.
 */

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const deps = { pool: pool as never, embedFn: embed } as ToolDeps;
const ns = "test-fts-language";

async function cleanup(): Promise<void> {
  await pool.query("DELETE FROM entry_access_log WHERE query_text LIKE $1", [
    "%__fts_lang_probe__%",
  ]);
  await pool.query("DELETE FROM thoughts WHERE namespace = $1", [ns]);
  await pool.query(
    "DELETE FROM ob_sources WHERE namespace = $1 AND external_id LIKE $2",
    [ns, "fts-lang/%"],
  );
}

async function seedThought(id: string, content: string): Promise<void> {
  await pool.query(
    `INSERT INTO thoughts (id, content, namespace, created_by, content_hash)
     VALUES ($1, $2, $3, 'test', $4)
     ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content`,
    [id, content, ns, `fts-lang-${id}`],
  );
}

/**
 * Seed a thought whose matchable non-english token lives ONLY in `tags`, not
 * in `content`. Both FTS paths fold tags into the analyzed text (english via
 * the stored generated `search_vector`, non-english via the on-the-fly
 * to_tsvector over FTS_SOURCE_TEXT), so this isolates tag-token stemming.
 */
async function seedThoughtWithTags(
  id: string,
  content: string,
  tags: string[],
): Promise<void> {
  await pool.query(
    `INSERT INTO thoughts (id, content, tags, namespace, created_by, content_hash)
     VALUES ($1, $2, $3, $4, 'test', $5)
     ON CONFLICT (id) DO UPDATE
       SET content = EXCLUDED.content, tags = EXCLUDED.tags`,
    [id, content, tags, ns, `fts-lang-${id}`],
  );
}

async function keywordIds(
  query: string,
  ftsConfig: "english" | "german" | "spanish",
): Promise<string[]> {
  const rows = await executeSearch(
    deps as ToolDeps,
    THOUGHTS_ONLY,
    query,
    10,
    "keyword",
    undefined,
    0,
    ns,
    false,
    undefined,
    { ftsConfig },
  );
  return rows.map((r) => r.id);
}

describe("search_brain language-aware FTS ranking (live Postgres)", () => {
  beforeAll(async () => {
    await assertUtf8Harness(pool);
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("german stemming finds a document english analysis misses (before/after)", async () => {
    await cleanup();
    // "Häuser" (houses) stems to "haus" under german; english leaves it intact,
    // so an english analysis of the query "Haus" never matches the document.
    const doc = "20000000-0000-4000-8000-000000000001";
    await seedThought(doc, "Die Häuser in der Stadt sind alt __fts_lang_probe__");

    const underGerman = await keywordIds("Haus", "german");
    const underEnglish = await keywordIds("Haus", "english");

    // AFTER (language-aware): the german-stemmed query matches the document.
    expect(underGerman).toContain(doc);
    // BEFORE (mismatched english config): the same query misses it.
    expect(underEnglish).not.toContain(doc);
  });

  it("token present ONLY in tags is found under language-aware stemming, missed under english", async () => {
    await cleanup();
    // The German inflection "Häuser" lives ONLY in tags -- the content has no
    // German word. german stems the tag "haeuser"->"haus", so the query "Haus"
    // matches via the tag; english leaves the tag token intact and never does.
    const doc = "20000000-0000-4000-8000-000000000004";
    await seedThoughtWithTags(
      doc,
      "Neutral english body with no german word __fts_lang_probe__",
      ["Häuser", "stadt"],
    );

    const underGerman = await keywordIds("Haus", "german");
    const underEnglish = await keywordIds("Haus", "english");

    // AFTER (language-aware): the german-stemmed tag matches the query.
    expect(underGerman).toContain(doc);
    // BEFORE (mismatched english config): the same tag token misses it.
    expect(underEnglish).not.toContain(doc);
  });

  it("spanish stemming matches an inflected form english analysis misses", async () => {
    await cleanup();
    // "corriendo"/"corrió" share the stem "corr" under spanish.
    const doc = "20000000-0000-4000-8000-000000000002";
    await seedThought(
      doc,
      "El atleta estaba corriendo por el parque __fts_lang_probe__",
    );

    const underSpanish = await keywordIds("corrió", "spanish");
    const underEnglish = await keywordIds("corrió", "english");

    expect(underSpanish).toContain(doc);
    expect(underEnglish).not.toContain(doc);
  });

  it("english default path is unchanged for english content", async () => {
    await cleanup();
    const doc = "20000000-0000-4000-8000-000000000003";
    await seedThought(
      doc,
      "The runner was running through the park __fts_lang_probe__",
    );
    // english stems running->run; the query "runners" matches.
    const ids = await keywordIds("runners", "english");
    expect(ids).toContain(doc);
  });
});
