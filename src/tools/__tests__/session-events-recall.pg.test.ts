/**
 * Live-Postgres coverage for session-event recall visibility (#433, defect 1).
 *
 * The defect: `brain_answer` filtered `ALL_TABLES` -- the PHYSICAL-table list
 * that drives `PERMISSIONS` and the write paths -- so `ob_session_events` was
 * structurally absent from every question it answered. Asking "what happened
 * in the last day" returned months-old thoughts while the day's events sat
 * unread. The corpus held 11,136 rows on the dogfood database when this was
 * found.
 *
 * SCOPE. Defect 2 of the same issue ("nothing promotes events into durable
 * tables") is NOT covered here and is not closed by these tests. Visibility and
 * promotion are independent concerns.
 *
 * These need a live Postgres because the thing under test is a JOIN predicate.
 * `ob_session_events` has NO `namespace` column; scope lives on
 * `ob_session_lanes` and is reachable only through `lane_id`. A fake pool can
 * assert that some predicate string was emitted, but only the database can
 * prove that the predicate actually excludes a foreign row -- and that is the
 * whole security question, because a recall path that reads this corpus without
 * carrying the auth-derived namespace through the lane join exposes every
 * agent's session history to every other namespace.
 *
 * REQUIRES the test database, and fails hard without it (operator ruling
 * 2026-08-27, issue #878): a suite that skips itself reports a false green.
 * `bun run test:isolated` supplies it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "../../db/migrate.ts";
import { executeSearch, readableSearchTables } from "../search-brain.ts";
import {
  executeSearch as executeSearchServer,
  readableSearchSources,
} from "../../../server/tools/search-engine.ts";
import pino from "pino";
import { createMockEmbed } from "./test-helpers.ts";
import { requireTestDatabaseUrl } from "../../../scripts/test-support/require-test-database.ts";


const CREATED_BY = "session-events-recall-pg-test";
const OWNER_NS = "test-433-owner";
const OTHER_NS = "test-433-other";

// Keyword mode with a null-returning embed: the lexical arm must find the row
// on its own, so a vector hit cannot mask a lexical path that was never wired.
const embed = createMockEmbed(null);

/** The subset of a search result row these assertions read. */
type SearchRow = {
  source_type?: unknown;
  source_ref?: unknown;
  namespace?: unknown;
  content_preview?: unknown;
};

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

const deps = { pool, embedFn: embed, logger: pino({ level: "silent" }) };

beforeAll(async () => {
  await runMigrations(pool);
});

afterEach(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await pool.end();
});

async function cleanup(): Promise<void> {
  await pool.query(
    `DELETE FROM ob_session_events
      WHERE lane_id IN (SELECT id FROM ob_session_lanes WHERE created_by = $1)`,
    [CREATED_BY],
  );
  await pool.query("DELETE FROM ob_session_lanes WHERE created_by = $1", [
    CREATED_BY,
  ]);
}

