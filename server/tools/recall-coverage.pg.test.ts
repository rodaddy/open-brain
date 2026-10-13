/**
 * Functional coverage-ranking fixture for the hybrid lexical candidate arm.
 *
 * REQUIRES `OPENBRAIN_TEST_DATABASE_URL`; run through `npm run test:isolated`.
 * Rows deliberately have no embeddings, so both candidates receive the same
 * zero vector contribution and the observed hybrid order comes from Postgres
 * lexical candidate generation alone.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import pino from "pino";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";
import { executeSearch, hybridSearch } from "./search-engine.ts";
import { buildSessionEventsFtsCTE } from "./search-engine-sql.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl(), max: 2 });
const QUERY = "deployment rollback checklist";
const NAMESPACE = `recall-coverage-pg-${process.pid}`;
const FOREIGN_NAMESPACE = `${NAMESPACE}-foreign`;
const zeroEmbedding = Array.from({ length: 768 }, () => 0);
const dependencies = {
  pool,
  embedFn: async () => zeroEmbedding,
  logger: pino({ level: "silent" }),
};

let resourceBroadId = "";
let resourceRepeatedId = "";
let simpleBroadId = "";
let simpleRepeatedId = "";
let urlResourceId = "";
let compoundResourceId = "";
let embeddedNumberResourceId = "";
let eventBroadId = "";
let eventRepeatedId = "";
let simpleEventBroadId = "";
let simpleEventRepeatedId = "";
let conciseResourceId = "";
let longResourceId = "";
let conciseEventId = "";
let longEventId = "";
let eventLaneId = "";
let foreignLaneId = "";

function requiredId(row: { id: string } | undefined): string {
  if (!row) throw new Error("fixture insert returned no id");
  return row.id;
}

beforeAll(async () => {
  const resources = await pool.query<{ id: string }>(
    `INSERT INTO thoughts (content, created_by, namespace)
     VALUES
       ('deployment rollback checklist for a routine service release', 'test', $1),
       ('deployment deployment deployment deployment deployment deployment', 'test', $1),
       ('deployment rollback checklist from another tenant', 'test', $2),
       ('https://example.com:8443/path release reference', 'test', $1)
     RETURNING id`,
    [NAMESPACE, FOREIGN_NAMESPACE],
  );
  resourceBroadId = requiredId(resources.rows[0]);
  resourceRepeatedId = requiredId(resources.rows[1]);
  urlResourceId = requiredId(resources.rows[3]);

  const normalizationResources = await pool.query<{ id: string }>(
    `INSERT INTO thoughts (content, created_by, namespace)
     VALUES
       ('price 0/blank HALT', 'test', $1),
       ('agent0/path9 identifier reference', 'test', $1)
     RETURNING id`,
    [NAMESPACE],
  );
  compoundResourceId = requiredId(normalizationResources.rows[0]);
  embeddedNumberResourceId = requiredId(normalizationResources.rows[1]);

  const simpleResources = await pool.query<{ id: string }>(
    `INSERT INTO thoughts (content, created_by, namespace)
     VALUES
       ('running rollback checklist for a routine service release', 'test', $1),
       ('running running running running running running', 'test', $1)
     RETURNING id`,
    [NAMESPACE],
  );
  simpleBroadId = requiredId(simpleResources.rows[0]);
  simpleRepeatedId = requiredId(simpleResources.rows[1]);

  const lengthResources = await pool.query<{ id: string }>(
    `INSERT INTO thoughts (content, created_by, namespace)
     VALUES
       ('sam price zero blank', 'test', $1),
       (repeat('sam price zero blank unrelated transcript words ', 20), 'test', $1)
     RETURNING id`,
    [NAMESPACE],
  );
  conciseResourceId = requiredId(lengthResources.rows[0]);
  longResourceId = requiredId(lengthResources.rows[1]);

  const lanes = await pool.query<{ id: string }>(
    `INSERT INTO ob_session_lanes (namespace, session_key, status, created_by)
     VALUES
       ($1, $2, 'active', 'test'),
       ($3, $4, 'active', 'test')
     RETURNING id`,
    [NAMESPACE, `${NAMESPACE}-lane`, FOREIGN_NAMESPACE, `${FOREIGN_NAMESPACE}-lane`],
  );
  eventLaneId = requiredId(lanes.rows[0]);
  foreignLaneId = requiredId(lanes.rows[1]);

  const events = await pool.query<{ id: string }>(
    `INSERT INTO ob_session_events
       (lane_id, event_type, content, created_by, created_at)
     VALUES
       ($1, 'fact', 'deployment rollback checklist for the ordinary release', 'test', NOW() - INTERVAL '2 minutes'),
       ($1, 'fact', 'deployment deployment deployment deployment deployment deployment', 'test', NOW() - INTERVAL '1 minute'),
       ($2, 'fact', 'deployment rollback checklist from another tenant', 'test', NOW()),
       ($1, 'fact', 'running rollback checklist for the ordinary release', 'test', NOW() - INTERVAL '4 minutes'),
       ($1, 'fact', 'running running running running running running', 'test', NOW() - INTERVAL '3 minutes')
     RETURNING id`,
    [eventLaneId, foreignLaneId],
  );
  eventBroadId = requiredId(events.rows[0]);
  eventRepeatedId = requiredId(events.rows[1]);
  simpleEventBroadId = requiredId(events.rows[3]);
  simpleEventRepeatedId = requiredId(events.rows[4]);

  const lengthEvents = await pool.query<{ id: string }>(
    `INSERT INTO ob_session_events
       (lane_id, event_type, content, created_by, created_at)
     VALUES
       ($1, 'fact', 'sam price zero blank', 'test', NOW() - INTERVAL '6 minutes'),
       ($1, 'fact', repeat('sam price zero blank unrelated transcript words ', 20), 'test', NOW() - INTERVAL '5 minutes')
     RETURNING id`,
    [eventLaneId],
  );
  conciseEventId = requiredId(lengthEvents.rows[0]);
  longEventId = requiredId(lengthEvents.rows[1]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM thoughts WHERE namespace = ANY($1::text[])`, [
    [NAMESPACE, FOREIGN_NAMESPACE],
  ]);
  await pool.query(`DELETE FROM ob_session_lanes WHERE id = ANY($1::uuid[])`, [
    [eventLaneId, foreignLaneId],
  ]);
  await pool.end();
});

describe("hybrid lexical distinct-query-term coverage (live Postgres)", () => {
  test.each([
    {
      label: "resource",
      tables: ["thoughts"] as const,
      broadId: () => resourceBroadId,
      repeatedId: () => resourceRepeatedId,
    },
    {
      label: "session event",
      tables: ["session_events"] as const,
      broadId: () => eventBroadId,
      repeatedId: () => eventRepeatedId,
    },
  ])(
    "ranks broader $label coverage before repetition and excludes another namespace",
    async ({ tables, broadId, repeatedId }) => {
      const rows = await executeSearch(
        dependencies,
        tables,
        QUERY,
        10,
        "hybrid",
        undefined,
        0,
        NAMESPACE,
      );
      const ids = rows.map((row) => row.id);

      expect(ids).toContain(broadId());
      expect(ids).toContain(repeatedId());
      expect(ids.indexOf(broadId())).toBeLessThan(ids.indexOf(repeatedId()));
      expect(rows.every((row) => row.namespace === NAMESPACE)).toBe(true);
      expect(rows.every((row) => !("lexical_coverage" in row))).toBe(true);
      expect(rows.every((row) => !("query_lexeme_count" in row))).toBe(true);
    },
  );

  test("uses the configured resource lexemes for partial coverage", async () => {
    const rows = await executeSearch(
      dependencies,
      ["thoughts"],
      "running rollback checklist",
      10,
      "hybrid",
      undefined,
      0,
      NAMESPACE,
      { ftsConfig: "simple" },
    );
    const ids = rows.map((row) => row.id);

    expect(ids).toContain(simpleBroadId);
    expect(ids).toContain(simpleRepeatedId);
    expect(ids.indexOf(simpleBroadId)).toBeLessThan(ids.indexOf(simpleRepeatedId));
  });

  test("uses the configured session-event lexemes for partial coverage", async () => {
    const rows = await executeSearch(
      dependencies,
      ["session_events"],
      "running rollback checklist",
      10,
      "hybrid",
      undefined,
      0,
      NAMESPACE,
      { ftsConfig: "simple" },
    );
    const ids = rows.map((row) => row.id);

    expect(ids).toContain(simpleEventBroadId);
    expect(ids).toContain(simpleEventRepeatedId);
    expect(ids.indexOf(simpleEventBroadId)).toBeLessThan(
      ids.indexOf(simpleEventRepeatedId),
    );
  });

  test("treats punctuation-bearing normalized lexemes as literal OR terms", async () => {
    const rows = await executeSearch(
      dependencies,
      ["thoughts"],
      "https://example.com:8443/path",
      10,
      "hybrid",
      undefined,
      0,
      NAMESPACE,
      { ftsConfig: "simple" },
    );

    expect(rows.map((row) => row.id)).toContain(urlResourceId);
  });
});

describe("hybrid lexical compound normalization (live Postgres)", () => {
  test("stores the exact session-event hybrid document vector", async () => {
    const result = await pool.query<{ matches_prior_expression: boolean }>(
      `SELECT hybrid_search_vector = hybrid_search_tsvector(
         'english'::regconfig,
         content,
         false
       ) AS matches_prior_expression
       FROM ob_session_events
       WHERE id = $1`,
      [eventBroadId],
    );

    expect(result.rows).toEqual([{ matches_prior_expression: true }]);
  });

  test("uses the stored English event vector without changing other lexical paths", () => {
    const context = {
      perTableLimit: 10,
      tier: undefined,
      namespaceParamIndex: 2,
      namespaceIsArray: false,
      lexicalCandidateMode: "partial_coverage" as const,
    };
    const englishHybrid = buildSessionEventsFtsCTE(context, "english");
    const simpleHybrid = buildSessionEventsFtsCTE(context, "simple");
    const keyword = buildSessionEventsFtsCTE(
      { ...context, lexicalCandidateMode: "all_terms" },
      "english",
    );

    expect(englishHybrid).toContain("se.hybrid_search_vector");
    expect(englishHybrid).not.toContain("CROSS JOIN LATERAL");
    expect(simpleHybrid).toContain("CROSS JOIN LATERAL");
    expect(simpleHybrid).toContain("se.content, false");
    expect(keyword).toContain("se.content ILIKE");
    expect(keyword).not.toContain("hybrid_search_vector");
  });

  test("adds compound components and canonical numeric concepts without fragmenting identifiers", async () => {
    let lexicalRows: Array<{
      id: string;
      lexical_coverage?: number;
      query_lexeme_count?: number;
    }> = [];
    const rows = await hybridSearch(
      dependencies,
      {
        tables: ["thoughts"],
        query: "price zero 0 blank",
        limit: 10,
        mode: "hybrid",
        tier: undefined,
        offset: 0,
        namespace: NAMESPACE,
        ftsConfig: "english",
      },
      zeroEmbedding,
      (arms) => {
        lexicalRows = arms.ftsRows;
      },
    );
    const compound = lexicalRows.find((row) => row.id === compoundResourceId);

    expect(rows.map((row) => row.id)).toContain(compoundResourceId);
    expect(compound?.lexical_coverage).toBeLessThanOrEqual(
      compound?.query_lexeme_count ?? -1,
    );
    expect(compound?.query_lexeme_count).toBe(3);

    const embeddedNumberRows = await executeSearch(
      dependencies,
      ["thoughts"],
      "zero nine",
      10,
      "hybrid",
      undefined,
      0,
      NAMESPACE,
    );
    expect(embeddedNumberRows.map((row) => row.id)).not.toContain(
      embeddedNumberResourceId,
    );
  });
});

describe("hybrid lexical numeric aliases (live Postgres)", () => {
  test("canonicalizes only parsed singleton digits and preserves literal token lexemes", async () => {
    const result = await pool.query<{ lexemes: string[] }>(
      `SELECT tsvector_to_array(
         hybrid_search_tsvector(
           'english'::regconfig,
           '0.5 127.0.0.1 identifiera-0-b literalfoo/0/bar',
           true
         )
       ) AS lexemes`,
    );
    const lexemes = result.rows[0]?.lexemes ?? [];

    expect(lexemes).toEqual(
      expect.arrayContaining(["0.5", "127.0.0.1", "-0", "literalfoo/0/bar", "zero"]),
    );
    expect(lexemes).not.toContain("0");
  });

  test("maps each English digit query to one nonempty spoken-number concept", async () => {
    const result = await pool.query<{
      digit_lexemes: string[];
      word_lexemes: string[];
    }>(
      `SELECT
         tsvector_to_array(hybrid_search_tsvector('english'::regconfig, digit, true)) AS digit_lexemes,
         tsvector_to_array(hybrid_search_tsvector('english'::regconfig, word, true)) AS word_lexemes
       FROM (VALUES
         ('0', 'zero'), ('1', 'one'), ('2', 'two'), ('3', 'three'), ('4', 'four'),
         ('5', 'five'), ('6', 'six'), ('7', 'seven'), ('8', 'eight'), ('9', 'nine')
       ) AS aliases(digit, word)`,
    );

    expect(result.rows).toHaveLength(10);
    for (const row of result.rows) {
      expect(row.digit_lexemes.length).toBeGreaterThan(0);
      expect(row.digit_lexemes).toEqual(row.word_lexemes);
    }
  });
});

describe("hybrid lexical document-length normalization (live Postgres)", () => {
  test.each([
    {
      label: "resource",
      tables: ["thoughts"] as const,
      conciseId: () => conciseResourceId,
      longId: () => longResourceId,
    },
    {
      label: "session event",
      tables: ["session_events"] as const,
      conciseId: () => conciseEventId,
      longId: () => longEventId,
    },
  ])(
    "ranks a concise $label answer before a long repetitive transcript",
    async ({ tables, conciseId, longId }) => {
      const rows = await executeSearch(
        dependencies,
        tables,
        "sam price zero blank",
        10,
        "hybrid",
        undefined,
        0,
        NAMESPACE,
      );
      const ids = rows.map((row) => row.id);

      expect(ids).toContain(conciseId());
      expect(ids).toContain(longId());
      expect(ids.indexOf(conciseId())).toBeLessThan(ids.indexOf(longId()));
    },
  );
});

describe("keyword lexical matching (live Postgres)", () => {
  test.each([
    {
      label: "resource",
      tables: ["thoughts"] as const,
      broadId: () => resourceBroadId,
    },
    {
      label: "session event",
      tables: ["session_events"] as const,
      broadId: () => eventBroadId,
    },
  ])(
    "keeps keyword-only $label matching on all query terms",
    async ({ tables, broadId }) => {
      const rows = await executeSearch(
        dependencies,
        tables,
        QUERY,
        10,
        "keyword",
        undefined,
        0,
        NAMESPACE,
      );

      expect(rows.map((row) => row.id)).toEqual([broadId()]);
    },
  );
});
