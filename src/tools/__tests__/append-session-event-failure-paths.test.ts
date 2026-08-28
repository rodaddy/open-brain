/**
 * Failure and rollback paths for `append_session_event`, split out of
 * append-session-event.test.ts so each half stays a readable size.
 */
import { describe, it, expect } from "bun:test";
import type { AuthInfo } from "../../types.ts";
import { createMockEmbed, parseToolResult, type MockPool } from "./test-helpers.ts";
import { setupToolClient } from "./append-session-event-test-helpers.ts";

async function returnsRetryableOutageWhenDatabaseFailsBeforeAppend() {
  const mockPool = {
    query: async () => {
      throw new Error("connection timeout");
    },
  };
  const auth: AuthInfo = { role: "agent", clientId: "nagatha" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "discord:guild-1:channel-1:nagatha",
        create_if_missing: true,
        event_type: "fact",
        content: "This should be spooled by Hermes.",
      },
    });

    expect(result.isError).toBe(true);
    const parsed = parseToolResult(result);
    expect(parsed.error).toBe("retryable_outage");
    expect(parsed.retryable).toBe(true);
    expect(parsed.message).toContain("connection timeout");
  } finally {
    await cleanup();
  }
}

async function rollsBackFirstWriteLaneWhenEventInsertFails() {
  const calls: string[] = [];
  let released = false;
  const client = {
    query: async (sql: string, _params?: unknown[]) => {
      calls.push(sql);
      if (sql === "BEGIN" || sql === "ROLLBACK" || sql === "COMMIT") {
        return { rows: [] };
      }
      if (sql.includes("FROM ob_session_lanes")) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO ob_session_lanes")) {
        return {
          rows: [
            {
              id: "lane-uuid-new",
              status: "active",
              agent: "nagatha",
              source: "discord",
              channel_id: "channel-1",
              thread_id: null,
              metadata: { server_id: "guild-1" },
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO ob_session_events")) {
        throw new Error("event insert failed");
      }
      return { rows: [] };
    },
    release: () => {
      released = true;
    },
  };
  const mockPool = {
    connect: async () => client,
    query: async () => {
      throw new Error("pool.query should not be used inside transaction");
    },
  };
  const auth: AuthInfo = { role: "agent", clientId: "nagatha" };
  const { client: toolClient, cleanup } = await setupToolClient(
    mockPool as unknown as MockPool,
    auth,
    async (text) => {
      calls.push(`embed:${text}`);
      return null;
    },
  );

  try {
    const result = await toolClient.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "discord:guild-1:channel-1:nagatha",
        create_if_missing: true,
        agent: "nagatha",
        platform: "discord",
        server_id: "guild-1",
        channel_id: "channel-1",
        topic: "Nagatha Discord scoped memory",
        event_type: "fact",
        content: "This event insert fails.",
      },
    });

    expect(result.isError).toBe(true);
    const parsed = parseToolResult(result);
    expect(parsed.error).toBe("retryable_outage");
    expect(parsed.retryable).toBe(true);
    expect(parsed.message).toContain("event insert failed");
    expect(calls).toContain("BEGIN");
    expect(calls).toContain("ROLLBACK");
    expect(calls).not.toContain("COMMIT");
    expect(calls).not.toContain("embed:Nagatha Discord scoped memory");
    expect(calls).not.toContain("embed:This event insert fails.");
    expect(released).toBe(true);
  } finally {
    await cleanup();
  }
}

async function preservesOriginalAppendErrorWhenRollbackFails() {
  const client = {
    query: async (sql: string, _params?: unknown[]) => {
      if (sql === "BEGIN") return { rows: [] };
      if (sql === "ROLLBACK") throw new Error("rollback connection reset");
      if (sql.includes("FROM ob_session_lanes")) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO ob_session_lanes")) {
        return {
          rows: [
            {
              id: "lane-uuid-new",
              status: "active",
              agent: "nagatha",
              source: "discord",
              channel_id: "channel-1",
              thread_id: null,
              metadata: { server_id: "guild-1" },
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO ob_session_events")) {
        throw new Error("event insert failed");
      }
      return { rows: [] };
    },
    release: () => {},
  };
  const mockPool = {
    connect: async () => client,
    query: async () => {
      throw new Error("pool.query should not be used inside transaction");
    },
  };
  const auth: AuthInfo = { role: "agent", clientId: "nagatha" };
  const { client: toolClient, cleanup } = await setupToolClient(
    mockPool as unknown as MockPool,
    auth,
    createMockEmbed(null),
  );

  try {
    const result = await toolClient.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "discord:guild-1:channel-1:nagatha",
        create_if_missing: true,
        agent: "nagatha",
        platform: "discord",
        server_id: "guild-1",
        channel_id: "channel-1",
        event_type: "fact",
        content: "This event insert fails before rollback also fails.",
      },
    });

    expect(result.isError).toBe(true);
    const parsed = parseToolResult(result);
    expect(parsed.error).toBe("retryable_outage");
    expect(parsed.message).toContain("event insert failed");
    expect(parsed.message).not.toContain("rollback connection reset");
  } finally {
    await cleanup();
  }
}

async function failsLoudWithoutTransactionalPool() {
  const mockPool = {
    query: async () => ({ rows: [] }),
  };
  const auth: AuthInfo = { role: "agent", clientId: "nagatha" };
  const { client, cleanup } = await setupToolClient(
    mockPool,
    auth,
    createMockEmbed(null),
    false,
  );

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "discord:guild-1:channel-1:nagatha",
        create_if_missing: true,
        agent: "nagatha",
        platform: "discord",
        server_id: "guild-1",
        channel_id: "channel-1",
        event_type: "fact",
        content: "This should not run non-atomically.",
      },
    });

    expect(result.isError).toBe(true);
    const parsed = parseToolResult(result);
    expect(parsed.error).toBe("retryable_outage");
    expect(parsed.message).toContain("requires a transactional pg Pool");
  } finally {
    await cleanup();
  }
}

describe("append_session_event failure and rollback paths", () => {
  it(
    "returns retryable_outage when the database fails before append",
    returnsRetryableOutageWhenDatabaseFailsBeforeAppend,
  );
  it(
    "rolls back a first-write lane when event insert fails after lane creation",
    rollsBackFirstWriteLaneWhenEventInsertFails,
  );
  it(
    "preserves the original append error when rollback also fails",
    preservesOriginalAppendErrorWhenRollbackFails,
  );
  it(
    "fails loud when create_if_missing cannot get a transactional pool",
    failsLoudWithoutTransactionalPool,
  );
});
