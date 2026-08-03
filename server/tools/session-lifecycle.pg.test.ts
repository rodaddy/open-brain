/**
 * Live-Postgres behavior tests for the ported session lifecycle tools.
 *
 * Regression coverage for #515: the port dropped `session_context`'s
 * `event_limit` argument (src/tools/session-context.ts:49, default 50) and
 * `session_start`'s `LIMIT 50` (src/tools/session-start.ts:237), so both
 * returned every event in the lane. A lane with enough history made the
 * response larger than clients read, and every resume died. These tests seed
 * more events than the bounds and prove the row counts, so the old behavior
 * fails them.
 *
 * Skips loudly (via `describe.skip`) when `OPENBRAIN_TEST_DATABASE_URL` is
 * unset. It must point at an isolated test/playground database, never the
 * dogfood database.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pino from "pino";
import { Pool } from "pg";
import { registerSessionLifecycleTools } from "./session-lifecycle.ts";

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;
const pool = DB_URL ? new Pool({ connectionString: DB_URL }) : null;

const NAMESPACE = `session-lifecycle-pg-${process.pid}`;
const SESSION_KEY = `${NAMESPACE}-lane`;
const EVENT_COUNT = 55;

interface ContextEnvelope {
  lane: { id: string; session_key: string } | null;
  events: Array<{ event_type: string; content: string }>;
  event_count: number;
}

interface StartEnvelope {
  lane: { id: string; session_key: string };
  events: Array<{ event_type: string; content: string }>;
  events_returned: number;
  is_new: boolean;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!pool) throw new Error("OPENBRAIN_TEST_DATABASE_URL is required");
  const server = new McpServer({ name: "session-lifecycle-test", version: "1.0.0" });
  registerSessionLifecycleTools(server, {
    pool,
    embedFn: async () => null,
    logger: pino({ level: "silent" }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    originalSend(message, {
      ...options,
      authInfo: { role: "agent", clientId: NAMESPACE, namespaceSource: "token" },
    } as never);
  const client = new Client({ name: "session-lifecycle-test", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
  await client.close();
  return JSON.parse(text);
}

dbDescribe("session lifecycle event bounds (#515)", () => {
  let laneId: string;

  beforeAll(async () => {
    if (!pool) return;
    const lane = await pool.query(
      `INSERT INTO ob_session_lanes
         (session_key, namespace, status, metadata, created_by)
       VALUES ($1, $2, 'active', '{}'::jsonb, $3)
       RETURNING id`,
      [SESSION_KEY, NAMESPACE, NAMESPACE],
    );
    laneId = lane.rows[0].id;
    for (let i = 0; i < EVENT_COUNT; i++) {
      await pool.query(
        `INSERT INTO ob_session_events
           (lane_id, event_type, content, importance, metadata, created_by, created_at)
         VALUES ($1, $2, $3, 'warm', '{}'::jsonb, $4, now() + make_interval(secs => $5))`,
        [laneId, i % 5 === 0 ? "decision" : "fact", `event ${i}`, NAMESPACE, i],
      );
    }
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM ob_session_events WHERE lane_id = $1`, [laneId]);
    await pool.query(`DELETE FROM ob_session_lanes WHERE id = $1`, [laneId]);
    await pool.end();
  });

  test("session_context honors event_limit", async () => {
    const ctx = (await callTool("session_context", {
      session_key: SESSION_KEY,
      include_events: true,
      event_limit: 3,
    })) as ContextEnvelope;
    expect(ctx.lane?.session_key).toBe(SESSION_KEY);
    expect(ctx.events.length).toBe(3);
    expect(ctx.event_count).toBe(3);
    // Newest first
    expect(ctx.events[0]?.content).toBe(`event ${EVENT_COUNT - 1}`);
  });

  test("session_context defaults to 50 events, not the whole lane", async () => {
    const ctx = (await callTool("session_context", {
      session_key: SESSION_KEY,
      include_events: true,
    })) as ContextEnvelope;
    expect(ctx.events.length).toBe(50);
  });

  test("session_context filters by event_types", async () => {
    const ctx = (await callTool("session_context", {
      session_key: SESSION_KEY,
      event_types: ["decision"],
      event_limit: 200,
    })) as ContextEnvelope;
    expect(ctx.events.length).toBe(Math.ceil(EVENT_COUNT / 5));
    for (const event of ctx.events) expect(event.event_type).toBe("decision");
  });

  test("session_start returns the 50 newest events for an existing lane", async () => {
    const started = (await callTool("session_start", {
      session_key: SESSION_KEY,
    })) as StartEnvelope;
    expect(started.is_new).toBe(false);
    expect(started.events_returned).toBe(50);
    expect(started.events[0]?.content).toBe(`event ${EVENT_COUNT - 1}`);
  });
});
