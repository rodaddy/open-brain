/**
 * Live-Postgres lifecycle test for the exact-scope checkpoint path.
 *
 * `session_start` and `session_wrap` materialize a lane row and rewrite its
 * `current_context_md`; `agent_context_pack` reads it back. None of that is
 * observable without a real database -- the lane row, its metadata, and the
 * scope predicate that rejects a hostile claim all live in Postgres.
 *
 * REQUIRES `OPENBRAIN_TEST_DATABASE_URL`, and fails hard without it (operator
 * ruling 2026-08-27, issue #878). This file previously selected `describe.skip`
 * when the variable was unset, which reported `0 pass, 2 skip` and exited 0 --
 * indistinguishable from a passing run. It must point at an isolated
 * test/playground database, never the dogfood database; `bun run test:isolated`
 * sets it.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../../scripts/test-support/require-test-database.ts";
import { registerAgentContextPack } from "../agent-context-pack.ts";
import type { ToolDeps } from "../index.ts";
import { registerSessionStart } from "../session-start.ts";
import { registerSessionWrap } from "../session-wrap.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

const NAMESPACE = "test-session-wrap-exact-live";
const SESSION_KEY = "checkpoint-first-exact-lane";

const SCOPE = {
  session_key: SESSION_KEY,
  agent: "nagatha",
  platform: "discord",
  server_id: "guild-owner",
  channel_id: "channel-owner",
};

/** Result shape the tests read back off an MCP tool call. */
interface ToolResult {
  isError: boolean;
  text: string;
}

/**
 * Calls one tool over an in-memory MCP pair, authenticated as the namespace.
 *
 * A fresh server per call keeps each tool invocation independent, matching how
 * the real transport hands every request its own authenticated context.
 */
async function callTool(
  name: string,
  arguments_: Record<string, unknown>,
): Promise<ToolResult> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = { pool, embedFn: async () => null };
  registerSessionStart(server, deps);
  registerSessionWrap(server, deps);
  registerAgentContextPack(server, deps);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    originalSend(message, {
      ...options,
      authInfo: { role: "agent", clientId: NAMESPACE },
    } as never);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name, arguments: arguments_ });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    return { isError: result.isError === true, text };
  } finally {
    await client.close();
    await server.close();
  }
}

/** Reads the lane's durable context back through `agent_context_pack`. */
async function readLaneContext(): Promise<string> {
  const pack = await callTool("agent_context_pack", {
    ...SCOPE,
    requested_sections: ["durable_lane_context"],
  });
  expect(pack.isError).toBeFalsy();
  const payload = JSON.parse(pack.text) as {
    sections: {
      durable_lane_context: { lane: { current_context_md: string } };
    };
  };
  return payload.sections.durable_lane_context.lane.current_context_md;
}

async function cleanup(): Promise<void> {
  await pool.query("DELETE FROM sessions WHERE namespace = $1", [NAMESPACE]);
  await pool.query(
    `DELETE FROM ob_session_events WHERE lane_id IN
       (SELECT id FROM ob_session_lanes WHERE namespace = $1)`,
    [NAMESPACE],
  );
  await pool.query("DELETE FROM ob_session_lanes WHERE namespace = $1", [
    NAMESPACE,
  ]);
}

afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("exact-scope checkpoint lifecycle (live Postgres)", () => {
  it("materializes checkpoint and wrap summaries onto the lane", async () => {
    await cleanup();
    const started = await callTool("session_start", SCOPE);
    expect(started.isError).toBeFalsy();

    for (const summary of ["checkpoint summary", "wrap summary"]) {
      const wrapped = await callTool("session_wrap", { ...SCOPE, summary });
      expect(wrapped.isError).toBeFalsy();
      expect(await readLaneContext()).toBe(summary);
    }

    const { rows } = await pool.query(
      `SELECT agent, source, channel_id, thread_id,
              metadata->>'server_id' AS server_id, current_context_md
         FROM ob_session_lanes
        WHERE namespace = $1 AND session_key = $2`,
      [NAMESPACE, SESSION_KEY],
    );
    expect(rows).toEqual([
      {
        agent: SCOPE.agent,
        source: SCOPE.platform,
        channel_id: SCOPE.channel_id,
        thread_id: null,
        server_id: SCOPE.server_id,
        current_context_md: "wrap summary",
      },
    ]);
  });

  it("denies a later hostile scope claim on the same session key", async () => {
    const hostileScope = {
      ...SCOPE,
      server_id: "guild-hostile",
      thread_id: "thread-hostile",
    };
    const hostile = await callTool("session_start", hostileScope);
    expect(hostile.isError).toBe(true);

    const hostileWrap = await callTool("session_wrap", {
      ...hostileScope,
      summary: "hostile summary",
    });
    expect(hostileWrap.isError).toBe(true);

    const { rows } = await pool.query(
      "SELECT id FROM sessions WHERE namespace = $1 AND summary = $2",
      [NAMESPACE, "hostile summary"],
    );
    expect(rows).toEqual([]);
  });
});
