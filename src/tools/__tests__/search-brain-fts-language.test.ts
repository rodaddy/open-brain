import { describe, it, expect, afterEach } from "bun:test";
import { registerSearchBrain } from "../search-brain.ts";
import type { AuthInfo } from "../../types.ts";
import { createMockEmbed, setupMcpClient } from "./test-helpers.ts";

/**
 * Functional coverage for language-aware FTS configuration selection (#341).
 *
 * These assert the OBSERVABLE lexical behavior of the search boundary: which
 * text-search configuration the emitted FTS SQL analyzes with for a given
 * corpus config, that the english default preserves the fast GIN-indexed stored
 * column, that a non-english corpus stays internally consistent (match arm and
 * rank arm share one config against the same text), and that isolation and
 * parameterization survive. They do not assert call order or SQL line shape
 * beyond the config that actually governs matching.
 */

const admin: AuthInfo = { role: "admin", clientId: "admin-client" };

/** Pool that records every FTS-arm SQL statement it is asked to run. */
function recordingPool() {
  const ftsSql: string[] = [];
  const allSql: string[] = [];
  return {
    ftsSql,
    allSql,
    pool: {
      query: async (...args: any[]) => {
        const sql = String(args[0]);
        allSql.push(sql);
        if (sql.includes("fts_query")) ftsSql.push(sql);
        if (sql.includes("FROM ob_links")) return { rows: [] };
        return { rows: [] };
      },
    },
  };
}

async function runKeywordSearch(
  pool: { query: (...args: any[]) => Promise<{ rows: any[] }> },
  query: string,
  opts: { namespace?: string; ftsConfig?: string } = {},
): Promise<void> {
  const { client, cleanup } = await setupMcpClient(
    registerSearchBrain,
    pool,
    createMockEmbed(),
    admin,
  );
  try {
    await client.callTool({
      name: "search_brain",
      arguments: {
        query,
        search_mode: "keyword",
        table: "thoughts",
        ...(opts.namespace ? { namespace: opts.namespace } : {}),
        ...(opts.ftsConfig ? { fts_config: opts.ftsConfig } : {}),
      },
    });
  } finally {
    await cleanup();
  }
}

const savedFtsConfig = process.env.OPENBRAIN_FTS_CONFIG;
afterEach(() => {
  if (savedFtsConfig === undefined) delete process.env.OPENBRAIN_FTS_CONFIG;
  else process.env.OPENBRAIN_FTS_CONFIG = savedFtsConfig;
});

