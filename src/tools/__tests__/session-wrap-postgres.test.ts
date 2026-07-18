import { afterAll, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Pool } from "pg";
import { registerAgentContextPack } from "../agent-context-pack.ts";
import type { ToolDeps } from "../index.ts";
import { registerSessionStart } from "../session-start.ts";
import { registerSessionWrap } from "../session-wrap.ts";

function createMockEmbed(result: number[] | null = Array(768).fill(0.1)) {
  return async (_text: string) => result;
}

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;

dbDescribe("exact-scope checkpoint lifecycle (live Postgres)", () => {
  const pool = new Pool({ connectionString: DB_URL });
  const namespace = "test-session-wrap-exact-live";
  const sessionKey = "checkpoint-first-exact-lane";
  const scope = {
    session_key: sessionKey,
    agent: "nagatha",
    platform: "discord",
    server_id: "guild-owner",
    channel_id: "channel-owner",
  };

  async function callTool(name: string, arguments_: Record<string, unknown>) {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const deps: ToolDeps = {
      pool: pool as any,
      embedFn: createMockEmbed(null),
    };
    registerSessionStart(server, deps);
    registerSessionWrap(server, deps);
    registerAgentContextPack(server, deps);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const originalSend = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message: any, options?: any) =>
      originalSend(message, {
        ...options,
        authInfo: { role: "agent", clientId: namespace },
      });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      return await client.callTool({ name, arguments: arguments_ });
    } finally {
      await client.close();
      await server.close();
    }
  }

  async function cleanup(): Promise<void> {
    await pool.query("DELETE FROM sessions WHERE namespace = $1", [namespace]);
    await pool.query(
      `DELETE FROM ob_session_events WHERE lane_id IN
         (SELECT id FROM ob_session_lanes WHERE namespace = $1)`,
      [namespace],
    );
    await pool.query("DELETE FROM ob_session_lanes WHERE namespace = $1", [
      namespace,
    ]);
  }

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("materializes checkpoint/wrap summaries and denies a later hostile scope claim", async () => {
    await cleanup();
    const started = await callTool("session_start", scope);
    expect(started.isError).toBeFalsy();

    for (const summary of ["checkpoint summary", "wrap summary"]) {
      const wrapped = await callTool("session_wrap", {
        ...scope,
        summary,
      });
      expect(wrapped.isError).toBeFalsy();

      const pack = await callTool("agent_context_pack", {
        ...scope,
        requested_sections: ["durable_lane_context"],
      });
      expect(pack.isError).toBeFalsy();
      const payload = JSON.parse((pack.content as any)[0].text);
      expect(
        payload.sections.durable_lane_context.lane.current_context_md,
      ).toBe(summary);
    }

    const hostileScope = {
      ...scope,
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
      `SELECT agent, source, channel_id, thread_id, metadata->>'server_id' AS server_id,
              current_context_md
         FROM ob_session_lanes
        WHERE namespace = $1 AND session_key = $2`,
      [namespace, sessionKey],
    );
    expect(rows).toEqual([
      {
        agent: scope.agent,
        source: scope.platform,
        channel_id: scope.channel_id,
        thread_id: null,
        server_id: scope.server_id,
        current_context_md: "wrap summary",
      },
    ]);
    const { rows: hostileSessions } = await pool.query(
      "SELECT id FROM sessions WHERE namespace = $1 AND summary = $2",
      [namespace, "hostile summary"],
    );
    expect(hostileSessions).toEqual([]);
  });
});
