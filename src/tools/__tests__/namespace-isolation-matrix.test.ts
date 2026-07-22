import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerArchiveEntry } from "../archive-entry.ts";
import { registerBulkArchive } from "../bulk-archive.ts";
import { registerArchiveEntity } from "../archive-entity.ts";
import { registerUnlinkEntities } from "../unlink-entities.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

// Cross-surface negative matrix for #297: a delete-capable identity whose
// namespace authority is header-bound must not be able to archive rows in
// another namespace, and the denial must be content-free (no foreign namespace
// names, no row content in the response). Per-tool positive tests live next to
// each tool; this file pins the isolation boundary itself, across the FULL
// delete-capable header-scopable surface (archive_entry, bulk_archive,
// archive_entity, unlink_entities) and both delete-capable header-scopable
// roles (admin, ob-admin) so a future role-specific branch cannot silently
// un-scope one of them.

const FOREIGN_ROW_ID = "550e8400-e29b-41d4-a716-446655440000";
const OWN_ROW_ID = "770e8400-e29b-41d4-a716-446655440002";

const HEADER_SCOPABLE_DELETE_ROLES = ["admin", "ob-admin"] as const;

function headerScopedAuth(
  namespace: string,
  role: (typeof HEADER_SCOPABLE_DELETE_ROLES)[number] = "admin",
): AuthInfo {
  return {
    role,
    clientId: namespace,
    namespaceSource: "header",
  };
}

async function setupToolClient(
  register: (server: McpServer, deps: ToolDeps) => void,
  mockPool: Record<string, unknown>,
  auth: AuthInfo,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = {
    pool: mockPool as any,
    embedFn: async () => Array(768).fill(0.1),
  };
  register(server, deps);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message: any, options?: any) =>
    originalSend(message, { ...options, authInfo: auth });

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

