import { describe, expect, it } from "bun:test";
import { registerDecomposeEntry } from "../decompose-entry.ts";
import type { AuthInfo } from "../../types.ts";
import {
  createMockEmbed,
  getErrorText,
  parseToolResult,
  setupMcpClient,
} from "./test-helpers.ts";

const SOURCE_ID = "550e8400-e29b-41d4-a716-446655440247";

function longContent(): string {
  return Array.from(
    { length: 80 },
    (_, i) => `Sentence ${i} carries enough context for decomposition.`,
  ).join(" ");
}

describe("decompose_entry", () => {
  it("plans oversized replacements by default without writing", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const mockPool = {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        return {
          rows: [
            {
              id: SOURCE_ID,
              namespace: "bilby",
              content_text: longContent(),
            },
          ],
        };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupMcpClient(
      registerDecomposeEntry,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "decompose_entry",
        arguments: {
          table: "thoughts",
          id: SOURCE_ID,
          max_chunk_chars: 700,
          overlap_chars: 50,
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = parseToolResult(result);
      expect(parsed).toMatchObject({
        status: "planned",
        dry_run: true,
        oversized: true,
        source_ref: {
          source: "brain",
          table: "thoughts",
          id: SOURCE_ID,
          namespace: "bilby",
        },
        max_chunk_chars: 700,
        overlap_chars: 50,
      });
      expect(parsed.proposed_replacements.length).toBeGreaterThan(1);
      expect(parsed.would_write).toBe(parsed.proposed_replacements.length);
      expect(parsed.proposed_replacements[0].provenance).toMatchObject({
        source: "dreamengine-decomposition",
        source_table: "thoughts",
        source_id: SOURCE_ID,
        source_namespace: "bilby",
        chunk_index: 0,
      });
      expect(queries).toHaveLength(1);
      expect(queries[0]?.sql).toContain("namespace = ANY($2::text[])");
      expect(queries[0]?.params).toEqual([SOURCE_ID, ["bilby", "shared-kb"]]);
    } finally {
      await cleanup();
    }
  });

  it("rejects apply mode unless dry_run false names the mutating wrapper", async () => {
    let insertSeen = false;
    const mockPool = {
      query: async (sql: string) => {
        if (sql.includes("INSERT INTO thoughts")) insertSeen = true;
        return {
          rows: [
            {
              id: SOURCE_ID,
              namespace: "bilby",
              content_text: longContent(),
            },
          ],
        };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupMcpClient(
      registerDecomposeEntry,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "decompose_entry",
        arguments: {
          table: "thoughts",
          id: SOURCE_ID,
          dry_run: false,
        },
      });

      expect(result.isError).toBe(true);
      expect(getErrorText(result)).toContain("apply_mode=write_replacements");
      expect(insertSeen).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("writes replacement thoughts only after explicit apply approval", async () => {
    const writes: Array<{ sql: string; params?: unknown[] }> = [];
    let inserted = 0;
    const mockPool = {
      query: async (sql: string, params?: unknown[]) => {
        writes.push({ sql, params });
        if (sql.includes("INSERT INTO thoughts")) {
          inserted += 1;
          return { rows: [{ id: `new-${inserted}` }] };
        }
        return {
          rows: [
            {
              id: SOURCE_ID,
              namespace: "bilby",
              content_text: longContent(),
            },
          ],
        };
      },
      connect: async () => ({
        query: async (sql: string, params?: unknown[]) => {
          writes.push({ sql, params });
          if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
          if (sql.includes("INSERT INTO thoughts")) {
            inserted += 1;
            return { rows: [{ id: `new-${inserted}` }] };
          }
          return { rows: [] };
        },
        release: () => undefined,
      }),
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupMcpClient(
      registerDecomposeEntry,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "decompose_entry",
        arguments: {
          table: "thoughts",
          id: SOURCE_ID,
          max_chunk_chars: 700,
          overlap_chars: 50,
          dry_run: false,
          apply_mode: "write_replacements",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = parseToolResult(result);
      expect(parsed.status).toBe("applied");
      expect(parsed.dry_run).toBe(false);
      expect(parsed.written_ids.length).toBeGreaterThan(1);
      expect(parsed.skipped_duplicates).toEqual([]);
      expect(writes.map((call) => call.sql)).toContain("BEGIN");
      expect(writes.map((call) => call.sql)).toContain("COMMIT");
      const insertCalls = writes.filter((call) =>
        call.sql.includes("INSERT INTO thoughts"),
      );
      expect(insertCalls.length).toBe(parsed.written_ids.length);
      expect(insertCalls[0]?.params?.[2]).toBe("bilby");
      expect(insertCalls[0]?.params?.[3]).toBe("bilby");
      expect(insertCalls[0]?.params?.[9]).toBe(SOURCE_ID);
    } finally {
      await cleanup();
    }
  });

  it("keeps explicit apply on non-oversized entries as a no-op", async () => {
    let insertSeen = false;
    const mockPool = {
      query: async () => ({
        rows: [
          {
            id: SOURCE_ID,
            namespace: "bilby",
            content_text: "small enough",
          },
        ],
      }),
      connect: async () => ({
        query: async (sql: string) => {
          if (sql.includes("INSERT INTO thoughts")) insertSeen = true;
          return { rows: [] };
        },
        release: () => undefined,
      }),
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupMcpClient(
      registerDecomposeEntry,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "decompose_entry",
        arguments: {
          table: "thoughts",
          id: SOURCE_ID,
          dry_run: false,
          apply_mode: "write_replacements",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = parseToolResult(result);
      expect(parsed.status).toBe("not_oversized");
      expect(parsed.dry_run).toBe(false);
      expect(parsed.would_write).toBe(0);
      expect(parsed.written_ids).toEqual([]);
      expect(parsed.skipped_duplicates).toEqual([]);
      expect(insertSeen).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("rolls back replacement writes when apply fails mid-batch", async () => {
    const queries: string[] = [];
    let embedCalls = 0;
    const mockPool = {
      query: async () => ({
        rows: [
          {
            id: SOURCE_ID,
            namespace: "bilby",
            content_text: longContent(),
          },
        ],
      }),
      connect: async () => ({
        query: async (sql: string) => {
          queries.push(sql);
          if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
          if (sql.includes("INSERT INTO thoughts")) return { rows: [{ id: "new-1" }] };
          return { rows: [] };
        },
        release: () => undefined,
      }),
    };
    const mockEmbed = async () => {
      embedCalls += 1;
      if (embedCalls > 1) throw new Error("embedding provider failed");
      return Array(768).fill(0.1);
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupMcpClient(
      registerDecomposeEntry,
      mockPool,
      mockEmbed,
      auth,
    );

    try {
      const result = await client.callTool({
        name: "decompose_entry",
        arguments: {
          table: "thoughts",
          id: SOURCE_ID,
          max_chunk_chars: 700,
          overlap_chars: 50,
          dry_run: false,
          apply_mode: "write_replacements",
        },
      });

      expect(result.isError).toBe(true);
      expect(getErrorText(result)).toContain("embedding provider failed");
      expect(queries).toContain("BEGIN");
      expect(queries).toContain("ROLLBACK");
      expect(queries).not.toContain("COMMIT");
    } finally {
      await cleanup();
    }
  });

  it("uses JSONB-safe source SQL for decision alternatives", async () => {
    let sourceSql = "";
    const mockPool = {
      query: async (sql: string) => {
        sourceSql = sql;
        return {
          rows: [
            {
              id: SOURCE_ID,
              namespace: "bilby",
              content_text: longContent(),
            },
          ],
        };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupMcpClient(
      registerDecomposeEntry,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "decompose_entry",
        arguments: {
          table: "decisions",
          id: SOURCE_ID,
        },
      });

      expect(result.isError).toBeFalsy();
      expect(sourceSql).toContain("jsonb_array_length(alternatives)");
      expect(sourceSql).toContain("jsonb_array_elements_text(alternatives)");
      expect(sourceSql).not.toContain("array_length(alternatives,");
    } finally {
      await cleanup();
    }
  });

  it("denies replacement writes when caller cannot write the source namespace", async () => {
    let insertSeen = false;
    const mockPool = {
      query: async (sql: string) => {
        if (sql.includes("INSERT INTO thoughts")) insertSeen = true;
        return {
          rows: [
            {
              id: SOURCE_ID,
              namespace: "other-agent",
              content_text: longContent(),
            },
          ],
        };
      },
    };
    const auth: AuthInfo = {
      role: "admin",
      clientId: "bilby",
      tokenClientId: "admin",
      namespaceSource: "header",
    };
    const { client, cleanup } = await setupMcpClient(
      registerDecomposeEntry,
      mockPool,
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "decompose_entry",
        arguments: {
          table: "thoughts",
          id: SOURCE_ID,
          dry_run: false,
          apply_mode: "write_replacements",
        },
      });

      expect(result.isError).toBe(true);
      expect(getErrorText(result)).toContain("X-Namespace header requires");
      expect(insertSeen).toBe(false);
    } finally {
      await cleanup();
    }
  });
});
