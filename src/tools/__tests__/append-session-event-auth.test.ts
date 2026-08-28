/**
 * Auth and lane-lookup coverage for `append_session_event`, split out of
 * append-session-event.test.ts so each half stays a readable size.
 */
import { describe, it, expect } from "bun:test";
import type { Pool } from "pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAppendSessionEvent } from "../append-session-event.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";
import { createMockEmbed, getErrorText, parseToolResult } from "./test-helpers.ts";
import {
  setupToolClient,
  createLaneFoundPool,
  createLaneNotFoundPool,
} from "./append-session-event-test-helpers.ts";

async function deniesWriteWithoutAuth() {
  const mockPool = createLaneFoundPool();
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = {
    pool: mockPool as unknown as Pool,
    embedFn: createMockEmbed(),
  };
  registerAppendSessionEvent(server, deps);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "test",
        event_type: "fact",
        content: "test content",
      },
    });
    expect(result.isError).toBe(true);
    expect(getErrorText(result)).toContain("Permission denied");
  } finally {
    await client.close();
    await server.close();
  }
}

async function deniesWriteForDiscordRole() {
  const mockPool = createLaneFoundPool();
  const auth: AuthInfo = { role: "discord", clientId: "random-user" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "test",
        event_type: "fact",
        content: "test content",
      },
    });
    expect(result.isError).toBe(true);
    expect(getErrorText(result)).toContain("Permission denied");
  } finally {
    await cleanup();
  }
}

async function deniesWriteForReadonlyRole() {
  const mockPool = createLaneFoundPool();
  const auth: AuthInfo = { role: "readonly", clientId: "viewer" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "test",
        event_type: "fact",
        content: "test content",
      },
    });
    expect(result.isError).toBe(true);
    expect(getErrorText(result)).toContain("Permission denied");
  } finally {
    await cleanup();
  }
}

async function adminAppendsEventFullOutput() {
  const mockPool = createLaneFoundPool(
    "lane-uuid-1",
    "event-uuid-1",
    "2026-06-08T10:00:00Z",
  );
  const auth: AuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "ob-v2-dev",
        namespace: "team-kb",
        event_type: "decision",
        content: "Decided to use append-only event journal",
        source: "skippy",
        artifact_path: "/src/tools/append-session-event.ts",
        importance: "hot",
        metadata: { pr: 42 },
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = parseToolResult(result);
    expect(parsed.event_id).toBe("event-uuid-1");
    expect(parsed.lane_id).toBe("lane-uuid-1");
    expect(parsed.event_type).toBe("decision");
    expect(parsed.importance).toBe("hot");
    expect(parsed.created_at).toBe("2026-06-08T10:00:00Z");
  } finally {
    await cleanup();
  }
}

async function allowsAgentRole() {
  const mockPool = createLaneFoundPool();
  const auth: AuthInfo = { role: "agent", clientId: "bilby" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "test",
        event_type: "fact",
        content: "Agent recorded a fact",
      },
    });
    expect(result.isError).toBeFalsy();
  } finally {
    await cleanup();
  }
}

async function allowsObAdminRole() {
  const mockPool = createLaneFoundPool();
  const auth: AuthInfo = { role: "ob-admin", clientId: "ob-admin-worker" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "test",
        event_type: "receipt",
        content: "Workflow completed",
      },
    });
    expect(result.isError).toBeFalsy();
  } finally {
    await cleanup();
  }
}

async function errorsWhenLaneNotFound() {
  const mockPool = createLaneNotFoundPool();
  const auth: AuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "nonexistent",
        event_type: "fact",
        content: "This lane does not exist",
      },
    });
    expect(result.isError).toBe(true);
    expect(getErrorText(result)).toContain("Lane not found");
    expect(getErrorText(result)).toContain("nonexistent");
  } finally {
    await cleanup();
  }
}

describe("append_session_event auth and lookup", () => {
  it("denies write when auth is missing entirely", deniesWriteWithoutAuth);
  it("denies write for discord role", deniesWriteForDiscordRole);
  it("denies write for readonly role", deniesWriteForReadonlyRole);
  it("admin can append event — full output fields", adminAppendsEventFullOutput);
  it("allows agent role", allowsAgentRole);
  it("allows ob-admin role", allowsObAdminRole);
  it("returns error when lane not found", errorsWhenLaneNotFound);
});
