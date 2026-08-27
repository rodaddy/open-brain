import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { executeSearch } from "../search-brain.ts";
import type { ToolDeps } from "../index.ts";
import { requestFtsConfig, resolveFtsConfig } from "../fts-config.ts";
import { requireTestDatabaseUrl } from "../../../scripts/test-support/require-test-database.ts";
import {
  assertUtf8Harness,
  embed,
  THOUGHTS_ONLY,
} from "./search-brain-fts-language-test-helpers.ts";

/**
 * Live-PostgreSQL coverage that a corpus's declared language selects the real
 * search config through an explicit request setting (#341), split out of
 * search-brain-fts-language.pg.test.ts so each live suite owns one file.
 *
 * HONEST SCOPE. There is NO thought->ob_sources linkage in the schema
 * (`thoughts` has no source_id), so an ob_sources.language value cannot, on its
 * own, control the config a search analyzes with. The truthful causal chain is:
 * a corpus's declared language -> an explicit request `fts_config` setting ->
 * the regconfig the real search path actually uses. The block below exercises
 * exactly that chain (resolveFtsConfig(language) fed as the explicit request
 * config), and does NOT pretend an unlinked source row drives retrieval by
 * itself.
 *
 * The imported helper demands a real Postgres at module scope rather than
 * letting the suite skip itself when the harness is absent (#878).
 */

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

const deps = { pool: pool as never, embedFn: embed };
const ns = "test-fts-language-e2e";

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
    // requestFtsConfig(declaredLanguage) is the caller-visible selection;
    // pass an empty env so ONLY the declared language can drive the config.
    { ftsConfig: requestFtsConfig(declaredLanguage, {}) },
  );
  return rows.map((r) => r.id);
}
describe("declared source language selects the real search config via explicit request (live Postgres)", () => {
  beforeAll(async () => {
    await assertUtf8Harness(pool);
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

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
      const foundUnderEnglish = (await keywordIdsForLanguage(s.query, "en")).includes(
        s.thoughtId,
      );
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
});
