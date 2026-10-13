/**
 * Live-Postgres tests for `loadCanonEntriesForNamespace` (issue 1618 B4 L1):
 * the adapter over the context-pack guidance read returns the standing canon
 * set for one namespace, honours relegation, and never crosses namespaces.
 *
 * REQUIRES `OPENBRAIN_TEST_DATABASE_URL`, and fails hard without it (issue 878).
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";
import { loadCanonEntriesForNamespace } from "./distill-jev-type.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

const NS_A = "ns_a";
const NS_B = "ns_b";
const laneIds: string[] = [];

async function seedLane(namespace: string): Promise<string> {
  const lane = await pool.query<{ id: string }>(
    `INSERT INTO ob_session_lanes (namespace, session_key, status, created_by)
     VALUES ($1, $2, 'active', 'test')
     RETURNING id`,
    [namespace, `canon-read-pg-${namespace}-${process.pid}`],
  );
  const id = lane.rows[0]?.id ?? "";
  laneIds.push(id);
  return id;
}

let minute = 0;

async function seedEvent(input: {
  laneId: string;
  content: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  minute += 1;
  await pool.query(
    `INSERT INTO ob_session_events
       (lane_id, event_type, content, metadata, created_at, created_by)
     VALUES ($1, 'decision', $2, $3::jsonb, $4, 'test')`,
    [
      input.laneId,
      input.content,
      JSON.stringify(input.metadata),
      new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
    ],
  );
}

function lifecycle(action: string, type: string, key: string): Record<string, unknown> {
  return {
    memory_lifecycle_action: action,
    candidate_type: type,
    candidate_scope: { key },
  };
}

beforeAll(async () => {
  const laneA = await seedLane(NS_A);
  const laneB = await seedLane(NS_B);
  await seedEvent({
    laneId: laneA,
    content: "rule a one",
    metadata: lifecycle("promote", "process_rule", "process.a_one"),
  });
  await seedEvent({
    laneId: laneA,
    content: "pref a two",
    metadata: lifecycle("promote", "user_preference", "profile.a_two"),
  });
  await seedEvent({
    laneId: laneA,
    content: "rule a gone",
    metadata: lifecycle("promote", "process_rule", "process.a_gone"),
  });
  await seedEvent({
    laneId: laneA,
    content: "rule a gone retired",
    metadata: lifecycle("relegate", "process_rule", "process.a_gone"),
  });
  await seedEvent({ laneId: laneA, content: "plain event", metadata: {} });
  await seedEvent({
    laneId: laneB,
    content: "rule b one",
    metadata: lifecycle("promote", "process_rule", "process.b_one"),
  });
});

afterAll(async () => {
  await pool.query(`DELETE FROM ob_session_events WHERE lane_id = ANY($1::uuid[])`, [
    laneIds,
  ]);
  await pool.query(`DELETE FROM ob_session_lanes WHERE id = ANY($1::uuid[])`, [
    laneIds,
  ]);
  await pool.end();
});

describe("loadCanonEntriesForNamespace (live Postgres)", () => {
  test("returns the standing set with sections, minus relegated keys", async () => {
    const entries = await loadCanonEntriesForNamespace({
      db: pool,
      namespace: NS_A,
      logger: { warn: vi.fn() },
    });
    const got = entries
      .map((e) => ({ scopeKey: e.scopeKey, section: e.section, content: e.content }))
      .sort((a, b) => a.scopeKey.localeCompare(b.scopeKey));
    expect(got).toEqual([
      { scopeKey: "process.a_one", section: "process_guidance", content: "rule a one" },
      { scopeKey: "profile.a_two", section: "profile_guidance", content: "pref a two" },
    ]);
  });

  test("is namespace-isolated", async () => {
    const entries = await loadCanonEntriesForNamespace({
      db: pool,
      namespace: NS_B,
      logger: { warn: vi.fn() },
    });
    expect(entries.map((e) => e.scopeKey)).toEqual(["process.b_one"]);
  });

  test("returns an empty array for an unknown namespace", async () => {
    const entries = await loadCanonEntriesForNamespace({
      db: pool,
      namespace: `ns_unknown_${process.pid}`,
      logger: { warn: vi.fn() },
    });
    expect(entries).toEqual([]);
  });
});
