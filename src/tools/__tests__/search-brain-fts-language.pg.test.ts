import { afterAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { executeSearch } from "../search-brain.ts";
import { requestFtsConfig, resolveFtsConfig } from "../fts-config.ts";
import { createMockEmbed } from "./test-helpers.ts";

/**
 * Live-PostgreSQL functional ranking coverage for language-aware FTS (#341).
 *
 * These run only when OPENBRAIN_TEST_DATABASE_URL points at a real Postgres
 * with the migrations applied (the stored english search_vector column and the
 * bundled snowball text-search configs). They prove the actual retrieval
 * benefit: content that only matches once its language is stemmed correctly is
 * found under the language-aware config and NOT under a mismatched english
 * config -- the before/after that motivates the change.
 *
 * HONEST SCOPE. There is NO thought->ob_sources linkage in the schema
 * (`thoughts` has no source_id), so an ob_sources.language value cannot, on its
 * own, control the config a search analyzes with. The truthful causal chain is:
 * a corpus's declared language -> an explicit request `fts_config` setting ->
 * the regconfig the real search path actually uses. The per-source-kind block
 * below exercises exactly that chain (resolveFtsConfig(language) fed as the
 * explicit request config), and does NOT pretend an unlinked source row drives
 * retrieval by itself.
 */

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;

// Vector arm is irrelevant here; force keyword mode so we isolate the lexical
// FTS config behavior deterministically.
const embed = createMockEmbed(null);
const THOUGHTS_ONLY: "thoughts"[] = ["thoughts"];

dbDescribe("search_brain language-aware FTS ranking (live Postgres)", () => {
  const pool = new Pool({ connectionString: DB_URL });
  const deps = { pool: pool as any, embedFn: embed };
  const ns = "test-fts-language";

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

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
      deps as any,
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

  it("german stemming finds a document english analysis misses (before/after)", async () => {
    await cleanup();
    // "Häuser" (houses) stems to "haus" under german; english leaves it intact,
    // so an english analysis of the query "Haus" never matches the document.
    const doc = "20000000-0000-4000-8000-000000000001";
    await seedThought(
      doc,
      "Die Häuser in der Stadt sind alt __fts_lang_probe__",
    );

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

dbDescribe(
  "declared source language selects the real search config via explicit request (live Postgres)",
  () => {
    const pool = new Pool({ connectionString: DB_URL });
    const deps = { pool: pool as any, embedFn: embed };
    const ns = "test-fts-language-e2e";

    afterAll(async () => {
      await cleanup();
      await pool.end();
    });

    async function cleanup(): Promise<void> {
      await pool.query("DELETE FROM thoughts WHERE namespace = $1", [ns]);
      await pool.query(
        "DELETE FROM ob_sources WHERE namespace = $1 AND external_id LIKE $2",
        [ns, "fts-lang-e2e/%"],
      );
    }

    // One representative supported-language corpus per approved source kind:
    // synchronized file source (directory), approved drop-folder (drop), and
    // approved conversation content (conversation). Each declares a language on
    // its ob_sources row; that declared language is fed as the explicit request
    // `fts_config` (via requestFtsConfig) -- the same knob a caller uses -- and
    // that is what selects the config the real search path analyzes with.
    const sources = [
      {
        kind: "directory" as const,
        externalId: "fts-lang-e2e/repo-de",
        language: "de-DE",
        expectConfig: "german" as const,
        thoughtId: "21000000-0000-4000-8000-000000000001",
        content: "Die Häuser wurden im Repository dokumentiert",
        query: "Haus",
        missUnder: "english" as const,
      },
      {
        kind: "drop" as const,
        externalId: "fts-lang-e2e/drop-es",
        language: "es",
        expectConfig: "spanish" as const,
        thoughtId: "21000000-0000-4000-8000-000000000002",
        content: "El documento describe atletas corriendo",
        query: "corrió",
        missUnder: "english" as const,
      },
      {
        kind: "conversation" as const,
        externalId: "fts-lang-e2e/convo-en",
        language: "en-US",
        expectConfig: "english" as const,
        thoughtId: "21000000-0000-4000-8000-000000000003",
        content: "The teams were running the deployment",
        query: "runs",
        missUnder: null,
      },
    ];

    /** Seed the approved source row AND read its stored language back. */
    async function seedSource(s: (typeof sources)[number]): Promise<string> {
      const { rows } = await pool.query(
        `INSERT INTO ob_sources
           (namespace, source_kind, external_id, approval_state, approved_by,
            approved_at, lifecycle_state, language, created_by)
         VALUES ($1, $2, $3, 'approved', 'test-approver', now(), 'active', $4, 'test')
         ON CONFLICT (namespace, source_kind, external_id)
         DO UPDATE SET language = EXCLUDED.language, approval_state = 'approved'
         RETURNING language`,
        [ns, s.kind, s.externalId, s.language],
      );
      await pool.query(
        `INSERT INTO thoughts (id, content, namespace, created_by, content_hash)
         VALUES ($1, $2, $3, 'test', $4)
         ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content`,
        [s.thoughtId, s.content, ns, `fts-lang-e2e-${s.thoughtId}`],
      );
      return rows[0].language as string;
    }

    /**
     * Run the real search path. `declaredLanguage` is the value stored on the
     * source row; it flows through requestFtsConfig exactly as the public
     * `search_brain` handler routes its `fts_config` argument -- there is no
     * hand-picked internal config literal here.
     */
    async function keywordIdsForLanguage(
      query: string,
      declaredLanguage: string,
    ): Promise<string[]> {
      const rows = await executeSearch(
        deps as any,
        THOUGHTS_ONLY,
        query,
        10,
        "keyword",
        undefined,
        0,
        ns,
        false,
        undefined,
        // requestFtsConfig(declaredLanguage) is the caller-visible selection;
        // pass an empty env so ONLY the declared language can drive the config.
        { ftsConfig: requestFtsConfig(declaredLanguage, {}) },
      );
      return rows.map((r) => r.id);
    }

    it("each source's stored language maps to the expected config (metadata only)", async () => {
      // Pure metadata-mapping check: the stored ob_sources.language round-trips
      // to the right regconfig. This does NOT by itself drive retrieval -- the
      // ranking test below proves the retrieval effect via the explicit request.
      await cleanup();
      for (const s of sources) {
        const stored = await seedSource(s);
        expect(resolveFtsConfig(stored)).toBe(s.expectConfig);
      }
    });

    it("declared source language, fed as the explicit request config, drives ranking", async () => {
      await cleanup();
      for (const s of sources) {
        const declaredLanguage = await seedSource(s);
        const underOwn = await keywordIdsForLanguage(s.query, declaredLanguage);
        expect(underOwn).toContain(s.thoughtId);
        if (s.missUnder) {
          // Same query, but english (the mismatched config) misses it.
          const underMismatch = await keywordIdsForLanguage(s.query, "en");
          expect(underMismatch).not.toContain(s.thoughtId);
        }
      }
    });

    it("deterministic before/after comparison across the three source kinds", async () => {
      await cleanup();
      // Structured, order-stable table: for each representative fixture, record
      // whether its document is found under (a) english = the pre-#341 baseline
      // and (b) its declared language config. english-content fixtures must
      // show NO regression; non-english fixtures show the language-aware gain.
      const comparison = [];
      for (const s of sources) {
        const declaredLanguage = await seedSource(s);
        const foundUnderEnglish = (
          await keywordIdsForLanguage(s.query, "en")
        ).includes(s.thoughtId);
        const foundUnderDeclared = (
          await keywordIdsForLanguage(s.query, declaredLanguage)
        ).includes(s.thoughtId);
        comparison.push({
          kind: s.kind,
          declaredLanguage,
          config: s.expectConfig,
          query: s.query,
          before_english: foundUnderEnglish,
          after_declared: foundUnderDeclared,
        });
      }

      expect(comparison).toEqual([
        {
          kind: "directory",
          declaredLanguage: "de-DE",
          config: "german",
          query: "Haus",
          before_english: false, // english analysis misses the german inflection
          after_declared: true, // german stemming finds it
        },
        {
          kind: "drop",
          declaredLanguage: "es",
          config: "spanish",
          query: "corrió",
          before_english: false,
          after_declared: true,
        },
        {
          kind: "conversation",
          declaredLanguage: "en-US",
          config: "english",
          query: "runs",
          before_english: true, // english content: no regression
          after_declared: true, // declared english == baseline
        },
      ]);
    });
  },
);
