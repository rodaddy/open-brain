import { afterAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerPromoteShared } from "../promote-shared.ts";
import { contentHash } from "../../embedding.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

const SOURCE_ID = "550e8400-e29b-41d4-a716-446655440000";
const LONG_FACT =
  "The promoter graduates this substantive durable fact into shared truth for all agents.";
const FAKE_AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";

function createMockEmbed(result: number[] | null = Array(768).fill(0.1)) {
  return async (_text: string) => result;
}

/**
 * Mock pool routed by SQL shape:
 *  - SELECT ... FROM <table> WHERE id = $1   → the source row for classification
 *    AND promoteEntry's own source read.
 *  - INSERT INTO <table> ...                 → records a write.
 *  - duplicate-check SELECT                  → controllable miss.
 */
function createMockPool(opts: {
  row?: Record<string, unknown> | null;
  table?: string;
}) {
  const row =
    opts.row === undefined
      ? { id: SOURCE_ID, content: LONG_FACT, namespace: "bilby", content_hash: contentHash(LONG_FACT) }
      : opts.row;
  const writes: Array<{ sql: string; params: any[] }> = [];
  const reads: Array<{ sql: string; params: any[] }> = [];
  const pool = {
    reads,
    writes,
    query: async (sql: string, params: any[] = []) => {
      reads.push({ sql, params });
      if (sql.startsWith("INSERT")) {
        writes.push({ sql, params });
        return { rows: [{ id: "new-shared-id" }] };
      }
      if (sql.includes("WHERE namespace = $1")) {
        // findDuplicate — no existing duplicate.
        return { rows: [] };
      }
      if (sql.includes("WHERE id = $1")) {
        if (
          sql.includes("namespace = ANY") &&
          row &&
          Array.isArray(params[1]) &&
          !params[1].includes(row.namespace)
        ) {
          return { rows: [] };
        }
        return { rows: row ? [row] : [] };
      }
      return { rows: [] };
    },
  };
  return pool;
}

