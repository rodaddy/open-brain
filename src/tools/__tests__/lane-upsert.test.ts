import { describe, it, expect } from "bun:test";
import { Pool } from "pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerLaneUpsert } from "../lane-upsert.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

function createMockEmbed(result: number[] | null = Array(768).fill(0.1)) {
  return async (_text: string) => result;
}

function createThrowingEmbed(error: Error) {
  return async (_text: string): Promise<number[] | null> => {
    throw error;
  };
}

async function setupToolClient(
  mockPool: { query: (...args: any[]) => Promise<{ rows: any[] }> },
  auth: AuthInfo,
  embedFn?: (text: string) => Promise<number[] | null>,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = {
    pool: mockPool as any,
    embedFn: embedFn ?? createMockEmbed(),
  };
  registerLaneUpsert(server, deps);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message: any, options?: any) => {
    return originalSend(message, { ...options, authInfo: auth });
  };

  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("lane_upsert", () => {
  // ── AUTH PATHS ──

  it("denies write when auth is missing entirely", async () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const deps: ToolDeps = {
      pool: mockPool as any,
      embedFn: createMockEmbed(),
    };
    registerLaneUpsert(server, deps);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
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
      expect((result.content as any)[0].text).toContain("Permission denied");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("denies write for discord role (write-thoughts-only)", async () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const auth: AuthInfo = { role: "discord", clientId: "random-user" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: { session_key: "test-lane" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("Permission denied");
    } finally {
      await cleanup();
    }
  });

  it("denies write for readonly role", async () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const auth: AuthInfo = { role: "readonly", clientId: "viewer" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: { session_key: "test-lane" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("Permission denied");
    } finally {
      await cleanup();
    }
  });

  it("allows admin role", async () => {
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
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
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
  });

  it("allows agent role", async () => {
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
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
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
  });

  it("allows n8n role", async () => {
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
    const auth: AuthInfo = { role: "n8n", clientId: "n8n-worker" };
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
  });

  // ── CREATE vs UPDATE ──

  it("creates a new lane — is_new=true, full field propagation", async () => {
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
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: {
          session_key: "ob-v2-session-lanes",
          namespace: "collab",
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
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.id).toBe("uuid-new");
      expect(parsed.session_key).toBe("ob-v2-session-lanes");
      expect(parsed.namespace).toBe("collab");
      expect(parsed.is_new).toBe(true);
      expect(parsed.status).toBe("active");
      expect(parsed.embedded).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("updates an existing lane — is_new=false on conflict", async () => {
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
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
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
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.is_new).toBe(false);
      expect(parsed.embedded).toBe(true);
    } finally {
      await cleanup();
    }
  });

  // ── NAMESPACE DEFAULTING ──

  it("defaults namespace to auth.clientId when not provided", async () => {
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
    const auth: AuthInfo = { role: "admin", clientId: "bilby-agent" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: { session_key: "my-lane" },
      });

      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.namespace).toBe("bilby-agent");
    } finally {
      await cleanup();
    }
  });

  it("uses explicit namespace when provided", async () => {
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
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: { session_key: "shared-lane", namespace: "collab" },
      });

      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.namespace).toBe("collab");
    } finally {
      await cleanup();
    }
  });

  // ── STATUS TRANSITIONS ──

  it("wraps a lane — status=wrapped", async () => {
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
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: { session_key: "done-lane", status: "wrapped" },
      });

      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.status).toBe("wrapped");
    } finally {
      await cleanup();
    }
  });

  it("archives a lane — status=archived", async () => {
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
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: { session_key: "old-lane", status: "archived" },
      });

      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.status).toBe("archived");
    } finally {
      await cleanup();
    }
  });

  // ── EMBEDDING PATHS ──

  it("skips embedding when no context or topic provided", async () => {
    const mockPool = {
      query: async () => ({
        rows: [
          {
            id: "uuid-noembed",
            is_new: true,
            status: "active",
            updated_at: "2026-06-07T15:30:00Z",
          },
        ],
      }),
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: { session_key: "bare-lane" },
      });

      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.embedded).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("embeds from topic when current_context_md is absent", async () => {
    let embedCalled = false;
    const embedFn = async (text: string) => {
      embedCalled = true;
      expect(text).toContain("my topic");
      return Array(768).fill(0.1);
    };
    const mockPool = {
      query: async () => ({
        rows: [
          {
            id: "uuid-topic",
            is_new: true,
            status: "active",
            updated_at: "2026-06-07T15:30:00Z",
          },
        ],
      }),
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth, embedFn);

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: { session_key: "topic-lane", topic: "my topic" },
      });

      expect(embedCalled).toBe(true);
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.embedded).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("returns null embedding when embedFn returns null (graceful degradation)", async () => {
    const mockPool = {
      query: async () => ({
        rows: [
          {
            id: "uuid-nullembed",
            is_new: true,
            status: "active",
            updated_at: "2026-06-07T15:30:00Z",
          },
        ],
      }),
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(
      mockPool,
      auth,
      createMockEmbed(null),
    );

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: {
          session_key: "null-embed-lane",
          current_context_md: "some context",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.embedded).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("continues without embedding when embedFn throws (error resilience)", async () => {
    const mockPool = {
      query: async () => ({
        rows: [
          {
            id: "uuid-embedfail",
            is_new: true,
            status: "active",
            updated_at: "2026-06-07T15:30:00Z",
          },
        ],
      }),
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(
      mockPool,
      auth,
      createThrowingEmbed(new Error("embedding provider timeout")),
    );

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: {
          session_key: "embed-crash-lane",
          current_context_md: "context that triggers embed failure",
        },
      });

      // Should succeed with embedded=false, NOT crash
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.embedded).toBe(false);
    } finally {
      await cleanup();
    }
  });

  // ── DATABASE ERROR PATH ──

  it("returns isError=true with message when DB query throws", async () => {
    const mockPool = {
      query: async () => {
        throw new Error("connection refused");
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: { session_key: "db-fail-lane" },
      });

      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("connection refused");
      expect((result.content as any)[0].text).toContain("Database error");
    } finally {
      await cleanup();
    }
  });

  // ── METADATA HANDLING ──

  it("succeeds with default metadata when not provided", async () => {
    const mockPool = {
      query: async () => ({
        rows: [
          {
            id: "uuid-nometa",
            is_new: true,
            status: "active",
            updated_at: "2026-06-07T15:30:00Z",
          },
        ],
      }),
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: { session_key: "no-meta-lane" },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.id).toBe("uuid-nometa");
    } finally {
      await cleanup();
    }
  });

  // ── EXPLICIT FIELD CLEARING ──

  it("succeeds when agent is empty string (explicit clear)", async () => {
    const mockPool = {
      query: async () => ({
        rows: [
          {
            id: "uuid-clear",
            is_new: false,
            status: "active",
            updated_at: "2026-06-07T15:30:00Z",
          },
        ],
      }),
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: { session_key: "clear-test", agent: "" },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.id).toBe("uuid-clear");
      expect(parsed.status).toBe("active");
    } finally {
      await cleanup();
    }
  });

  // ── STATUS PRESERVATION ──

  it("preserves existing status when status param is omitted", async () => {
    const mockPool = {
      query: async () => ({
        rows: [
          {
            id: "uuid-preserve",
            is_new: false,
            status: "wrapped",
            updated_at: "2026-06-07T15:30:00Z",
          },
        ],
      }),
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: { session_key: "status-preserve", topic: "updated topic" },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      // DB returned "wrapped" proving status was preserved (not overwritten to "active")
      expect(parsed.status).toBe("wrapped");
    } finally {
      await cleanup();
    }
  });

  it("inserts status 'active' for a new lane when status is omitted (NOT NULL regression)", async () => {
    // Regression for lane_upsert_db_error: omitting status previously bound an
    // explicit NULL into the NOT NULL status column, so creating a NEW lane
    // failed the constraint. The INSERT value must default to 'active' while
    // the ON CONFLICT path keeps a nullable status to preserve existing rows.
    let capturedSql = "";
    let capturedParams: any[] = [];
    const mockPool = {
      query: async (sql: string, params: any[]) => {
        capturedSql = sql;
        capturedParams = params;
        return {
          rows: [
            {
              id: "uuid-new",
              is_new: true,
              status: "active",
              updated_at: "2026-06-07T15:30:00Z",
            },
          ],
        };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "bilby" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: { session_key: "new-lane-no-status" },
      });

      expect(result.isError).toBeFalsy();
      // $3 (ON CONFLICT / status-preserve source) stays NULL on omission.
      expect(capturedParams[2]).toBeNull();
      // $24 (INSERT VALUES status) defaults to 'active' so the NOT NULL
      // column is satisfied for brand-new lanes.
      expect(capturedParams[23]).toBe("active");
      // ended_at must key off $3 (nullable), NOT EXCLUDED.status, otherwise a
      // status-omitted update would reactivate a wrapped/archived lane. The
      // ended_at clause is the segment after the embedding_model update line.
      const endedAtClause = capturedSql.slice(capturedSql.indexOf("ended_at ="));
      // $3 is cast to ::text so Postgres can infer the param type (it is no
      // longer bound into a typed column position).
      expect(endedAtClause).toContain("$3::text = 'active'");
      expect(endedAtClause).not.toContain("EXCLUDED.status");
    } finally {
      await cleanup();
    }
  });

  // ── MINIMAL CALL ──

  it("succeeds with only the required session_key", async () => {
    const mockPool = {
      query: async () => ({
        rows: [
          {
            id: "uuid-min",
            is_new: true,
            status: "active",
            updated_at: "2026-06-07T15:30:00Z",
          },
        ],
      }),
    };
    const auth: AuthInfo = { role: "admin", clientId: "skippy" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "lane_upsert",
        arguments: { session_key: "minimal" },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.session_key).toBe("minimal");
      expect(parsed.namespace).toBe("skippy");
      expect(parsed.is_new).toBe(true);
      expect(parsed.embedded).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

// ── DB-BACKED INTEGRATION ──
// The mock harness above cannot catch Postgres parameter-type inference or the
// real NOT NULL / ended_at behavior. These tests run the ACTUAL query through a
// real pool and are gated on OPENBRAIN_TEST_DATABASE_URL so the default suite
// stays infra-free. Run with:
//   OPENBRAIN_TEST_DATABASE_URL=postgres://... bun test src/tools/__tests__/lane-upsert.test.ts
const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;

dbDescribe("lane_upsert (live Postgres)", () => {
  const pool = new Pool({ connectionString: DB_URL });
  const ns = "test-lane-upsert-live";

  async function callLaneUpsert(args: Record<string, unknown>) {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const deps: ToolDeps = { pool: pool as any, embedFn: createMockEmbed(null) };
    registerLaneUpsert(server, deps);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const original = ct.send.bind(ct);
    ct.send = (m: any, o?: any) =>
      original(m, { ...o, authInfo: { role: "admin", clientId: ns } });
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

  it("creates a new lane with status omitted (no $3 type-inference error, NOT NULL satisfied)", async () => {
    await cleanupNs();
    try {
      const res = await callLaneUpsert({ session_key: "live-new", namespace: ns });
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse((res.content as any)[0].text);
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
      await pool.end();
    }
  });
});
