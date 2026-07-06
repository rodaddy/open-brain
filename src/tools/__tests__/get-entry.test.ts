import { afterAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { registerGetEntry } from "../get-entry.ts";
import type { AuthInfo } from "../../types.ts";
import {
  createMockEmbed,
  getErrorText,
  parseToolResult,
  setupMcpClient,
} from "./test-helpers.ts";

describe("get_entry", () => {
  it("filters scoped callers to readable namespaces", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const mockPool = {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        return { rows: [{ id: params?.[0], namespace: "bilby", content: "ok" }] };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupMcpClient(
      registerGetEntry,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "get_entry",
        arguments: {
          table: "thoughts",
          id: "550e8400-e29b-41d4-a716-446655440000",
        },
      });

      expect(result.isError).toBeFalsy();
      expect(parseToolResult(result).namespace).toBe("bilby");
      expect(queries[0]?.sql).toContain("namespace = ANY($2::text[])");
      expect(queries[0]?.params).toEqual([
        "550e8400-e29b-41d4-a716-446655440000",
        ["bilby", "shared-kb"],
      ]);
    } finally {
      await cleanup();
    }
  });

  it("redacts source refs from full reads unless source scope is supplied", async () => {
    const mockPool = {
      query: async () => ({
        rows: [
          {
            id: "550e8400-e29b-41d4-a716-446655440020",
            namespace: "bilby",
            content: "privileged summary",
            source_refs: [
              {
                document_id: "doc-1",
                client_id: "acme",
                matter_id: "lit-1",
                path: "matters/acme/strategy.pdf",
              },
            ],
          },
        ],
      }),
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupMcpClient(
      registerGetEntry,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "get_entry",
        arguments: {
          table: "thoughts",
          id: "550e8400-e29b-41d4-a716-446655440020",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = parseToolResult(result);
      expect(parsed.content).toBe("privileged summary");
      expect(parsed.source_refs).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("requires matching source scope before returning source refs", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const sourceRefs = [
      {
        document_id: "doc-1",
        client_id: "acme",
        matter_id: "lit-1",
        path: "matters/acme/strategy.pdf",
      },
      {
        document_id: "doc-2",
        client_id: "acme",
        matter_id: "lit-2",
        path: "matters/acme/other.pdf",
      },
    ];
    const mockPool = {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        return {
          rows: [
            {
              id: params?.[0],
              namespace: "bilby",
              content: "scoped summary",
              source_refs: sourceRefs,
            },
          ],
        };
      },
    };
    const auth: AuthInfo = {
      role: "admin",
      clientId: "admin",
      namespaceSource: "token",
    };
    const { client, cleanup } = await setupMcpClient(
      registerGetEntry,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "get_entry",
        arguments: {
          table: "thoughts",
          id: "550e8400-e29b-41d4-a716-446655440021",
          source_scope: {
            client_id: "acme",
            matter_id: "lit-1",
            document_id: "doc-1",
          },
        },
      });

      expect(result.isError).toBeFalsy();
      expect(parseToolResult(result).source_refs).toEqual([
        { ...sourceRefs[0], source_type: "file" },
      ]);
      expect(queries[0]?.sql).toContain(
        "COALESCE(t.source_refs, '[]'::jsonb)",
      );
      expect(queries[0]?.params).toEqual([
        "550e8400-e29b-41d4-a716-446655440021",
        JSON.stringify({
          client_id: "acme",
          matter_id: "lit-1",
          document_id: "doc-1",
        }),
      ]);
    } finally {
      await cleanup();
    }
  });

  it("denies source scope for non-admin callers before querying", async () => {
    let queried = false;
    const mockPool = {
      query: async () => {
        queried = true;
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupMcpClient(
      registerGetEntry,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "get_entry",
        arguments: {
          table: "thoughts",
          id: "550e8400-e29b-41d4-a716-446655440021",
          source_scope: { client_id: "acme" },
        },
      });

      expect(result.isError).toBe(true);
      expect(getErrorText(result)).toContain("source_scope requires");
      expect(queried).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("returns not found when scoped namespace filter excludes the row", async () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const auth: AuthInfo = {
      role: "admin",
      clientId: "bilby",
      tokenClientId: "admin",
      namespaceSource: "header",
    };
    const { client, cleanup } = await setupMcpClient(
      registerGetEntry,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "get_entry",
        arguments: {
          table: "thoughts",
          id: "550e8400-e29b-41d4-a716-446655440001",
        },
      });

      expect(result.isError).toBe(true);
      expect(getErrorText(result)).toContain("Entry not found");
    } finally {
      await cleanup();
    }
  });

  it("denies compact render before querying when the role cannot read the table", async () => {
    let queried = false;
    const mockPool = {
      query: async () => {
        queried = true;
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "discord", clientId: "discord" };
    const { client, cleanup } = await setupMcpClient(
      registerGetEntry,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "get_entry",
        arguments: {
          table: "thoughts",
          id: "550e8400-e29b-41d4-a716-446655440012",
          render: "compact",
        },
      });

      expect(result.isError).toBe(true);
      expect(getErrorText(result)).toContain("Permission denied");
      expect(queried).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("returns not found for compact render when scoped namespace filter excludes the row", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const mockPool = {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupMcpClient(
      registerGetEntry,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "get_entry",
        arguments: {
          table: "thoughts",
          id: "550e8400-e29b-41d4-a716-446655440013",
          render: "compact",
        },
      });

      expect(result.isError).toBe(true);
      expect(getErrorText(result)).toContain("Entry not found");
      expect(queries[0]?.sql).toContain("namespace = ANY($2::text[])");
      expect(queries[0]?.params).toEqual([
        "550e8400-e29b-41d4-a716-446655440013",
        ["bilby", "shared-kb"],
        500,
      ]);
    } finally {
      await cleanup();
    }
  });

  it("returns a bounded compact envelope without emitting the full row", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const mockPool = {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        return {
          rows: [
            {
              id: params?.[0],
              namespace: "bilby",
              created_by: "codex",
              created_at: "2026-07-06T00:00:00.000Z",
              updated_at: "2026-07-06T00:01:00.000Z",
              tier: "warm",
              tags: ["large"],
              content_preview: "Large entry preview",
              content_length: "1200",
              content_truncated: true,
            },
          ],
        };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupMcpClient(
      registerGetEntry,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "get_entry",
        arguments: {
          table: "thoughts",
          id: "550e8400-e29b-41d4-a716-446655440010",
          render: "compact",
          max_chars: 120,
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = parseToolResult(result);
      expect(parsed).toMatchObject({
        id: "550e8400-e29b-41d4-a716-446655440010",
        table: "thoughts",
        source_type: "thought",
        namespace: "bilby",
        render: "compact",
        max_chars: 120,
        content_preview: "Large entry preview",
        content_length: 1200,
        content_truncated: true,
        full_available: true,
      });
      expect(parsed.content).toBeUndefined();
      expect(parsed.source_ref).toMatchObject({
        source: "brain",
        type: "thought",
        id: "550e8400-e29b-41d4-a716-446655440010",
        namespace: "bilby",
      });
      expect(parsed.fetch_path).toEqual({
        tool: "get_entry",
        arguments: {
          table: "thoughts",
          id: "550e8400-e29b-41d4-a716-446655440010",
          render: "full",
        },
      });
      expect(queries[0]?.sql).toContain("LEFT(");
      expect(queries[0]?.sql).toContain("content_preview");
      expect(queries[0]?.sql).toContain("entry.content_text");
      expect(queries[0]?.sql).toContain("namespace = ANY($2::text[])");
      expect(queries[0]?.params).toEqual([
        "550e8400-e29b-41d4-a716-446655440010",
        ["bilby", "shared-kb"],
        120,
      ]);
    } finally {
      await cleanup();
    }
  });

  it("builds session compact content from the full summary, not the clipped search preview", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const mockPool = {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        return {
          rows: [
            {
              id: params?.[0],
              namespace: "bilby",
              created_by: "codex",
              created_at: "2026-07-06T00:00:00.000Z",
              updated_at: "2026-07-06T00:01:00.000Z",
              tier: "warm",
              tags: [],
              content_preview: "session preview",
              content_length: "450",
              content_truncated: true,
            },
          ],
        };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupMcpClient(
      registerGetEntry,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "get_entry",
        arguments: {
          table: "sessions",
          id: "550e8400-e29b-41d4-a716-446655440011",
          render: "compact",
          max_chars: 120,
        },
      });

      expect(result.isError).toBeFalsy();
      expect(parseToolResult(result).content_truncated).toBe(true);
      expect(queries[0]?.sql).toContain("COALESCE(s.summary, '')");
      expect(queries[0]?.sql).not.toContain("LEFT(s.summary, 300)");
      expect(queries[0]?.sql).toContain("length(entry.content_text)");
    } finally {
      await cleanup();
    }
  });
});

