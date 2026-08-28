// Live Postgres reads for the agent_context_pack durable lane section.
//
// This suite demands a real database: `requireTestDatabaseUrl()` throws
// `test_database_required` at module scope when the test database is absent,
// so a run without one fails loudly instead of reporting a skipped suite as a
// pass (#878).
import { afterAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../../scripts/test-support/require-test-database.ts";
import { setupAgentContextPackToolClient as setupToolClient } from "./agent-context-pack-test-helpers.ts";
import {
  expectDefined,
  parsePackPayload,
  type PackEvent,
  type ToolClientPool,
} from "./agent-context-pack-durable-lane-test-helpers.ts";

const pool = new Pool({
  connectionString: requireTestDatabaseUrl(),
  max: 2,
  connectionTimeoutMillis: 500,
});
const namespace = `test-context-pack-${process.pid}`;
const liveScope = {
  namespace,
  agent: "nagatha",
  platform: "discord",
  server_id: "live-server",
  channel_id: "live-channel",
  session_key: `live-context-pack-${process.pid}`,
};
const laneId = "10000000-0000-0000-0000-000000000001";

async function cleanupDatabaseRows() {
  await pool.query(
    `DELETE FROM ob_session_events
      WHERE lane_id IN (SELECT id FROM ob_session_lanes WHERE namespace = $1)`,
    [namespace],
  );
  await pool.query("DELETE FROM ob_session_lanes WHERE namespace = $1", [namespace]);
}

async function insertLane() {
  await pool.query(
    `INSERT INTO ob_session_lanes
       (id, session_key, namespace, agent, source, channel_id, thread_id,
        project, topic, current_context_md, metadata, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, 'open-brain', 'live context',
             'live checkpoint', jsonb_build_object('server_id', $7::text), 'test')`,
    [
      laneId,
      liveScope.session_key,
      namespace,
      liveScope.agent,
      liveScope.platform,
      liveScope.channel_id,
      liveScope.server_id,
    ],
  );
}

async function callLivePack(maxLatencyMs?: number) {
  const { client, cleanup } = await setupToolClient(
    { role: "admin", clientId: namespace },
    pool as unknown as ToolClientPool,
  );
  try {
    return await client.callTool({
      name: "agent_context_pack",
      arguments: {
        ...liveScope,
        requested_sections: ["durable_lane_context"],
        ...(maxLatencyMs === undefined
          ? {}
          : { budget: { max_latency_ms: maxLatencyMs } }),
      },
    });
  } finally {
    await cleanup();
  }
}

afterAll(async () => {
  await cleanupDatabaseRows();
  await pool.end();
});

async function readsWholeLaneChronologically() {
  await cleanupDatabaseRows();
  try {
    await insertLane();
    const createdAt = "2026-07-17T17:00:00.000Z";
    for (let index = 1; index <= 9; index += 1) {
      const id = `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`;
      await pool.query(
        `INSERT INTO ob_session_events
           (id, lane_id, event_type, content, source, importance, created_by, created_at)
         VALUES ($1, $2, 'fact', $3, 'test', 'warm', 'test', $4)`,
        [id, laneId, `short event ${index}`, createdAt],
      );
    }

    const pack = await callLivePack();
    const payload = parsePackPayload(pack.content);
    expect(pack.isError).toBeFalsy();
    expect(payload.sections.durable_lane_context).toBeDefined();
    // No budget was requested, so the whole lane comes back whole. All nine
    // events share one timestamp, so the `created_at DESC, id DESC` tie-break
    // is what makes the order deterministic; after the chronological reverse
    // that surfaces as UUID ascending. This used to expect only the eight
    // "recent" events and `truncated: true`, dropping ...0001 to the 8-event
    // ceiling. That ceiling and its truncation marker are gone as of
    // 2026-07-30 (see agent-context-pack-durable-lane.ts) -- the oldest event
    // is no longer the price of a full read.
    expect(
      expectDefined(
        payload.sections.durable_lane_context,
        "the durable lane section",
      ).events.map((event: PackEvent) => event.id),
    ).toEqual(
      Array.from(
        { length: 9 },
        (_, index) => `00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
      ),
    );
    expect(payload.sections.durable_lane_context).toMatchObject({
      event_count: 9,
      truncated: false,
    });
  } finally {
    await cleanupDatabaseRows();
  }
}

async function cancelsLockDelayedRead() {
  await cleanupDatabaseRows();
  const blocker = await pool.connect();
  try {
    await insertLane();
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE ob_session_events IN ACCESS EXCLUSIVE MODE");

    const startedAt = performance.now();
    const pack = await callLivePack(50);
    const elapsedMs = performance.now() - startedAt;
    const payload = parsePackPayload(pack.content);

    expect(pack.isError).toBeFalsy();
    expect(payload.sections.durable_lane_context).toBeUndefined();
    expect(payload.warnings.degraded_sources).toEqual([
      {
        source: "durable_lane_context",
        reason: "database_unavailable",
      },
    ]);
    expect(elapsedMs).toBeLessThan(500);
    await pool.query("SELECT 1");
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
    await cleanupDatabaseRows();
  }
}

describe("agent_context_pack durable lane reads (live Postgres)", () => {
  it(
    "orders equal-timestamp events by UUID and returns the whole lane chronologically",
    readsWholeLaneChronologically,
  );

  it(
    "cancels a lock-delayed event read before returning and releases its pool client",
    cancelsLockDelayedRead,
  );
});
