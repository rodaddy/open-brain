/**
 * Live-Postgres behavior tests for `session_wrap` exact-scope validation.
 *
 * Regression coverage for issue 864: the src/ retirement dropped the wrap-side
 * scope check. `server/contracts/schemas-events.ts` still advertises
 * agent/platform/server_id/channel_id/thread_id on `session_wrap` with
 * exact-scope checkpoint validation, but the server handler accepted none of
 * them and validated nothing, so a checkpoint could land on a lane belonging to
 * a different agent. The behavior restored here is the one the deleted
 * `src/tools/session-wrap.ts` carried.
 *
 * REQUIRES `OPENBRAIN_TEST_DATABASE_URL`, and fails hard without it (operator
 * ruling 2026-08-27, issue #878). It must point at an isolated test/playground
 * database, never the dogfood database.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pino from "pino";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";
import { registerSessionLifecycleTools } from "./session-lifecycle.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

const NAMESPACE = `session-wrap-scope-pg-${process.pid}`;

const SCOPE = {
  agent: "agent-864",
  platform: "cli-864",
  server_id: "server-864",
  channel_id: "channel-864",
};

const matchedKey = `${NAMESPACE}-matched`;
const conflictKey = `${NAMESPACE}-conflict`;
const threadedKey = `${NAMESPACE}-threaded`;
const partialKey = `${NAMESPACE}-partial`;

/** The tool's raw text. Error results are JSON envelopes or plain sentences. */
async function callToolText(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const server = new McpServer({
    name: "session-wrap-scope-test",
    version: "1.0.0",
  });
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
      authInfo: {
        role: "agent",
        clientId: NAMESPACE,
        namespaceSource: "token",
      },
    } as never);
  const client = new Client({
    name: "session-wrap-scope-test",
    version: "1.0.0",
  });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
  await client.close();
  return text;
}

async function seed(
  sessionKey: string,
  lane: {
    agent: string | null;
    source?: string | null;
    channelId?: string | null;
    threadId?: string | null;
    serverId?: string | null;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO ob_session_lanes
       (session_key, namespace, status, agent, source, channel_id, thread_id,
        metadata, created_by)
     VALUES ($1, $2, 'active', $3, $4, $5, $6, $7::jsonb, $2)`,
    [
      sessionKey,
      NAMESPACE,
      lane.agent,
      lane.source ?? null,
      lane.channelId ?? null,
      lane.threadId ?? null,
      JSON.stringify(lane.serverId ? { server_id: lane.serverId } : {}),
    ],
  );
}

describe("session_wrap exact-scope checkpoint validation (live Postgres)", () => {
  beforeAll(async () => {
    await seed(matchedKey, {
      agent: SCOPE.agent,
      source: SCOPE.platform,
      channelId: SCOPE.channel_id,
      serverId: SCOPE.server_id,
    });
    await seed(conflictKey, {
      agent: "someone-else",
      source: SCOPE.platform,
      channelId: SCOPE.channel_id,
      serverId: SCOPE.server_id,
    });
    await seed(threadedKey, {
      agent: SCOPE.agent,
      source: SCOPE.platform,
      channelId: SCOPE.channel_id,
      serverId: SCOPE.server_id,
    });
    // The shape a head session leaves behind: an agent, and nothing else.
    await seed(partialKey, { agent: SCOPE.agent });
  });

  afterAll(async () => {
    const keys = [matchedKey, conflictKey, threadedKey, partialKey];
    await pool.query(`DELETE FROM sessions WHERE namespace = $1`, [NAMESPACE]);
    await pool.query(
      `DELETE FROM ob_session_lanes WHERE namespace = $1 AND session_key = ANY($2)`,
      [NAMESPACE, keys],
    );
    await pool.end();
  });

  test("rejects a mismatched agent by name, without echoing the value", async () => {
    const text = await callToolText("session_wrap", {
      session_key: conflictKey,
      summary: "checkpoint against a lane owned by another agent",
      ...SCOPE,
    });

    expect(text).toContain("scope_validation");
    expect(text).toContain("agent");
    // Label, never value: the rejection names the field, not the content.
    expect(text).not.toContain("someone-else");

    // The conflicting lane is left exactly as it was.
    const row = await pool.query(
      `SELECT agent, current_context_md FROM ob_session_lanes
         WHERE namespace = $1 AND session_key = $2`,
      [NAMESPACE, conflictKey],
    );
    expect(row.rows[0].agent).toBe("someone-else");
    expect(row.rows[0].current_context_md).toBeNull();
  });

  test("rejects an omitted thread_id as an unthreaded assertion on a threaded lane", async () => {
    await pool.query(
      `UPDATE ob_session_lanes SET thread_id = $3
         WHERE namespace = $1 AND session_key = $2`,
      [NAMESPACE, threadedKey, "thread-864"],
    );

    const text = await callToolText("session_wrap", {
      session_key: threadedKey,
      summary: "checkpoint asserting an unthreaded lane",
      ...SCOPE,
    });

    expect(text).toContain("scope_validation");
    expect(text).toContain("thread_id");
  });

  test("checkpoints a lane whose stored scope matches the request", async () => {
    const text = await callToolText("session_wrap", {
      session_key: matchedKey,
      summary: "checkpoint on a fully matching scope",
      ...SCOPE,
    });

    const payload = JSON.parse(text) as {
      lane_id?: string;
      context_updated?: boolean;
    };
    expect(text).not.toContain("scope_validation");
    expect(payload.context_updated).toBe(true);
    expect(payload.lane_id).toBeTruthy();
  });

  test("establishes the exact scope of a lane that lacks it", async () => {
    const text = await callToolText("session_wrap", {
      session_key: partialKey,
      summary: "checkpoint that fills in the missing scope coordinates",
      ...SCOPE,
    });

    expect(text).not.toContain("scope_validation");

    // Durably written, not just accepted.
    const row = await pool.query(
      `SELECT source, channel_id, metadata->>'server_id' AS server_id
         FROM ob_session_lanes WHERE namespace = $1 AND session_key = $2`,
      [NAMESPACE, partialKey],
    );
    expect(row.rows[0].source).toBe(SCOPE.platform);
    expect(row.rows[0].channel_id).toBe(SCOPE.channel_id);
    expect(row.rows[0].server_id).toBe(SCOPE.server_id);
  });
});
