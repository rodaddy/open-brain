/**
 * Live-Postgres coverage for tier_lane, the graduation path that copies durable
 * session-lane events into the namespace as thoughts.
 *
 * The mock-pool suite (tier-lane.test.ts) covers auth, argument validation, and
 * response shape against a fake pool, which is right for all of those. It
 * cannot cover what this file covers: real halfvec embeddings, the ON CONFLICT
 * idempotency of a re-run, and cosine-distance near-duplicate detection are all
 * supplied by the fixture in a fake and computed by Postgres here.
 *
 * The suite demands the test database through the shared helper rather than
 * reading the environment itself, so a run without one fails loudly instead of
 * reporting a silent green over a suite that never executed.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { Pool } from "pg";
import { toSql } from "pgvector/pg";
import { requireTestDatabaseUrl } from "../../../scripts/test-support/require-test-database.ts";
import { registerTierLane } from "../tier-lane.ts";
import { contentHash } from "../../embedding.ts";
import {
  createMockEmbed,
  setupMcpClient,
  parseToolResult,
  type MockPool,
} from "./test-helpers.ts";
import type { AuthInfo } from "../../types.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

const ns = "test-tier-lane-live";
const sessionKey = "live-tier-lane";
// Deterministic embeddings so near-dup behavior is testable.
const baseEmbedding = Array(768).fill(0.1);
const embedFn = createMockEmbed(baseEmbedding);

async function callTierLane(args: Record<string, unknown>, auth: AuthInfo) {
  const { client, cleanup } = await setupMcpClient(
    registerTierLane,
    pool as unknown as MockPool,
    embedFn,
    auth,
  );
  try {
    return await client.callTool({ name: "tier_lane", arguments: args });
  } finally {
    await cleanup();
  }
}

async function seedLaneWithEvent(content: string, eventType = "fact") {
  const { rows } = await pool.query(
    `INSERT INTO ob_session_lanes (session_key, namespace, agent, created_by)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (namespace, session_key) DO UPDATE SET updated_at = NOW()
       RETURNING id`,
    [sessionKey, ns, ns],
  );
  const laneId = rows[0].id as string;
  await pool.query(
    `INSERT INTO ob_session_events
         (lane_id, event_type, content, importance, content_hash, embedding, created_by)
       VALUES ($1, $2, $3, 'warm', $4, $5, $6)
       ON CONFLICT (lane_id, content_hash) WHERE content_hash IS NOT NULL
       DO NOTHING`,
    [laneId, eventType, content, contentHash(content), toSql(baseEmbedding), ns],
  );
  return laneId;
}

async function cleanup() {
  await pool.query("DELETE FROM ob_session_lanes WHERE namespace = $1", [ns]);
  await pool.query("DELETE FROM thoughts WHERE namespace = $1", [ns]);
}

describe("tier_lane (live Postgres)", () => {
  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("graduates a fact into the namespace with provenance, idempotent on re-run", async () => {
    await cleanup();
    const content =
      "Live durable fact about the open-brain tiering integration test path";
    await seedLaneWithEvent(content);
    const auth: AuthInfo = { role: "agent", clientId: ns };

    const first = await callTierLane(
      { session_key: sessionKey, namespace: ns, dry_run: false },
      auth,
    );
    expect(first.isError).toBeFalsy();
    expect(parseToolResult(first).graduated).toBe(1);

    const { rows: afterFirst } = await pool.query(
      "SELECT id, promoted_from, tags FROM thoughts WHERE namespace = $1",
      [ns],
    );
    expect(afterFirst.length).toBe(1);
    expect(afterFirst[0].promoted_from.source).toBe("session-lane");
    expect(afterFirst[0].tags).toContain("tiered-from-lane");

    // Re-run: ON CONFLICT idempotency — exact-hash dedup skips, no new row.
    const second = await callTierLane(
      { session_key: sessionKey, namespace: ns, dry_run: false },
      auth,
    );
    expect(second.isError).toBeFalsy();
    expect(parseToolResult(second).duplicates).toBe(1);

    const { rows: afterSecond } = await pool.query(
      "SELECT count(*)::int AS n FROM thoughts WHERE namespace = $1",
      [ns],
    );
    expect(afterSecond[0].n).toBe(1);
  });

  it("skips a near-duplicate by embedding distance", async () => {
    await cleanup();
    const auth: AuthInfo = { role: "agent", clientId: ns };
    // First event graduates.
    await seedLaneWithEvent(
      "Original durable statement that should graduate into thoughts cleanly",
    );
    await callTierLane(
      { session_key: sessionKey, namespace: ns, dry_run: false },
      auth,
    );

    // Second event: different text + hash but identical embedding → near-dup.
    await seedLaneWithEvent(
      "A slightly reworded but semantically identical durable statement here",
    );
    const res = await callTierLane(
      { session_key: sessionKey, namespace: ns, dry_run: false },
      auth,
    );
    const parsed = parseToolResult(res);
    // The tool re-scans the whole lane, so BOTH events are now duplicates:
    // event 1 by exact content_hash (already graduated), event 2 by near
    // embedding distance. The point is that the near-dup event 2 did NOT
    // graduate (no new row), proving embedding dedup works.
    expect(parsed.graduated).toBe(0);
    expect(parsed.duplicates).toBe(2);

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM thoughts WHERE namespace = $1",
      [ns],
    );
    expect(rows[0].n).toBe(1);
  });
});