describe("namespace isolation negative matrix (#297)", () => {
  for (const role of HEADER_SCOPABLE_DELETE_ROLES) {
    it(`archive_entry: header-scoped ${role} cannot archive a foreign-namespace row and the noop is content-free`, async () => {
      const captured: Array<{ sql: string; params: unknown[] }> = [];
      const mockPool = {
        // Foreign-namespace row: the namespace predicate excludes it, so the
        // UPDATE matches zero rows regardless of the row existing.
        query: async (sql: string, params: unknown[]) => {
          captured.push({ sql, params });
          return { rows: [] };
        },
      };
      const auth = headerScopedAuth("bilby", role);
      const { client, cleanup } = await setupToolClient(
        registerArchiveEntry,
        mockPool,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "archive_entry",
          arguments: { table: "thoughts", id: FOREIGN_ROW_ID },
        });

        // The UPDATE carried the auth-derived namespace predicate bound to the
        // caller's own namespace only.
        expect(captured.length).toBe(1);
        expect(captured[0]!.sql).toContain("AND namespace = ANY($2::text[])");
        expect(captured[0]!.params).toEqual([FOREIGN_ROW_ID, ["bilby"]]);

        // Denial is indistinguishable from not-found and leaks nothing.
        const text = (result.content as Array<{ text: string }>)[0]!.text;
        expect(text).toBe("Already archived or not found");
        expect(text).not.toContain("bilby");
        expect(result.isError).toBeUndefined();
      } finally {
        await cleanup();
      }
    });

    it(`bulk_archive: header-scoped ${role} archives zero foreign-namespace rows inside the transaction`, async () => {
      const captured: Array<{ sql: string; params: unknown[] }> = [];
      const mockClient = {
        query: async (sql: string, params?: unknown[]) => {
          if (params !== undefined) captured.push({ sql, params });
          return { rows: [], rowCount: 0 };
        },
        release: () => {},
      };
      const mockPool = {
        connect: async () => mockClient,
      };
      const auth = headerScopedAuth("bilby", role);
      const { client, cleanup } = await setupToolClient(
        registerBulkArchive,
        mockPool,
        auth,
      );

      try {
        const result = await client.callTool({
          name: "bulk_archive",
          arguments: {
            entries: [
              { table: "thoughts", id: FOREIGN_ROW_ID },
              {
                table: "decisions",
                id: "660e8400-e29b-41d4-a716-446655440001",
              },
            ],
          },
        });

        // Every per-entry UPDATE carried the caller-bound namespace predicate.
        expect(captured.length).toBe(2);
        for (const call of captured) {
          expect(call.sql).toContain("AND namespace = ANY($2::text[])");
          expect(call.params[1]).toEqual(["bilby"]);
        }

        // Zero rows archived, reported truthfully and content-free.
        const text = (result.content as Array<{ text: string }>)[0]!.text;
        expect(JSON.parse(text)).toEqual({ requested: 2, archived: 0 });
        expect(text).not.toContain("bilby");
      } finally {
        await cleanup();
      }
    });
  }

  it("archive_entity: header-scoped identity cannot archive a foreign-namespace entity and the noop is content-free", async () => {
    const captured: Array<{ sql: string; params: unknown[] }> = [];
    const mockClient = {
      // BEGIN/COMMIT/ROLLBACK arrive without params; only parameterized
      // statements are the isolation-relevant SQL.
      query: async (sql: string, params?: unknown[]) => {
        if (params !== undefined) captured.push({ sql, params });
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    };
    const mockPool = {
      connect: async () => mockClient,
    };
    const auth = headerScopedAuth("bilby");
    const { client, cleanup } = await setupToolClient(
      registerArchiveEntity,
      mockPool,
      auth,
    );

    try {
      const result = await client.callTool({
        name: "archive_entity",
        arguments: { id: FOREIGN_ROW_ID },
      });

      // Exactly one parameterized statement: the ob_entities UPDATE carrying
      // the auth-derived ANY-predicate bound to the caller's own namespace.
      // Zero rows matched, so the ob_links UPDATE is never reached.
      expect(captured.length).toBe(1);
      expect(captured[0]!.sql).toContain("UPDATE ob_entities");
      expect(captured[0]!.sql).toContain("AND namespace = ANY($2::text[])");
      expect(captured[0]!.params).toEqual([FOREIGN_ROW_ID, ["bilby"]]);

      // Denial is indistinguishable from not-found and leaks nothing.
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      expect(text).toBe("Already archived or not found");
      expect(text).not.toContain("bilby");
      expect(result.isError).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("unlink_entities: header-scoped identity cannot reach a foreign namespace via the namespace argument", async () => {
    let queries = 0;
    const mockPool = {
      query: async () => {
        queries += 1;
        return { rows: [] };
      },
    };
    const auth = headerScopedAuth("bilby");
    const { client, cleanup } = await setupToolClient(
      registerUnlinkEntities,
      mockPool,
      auth,
    );

    try {
      const result = await client.callTool({
        name: "unlink_entities",
        arguments: {
          from_type: "entity",
          from_id: FOREIGN_ROW_ID,
          to_type: "entity",
          to_id: OWN_ROW_ID,
          relation: "relates_to",
          namespace: "victim",
        },
      });

      // The canWriteNamespace gate denies the caller-supplied foreign
      // namespace before any SQL: no mutation is ever issued against the
      // victim namespace.
      expect(result.isError).toBe(true);
      expect(queries).toBe(0);

      // The denial names only the caller's own bound namespace -- it does not
      // echo the foreign namespace, and no victim-namespace row data or IDs
      // can appear because no SQL ever ran.
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      expect(text).toContain("Permission denied");
      expect(text).toContain("bilby");
      expect(text).not.toContain("victim");
      expect(text).not.toContain("unlinked");
      expect(text).not.toContain(FOREIGN_ROW_ID);
    } finally {
      await cleanup();
    }
  });

  it("archive_entry: a caller-supplied namespace argument cannot influence the bound predicate", async () => {
    const captured: Array<{ sql: string; params: unknown[] }> = [];
    const mockPool = {
      query: async (sql: string, params: unknown[]) => {
        captured.push({ sql, params });
        return { rows: [] };
      },
    };
    const auth = headerScopedAuth("bilby");
    const { client, cleanup } = await setupToolClient(
      registerArchiveEntry,
      mockPool,
      auth,
    );

    try {
      // archive_entry's schema has no `namespace` input; an override attempt
      // must not become caller-controllable predicate input.
      const result = await client.callTool({
        name: "archive_entry",
        arguments: {
          table: "thoughts",
          id: FOREIGN_ROW_ID,
          namespace: "victim",
        },
      });

      if (result.isError) {
        // Strict-schema behavior: the call is rejected outright, no SQL runs.
        expect(captured.length).toBe(0);
      } else {
        // Strip behavior: the unknown key is discarded and the bound params
        // remain exactly the auth-derived shape -- "victim" appears nowhere.
        expect(captured.length).toBe(1);
        expect(captured[0]!.params).toEqual([FOREIGN_ROW_ID, ["bilby"]]);
        expect(JSON.stringify(captured)).not.toContain("victim");
        const text = (result.content as Array<{ text: string }>)[0]!.text;
        expect(text).toBe("Already archived or not found");
      }
    } finally {
      await cleanup();
    }
  });

  it("bulk_archive: non-delete role is stopped at the permission gate before any connection", async () => {
    let connects = 0;
    const mockPool = {
      connect: async () => {
        connects += 1;
        return {
          query: async () => ({ rows: [], rowCount: 0 }),
          release: () => {},
        };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupToolClient(
      registerBulkArchive,
      mockPool,
      auth,
    );

    try {
      const result = await client.callTool({
        name: "bulk_archive",
        arguments: {
          entries: [{ table: "thoughts", id: FOREIGN_ROW_ID }],
        },
      });

      expect(result.isError).toBe(true);
      expect(connects).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("bulk_archive: mixed own/foreign batch archives only the own-namespace row under the predicate", async () => {
    const captured: Array<{ sql: string; params: unknown[] }> = [];
    let commits = 0;
    let rollbacks = 0;
    const mockClient = {
      query: async (sql: string, params?: unknown[]) => {
        if (params === undefined) {
          if (sql === "COMMIT") commits += 1;
          if (sql === "ROLLBACK") rollbacks += 1;
          return { rows: [], rowCount: 0 };
        }
        captured.push({ sql, params });
        // Params-keyed row visibility: only the own-namespace id under the
        // caller's exact predicate matches, mirroring real Postgres
        // evaluation of the namespace predicate.
        const matches =
          params[0] === OWN_ROW_ID &&
          JSON.stringify(params[1]) === JSON.stringify(["bilby"]);
        return { rows: [], rowCount: matches ? 1 : 0 };
      },
      release: () => {},
    };
    const mockPool = {
      connect: async () => mockClient,
    };
    const auth = headerScopedAuth("bilby");
    const { client, cleanup } = await setupToolClient(
      registerBulkArchive,
      mockPool,
      auth,
    );

    try {
      const result = await client.callTool({
        name: "bulk_archive",
        arguments: {
          entries: [
            { table: "thoughts", id: OWN_ROW_ID },
            { table: "thoughts", id: FOREIGN_ROW_ID },
          ],
        },
      });

      // Both UPDATEs carried the caller-bound predicate; only the own row hit.
      expect(captured.length).toBe(2);
      for (const call of captured) {
        expect(call.sql).toContain("AND namespace = ANY($2::text[])");
        expect(call.params[1]).toEqual(["bilby"]);
      }
      expect(commits).toBe(1);
      expect(rollbacks).toBe(0);

      const text = (result.content as Array<{ text: string }>)[0]!.text;
      expect(JSON.parse(text)).toEqual({ requested: 2, archived: 1 });
    } finally {
      await cleanup();
    }
  });

  it("bulk_archive: transaction failure is content-free -- no dependency message crosses the transport boundary", async () => {
    let rollbacks = 0;
    const mockClient = {
      query: async (sql: string, params?: unknown[]) => {
        if (params === undefined) {
          if (sql === "ROLLBACK") rollbacks += 1;
          return { rows: [], rowCount: 0 };
        }
        const err = new Error(
          'relation "secret_internal_table" violates constraint victim-ns-detail',
        );
        (err as any).code = "23505";
        throw err;
      },
      release: () => {},
    };
    const mockPool = {
      connect: async () => mockClient,
    };
    const auth = headerScopedAuth("bilby");
    const { client, cleanup } = await setupToolClient(
      registerBulkArchive,
      mockPool,
      auth,
    );

    try {
      const result = await client.callTool({
        name: "bulk_archive",
        arguments: {
          entries: [{ table: "thoughts", id: FOREIGN_ROW_ID }],
        },
      });

      expect(result.isError).toBe(true);
      expect(rollbacks).toBe(1);
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      expect(text).toBe("Transaction failed");
      expect(text).not.toContain("secret_internal_table");
      expect(text).not.toContain("victim-ns-detail");
    } finally {
      await cleanup();
    }
  });

  it("token-sourced non-delete role is stopped at the permission gate before any SQL", async () => {
    let queries = 0;
    const mockPool = {
      query: async () => {
        queries += 1;
        return { rows: [] };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupToolClient(
      registerArchiveEntry,
      mockPool,
      auth,
    );

    try {
      const result = await client.callTool({
        name: "archive_entry",
        arguments: { table: "thoughts", id: FOREIGN_ROW_ID },
      });

      expect(result.isError).toBe(true);
      expect(queries).toBe(0);
    } finally {
      await cleanup();
    }
  });
});