describe("search_brain FTS configuration selection", () => {
  it("english default: analyzes with english and uses the stored search_vector column", async () => {
    delete process.env.OPENBRAIN_FTS_CONFIG;
    const { ftsSql, pool } = recordingPool();
    await runKeywordSearch(pool, "quarterly planning");

    expect(ftsSql.length).toBeGreaterThan(0);
    const sql = ftsSql.join("\n");
    // Default path is byte-identical to pre-#341: stored column + english tsquery.
    expect(sql).toContain("t.search_vector @@");
    expect(sql).toContain("plainto_tsquery('english',");
    // It must NOT recompute a tsvector on the fly for the default path.
    expect(sql).not.toContain("to_tsvector('english'");
  });

  it("german corpus: match AND rank arms share one allowlisted german config, off the stored column", async () => {
    process.env.OPENBRAIN_FTS_CONFIG = "german";
    const { ftsSql, pool } = recordingPool();
    await runKeywordSearch(pool, "vierteljährliche Planung");

    const sql = ftsSql.join("\n");
    // The regconfig literal is the allowlisted 'german' -- the one internal
    // detail no public result can distinguish (english vs german stemming is
    // proven functionally by the live-Postgres ranking test). Both arms use it:
    // the WHERE match arm recomputes to_tsvector('german', ...) @@ ..., and the
    // rank arm ranks with the same recomputed german tsvector.
    expect(sql).toContain("to_tsvector('german',"); // recomputed, not stored col
    expect(sql).toContain("@@ plainto_tsquery('german',"); // match arm config
    expect(sql).toMatch(/ts_rank_cd\(to_tsvector\('german',/); // rank arm config
    // Non-english path abandons the english stored column entirely -- no mixed
    // config, so the query arm can never mismatch the analyzed text.
    expect(sql).not.toContain("t.search_vector @@");
    expect(sql).not.toContain("'english'");
  });

  it("non-english recompute folds in the same tags term the stored column indexes", async () => {
    // Regression guard: the stored search_vector (migration 007) analyzes
    // content + tags. If the on-the-fly recompute dropped the tags term it would
    // silently under-index non-english corpora vs the english default. There is
    // no stored-column output to diff against here, so assert the source text.
    process.env.OPENBRAIN_FTS_CONFIG = "german";
    const { ftsSql, pool } = recordingPool();
    await runKeywordSearch(pool, "Planung");
    const sql = ftsSql.join("\n");
    expect(sql).toContain("immutable_array_to_string(t.tags, ' ')");
  });

  it("resolves a source-style language token (de-DE) to the german config", async () => {
    process.env.OPENBRAIN_FTS_CONFIG = "de-DE";
    const { ftsSql, pool } = recordingPool();
    await runKeywordSearch(pool, "Planung");
    expect(ftsSql.join("\n")).toContain("plainto_tsquery('german',");
  });

  it("spanish corpus: analyzes with the spanish config", async () => {
    process.env.OPENBRAIN_FTS_CONFIG = "spanish";
    const { ftsSql, pool } = recordingPool();
    await runKeywordSearch(pool, "planificación trimestral");
    const sql = ftsSql.join("\n");
    expect(sql).toContain("to_tsvector('spanish',");
    expect(sql).toContain("@@ plainto_tsquery('spanish',");
  });

  it("unknown corpus config falls back to the english stored-column path", async () => {
    process.env.OPENBRAIN_FTS_CONFIG = "gernam"; // typo
    const { ftsSql, pool } = recordingPool();
    await runKeywordSearch(pool, "planning");
    const sql = ftsSql.join("\n");
    expect(sql).toContain("t.search_vector @@");
    expect(sql).toContain("plainto_tsquery('english',");
  });

  it("keeps the query text parameterized regardless of config", async () => {
    process.env.OPENBRAIN_FTS_CONFIG = "german";
    const { ftsSql, pool } = recordingPool();
    const injection = "'; DROP TABLE thoughts; --";
    await runKeywordSearch(pool, injection);
    const sql = ftsSql.join("\n");
    // Query text flows through the parameterized fts_query CTE, never inlined.
    expect(sql).toContain("SELECT q FROM fts_query");
    expect(sql).not.toContain(injection);
    // Config is a fixed allowlisted literal; the query is never a config literal.
    expect(sql).not.toContain(`plainto_tsquery('${injection}'`);
  });

  it("preserves the namespace predicate under a non-english config", async () => {
    process.env.OPENBRAIN_FTS_CONFIG = "german";
    const { ftsSql, allSql, pool } = recordingPool();
    const namespace = "client-42";
    await runKeywordSearch(pool, "Planung", { namespace });
    const sql = ftsSql.join("\n");
    // Namespace stays a parameter, still applied on the language-aware path.
    expect(sql).toContain("t.namespace = $");
    // Namespace value is never inlined into any statement.
    expect(allSql.join("\n")).not.toContain(namespace);
  });
});

describe("search_brain explicit fts_config request argument", () => {
  it("an explicit fts_config selects the config in the real search path (no env)", async () => {
    // The caller-visible knob, not an env var, drives the emitted SQL.
    delete process.env.OPENBRAIN_FTS_CONFIG;
    const { ftsSql, pool } = recordingPool();
    await runKeywordSearch(pool, "vierteljährliche Planung", {
      ftsConfig: "german",
    });
    const sql = ftsSql.join("\n");
    expect(sql).toContain("to_tsvector('german',");
    expect(sql).toContain("@@ plainto_tsquery('german',");
    expect(sql).not.toContain("t.search_vector @@");
  });

  it("accepts a language token (de-DE) as the explicit request config", async () => {
    delete process.env.OPENBRAIN_FTS_CONFIG;
    const { ftsSql, pool } = recordingPool();
    await runKeywordSearch(pool, "Planung", { ftsConfig: "de-DE" });
    expect(ftsSql.join("\n")).toContain("plainto_tsquery('german',");
  });

  it("an explicit request config overrides the deployment env default", async () => {
    // Deployment corpus is german, but this request asks for spanish.
    process.env.OPENBRAIN_FTS_CONFIG = "german";
    const { ftsSql, pool } = recordingPool();
    await runKeywordSearch(pool, "planificación", { ftsConfig: "spanish" });
    const sql = ftsSql.join("\n");
    expect(sql).toContain("plainto_tsquery('spanish',");
    expect(sql).not.toContain("plainto_tsquery('german',");
  });

  it("an unrecognized explicit config falls back to the env corpus default", async () => {
    // A typo in the request must not force english when a corpus is configured.
    process.env.OPENBRAIN_FTS_CONFIG = "german";
    const { ftsSql, pool } = recordingPool();
    await runKeywordSearch(pool, "Planung", { ftsConfig: "gernam" });
    expect(ftsSql.join("\n")).toContain("plainto_tsquery('german',");
  });

  it("no explicit config uses the env corpus default", async () => {
    process.env.OPENBRAIN_FTS_CONFIG = "spanish";
    const { ftsSql, pool } = recordingPool();
    await runKeywordSearch(pool, "planificación");
    expect(ftsSql.join("\n")).toContain("plainto_tsquery('spanish',");
  });

  it("the injected config literal is always allowlisted, never caller text", async () => {
    delete process.env.OPENBRAIN_FTS_CONFIG;
    const { ftsSql, pool } = recordingPool();
    // A config-injection attempt is not on the allowlist -> falls back safely.
    await runKeywordSearch(pool, "planning", {
      ftsConfig: "english'); DROP TABLE thoughts; --",
    });
    const sql = ftsSql.join("\n");
    expect(sql).not.toContain("DROP TABLE");
    expect(sql).toContain("plainto_tsquery('english',");
  });
});
