// This suite requires OPENBRAIN_TEST_DATABASE_URL and fails loudly without it.
import { afterAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../../scripts/test-support/require-test-database.ts";
import { registerGetEntry } from "../get-entry.ts";
import {
  createMockEmbed,
  type MockPool,
  parseToolResult,
  setupMcpClient,
} from "./test-helpers.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

describe("get_entry compact render (live Postgres)", () => {
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
      pool as unknown as MockPool,
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
