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
    it("inserts title, rationale, alternatives, tags, context, created_by, embedding and returns { id, embedded: true }", async () => {
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
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
            tags: ["runtime"],
            context: "Server runtime selection",
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse((result.content as any)[0].text);
        expect(parsed.id).toBe("decision-uuid");
        expect(parsed.embedded).toBe(true);

        // Verify SQL parameters
        expect(queryCalls.length).toBe(1);
        const [sql, params] = queryCalls[0];
        expect(sql).toContain("INSERT INTO decisions");
        expect(params[0]).toBe("Use Bun"); // title
        expect(params[1]).toBe("Faster than Node.js for our use case"); // rationale
        // alternatives should be JSON-serialized
        const alts = params[2];
        expect(typeof alts).toBe("string");
        expect(JSON.parse(alts)).toEqual(["Node.js", "Deno"]);
        expect(params[3]).toEqual(["runtime"]); // tags (original -- extraction is fire-and-forget)
        expect(params[4]).toBe("Server runtime selection"); // context
        expect(params[5]).toBe("admin-client"); // created_by
        expect(params.length).toBe(10);
      } finally {
        await cleanup();
      }
    });
  });

  describe("embedding text construction", () => {
    it("embeds concatenation of title + newline + rationale", async () => {
      const embeddedTexts: string[] = [];
      const mockEmbed = async (text: string) => {
        embeddedTexts.push(text);
        return Array(768).fill(0.1);
      };
      const mockPool = {
        query: async () => ({ rows: [{ id: "embed-test-uuid" }] }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "test" };

      const { client, cleanup } = await setupDecisionClient(
        mockPool,
        mockEmbed,
        auth,
      );

      try {
        await client.callTool({
          name: "log_decision",
          arguments: {
            title: "My Title",
            rationale: "My Rationale",
          },
        });

        expect(embeddedTexts.length).toBe(1);
        expect(embeddedTexts[0]).toBe("My Title\nMy Rationale");
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
