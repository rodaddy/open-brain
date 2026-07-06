import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerLogDecision } from "../log-decision.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

function createMockEmbed(result: number[] | null = Array(768).fill(0.1)) {
  return async (_text: string) => result;
}

async function setupDecisionClient(
  mockPool: { query: (...args: any[]) => Promise<{ rows: any[] }> },
  mockEmbed: ReturnType<typeof createMockEmbed>,
  auth: AuthInfo,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = { pool: mockPool as any, embedFn: mockEmbed };
  registerLogDecision(server, deps);

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

describe("log_decision", () => {
  describe("success with embedding", () => {
    it("returns { id, embedded: true } for valid decision input", async () => {
      const mockPool = {
        query: async () => ({ rows: [{ id: "decision-uuid" }] }),
      };
      const mockEmbed = createMockEmbed();
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupDecisionClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "log_decision",
          arguments: {
            title: "Use Bun",
            rationale: "Faster than Node.js for our use case",
            alternatives: ["Node.js", "Deno"],
            tags: ["runtime"],
            context: "Server runtime selection",
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.id).toBe("decision-uuid");
        expect(parsed.embedded).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it("passes alternatives as a JSON string for the jsonb column", async () => {
      // Regression: a raw JS array is serialized by node-postgres as a
      // Postgres array literal ('{..}'), which jsonb rejects with
      // "invalid input syntax for type json" whenever it is non-empty.
      let capturedParams: any[] = [];
      const mockPool = {
        query: async (_sql: string, params?: any[]) => {
          if (params) capturedParams = params;
          return { rows: [{ id: "decision-uuid" }] };
        },
      };
      const mockEmbed = createMockEmbed();
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupDecisionClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "log_decision",
          arguments: {
            title: "Use Bun",
            rationale: "Faster than Node.js for our use case",
            alternatives: ["Node.js", "Deno"],
          },
        });

        expect(result.isError).toBeFalsy();
        const alternativesParam = capturedParams[2];
        expect(typeof alternativesParam).toBe("string");
        expect(JSON.parse(alternativesParam)).toEqual(["Node.js", "Deno"]);
      } finally {
        await cleanup();
      }
    });

    it("stores structured source refs with decision entries", async () => {
      let capturedSql = "";
      let capturedParams: unknown[] = [];
      const sourceRefs = [
        {
          source_type: "file",
          document_id: "decision-doc-1",
          path: "matters/acme/strategy-memo.pdf",
          client_id: "acme",
          matter_id: "lit-2026-001",
          page: 9,
          paragraph: "12",
          source_hash: "sha256:decisionhash",
          ingested_at: "2026-07-06T14:00:00.000Z",
        },
      ];
      const mockPool = {
        query: async (sql: string, params?: unknown[]) => {
          capturedSql = sql;
          capturedParams = params ?? [];
          return {
            rows: [
              {
                id: "decision-source-ref-uuid",
                is_new: true,
                source_refs: sourceRefs,
              },
            ],
          };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupDecisionClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "log_decision",
          arguments: {
            title: "Use source-grounded answer",
            rationale: "Legal workflow answers need matter-scoped citations.",
            source_refs: sourceRefs,
          },
        });

        expect(result.isError).toBeFalsy();
        expect(capturedSql).toContain("source_refs");
        expect(JSON.parse(capturedParams[11] as string)).toEqual(sourceRefs);
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.source_refs).toEqual(sourceRefs);
      } finally {
        await cleanup();
      }
    });

    it("rejects invalid source refs before writing decisions", async () => {
      let queried = false;
      const mockPool = {
        query: async () => {
          queried = true;
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

      const { client, cleanup } = await setupDecisionClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "log_decision",
          arguments: {
            title: "Bad source ref",
            rationale: "Should fail validation.",
            source_refs: [{ client_id: "acme", matter_id: "lit-1" }],
          },
        });

        expect(result.isError).toBe(true);
        expect(queried).toBe(false);
      } finally {
        await cleanup();
      }
    });
  });

  describe("embedding text construction", () => {
    it("produces embedded: true when title and rationale are provided", async () => {
      const mockPool = {
        query: async () => ({ rows: [{ id: "embed-test-uuid" }] }),
      };
      const mockEmbed = createMockEmbed();
      const auth: AuthInfo = { role: "admin", clientId: "test" };

      const { client, cleanup } = await setupDecisionClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "log_decision",
          arguments: {
            title: "My Title",
            rationale: "My Rationale",
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.id).toBe("embed-test-uuid");
        expect(parsed.embedded).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  describe("permission denied for readonly role", () => {
    it("returns isError: true when role is readonly", async () => {
      const mockPool = {
        query: async () => ({ rows: [{ id: "should-not-reach" }] }),
      };
      const mockEmbed = createMockEmbed();
      const auth: AuthInfo = { role: "readonly", clientId: "ro-client" };

      const { client, cleanup } = await setupDecisionClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "log_decision",
          arguments: {
            title: "Denied Decision",
            rationale: "Should not be inserted",
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

  describe("permission denied for discord role", () => {
    it("returns isError: true because discord cannot write decisions", async () => {
      const mockPool = {
        query: async () => ({ rows: [{ id: "should-not-reach" }] }),
      };
      const mockEmbed = createMockEmbed();
      const auth: AuthInfo = { role: "discord", clientId: "discord-client" };

      const { client, cleanup } = await setupDecisionClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "log_decision",
          arguments: {
            title: "Discord Decision",
            rationale: "Discord should not write decisions",
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

  describe("admin and agent succeed", () => {
    it("admin role can write decisions", async () => {
      const mockPool = {
        query: async () => ({ rows: [{ id: "admin-uuid" }] }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setupDecisionClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "log_decision",
          arguments: { title: "Admin Decision", rationale: "Admin is allowed" },
        });
        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.id).toBe("admin-uuid");
      } finally {
        await cleanup();
      }
    });

    it("agent role can write decisions", async () => {
      const mockPool = {
        query: async () => ({ rows: [{ id: "agent-uuid" }] }),
      };
      const auth: AuthInfo = { role: "agent", clientId: "agent" };
      const { client, cleanup } = await setupDecisionClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "log_decision",
          arguments: { title: "Agent Decision", rationale: "Agent is allowed" },
        });
        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.id).toBe("agent-uuid");
      } finally {
        await cleanup();
      }
    });
  });

  describe("duplicate content", () => {
    it("returns merged: true when upsert merges tags on conflict", async () => {
      const mockPool = {
        query: async () => ({
          rows: [{ id: "existing-uuid", is_new: false }],
        }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setupDecisionClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "log_decision",
          arguments: { title: "Dup Decision", rationale: "Already exists" },
        });
        expect(result.isError).toBeFalsy();
        const text = (result.content as any)[0].text;
        const parsed = JSON.parse(text);
        expect(parsed.merged).toBe(true);
        expect(parsed.id).toBe("existing-uuid");
      } finally {
        await cleanup();
      }
    });
  });
});