/** Seed one lane in `namespace` holding one event whose content is `content`. */
async function seedEvent(
  namespace: string,
  content: string,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO ob_session_lanes (session_key, namespace, created_by)
     VALUES ($1, $2, $3) RETURNING id`,
    [`${CREATED_BY}-${namespace}-${content.slice(0, 12)}`, namespace, CREATED_BY],
  );
  const laneId = rows[0]?.id as string | undefined;
  if (!laneId) throw new Error("seed lane insert returned no id");
  await pool.query(
    `INSERT INTO ob_session_events (lane_id, event_type, content, importance, created_by)
     VALUES ($1, 'fact', $2, 'hot', $3)`,
    [laneId, content, CREATED_BY],
  );
  return laneId;
}

function markerRows(
  rows: readonly SearchRow[],
  marker: string,
): SearchRow[] {
  return rows.filter((row) =>
    String(row.content_preview ?? "").includes(marker),
  );
}

describe("session-event recall visibility (#433 defect 1)", () => {
  it("brain_answer's source list reaches the session-event corpus", () => {
    // The regression that started #433 was a table list, so pin the list. Both
    // serving trees are asserted because both are live: server/main.ts is the
    // local-clone entrypoint and src/index.ts still serves production-host.
    expect(readableSearchTables("admin")).toContain("session_events");
    expect(readableSearchSources("admin")).toContain("session_events");
  });

  it("keeps entities opt-in so brain_answer's citations are unchanged", () => {
    // The fix must not quietly widen brain_answer beyond #433. `entities` rows
    // preview as name labels rather than statements, so they belong to
    // search_brain (which opts in) and not to the citation path.
    expect(readableSearchTables("admin")).not.toContain("entities");
    expect(
      readableSearchTables("admin", { includeEntities: true }),
    ).toContain("entities");
  });

  it("a role without sessions read access gets no session-event source", () => {
    // `discord` holds write-only on thoughts and nothing else, so it must not
    // reach a corpus it cannot read. This is what stops the fix from becoming a
    // blanket widening.
    expect(readableSearchTables("discord")).not.toContain("session_events");
    expect(readableSearchSources("discord")).not.toContain("session_events");
  });

});

describe("session-event recall against live Postgres (#433 defect 1)", () => {
  it("surfaces a session event from the src serving tree", async () => {
    const marker = "marker433src";
    await seedEvent(OWNER_NS, `${marker} a thing that happened this session`);

    const rows = await executeSearch(
      deps,
      readableSearchTables("admin"),
      marker,
      25,
      "keyword",
      undefined,
      0,
      OWNER_NS,
    );

    const hits = markerRows(rows, marker);
    expect(hits.length).toBe(1);
    expect(hits[0]?.source_type).toBe("session_event");
    // brain_answer refuses to cite a row without citation metadata, so an
    // invisible-to-citation row would be as useless as an unsearchable one.
    expect(hits[0]?.source_ref).toBeTruthy();
    expect(hits[0]?.namespace).toBe(OWNER_NS);
  });

  it("surfaces a session event from the server serving tree", async () => {
    const marker = "marker433srv";
    await seedEvent(OWNER_NS, `${marker} a thing that happened this session`);

    const rows = await executeSearchServer(
      deps,
      readableSearchSources("admin"),
      marker,
      25,
      "keyword",
      undefined,
      0,
      OWNER_NS,
    );

    const hits = markerRows(rows, marker);
    expect(hits.length).toBe(1);
    expect(hits[0]?.source_type).toBe("session_event");
    expect(hits[0]?.namespace).toBe(OWNER_NS);
  });

  it("does not leak another namespace's session events (src tree)", async () => {
    // THE SECURITY ASSERTION. The event belongs to OWNER_NS; the search runs as
    // OTHER_NS. Because ob_session_events has no namespace column, this passes
    // only if the lane JOIN carries the predicate. Deleting the namespace
    // filter from the session-event CTE makes exactly this fail.
    const marker = "marker433leaksrc";
    await seedEvent(OWNER_NS, `${marker} private to the owning namespace`);

    const rows = await executeSearch(
      deps,
      readableSearchTables("admin"),
      marker,
      25,
      "keyword",
      undefined,
      0,
      OTHER_NS,
    );

    expect(markerRows(rows, marker)).toEqual([]);
  });

  it("does not leak another namespace's session events (server tree)", async () => {
    const marker = "marker433leaksrv";
    await seedEvent(OWNER_NS, `${marker} private to the owning namespace`);

    const rows = await executeSearchServer(
      deps,
      readableSearchSources("admin"),
      marker,
      25,
      "keyword",
      undefined,
      0,
      OTHER_NS,
    );

    expect(markerRows(rows, marker)).toEqual([]);
  });

  it("returns the owning namespace's event and not a foreign one for the same query", async () => {
    // Both namespaces hold a row matching the SAME query token, so a passing
    // result cannot be explained by the query simply matching nothing. This is
    // the case that distinguishes "the predicate works" from "the search is
    // broken", which a single-row leak test cannot separate on its own.
    const shared = "marker433shared";
    await seedEvent(OWNER_NS, `${shared} owned by the caller`);
    await seedEvent(OTHER_NS, `${shared} owned by somebody else`);

    const rows = await executeSearch(
      deps,
      readableSearchTables("admin"),
      shared,
      25,
      "keyword",
      undefined,
      0,
      OWNER_NS,
    );

    const hits = markerRows(rows, shared);
    expect(hits.length).toBe(1);
    expect(hits[0]?.namespace).toBe(OWNER_NS);
    expect(String(hits[0]?.content_preview)).toContain("owned by the caller");
  });
});
