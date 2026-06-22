import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBrainServer } from "../../server.ts";
import { registerAllTools } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

/**
 * Protocol-level tests using InMemoryTransport.
 * Tests the full MCP round-trip: client -> transport -> server -> tool -> response.
 */

function createMockPool(
  rows: Record<string, unknown>[] = [{ id: "proto-uuid" }],
) {
  return {
    query: async () => ({ rows }),
  } as any;
}

function createMockEmbed(result: number[] | null = Array(768).fill(0.1)) {
  return async (_text: string) => result;
}

async function createProtocolClient(
  auth: AuthInfo,
  poolRows: Record<string, unknown>[] = [{ id: "proto-uuid" }],
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = createBrainServer();
  registerAllTools(server, {
    pool: createMockPool(poolRows),
    embedFn: createMockEmbed(),
  });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message: any, options?: any) => {
    return originalSend(message, { ...options, authInfo: auth });
  };

  const client = new Client({ name: "proto-test", version: "1.0.0" });
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

describe("Protocol tests: write tools via InMemoryTransport", () => {
  describe("log_thought via protocol", () => {
    it("returns valid JSON with id using admin auth", async () => {
      const auth: AuthInfo = { role: "admin", clientId: "proto-admin" };
      const { client, cleanup } = await createProtocolClient(auth);

      try {
        const result = await client.callTool({
          name: "log_thought",
          arguments: { content: "Protocol test thought", tags: ["protocol"] },
        });

        expect(result.isError).toBeFalsy();
        const text = (result.content as any)[0].text;
        const parsed = JSON.parse(text);
        expect(parsed.id).toBe("proto-uuid");
        expect(typeof parsed.embedded).toBe("boolean");
      } finally {
        await cleanup();
      }
    });

    it("returns validation error for empty content (Zod min(1))", async () => {
      const auth: AuthInfo = { role: "admin", clientId: "proto-admin" };
      const { client, cleanup } = await createProtocolClient(auth);

      try {
        const result = await client.callTool({
          name: "log_thought",
          arguments: { content: "" },
        });

        // SDK should reject validation against Zod min(1)
        expect(result.isError).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it("returns a machine-readable failing-field summary", async () => {
      const auth: AuthInfo = { role: "admin", clientId: "proto-admin" };
      const { client, cleanup } = await createProtocolClient(auth);

      try {
        const result = await client.callTool({
          name: "append_session_event",
          arguments: {
            session_key: "test",
            event_type: "invalid-event-type",
            content: "bad enum",
          },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text as string;
        expect(text).toContain("Input validation error: ");
        const summary = JSON.parse(
          text.slice(text.indexOf("Input validation error: ") + 24),
        );
        expect(summary).toMatchObject({
          error: "input_validation_failed",
          tool: "append_session_event",
        });
        expect(summary.fields).toContainEqual(
          expect.objectContaining({
            field: "event_type",
            code: "invalid_value",
          }),
        );
      } finally {
        await cleanup();
      }
    });
  });

  describe("search_brain via protocol", () => {
    it("returns results array with admin auth", async () => {
      const searchRows = [
        {
          source_type: "thought",
          id: "search-uuid",
          content_preview: "A relevant thought",
          distance: 0.05,
          tags: ["test"],
          created_at: "2026-01-01T00:00:00Z",
        },
      ];
      const auth: AuthInfo = { role: "admin", clientId: "proto-admin" };
      const { client, cleanup } = await createProtocolClient(auth, searchRows);

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "protocol search test" },
        });

        expect(result.isError).toBeFalsy();
        const text = (result.content as any)[0].text;
        const parsed = JSON.parse(text);
        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed.length).toBe(1);
        expect(parsed[0].source_type).toBe("thought");
        expect(parsed[0].id).toBe("search-uuid");
      } finally {
        await cleanup();
      }
    });

    it("returns validation error for empty query (Zod min(1))", async () => {
      const auth: AuthInfo = { role: "admin", clientId: "proto-admin" };
      const { client, cleanup } = await createProtocolClient(auth);

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "" },
        });

        expect(result.isError).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it("returns isError with discord role (no read permissions)", async () => {
      const auth: AuthInfo = { role: "discord", clientId: "proto-discord" };
      const { client, cleanup } = await createProtocolClient(auth);

      try {
        const result = await client.callTool({
          name: "search_brain",
          arguments: { query: "discord should fail" },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain("Permission denied");
      } finally {
        await cleanup();
      }
    });
  });

  describe("brain_answer via protocol", () => {
    it("returns cited evidence through the full tool registry", async () => {
      const searchRows = [
        {
          source_type: "thought",
          id: "answer-uuid",
          namespace: "proto-admin",
          content_preview: "Use Open Brain for cited Codex memory.",
          distance: 0.05,
          tags: ["memory"],
          created_at: "2026-01-01T00:00:00Z",
        },
      ];
      const auth: AuthInfo = { role: "admin", clientId: "proto-admin" };
      const { client, cleanup } = await createProtocolClient(auth, searchRows);

      try {
        const result = await client.callTool({
          name: "brain_answer",
          arguments: { query: "codex memory" },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.answer).toContain("[1]");
        expect(parsed.citations[0].source_ref).toMatchObject({
          source: "brain",
          type: "thought",
          id: "answer-uuid",
          namespace: "proto-admin",
        });
      } finally {
        await cleanup();
      }
    });

    it("returns validation error for empty query", async () => {
      const auth: AuthInfo = { role: "admin", clientId: "proto-admin" };
      const { client, cleanup } = await createProtocolClient(auth);

      try {
        const result = await client.callTool({
          name: "brain_answer",
          arguments: { query: "" },
        });

        expect(result.isError).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  describe("find_person via protocol", () => {
    it("name mode returns valid JSON array with admin auth", async () => {
      const personRows = [
        {
          id: "person-uuid",
          person_name: "Alice Johnson",
          context: "Engineer at Google",
          warmth: 4,
          last_contact: "2026-01-15",
          notes: "Met at conference",
          tags: ["engineering"],
          created_at: "2026-01-01T00:00:00Z",
        },
      ];
      const auth: AuthInfo = { role: "admin", clientId: "proto-admin" };
      const { client, cleanup } = await createProtocolClient(auth, personRows);

      try {
        const result = await client.callTool({
          name: "find_person",
          arguments: { query: "Alice", mode: "name" },
        });

        expect(result.isError).toBeFalsy();
        const text = (result.content as any)[0].text;
        const parsed = JSON.parse(text);
        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed.length).toBe(1);
        expect(parsed[0].person_name).toBe("Alice Johnson");
      } finally {
        await cleanup();
      }
    });

    it("returns isError with discord role", async () => {
      const auth: AuthInfo = { role: "discord", clientId: "proto-discord" };
      const { client, cleanup } = await createProtocolClient(auth);

      try {
        const result = await client.callTool({
          name: "find_person",
          arguments: { query: "Alice" },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain("Permission denied");
      } finally {
        await cleanup();
      }
    });
  });

  describe("session_save via protocol", () => {
    it("returns valid JSON with id using admin auth", async () => {
      const auth: AuthInfo = { role: "admin", clientId: "proto-admin" };
      const { client, cleanup } = await createProtocolClient(auth);

      try {
        const result = await client.callTool({
          name: "session_save",
          arguments: {
            summary: "Protocol test session",
            project: "test-project",
            tags: ["protocol"],
            blockers: [],
            next_steps: ["verify"],
            key_decisions: ["use MCP"],
          },
        });

        expect(result.isError).toBeFalsy();
        const text = (result.content as any)[0].text;
        const parsed = JSON.parse(text);
        expect(parsed.id).toBe("proto-uuid");
        expect(typeof parsed.embedded).toBe("boolean");
      } finally {
        await cleanup();
      }
    });

    it("returns isError with readonly role", async () => {
      const auth: AuthInfo = { role: "readonly", clientId: "proto-readonly" };
      const { client, cleanup } = await createProtocolClient(auth);

      try {
        const result = await client.callTool({
          name: "session_save",
          arguments: { summary: "Readonly should fail" },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain("Permission denied");
      } finally {
        await cleanup();
      }
    });
  });

  describe("session_load via protocol", () => {
    it("returns valid session JSON with admin auth", async () => {
      const sessionRow = {
        id: "session-uuid",
        project: "test-project",
        summary: "Test summary",
        tags: ["tag1"],
        blockers: [],
        next_steps: ["step1"],
        key_decisions: ["decision1"],
        created_by: "proto-admin",
        created_at: "2026-01-01T00:00:00Z",
      };
      const auth: AuthInfo = { role: "admin", clientId: "proto-admin" };
      const { client, cleanup } = await createProtocolClient(auth, [
        sessionRow,
      ]);

      try {
        const result = await client.callTool({
          name: "session_load",
          arguments: { project: "test-project" },
        });

        expect(result.isError).toBeFalsy();
        const text = (result.content as any)[0].text;
        const parsed = JSON.parse(text);
        expect(parsed.id).toBe("session-uuid");
        expect(parsed.project).toBe("test-project");
        expect(parsed.summary).toBe("Test summary");
        expect(Array.isArray(parsed.tags)).toBe(true);
        expect(Array.isArray(parsed.next_steps)).toBe(true);
        expect(Array.isArray(parsed.key_decisions)).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it("returns isError with discord role", async () => {
      const auth: AuthInfo = { role: "discord", clientId: "proto-discord" };
      const { client, cleanup } = await createProtocolClient(auth);

      try {
        const result = await client.callTool({
          name: "session_load",
          arguments: {},
        });

        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain("Permission denied");
      } finally {
        await cleanup();
      }
    });
  });

  describe("log_decision via protocol", () => {
    it("returns valid JSON with id using admin auth", async () => {
      const auth: AuthInfo = { role: "admin", clientId: "proto-admin" };
      const { client, cleanup } = await createProtocolClient(auth);

      try {
        const result = await client.callTool({
          name: "log_decision",
          arguments: {
            title: "Protocol Decision",
            rationale: "Testing full round-trip",
          },
        });

        expect(result.isError).toBeFalsy();
        const text = (result.content as any)[0].text;
        const parsed = JSON.parse(text);
        expect(parsed.id).toBe("proto-uuid");
        expect(typeof parsed.embedded).toBe("boolean");
      } finally {
        await cleanup();
      }
    });

    it("returns isError: true with readonly role", async () => {
      const auth: AuthInfo = { role: "readonly", clientId: "proto-readonly" };
      const { client, cleanup } = await createProtocolClient(auth);

      try {
        const result = await client.callTool({
          name: "log_decision",
          arguments: {
            title: "Should Fail",
            rationale: "Readonly cannot write decisions",
          },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain("Permission denied");
      } finally {
        await cleanup();
      }
    });
  });
});