// Gated on OPENBRAIN_TEST_DATABASE_URL. CI's db-integration job sets this and
// catches real Postgres SQL failures that mock-pool tests cannot execute.
const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;

dbDescribe("get_entry compact render (live Postgres)", () => {
  const pool = new Pool({ connectionString: DB_URL });
  const ns = "test-get-entry-compact";
  const sessionId = "550e8400-e29b-41d4-a716-446655440099";

  async function cleanupNs() {
    await pool.query("DELETE FROM sessions WHERE namespace = $1", [ns]);
  }

  afterAll(async () => {
    await cleanupNs();
    await pool.end();
  });

  it("reports session length and truncation from the full readable content", async () => {
    await cleanupNs();
    const longSummary = "x".repeat(450);
    await pool.query(
      `INSERT INTO sessions (id, namespace, project, summary, created_by, tags)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sessionId, ns, "proj", longSummary, "codex", ["compact"]],
    );

    const { client, cleanup } = await setupMcpClient(
      registerGetEntry,
      pool as any,
      createMockEmbed(),
      { role: "agent", clientId: ns },
    );

    try {
      const result = await client.callTool({
        name: "get_entry",
        arguments: {
          table: "sessions",
          id: sessionId,
          render: "compact",
          max_chars: 80,
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = parseToolResult(result);
      expect(parsed.content_preview).toBe(`proj: ${"x".repeat(74)}`);
      expect(parsed.content_length).toBe(456);
      expect(parsed.content_truncated).toBe(true);
      expect(parsed.content_preview).toHaveLength(80);
    } finally {
      await cleanup();
      await cleanupNs();
    }
  });
});