async function setupToolClient(
  mockPool: { query: (...args: any[]) => Promise<{ rows: any[] }> },
  auth: AuthInfo,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = { pool: mockPool as any, embedFn: createMockEmbed() };
  registerPromoteShared(server, deps);

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

describe("promote_shared", () => {
  // ── AUTH (the acceptance gate) ──

  it("REJECTS a normal agent token", async () => {
    const mockPool = createMockPool({});
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);
    try {
      const res = await client.callTool({
        name: "promote_shared",
        arguments: { table: "thoughts", id: SOURCE_ID },
      });
      expect(res.isError).toBe(true);
      expect((res.content as any)[0].text).toContain("Permission denied");
      // Refused before any DB read/write.
      expect((mockPool as any).writes.length).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("denies when auth is missing entirely", async () => {
    const mockPool = createMockPool({});
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const deps: ToolDeps = { pool: mockPool as any, embedFn: createMockEmbed() };
    registerPromoteShared(server, deps);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "tc", version: "1.0.0" });
    await server.connect(st);
    await client.connect(ct);
    try {
      const res = await client.callTool({
        name: "promote_shared",
        arguments: { table: "thoughts", id: SOURCE_ID },
      });
      expect(res.isError).toBe(true);
      expect((res.content as any)[0].text).toContain("Permission denied");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("denies a readonly role", async () => {
    const mockPool = createMockPool({});
    const auth: AuthInfo = { role: "readonly", clientId: "viewer" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);
    try {
      const res = await client.callTool({
        name: "promote_shared",
        arguments: { table: "thoughts", id: SOURCE_ID },
      });
      expect(res.isError).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("ALLOWS the promoter role (dry-run, no write)", async () => {
    const mockPool = createMockPool({});
    const auth: AuthInfo = {
      role: "promoter",
      clientId: "openbrain-promoter",
      tokenClientId: "openbrain-promoter",
      namespaceSource: "token",
    };
    const { client, cleanup } = await setupToolClient(mockPool, auth);
    try {
      const res = await client.callTool({
        name: "promote_shared",
        arguments: { table: "thoughts", id: SOURCE_ID },
      });
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse((res.content as any)[0].text);
      expect(parsed.classification).toBe("share");
      expect(parsed.status).toBe("dry_run");
      // Dry-run performs no INSERT.
      expect((mockPool as any).writes.length).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("ALLOWS an admin-as-promoter identity and writes on apply", async () => {
    // Admin role + the openbrain-promoter clientId is a promoter identity
    // (backward-compat path in isPromoterIdentity), so the shared-kb write is
    // permitted at the namespace boundary.
    const mockPool = createMockPool({});
    const auth: AuthInfo = {
      role: "admin",
      clientId: "openbrain-promoter",
      tokenClientId: "openbrain-promoter",
      namespaceSource: "token",
    };
    const { client, cleanup } = await setupToolClient(mockPool, auth);
    try {
      const res = await client.callTool({
        name: "promote_shared",
        arguments: { table: "thoughts", id: SOURCE_ID, dry_run: false },
      });
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse((res.content as any)[0].text);
      expect(parsed.status).toBe("promoted");
      expect((mockPool as any).writes.length).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("lets a PLAIN admin past the entry gate but the shared-kb write boundary still refuses", async () => {
    // Defense in depth: the entry gate admits admin, but only a promoter
    // IDENTITY may write shared-kb, so promoteEntry rejects a non-promoter admin.
    const mockPool = createMockPool({});
    const auth: AuthInfo = {
      role: "admin",
      clientId: "admin",
      tokenClientId: "admin",
      namespaceSource: "token",
    };
    const { client, cleanup } = await setupToolClient(mockPool, auth);
    try {
      const res = await client.callTool({
        name: "promote_shared",
        arguments: { table: "thoughts", id: SOURCE_ID, dry_run: false },
      });
      expect(res.isError).toBe(true);
      expect((res.content as any)[0].text).toContain("Permission denied");
      expect((mockPool as any).writes.length).toBe(0);
    } finally {
      await cleanup();
    }
  });

  // ── SECRET / PRIVATE REFUSAL (even for a promoter) ──

  it("REFUSES a secret-bearing entry even for a promoter", async () => {
    const mockPool = createMockPool({
      row: {
        id: SOURCE_ID,
        content: `${LONG_FACT} ${FAKE_AWS_KEY}`,
        namespace: "bilby",
        content_hash: contentHash("secret"),
      },
    });
    const auth: AuthInfo = {
      role: "promoter",
      clientId: "openbrain-promoter",
      tokenClientId: "openbrain-promoter",
      namespaceSource: "token",
    };
    const { client, cleanup } = await setupToolClient(mockPool, auth);
    try {
      const res = await client.callTool({
        name: "promote_shared",
        arguments: { table: "thoughts", id: SOURCE_ID, dry_run: false },
      });
      expect(res.isError).toBe(true);
      expect((res.content as any)[0].text).toContain("reject-secret");
      // Never inserted into shared truth.
      expect((mockPool as any).writes.length).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("REFUSES a person-private entry even for a promoter", async () => {
    const mockPool = createMockPool({
      row: {
        id: SOURCE_ID,
        content: LONG_FACT,
        namespace: "bilby",
        content_hash: contentHash(LONG_FACT),
        extracted_metadata: { private: true },
      },
    });
    const auth: AuthInfo = {
      role: "promoter",
      clientId: "openbrain-promoter",
      tokenClientId: "openbrain-promoter",
      namespaceSource: "token",
    };
    const { client, cleanup } = await setupToolClient(mockPool, auth);
    try {
      const res = await client.callTool({
        name: "promote_shared",
        arguments: { table: "thoughts", id: SOURCE_ID, dry_run: false },
      });
      expect(res.isError).toBe(true);
      expect((res.content as any)[0].text).toContain("reject-private");
      expect((mockPool as any).writes.length).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("returns not-found for a missing source entry", async () => {
    const mockPool = createMockPool({ row: null });
    const auth: AuthInfo = {
      role: "promoter",
      clientId: "openbrain-promoter",
      tokenClientId: "openbrain-promoter",
      namespaceSource: "token",
    };
    const { client, cleanup } = await setupToolClient(mockPool, auth);
    try {
      const res = await client.callTool({
        name: "promote_shared",
        arguments: { table: "thoughts", id: SOURCE_ID },
      });
      expect(res.isError).toBe(true);
      expect((res.content as any)[0].text).toContain("not found");
    } finally {
      await cleanup();
    }
  });

  it("scopes the pre-classification source read for delegated/header identities", async () => {
    const mockPool = createMockPool({
      row: {
        id: SOURCE_ID,
        content: LONG_FACT,
        namespace: "bilby",
        content_hash: contentHash(LONG_FACT),
      },
    });
    const auth: AuthInfo = {
      role: "promoter",
      clientId: "skippy",
      tokenClientId: "openbrain-promoter",
      agentId: "skippy",
      namespaceSource: "header",
    };
    const { client, cleanup } = await setupToolClient(mockPool, auth);
    try {
      const res = await client.callTool({
        name: "promote_shared",
        arguments: { table: "thoughts", id: SOURCE_ID, dry_run: false },
      });
      expect(res.isError).toBe(true);
      expect((res.content as any)[0].text).toContain("not found");
      expect((mockPool as any).writes.length).toBe(0);
      expect((mockPool as any).reads[0].sql).toContain("namespace = ANY");
      expect((mockPool as any).reads[0].params[1]).toEqual([
        "skippy",
        "shared-kb",
      ]);
    } finally {
      await cleanup();
    }
  });
});

// ── DB-BACKED INTEGRATION ──
// Gated on OPENBRAIN_TEST_DATABASE_URL. Proves a nominated own-namespace thought
// lands in shared-kb with provenance and is idempotent on re-run.
//   OPENBRAIN_TEST_DATABASE_URL=postgres://... bun test src/tools/__tests__/promote-shared.test.ts
const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;

dbDescribe("promote_shared (live Postgres)", () => {
  const pool = new Pool({ connectionString: DB_URL });
  const ns = "test-promote-shared-live";

  async function callPromoteShared(
    args: Record<string, unknown>,
    auth: AuthInfo,
  ) {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const deps: ToolDeps = { pool: pool as any, embedFn: createMockEmbed() };
    registerPromoteShared(server, deps);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const original = ct.send.bind(ct);
    ct.send = (m: any, o?: any) => original(m, { ...o, authInfo: auth });
    const client = new Client({ name: "tc", version: "1.0.0" });
    await server.connect(st);
    await client.connect(ct);
    const res = await client.callTool({
      name: "promote_shared",
      arguments: args,
    });
    await client.close();
    await server.close();
    return res;
  }

  async function seedThought(content: string): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO thoughts (content, namespace, created_by, content_hash)
       VALUES ($1, $2, $2, $3)
       RETURNING id`,
      [content, ns, content.slice(0, 60) + Math.random().toString(36)],
    );
    return rows[0].id as string;
  }

  async function cleanup() {
    // Source rows in the test's own namespace.
    await pool.query("DELETE FROM thoughts WHERE namespace = $1", [ns]);
    // Promoted copies land in shared-kb. promoteEntry copies the SOURCE row's
    // created_by verbatim (seedThought sets created_by = ns, NOT the promoter
    // identity), so a created_by='openbrain-promoter' predicate MISSES them and
    // the leaked row makes the next run resolve to "duplicate". Delete the
    // promoted copies by their provenance, which points back at this test's
    // namespace — precise and never touches unrelated shared-kb rows.
    await pool.query(
      "DELETE FROM thoughts WHERE namespace = 'shared-kb' AND promoted_from->>'source_physical_namespace' = $1",
      [ns],
    );
  }

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("promotes a nominated thought into shared-kb with provenance, idempotent", async () => {
    await cleanup();
    const content =
      "Live durable shared fact about the open-brain shared-kb promotion path test";
    const id = await seedThought(content);
    const auth: AuthInfo = {
      role: "promoter",
      clientId: "openbrain-promoter",
      tokenClientId: "openbrain-promoter",
      namespaceSource: "token",
    };

    const first = await callPromoteShared(
      { table: "thoughts", id, dry_run: false },
      auth,
    );
    expect(first.isError).toBeFalsy();
    expect(JSON.parse((first.content as any)[0].text).status).toBe("promoted");

    const { rows } = await pool.query(
      "SELECT promoted_from FROM thoughts WHERE namespace = 'shared-kb' AND content = $1",
      [content],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].promoted_from.target_kind).toBe("shared-kb");
    expect(rows[0].promoted_from.source_id).toBe(id);

    // Re-run is idempotent (duplicate, no second row).
    const second = await callPromoteShared(
      { table: "thoughts", id, dry_run: false },
      auth,
    );
    expect(JSON.parse((second.content as any)[0].text).status).toBe("duplicate");
    const { rows: after } = await pool.query(
      "SELECT count(*)::int AS n FROM thoughts WHERE namespace = 'shared-kb' AND content = $1",
      [content],
    );
    expect(after[0].n).toBe(1);
  });
});
