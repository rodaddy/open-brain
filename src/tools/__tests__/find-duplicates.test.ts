import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerFindDuplicates } from "../find-duplicates.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

function createMockEmbed(result: number[] | null = Array(768).fill(0.1)) {
  return async (_text: string) => result;
}

async function setupToolClient(
  mockPool: { query: (...args: any[]) => Promise<{ rows: any[] }> },
  auth: AuthInfo,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = { pool: mockPool as any, embedFn: createMockEmbed() };
  registerFindDuplicates(server, deps);

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

describe("find_duplicates", () => {
  it("returns duplicate pairs", async () => {
    const mockPool = {
      query: async (sql: string, _params?: any[]) => {
        if (sql.includes("embedding <=> b.embedding")) {
          return {
            rows: [
              {
                id_a: "uuid-1",
                preview_a: "First entry content",
                id_b: "uuid-2",
                preview_b: "Almost identical content",
                distance: 0.03,
              },
            ],
          };
        }
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "find_duplicates",
        arguments: { table: "thoughts", threshold: 0.08 },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.duplicates_found).toBe(1);
      expect(parsed.duplicates[0].entry_a.id).toBe("uuid-1");
      expect(parsed.duplicates[0].entry_b.id).toBe("uuid-2");
      expect(parsed.duplicates[0].distance).toBe(0.03);
    } finally {
      await cleanup();
    }
  });

  it("returns empty when no duplicates found", async () => {
    const mockPool = {
      query: async () => ({ rows: [] }),
    };
    const auth: AuthInfo = { role: "admin", clientId: "admin-client" };

    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "find_duplicates",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.duplicates_found).toBe(0);
      expect(parsed.duplicates).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("scopes duplicate pair reads to readable namespaces", async () => {
    const calls: Array<{ sql: string; params?: any[] }> = [];
    const mockPool = {
      query: async (sql: string, params?: any[]) => {
        calls.push({ sql, params });
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };

    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "find_duplicates",
        arguments: { table: "thoughts", threshold: 0.08 },
      });

      expect(result.isError).toBeFalsy();
      // Both sides bind the SAME list ($3): a pair spanning two namespaces is
      // not a duplicate, and binding one side only leaves the join unbounded.
      expect(calls[0]!.sql).toContain("a.namespace = ANY($3::text[])");
      expect(calls[0]!.sql).toContain("b.namespace = ANY($3::text[])");
      expect(calls[0]!.params).toEqual([0.08, 20, ["bilby", "shared-kb"]]);
    } finally {
      await cleanup();
    }
  });

  // #485: for a global role `readableNamespaces()` returns undefined, so the
  // old `appendReadNamespacePredicate()` call site contributed an empty string
  // on BOTH sides and the self-join ran over every pair in the table. Measured
  // on a 24,845-row corpus: 256.7ms scoped versus cancelled at 60,074ms by
  // statement_timeout, with pooled connections that never came back.
  describe("#485: a global role never emits an unscoped self-join", () => {
    for (const role of ["admin", "ob-admin", "promoter"] as const) {
      it(`binds ${role} to a concrete namespace on BOTH sides of the join`, async () => {
        const calls: Array<{ sql: string; params?: any[] }> = [];
        const mockPool = {
          query: async (sql: string, params?: any[]) => {
            calls.push({ sql, params });
            return { rows: [] };
          },
        };
        const auth: AuthInfo = { role, clientId: "operator" };

        const { client, cleanup } = await setupToolClient(mockPool, auth);

        try {
          const result = await client.callTool({
            name: "find_duplicates",
            arguments: { table: "thoughts", threshold: 0.08 },
          });

          expect(result.isError).toBeFalsy();
          const join = calls[0]!;
          // The whole defect: these two predicates were absent entirely.
          expect(join.sql).toContain("a.namespace = ANY($3::text[])");
          expect(join.sql).toContain("b.namespace = ANY($3::text[])");
          expect(join.params).toEqual([0.08, 20, ["operator"]]);
        } finally {
          await cleanup();
        }
      });
    }

    it("scans a named namespace the global caller may read", async () => {
      const calls: Array<{ sql: string; params?: any[] }> = [];
      const mockPool = {
        query: async (sql: string, params?: any[]) => {
          calls.push({ sql, params });
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "operator" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "find_duplicates",
          arguments: { table: "thoughts", namespace: "bilby" },
        });

        expect(result.isError).toBeFalsy();
        expect(calls[0]!.params).toEqual([0.08, 20, ["bilby"]]);
      } finally {
        await cleanup();
      }
    });

    // `canReadNamespace` treats the literal "all" as permitted for a global
    // role, which is the one input that could smuggle the unbounded scan back
    // in. It must resolve to a concrete single-element list -- a bounded
    // (empty) namespace -- and never to "no predicate".
    it("keeps the 'all' sentinel bounded rather than reopening the cross-product", async () => {
      const calls: Array<{ sql: string; params?: any[] }> = [];
      const mockPool = {
        query: async (sql: string, params?: any[]) => {
          calls.push({ sql, params });
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "operator" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "find_duplicates",
          arguments: { table: "thoughts", namespace: "all" },
        });

        expect(result.isError).toBeFalsy();
        expect(calls[0]!.sql).toContain("a.namespace = ANY($3::text[])");
        expect(calls[0]!.sql).toContain("b.namespace = ANY($3::text[])");
        const bound = calls[0]!.params![2] as string[];
        expect(Array.isArray(bound)).toBe(true);
        expect(bound.length).toBe(1);
      } finally {
        await cleanup();
      }
    });

    it("refuses a namespace the caller cannot read, before touching the pool", async () => {
      const calls: Array<{ sql: string }> = [];
      const mockPool = {
        query: async (sql: string) => {
          calls.push({ sql });
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "agent", clientId: "bilby" };

      const { client, cleanup } = await setupToolClient(mockPool, auth);

      try {
        const result = await client.callTool({
          name: "find_duplicates",
          arguments: { namespace: "someone-else" },
        });

        expect(result.isError).toBe(true);
        expect((result.content as any)[0].text).toContain(
          "Permission denied: cannot read namespace 'someone-else'",
        );
        expect(calls).toHaveLength(0);
      } finally {
        await cleanup();
      }
    });
  });

  it("denies discord role (no read access)", async () => {
    const mockPool = {
      query: async () => ({ rows: [] }),
    };
    const auth: AuthInfo = { role: "discord", clientId: "discord-client" };

    const { client, cleanup } = await setupToolClient(mockPool, auth);

    try {
      const result = await client.callTool({
        name: "find_duplicates",
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
