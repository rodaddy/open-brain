import { describe, expect, it } from "bun:test";
import { registerResolveEntry } from "../resolve-entry.ts";
import type { AuthInfo } from "../../types.ts";
import {
  createMockEmbed,
  parseToolResult,
  setupMcpClient,
} from "./test-helpers.ts";

const TEST_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("resolve_entry", () => {
  it("resolves a readable UUID to source type and get_entry fetch path", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const mockPool = {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes("FROM thoughts")) return { rows: [] };
        if (sql.includes("FROM decisions")) {
          return { rows: [{ id: params?.[0], namespace: "bilby" }] };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupMcpClient(
      registerResolveEntry,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "resolve_entry",
        arguments: { id: TEST_ID },
      });

      const payload = parseToolResult(result);
      expect(payload).toMatchObject({
        resolved: true,
        status: "found",
        id: TEST_ID,
        source_type: "decision",
        table: "decisions",
        namespace: "bilby",
        fetch_path: {
          tool: "get_entry",
          arguments: {
            table: "decisions",
            id: TEST_ID,
          },
        },
      });
      expect(payload.checked_tables).toEqual(["thoughts", "decisions"]);
      expect(queries[0]?.sql).toContain("namespace = ANY($2::text[])");
      expect(queries[0]?.params).toEqual([TEST_ID, ["bilby", "shared-kb"]]);
    } finally {
      await cleanup();
    }
  });

  it("mirrors promoter cross-namespace read policy", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const mockPool = {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes("FROM thoughts")) {
          return { rows: [{ id: params?.[0], namespace: "private-other" }] };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "promoter", clientId: "promoter" };
    const { client, cleanup } = await setupMcpClient(
      registerResolveEntry,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "resolve_entry",
        arguments: { id: TEST_ID },
      });

      expect(parseToolResult(result)).toMatchObject({
        resolved: true,
        status: "found",
        source_type: "thought",
        table: "thoughts",
        namespace: "private-other",
        fetch_path: {
          tool: "get_entry",
          arguments: {
            table: "thoughts",
            id: TEST_ID,
          },
        },
      });
      expect(queries[0]?.sql).not.toContain("namespace =");
      expect(queries[0]?.params).toEqual([TEST_ID]);
    } finally {
      await cleanup();
    }
  });

  it("does not disclose archived rows to non-admin callers", async () => {
    const queries: Array<string> = [];
    const mockPool = {
      query: async (sql: string) => {
        queries.push(sql);
        if (
          sql.includes("FROM thoughts") &&
          sql.includes("archived_at IS NOT NULL")
        ) {
          return { rows: [{ id: TEST_ID, namespace: "shared-kb" }] };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "readonly", clientId: "bilby" };
    const { client, cleanup } = await setupMcpClient(
      registerResolveEntry,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "resolve_entry",
        arguments: { id: TEST_ID },
      });

      expect(parseToolResult(result)).toEqual({
        resolved: false,
        status: "not_found_or_unreadable",
        id: TEST_ID,
        source_type: null,
        table: null,
        namespace: null,
        fetch_path: null,
        checked_sources: ["thought", "decision", "relationship", "project", "session"],
        checked_tables: [
          "thoughts",
          "decisions",
          "relationships",
          "projects",
          "sessions",
        ],
      });
      expect(queries.some((sql) => sql.includes("archived_at IS NULL"))).toBe(true);
      expect(queries.some((sql) => sql.includes("archived_at IS NOT NULL"))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("distinguishes archived rows only for admin-like callers", async () => {
    const queries: Array<string> = [];
    const mockPool = {
      query: async (sql: string) => {
        queries.push(sql);
        if (
          sql.includes("FROM thoughts") &&
          sql.includes("archived_at IS NOT NULL")
        ) {
          return { rows: [{ id: TEST_ID, namespace: "shared-kb" }] };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "ob-admin", clientId: "admin" };
    const { client, cleanup } = await setupMcpClient(
      registerResolveEntry,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "resolve_entry",
        arguments: { id: TEST_ID },
      });

      expect(parseToolResult(result)).toMatchObject({
        resolved: false,
        status: "archived",
        source_type: "thought",
        table: "thoughts",
        namespace: "shared-kb",
        fetch_path: null,
      });
      expect(queries.some((sql) => sql.includes("archived_at IS NULL"))).toBe(true);
      expect(queries.some((sql) => sql.includes("archived_at IS NOT NULL"))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("returns not_readable without querying when the role has no readable source families", async () => {
    const mockPool = {
      query: async () => {
        throw new Error("query should not run");
      },
    };
    const auth: AuthInfo = { role: "discord", clientId: "bilby" };
    const { client, cleanup } = await setupMcpClient(
      registerResolveEntry,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "resolve_entry",
        arguments: { id: TEST_ID },
      });

      expect(parseToolResult(result)).toEqual({
        resolved: false,
        status: "not_readable",
        id: TEST_ID,
        source_type: null,
        table: null,
        namespace: null,
        fetch_path: null,
        checked_sources: [],
        checked_tables: [],
      });
    } finally {
      await cleanup();
    }
  });

  it("does not disclose rows from an explicitly unreadable namespace", async () => {
    const mockPool = {
      query: async () => {
        throw new Error("query should not run");
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupMcpClient(
      registerResolveEntry,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "resolve_entry",
        arguments: { id: TEST_ID, namespace: "private-other" },
      });

      expect(parseToolResult(result)).toMatchObject({
        resolved: false,
        status: "not_readable",
        namespace: "private-other",
        checked_sources: [],
        checked_tables: [],
      });
    } finally {
      await cleanup();
    }
  });

  it("treats namespace=all as unrestricted only for global admin reads", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const mockPool = {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes("FROM thoughts")) return { rows: [] };
        if (sql.includes("FROM decisions")) {
          return { rows: [{ id: params?.[0], namespace: "private-other" }] };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "admin" };
    const { client, cleanup } = await setupMcpClient(
      registerResolveEntry,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "resolve_entry",
        arguments: { id: TEST_ID, namespace: "all" },
      });

      expect(parseToolResult(result)).toMatchObject({
        resolved: true,
        status: "found",
        source_type: "decision",
        table: "decisions",
        namespace: "private-other",
      });
      expect(queries[0]?.sql).not.toContain("namespace =");
      expect(queries[0]?.params).toEqual([TEST_ID]);
    } finally {
      await cleanup();
    }
  });
});
