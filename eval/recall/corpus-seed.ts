/**
 * Supply the rows the recall fixture suite demands, so it never skips.
 *
 * `fixtures.pg.test.ts` asserts that every expected and forbidden id in
 * `fixtures.json` names a live row, and that each isolation fixture's
 * forbidden row sits outside that fixture's namespace. Locally those rows are
 * the dogfood corpus. In CI they do not exist: both jobs provision a real
 * migrated Postgres, but neither carries the 32 dogfood rows, so the suite
 * failed with `recall_corpus_required` in every run.
 *
 * Ruling #878, restated by `.forgejo/workflows/ci.yml` in the repo's own
 * words: "tests never skip, so the suite runner supplies what the tests
 * demand." This is the supplier. It derives the seed FROM `fixtures.json`
 * rather than duplicating it, so a fixture added to the file is seeded without
 * touching this module.
 *
 * WHAT IT INSERTS. Only the ids the fixture file names, only the columns those
 * tables declare NOT NULL, and only under `ON CONFLICT (id) DO NOTHING`. It
 * issues no UPDATE and no DELETE. Against the real corpus, where all 32 rows
 * already exist, every insert conflicts and nothing changes -- which is the
 * required local behaviour.
 *
 * The suite reads only `id` and `namespace`; it never embeds, searches, or
 * reads content. So a minimal row is a sufficient row.
 *
 * `ob_session_events` HAS NO NAMESPACE COLUMN. Scope lives on
 * `ob_session_lanes` and is reachable only through `lane_id`
 * (`docs/decisions/search-engine-sql-session-events-indirect-namespace.md`).
 * Each seeded event therefore gets a lane row in the fixture's namespace
 * first; the lane id is derived deterministically from the event id so a
 * re-run conflicts rather than accumulating lanes.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { logger } from "../../server/logging/legacy-logger.ts";

interface FixtureRef {
  readonly source_type: string;
  readonly id: string;
}

interface Fixture {
  readonly namespace: string;
  readonly expected: readonly FixtureRef[];
  readonly forbidden?: readonly FixtureRef[];
}

interface FixtureFile {
  readonly fixtures: readonly Fixture[];
}

/** A ref plus the namespace the fixture file places it in. */
interface SeedRow {
  readonly source_type: string;
  readonly id: string;
  readonly namespace: string;
}

const SEED_AUTHOR = "recall-fixture-seed";
const SEED_TEXT = "recall fixture seed row";

/**
 * A stable uuid derived from another uuid, so re-running seeds the same lane.
 *
 * @param eventId - The session-event id the lane belongs to.
 * @returns A uuid-shaped string, deterministic in `eventId`.
 */
function laneIdFor(eventId: string): string {
  const h = createHash("sha256").update(`recall-fixture-lane:${eventId}`).digest("hex");
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `4${h.slice(13, 16)}`,
    ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join("-");
}

/**
 * Every ref in the fixture file, deduplicated, carrying its fixture namespace.
 *
 * @param path - Path to `fixtures.json`.
 * @returns One row per distinct `source_type` + `id`.
 */
export function seedRows(
  path = join(dirname(fileURLToPath(import.meta.url)), "fixtures.json"),
): SeedRow[] {
  const doc = JSON.parse(readFileSync(path, "utf8")) as FixtureFile;
  const refs = new Map<string, FixtureRef>();
  const expected = new Map<string, string>();
  const excluded = new Map<string, Set<string>>();
  for (const fixture of doc.fixtures) {
    for (const ref of fixture.expected) {
      const key = `${ref.source_type}:${ref.id}`;
      refs.set(key, ref);
      const prior = expected.get(key);
      if (prior && prior !== fixture.namespace) {
        throw new Error(
          `recall_seed_conflicting_expected_namespaces: ${key} (${prior}, ${fixture.namespace})`,
        );
      }
      expected.set(key, fixture.namespace);
    }
    for (const ref of fixture.forbidden ?? []) {
      const key = `${ref.source_type}:${ref.id}`;
      refs.set(key, ref);
      const namespaces = excluded.get(key) ?? new Set<string>();
      namespaces.add(fixture.namespace);
      excluded.set(key, namespaces);
    }
  }
  const all = [...new Set(doc.fixtures.map((f) => f.namespace))];
  return [...refs].map(([key, ref]) => {
    const forbidden = excluded.get(key) ?? new Set<string>();
    const required = expected.get(key);
    if (required && forbidden.has(required)) {
      throw new Error(`recall_seed_expected_namespace_forbidden: ${key} (${required})`);
    }
    const namespace = required ?? all.find((candidate) => !forbidden.has(candidate));
    if (!namespace) {
      throw new Error(`recall_seed_no_eligible_namespace: ${key}`);
    }
    if (!required) {
      logger.info("recall_seed_namespace_adjusted", {
        ref: key,
        original: [...forbidden].join(","),
        adjusted: namespace,
        reason: "forbidden-only fixture ref needs an eligible seed namespace",
      });
    }
    return { source_type: ref.source_type, id: ref.id, namespace };
  });
}

