/**
 * Unit coverage for lane_upsert auth paths and core create/update behavior.
 *
 * Embedding and defaulting cases live in
 * lane-upsert-embedding-and-defaults.test.ts; live Postgres coverage lives in
 * lane-upsert.pg.test.ts.
 */
import { describe, it, expect } from "bun:test";
import { Pool } from "pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerLaneUpsert } from "../lane-upsert.ts";
import { createMockEmbed } from "./test-helpers.ts";
import {
  firstText,
  setupToolClient,
  type ObAuthInfo,
} from "./lane-upsert-test-helpers.ts";
import type { ToolDeps } from "../index.ts";

async function case1() {
  const mockPool = { query: async () => ({ rows: [] }) };
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = {
    pool: mockPool as unknown as Pool,
    embedFn: createMockEmbed(),
  };
  registerLaneUpsert(server, deps);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // No authInfo injection at all
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const result = await client.callTool({
      name: "lane_upsert",
      arguments: { session_key: "test" },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("Permission denied");
  } finally {
    await client.close();
    await server.close();
  }
}

async function case2() {
  const mockPool = { query: async () => ({ rows: [] }) };
  const auth: ObAuthInfo = { role: "discord", clientId: "random-user" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "lane_upsert",
      arguments: { session_key: "test-lane" },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("Permission denied");
  } finally {
    await cleanup();
  }
}

async function case3() {
  const mockPool = { query: async () => ({ rows: [] }) };
  const auth: ObAuthInfo = { role: "readonly", clientId: "viewer" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "lane_upsert",
      arguments: { session_key: "test-lane" },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("Permission denied");
  } finally {
    await cleanup();
  }
}

async function case4() {
  const mockPool = {
    query: async () => ({
      rows: [
        {
          id: "uuid-1",
          is_new: true,
          status: "active",
          updated_at: "2026-06-07T15:30:00Z",
        },
      ],
    }),
  };
  const auth: ObAuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "lane_upsert",
      arguments: { session_key: "test" },
    });
    expect(result.isError).toBeFalsy();
  } finally {
    await cleanup();
  }
}

async function case5() {
  const mockPool = {
    query: async () => ({
      rows: [
        {
          id: "uuid-2",
          is_new: true,
          status: "active",
          updated_at: "2026-06-07T15:30:00Z",
        },
      ],
    }),
  };
  const auth: ObAuthInfo = { role: "agent", clientId: "bilby" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "lane_upsert",
      arguments: { session_key: "test" },
    });
    expect(result.isError).toBeFalsy();
  } finally {
    await cleanup();
  }
}

async function case6() {
  const mockPool = {
    query: async () => ({
      rows: [
        {
          id: "uuid-3",
          is_new: true,
          status: "active",
          updated_at: "2026-06-07T15:30:00Z",
        },
      ],
    }),
  };
  const auth: ObAuthInfo = { role: "ob-admin", clientId: "ob-admin-worker" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "lane_upsert",
      arguments: { session_key: "test" },
    });
    expect(result.isError).toBeFalsy();
  } finally {
    await cleanup();
  }
}

async function case7() {
  const mockPool = {
    query: async () => ({
      rows: [
        {
          id: "uuid-new",
          is_new: true,
          status: "active",
          updated_at: "2026-06-07T15:30:00Z",
        },
      ],
    }),
  };
  const auth: ObAuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "lane_upsert",
      arguments: {
        session_key: "ob-v2-session-lanes",
        namespace: "team-kb",
        project: "open-brain",
        agent: "skippy",
        source: "discord",
        channel_id: "123456",
        thread_id: "789",
        topic: "Building session lane schema",
        current_context_md: "## Session Lanes\nMigration 010 written.",
        metadata: { pr: 42, branch: "feat/session-lanes" },
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(firstText(result));
    expect(parsed.id).toBe("uuid-new");
    expect(parsed.session_key).toBe("ob-v2-session-lanes");
    expect(parsed.namespace).toBe("team-kb");
    expect(parsed.is_new).toBe(true);
    expect(parsed.status).toBe("active");
    expect(parsed.embedded).toBe(true);
  } finally {
    await cleanup();
  }
}

async function case8() {
  const mockPool = {
    query: async () => ({
      rows: [
        {
          id: "uuid-existing",
          is_new: false,
          status: "active",
          updated_at: "2026-06-07T16:00:00Z",
        },
      ],
    }),
  };
  const auth: ObAuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "lane_upsert",
      arguments: {
        session_key: "ob-v2-session-lanes",
        current_context_md: "## Updated context\nTests passing.",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(firstText(result));
    expect(parsed.is_new).toBe(false);
    expect(parsed.embedded).toBe(true);
  } finally {
    await cleanup();
  }
}

async function case9() {
  const mockPool = {
    query: async () => ({
      rows: [
        {
          id: "uuid-ns",
          is_new: true,
          status: "active",
          updated_at: "2026-06-07T15:30:00Z",
        },
      ],
    }),
  };
  const auth: ObAuthInfo = { role: "admin", clientId: "bilby-agent" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "lane_upsert",
      arguments: { session_key: "my-lane" },
    });

    const parsed = JSON.parse(firstText(result));
    expect(parsed.namespace).toBe("bilby-agent");
  } finally {
    await cleanup();
  }
}

async function case10() {
  const mockPool = {
    query: async () => ({
      rows: [
        {
          id: "uuid-ns2",
          is_new: true,
          status: "active",
          updated_at: "2026-06-07T15:30:00Z",
        },
      ],
    }),
  };
  const auth: ObAuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "lane_upsert",
      arguments: { session_key: "shared-lane", namespace: "team-kb" },
    });

    const parsed = JSON.parse(firstText(result));
    expect(parsed.namespace).toBe("team-kb");
  } finally {
    await cleanup();
  }
}

async function case11() {
  const mockPool = {
    query: async () => ({
      rows: [
        {
          id: "uuid-wrap",
          is_new: false,
          status: "wrapped",
          updated_at: "2026-06-07T17:00:00Z",
        },
      ],
    }),
  };
  const auth: ObAuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "lane_upsert",
      arguments: { session_key: "done-lane", status: "wrapped" },
    });

    const parsed = JSON.parse(firstText(result));
    expect(parsed.status).toBe("wrapped");
  } finally {
    await cleanup();
  }
}

async function case12() {
  const mockPool = {
    query: async () => ({
      rows: [
        {
          id: "uuid-arch",
          is_new: false,
          status: "archived",
          updated_at: "2026-06-07T18:00:00Z",
        },
      ],
    }),
  };
  const auth: ObAuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "lane_upsert",
      arguments: { session_key: "old-lane", status: "archived" },
    });

    const parsed = JSON.parse(firstText(result));
    expect(parsed.status).toBe("archived");
  } finally {
    await cleanup();
  }
}

describe("lane_upsert", () => {
  // ── AUTH PATHS ──

  it("denies write when auth is missing entirely", case1);

  it("denies write for discord role (write-thoughts-only)", case2);

  it("denies write for readonly role", case3);

  it("allows admin role", case4);

  it("allows agent role", case5);

  it("allows ob-admin role", case6);

  // ── CREATE vs UPDATE ──

  it("creates a new lane — is_new=true, full field propagation", case7);

  it("updates an existing lane — is_new=false on conflict", case8);

  // ── NAMESPACE DEFAULTING ──

  it("defaults namespace to auth.clientId when not provided", case9);

  it("uses explicit namespace when provided", case10);

  // ── STATUS TRANSITIONS ──

  it("wraps a lane — status=wrapped", case11);

  it("archives a lane — status=archived", case12);
});
