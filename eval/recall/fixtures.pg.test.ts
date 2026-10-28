import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * The recall fixture set is real, or this fails.
 *
 * A fixture file is only worth anything if every id in it names a row that
 * exists. A hand-written uuid, or one that was real when the fixture was
 * authored and has since been archived away, turns a recall eval into a test
 * of nothing: the retrieval stack cannot return a row that is not there, and
 * the eval reports a miss that no code change can fix. So this suite queries
 * the corpus for every expected and forbidden id rather than trusting the file.
 *
 * REQUIRES a database and fails hard without one. No `describe.skip`, no `skipIf`: a suite that
 * skips itself exits 0 and is indistinguishable from one that passed.
 *
 * IT RUNS EVERYWHERE, BECAUSE THE RUNNER SUPPLIES ITS ROWS. Locally it reads
 * the dogfood corpus, where all 32 fixture rows already exist. In CI neither
 * job carries those rows -- both provision a real migrated Postgres, and a
 * migrated schema is empty -- so `seedRecallCorpus` inserts the ids
 * `fixtures.json` names, minimally and idempotently, before the assertions
 * run. The rule is that
 * tests never skip: the runner supplies what they demand. Against the real
 * corpus every seed insert conflicts and nothing changes.
 *
 * THE GUARD IS AT THE CALL SITE, NOT AT MODULE TOP LEVEL (HANDOVER-RULES rule
 * 20). Resolving the corpus url while the module evaluates makes a missing
 * corpus an import-time error, which Bun reports as an error BETWEEN tests and
 * which takes the whole file down before a single test runs. Inside
 * `beforeAll` the same missing value fails these tests, loudly, and nothing
 * else. The structural half of this suite lives in `fixtures.test.ts` and
 * needs no database, so CI -- where the dogfood corpus genuinely does not
 * exist -- still runs every check that can be decided from the file alone.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { requireRecallCorpusUrl } from "../../scripts/test-support/require-test-database.ts";
import { seedRecallCorpus } from "./corpus-seed.ts";

/** The tables a fixture may name, and the allowlist that makes the id lookup safe. */
const ALLOWED_TABLES = new Set([
  "thoughts",
  "decisions",
  "sessions",
  "relationships",
  "projects",
  "ob_session_events",
]);

type AllowedTable =
  | "thoughts"
  | "decisions"
  | "sessions"
  | "relationships"
  | "projects"
  | "ob_session_events";

interface FixtureRef {
  readonly source_type: string;
  readonly id: string;
  readonly label?: number;
}

interface Fixture {
  readonly id: string;
  readonly query: string;
  readonly namespace: string;
  readonly expected: readonly FixtureRef[];
  readonly forbidden?: readonly FixtureRef[];
  readonly isolation?: boolean;
  readonly note: string;
}

interface FixtureFile {
  readonly version: number;
  readonly fixtures: readonly Fixture[];
}

const FIXTURES_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures.json");
const doc = JSON.parse(readFileSync(FIXTURES_PATH, "utf8")) as FixtureFile;

let pool: Pool | undefined;

/** The corpus connection, resolved on first use so a missing corpus fails a test. */
function corpus(): Pool {
  if (!pool) {
    throw new Error("recall corpus pool was not initialised");
  }
  return pool;
}

/**
 * The database this suite runs against, in preference order.
 *
 * `OPENBRAIN_RECALL_CORPUS_URL` wins, for pointing the suite at a specific
 * corpus. Then `OPENBRAIN_TEST_DATABASE_URL`, which both CI jobs set and
 * `test:isolated` sets locally -- a real migrated database with none of the
 * dogfood rows, which is exactly what `seedRecallCorpus` supplies. Then the
 * libpq vars `.env` carries, which name the dogfood corpus itself.
 *
 * @returns The connection string to use.
 * @throws {Error} `recall_corpus_required` when no database can be resolved.
 */
function resolveCorpusUrl(): string {
  const testUrl = process.env.OPENBRAIN_TEST_DATABASE_URL;
  if (!process.env.OPENBRAIN_RECALL_CORPUS_URL && testUrl) {
    return testUrl;
  }
  return requireRecallCorpusUrl();
}