/**
 * Insert the fixture rows that are missing, and leave every existing row alone.
 *
 * Idempotent: `ON CONFLICT (id) DO NOTHING` everywhere, so against the real
 * dogfood corpus this inserts nothing at all.
 *
 * @param pool - An open connection to the corpus or test database.
 * @param path - Path to `fixtures.json`.
 * @returns The number of rows actually inserted, lanes included.
 */
type Inserter = (pool: Pool, id: string, namespace: string) => Promise<number>;

/** One minimal-row inserter per table a fixture may name, all conflict-safe. */
const INSERTERS: Readonly<Record<string, Inserter>> = {
  thoughts: async (pool, id, ns) =>
    (
      await pool.query(
        `INSERT INTO public.thoughts (id, content, created_by, namespace)
         VALUES ($1::uuid, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        [id, SEED_TEXT, SEED_AUTHOR, ns],
      )
    ).rowCount ?? 0,
  decisions: async (pool, id, ns) =>
    (
      await pool.query(
        `INSERT INTO public.decisions (id, title, rationale, created_by, namespace)
         VALUES ($1::uuid, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
        [id, SEED_TEXT, SEED_TEXT, SEED_AUTHOR, ns],
      )
    ).rowCount ?? 0,
  sessions: async (pool, id, ns) =>
    (
      await pool.query(
        `INSERT INTO public.sessions (id, summary, created_by, namespace)
         VALUES ($1::uuid, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        [id, SEED_TEXT, SEED_AUTHOR, ns],
      )
    ).rowCount ?? 0,
  ob_session_events: seedSessionEvent,
};

/**
 * Seed one session event, and the lane that carries its namespace.
 *
 * Session events are namespaced INDIRECTLY: `ob_session_events` has no
 * `namespace` column, scope lives on `ob_session_lanes` and is reachable only
 * through `lane_id`
 * (`docs/decisions/search-engine-sql-session-events-indirect-namespace.md`).
 * So the lane is inserted first, or the foreign key rejects the event.
 *
 * The existence check comes before both inserts on purpose: against the real
 * corpus the event already exists, and inserting its derived lane anyway would
 * leave an orphan lane behind on every run.
 *
 * @param pool - An open connection.
 * @param id - The event id the fixture names.
 * @param ns - The namespace the fixture places it in.
 * @returns The number of rows inserted, lane included.
 */
async function seedSessionEvent(pool: Pool, id: string, ns: string): Promise<number> {
  const present = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM public.ob_session_events WHERE id = $1::uuid`,
    [id],
  );
  if (present.rows[0]?.n === "1") {
    return 0;
  }
  const laneId = laneIdFor(id);
  const lane = await pool.query(
    `INSERT INTO public.ob_session_lanes (id, session_key, namespace, created_by)
     VALUES ($1::uuid, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
    [laneId, `recall-fixture-seed:${id}`, ns, SEED_AUTHOR],
  );
  const event = await pool.query(
    `INSERT INTO public.ob_session_events (id, lane_id, event_type, content, created_by)
     VALUES ($1::uuid, $2::uuid, 'fact', $3, $4) ON CONFLICT (id) DO NOTHING`,
    [id, laneId, SEED_TEXT, SEED_AUTHOR],
  );
  return (lane.rowCount ?? 0) + (event.rowCount ?? 0);
}

/**
 * Insert the fixture rows that are missing, and leave every existing row alone.
 *
 * Idempotent: `ON CONFLICT (id) DO NOTHING` everywhere, so against the real
 * dogfood corpus this inserts nothing at all. It issues no UPDATE and no
 * DELETE, and touches no id the fixture file does not name.
 *
 * @param pool - An open connection to the corpus or test database.
 * @param path - Path to `fixtures.json`.
 * @returns The number of rows actually inserted, lanes included.
 */
export async function seedRecallCorpus(
  pool: Pool,
  path = join(dirname(fileURLToPath(import.meta.url)), "fixtures.json"),
): Promise<number> {
  let inserted = 0;
  for (const row of seedRows(path)) {
    const insert = INSERTERS[row.source_type];
    if (!insert) {
      throw new Error(`recall_seed_unknown_table: ${row.source_type}`);
    }
    inserted += await insert(pool, row.id, row.namespace);
  }
  return inserted;
}
