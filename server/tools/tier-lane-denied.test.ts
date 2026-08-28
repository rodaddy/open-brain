/**
 * The `tier_lane_denied` warn line is part of this tool's contract.
 *
 * `authorizeTierLane` (./tier-lane.ts) is a LOCAL helper rather than the shared
 * `authorize` in ./memory-helpers.ts for exactly one reason, which its own
 * comment states: the shared helper emits no denial event, so calling it would
 * drop this line. That reason is only enforceable if something reads the line.
 * Nothing did — the existing suites assert the refusal's `isError` and its
 * message, both of which survive the swap untouched.
 *
 * So these tests assert the EVENT, not the refusal: the message string
 * `tier_lane_denied` and each field the log record carries. A denial that stops
 * logging and a denial that still logs produce identical tool results, and the
 * captured record is the only thing that tells them apart.
 *
 * No database: the namespace check runs before any pool call, and the stub pool
 * here is asserted to have recorded ZERO statements — which is itself the
 * second half of the isolation claim (a refused caller never reaches the pool).
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "pino";
import type { Pool, PoolClient } from "pg";
import type { Role } from "../config.ts";
import { registerTierLaneTool } from "./tier-lane.ts";
import { DEFAULT_SHARED_NAMESPACE_NAMES } from "./shared-namespace-fixture.ts";

/** One captured `logger.warn(fields, message)` call. */
interface CapturedWarn {
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

/**
 * A `tier_lane` client whose logger and pool both record instead of acting.
 *
 * Only `registerTierLaneTool` is registered, so any captured statement or warn
 * belongs to this tool and nothing else.
 */
async function tierLaneClient(
  role: Role,
  clientId: string,
): Promise<{
  client: Client;
  warns: CapturedWarn[];
  statements: string[];
  close: () => Promise<void>;
}> {
  const warns: CapturedWarn[] = [];
  const statements: string[] = [];
  const run = async (sql: string) => {
    statements.push(sql);
    return { rows: [], rowCount: 0 };
  };
  const pool = {
    query: run,
    connect: async () =>
      ({ query: run, release: () => undefined }) as unknown as PoolClient,
  } as unknown as Pool;
  const logger = {
    warn: (fields: Record<string, unknown>, message: string) => {
      warns.push({ fields, message });
    },
    info: () => undefined,
    debug: () => undefined,
    error: () => undefined,
  } as unknown as Logger;

  const server = new McpServer({ name: "tier-lane-denied", version: "1.0.0" });
  registerTierLaneTool(server, {
    pool,
    embedFn: async () => null,
    logger,
    sharedNamespaceNames: DEFAULT_SHARED_NAMESPACE_NAMES,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    send(message, {
      ...options,
      authInfo: { role, clientId, namespaceSource: "token" },
    } as unknown as Parameters<typeof send>[1]);
  const client = new Client({
    name: "tier-lane-denied-client",
    version: "1.0.0",
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    warns,
    statements,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("tier_lane denial log", () => {
  test("a refused namespace emits tier_lane_denied with tool, role and namespace", async () => {
    const { client, warns, statements, close } = await tierLaneClient("agent", "rico");
    try {
      const result = await client.callTool({
        name: "tier_lane",
        arguments: { session_key: "lane-6", namespace: "someone-else" },
      });

      expect(result.isError).toBe(true);
      expect(warns).toHaveLength(1);
      expect(warns[0]?.message).toBe("tier_lane_denied");
      expect(warns[0]?.fields).toEqual({
        tool: "tier_lane",
        role: "agent",
        namespace: "someone-else",
      });
      // The refusal happens before any pool call, so a denied caller leaves no
      // statement behind at all.
      expect(statements).toEqual([]);
    } finally {
      await close();
    }
  });

  test("the caller's own namespace emits no tier_lane_denied warn", async () => {
    // Without this, a logger that warned on EVERY call would satisfy the test
    // above and the event would still be unpinned.
    const { client, warns, close } = await tierLaneClient("agent", "rico");
    try {
      await client.callTool({
        name: "tier_lane",
        arguments: { session_key: "lane-6", namespace: "rico" },
      });

      expect(warns.filter((warn) => warn.message === "tier_lane_denied")).toEqual([]);
    } finally {
      await close();
    }
  });
});
