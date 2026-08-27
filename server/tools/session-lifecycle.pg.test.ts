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
 * REQUIRES `OPENBRAIN_TEST_DATABASE_URL`, and fails hard without it (operator
 * ruling 2026-08-27, issue #878). It must point at an isolated test/playground database, never the
 * dogfood database.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pino from "pino";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";
import { registerSessionLifecycleTools } from "./session-lifecycle.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

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

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return JSON.parse(await callToolText(name, args));
}

/** The tool's raw text. Error results are sentences, not JSON envelopes. */
async function callToolText(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const server = new McpServer({
    name: "session-lifecycle-test",
    version: "1.0.0",
  });
  registerSessionLifecycleTools(server, {
    pool,
    embedFn: async () => null,
    logger: pino({ level: "silent" }),
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    originalSend(message, {
      ...options,
      authInfo: {
        role: "agent",
        clientId: NAMESPACE,
        namespaceSource: "token",
      },
    } as never);
  const client = new Client({
    name: "session-lifecycle-test",
    version: "1.0.0",
  });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  const result = await client.callTool({ name, arguments: args });
  const text =
    (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
  await client.close();
  return text;
}

describe("session lifecycle event bounds (#515)", () => {
  let laneId: string;

  beforeAll(async () => {
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
    await pool.query(`DELETE FROM ob_session_events WHERE lane_id = $1`, [
      laneId,
    ]);
    await pool.query(`DELETE FROM ob_session_lanes WHERE id = $1`, [laneId]);
    // `pool` is module-level and shared by every suite's callTool(); closing it
    // here made the #646 suite fail with "Cannot use a pool after calling end",
    // which reads exactly like a real red. It is closed once, at the bottom of
    // the file, after the last suite.
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

/**
 * #646 — exact scope must be establishable on a lane that predates it.
 *
 * This handler used to return an existing lane verbatim, so a lane opened
 * without the full exact-scope predicate could never afterwards prove it. The
 * client's scope proof then failed permanently and EVERY capture into that
 * lane was lost with "session_start result did not prove exact Open Brain
 * scope". 2009 such lanes existed on the dogfood database when measured.
 *
 * The old behavior fails the first two tests here: it returned NULL scope
 * columns unchanged, and it never refused a conflicting lane.
 */
describe("session_start exact-scope establishment (#646)", () => {
  const SCOPE = {
    agent: "agent-646",
    platform: "cli-646",
    server_id: "server-646",
    channel_id: "channel-646",
  };
  const partialKey = `${NAMESPACE}-646-partial`;
  const conflictKey = `${NAMESPACE}-646-conflict`;
  const scopePool = new Pool({ connectionString: requireTestDatabaseUrl() });

  const seed = async (
    sessionKey: string,
    agent: string | null,
  ): Promise<void> => {
    await scopePool.query(
      `INSERT INTO ob_session_lanes
         (session_key, namespace, status, agent, metadata, created_by)
       VALUES ($1, $2, 'active', $3, '{}'::jsonb, $2)`,
      [sessionKey, NAMESPACE, agent],
    );
  };

  beforeAll(async () => {
    // The shape a head session leaves behind: an agent, and nothing else.
    await seed(partialKey, "openbrain-capture");
    // A lane that genuinely belongs to a different scope.
    await seed(conflictKey, "someone-else");
  });

  afterAll(async () => {
    await scopePool.query(
      `DELETE FROM ob_session_lanes WHERE namespace = $1 AND session_key = ANY($2)`,
      [NAMESPACE, [partialKey, conflictKey]],
    );
    await scopePool.end();
  });

  test("backfills the exact-scope coordinates of a lane that lacks them", async () => {
    const started = (await callTool("session_start", {
      session_key: partialKey,
      ...SCOPE,
      agent: "openbrain-capture", // matches the lane; the NULLs are what fill in
    })) as StartEnvelope & {
      lane: {
        agent: string;
        source: string;
        channel_id: string;
        metadata: Record<string, unknown>;
      };
    };

    expect(started.is_new).toBe(false);
    expect(started.lane.source).toBe(SCOPE.platform);
    expect(started.lane.channel_id).toBe(SCOPE.channel_id);
    expect(started.lane.metadata.server_id).toBe(SCOPE.server_id);

    // Durably written, not just reflected in the response.
    const row = await scopePool.query(
      `SELECT source, channel_id, metadata->>'server_id' AS server_id
         FROM ob_session_lanes WHERE namespace = $1 AND session_key = $2`,
      [NAMESPACE, partialKey],
    );
    expect(row.rows[0].source).toBe(SCOPE.platform);
    expect(row.rows[0].channel_id).toBe(SCOPE.channel_id);
    expect(row.rows[0].server_id).toBe(SCOPE.server_id);
  });

  test("refuses a lane whose established scope conflicts, instead of returning it unproven", async () => {
    // errorResult returns a plain sentence, not a JSON envelope, so this reads
    // the raw tool text rather than going through callTool()'s JSON.parse.
    const text = await callToolText("session_start", {
      session_key: conflictKey,
      ...SCOPE,
    });

    expect(text).toContain("does not match");

    // And the conflicting lane is left exactly as it was — never re-pointed.
    const row = await scopePool.query(
      `SELECT agent, source FROM ob_session_lanes WHERE namespace = $1 AND session_key = $2`,
      [NAMESPACE, conflictKey],
    );
    expect(row.rows[0].agent).toBe("someone-else");
    expect(row.rows[0].source).toBeNull();
  });

  afterAll(async () => {
    // Last suite in the file owns closing the shared module-level pool.
    if (pool) await pool.end();
  });
});
