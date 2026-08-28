/**
 * Live Postgres coverage for lane_upsert.
 *
 * The mock harness in the sibling unit files cannot catch Postgres parameter
 * type inference or the real NOT NULL / ended_at behavior. These tests run the
 * ACTUAL query through a real pool, and demand the test database rather than
 * skipping themselves when it is absent.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { Pool } from "pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { requireTestDatabaseUrl } from "../../../scripts/test-support/require-test-database.ts";
import { registerLaneUpsert } from "../lane-upsert.ts";
import { createMockEmbed } from "./test-helpers.ts";
import { firstText } from "./lane-upsert-test-helpers.ts";
import type { ToolDeps } from "../index.ts";

type TransportSend = InMemoryTransport["send"];
type SendMessage = Parameters<TransportSend>[0];
type SendOptions = Parameters<TransportSend>[1];

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const ns = "test-lane-upsert-live";

async function callLaneUpsert(args: Record<string, unknown>) {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = { pool, embedFn: createMockEmbed(null) };
  registerLaneUpsert(server, deps);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const original = ct.send.bind(ct);
  ct.send = (m: SendMessage, o?: SendOptions) =>
    original(m, {
      ...o,
      authInfo: {
        role: "admin",
        clientId: ns,
      } as unknown as NonNullable<SendOptions>["authInfo"],
    });
  const client = new Client({ name: "tc", version: "1.0.0" });
  await server.connect(st);
  await client.connect(ct);
  const res = await client.callTool({ name: "lane_upsert", arguments: args });
  await client.close();
  await server.close();
  return res;
}

async function cleanupNs() {
  await pool.query("DELETE FROM ob_session_lanes WHERE namespace = $1", [ns]);
}

afterAll(async () => {
  await pool.end();
});

describe("lane_upsert (live Postgres)", () => {
  it("creates a new lane with status omitted (no $3 type-inference error, NOT NULL satisfied)", async () => {
    await cleanupNs();
    try {
      const res = await callLaneUpsert({ session_key: "live-new", namespace: ns });
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(firstText(res));
      expect(parsed.is_new).toBe(true);
      expect(parsed.status).toBe("active");
    } finally {
      await cleanupNs();
    }
  });

  it("preserves status and ended_at on a status-omitted update of a wrapped lane", async () => {
    await cleanupNs();
    try {
      await callLaneUpsert({ session_key: "live-wrap", namespace: ns });
      await callLaneUpsert({
        session_key: "live-wrap",
        namespace: ns,
        status: "wrapped",
      });
      const { rows: afterWrap } = await pool.query(
        "SELECT status, ended_at FROM ob_session_lanes WHERE namespace=$1 AND session_key=$2",
        [ns, "live-wrap"],
      );
      expect(afterWrap[0].status).toBe("wrapped");
      expect(afterWrap[0].ended_at).not.toBeNull();

      // status omitted: must NOT reactivate the lane
      const res = await callLaneUpsert({
        session_key: "live-wrap",
        namespace: ns,
        topic: "touch",
      });
      expect(res.isError).toBeFalsy();
      const { rows: afterTouch } = await pool.query(
        "SELECT status, ended_at FROM ob_session_lanes WHERE namespace=$1 AND session_key=$2",
        [ns, "live-wrap"],
      );
      expect(afterTouch[0].status).toBe("wrapped");
      expect(afterTouch[0].ended_at).not.toBeNull();
    } finally {
      await cleanupNs();
    }
  });
});