beforeAll(async () => {
  pool = new Pool({ connectionString: resolveCorpusUrl() });
  // The suite never skips, so the runner supplies what it demands.
  // Against the real corpus every insert conflicts and this changes nothing.
  await seedRecallCorpus(pool);
});

afterAll(async () => {
  await pool?.end();
});

/** Every ref in the file, deduplicated, as `table` + `id` pairs. */
function allRefs(): FixtureRef[] {
  const seen = new Map<string, FixtureRef>();
  for (const fixture of doc.fixtures) {
    for (const ref of [...fixture.expected, ...(fixture.forbidden ?? [])]) {
      seen.set(`${ref.source_type}:${ref.id}`, ref);
    }
  }
  return [...seen.values()];
}

/** Validate a fixture table before interpolating it into a query. */
function allowedTable(sourceType: string): AllowedTable {
  if (!ALLOWED_TABLES.has(sourceType)) {
    throw new Error(`recall_fixture_unknown_table: ${sourceType}`);
  }
  return sourceType as AllowedTable;
}

/** Resolve the namespace production recall applies to a source row. */
async function effectiveNamespace(ref: FixtureRef): Promise<string> {
  const table = allowedTable(ref.source_type);
  const result =
    table === "ob_session_events"
      ? await corpus().query<{ namespace: string }>(
          `SELECT l.namespace
             FROM public.ob_session_events e
             JOIN public.ob_session_lanes l ON l.id = e.lane_id
            WHERE e.id = $1::uuid`,
          [ref.id],
        )
      : await corpus().query<{ namespace: string }>(
          `SELECT namespace FROM public.${table} WHERE id = $1::uuid`,
          [ref.id],
        );
  expect(result.rows).toHaveLength(1);
  const row = result.rows[0];
  if (!row) {
    throw new Error(`recall_fixture_row_missing: ${ref.source_type}/${ref.id}`);
  }
  return row.namespace;
}

/** Assert that an expected ref is eligible in the fixture's scope. */
async function expectInNamespace(ref: FixtureRef, namespace: string): Promise<void> {
  expect(await effectiveNamespace(ref)).toBe(namespace);
}

/** Assert that a forbidden ref is ineligible in the fixture's scope. */
async function expectOutsideNamespace(
  ref: FixtureRef,
  namespace: string,
): Promise<void> {
  expect(await effectiveNamespace(ref)).not.toBe(namespace);
}

describe("recall fixture ids resolve in the dogfood corpus (live Postgres)", () => {
  it("resolves every expected and forbidden id to a live row", async () => {
    const refs = allRefs();
    // The fixture file is what defines the id set; assert it is non-empty so a
    // truncated file cannot pass this by having nothing to check.
    expect(refs.length).toBeGreaterThanOrEqual(12);
    const missing: string[] = [];
    for (const ref of refs) {
      try {
        await effectiveNamespace(ref);
      } catch (error: unknown) {
        missing.push(`${ref.source_type}/${ref.id} (${String(error)})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("puts every expected row in the fixture's effective namespace", async () => {
    for (const fixture of doc.fixtures) {
      for (const ref of fixture.expected) {
        await expectInNamespace(ref, fixture.namespace);
      }
    }
  });

  it("puts each isolation fixture's forbidden row outside the fixture's namespace", async () => {
    for (const fixture of doc.fixtures.filter((f) => f.isolation === true)) {
      for (const ref of fixture.forbidden ?? []) {
        await expectOutsideNamespace(ref, fixture.namespace);
      }
    }
  });

  it("rejects deliberately wrong expected and forbidden scope assertions", async () => {
    const eventRef: FixtureRef = {
      source_type: "ob_session_events",
      id: "99370b47-3d3f-4f29-8ce9-f5b81dd315a1",
    };
    const directRef: FixtureRef = {
      source_type: "thoughts",
      id: "a4c5c025-c0e1-45a0-b398-63f79376e610",
    };

    await expect(expectInNamespace(eventRef, "shared-kb")).rejects.toThrow();
    await expect(expectOutsideNamespace(eventRef, "dana")).rejects.toThrow();
    await expect(expectInNamespace(directRef, "shared-kb")).rejects.toThrow();
  });
});
