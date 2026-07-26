/**
 * Live-Postgres coverage for set_tier, the single-row dream mutator.
 *
 * The focused suite (set-tier.test.ts) is comparatively strong: it already
 * covers roles, output shape, and asserts that a namespace predicate is
 * present in the SQL with the right params. This suite deliberately does NOT
 * repeat any of that. It covers only what a fake pool cannot express:
 *
 *  1. The mutation PERSISTS. The fake proves the handler returns the tier it
 *     was handed back; only a re-read proves the row actually changed.
 *  2. Postgres genuinely evaluates the predicate: a foreign-namespace id is a
 *     no-op and the target row is unchanged field-for-field. The mock asserts
 *     the predicate string and params; it cannot assert the row survived.
 *  3. The denial is indistinguishable from a missing row at the caller
 *     boundary -- both return "Entry not found or archived". That is
 *     deliberate (a distinct denial reply would be an existence oracle for
 *     rows the caller cannot read), so it is pinned as intended behaviour
 *     rather than left to be "fixed" later.
 *  4. `archived_at IS NULL` is a real timestamp comparison, tested on a row in
 *     the caller's OWN namespace so archival is the only thing excluding it.
 *  5. Every tier value in the Zod enum round-trips through the real column,
 *     including a same-value write, which must report success rather than
 *     "not found" -- UPDATE matches the row even when the value is unchanged.
 *
 * Gated on OPENBRAIN_TEST_DATABASE_URL (repo dbDescribe convention).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runMigrations } from "../../db/migrate.ts";
import { registerSetTier } from "../set-tier.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;

const CREATED_BY = "dream-set-tier-pg-test";
const OWNER_NS = "dream-set-tier-owner-ns";
const FOREIGN_NS = "dream-set-tier-foreign-ns";

// Token-scoped agent: writable namespaces resolve to [OWNER_NS], producing the
// `AND namespace = ANY($n)` containment predicate this suite exercises.
const ownerAuth: AuthInfo = {
  role: "agent",
  clientId: OWNER_NS,
  namespaceSource: "token",
};

dbDescribe("set_tier (live Postgres)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await runMigrations(pool);
    await cleanup();
  });

  afterEach(cleanup);

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  async function cleanup(): Promise<void> {
    for (const table of ["thoughts", "decisions"]) {
      await pool.query(`DELETE FROM ${table} WHERE created_by = $1`, [
        CREATED_BY,
      ]);
    }
  }

  async function seedThought(opts: {
    namespace: string;
    tier: string;
    content: string;
    archivedAt?: Date | null;
  }): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO thoughts (content, created_by, namespace, tier, archived_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        opts.content,
        CREATED_BY,
        opts.namespace,
        opts.tier,
        opts.archivedAt ?? null,
      ],
    );
    return rows[0].id as string;
  }

  async function readRow(id: string): Promise<Record<string, unknown>> {
    const { rows } = await pool.query(
      `SELECT id, tier, namespace, archived_at, content, updated_at
         FROM thoughts WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async function readTier(id: string): Promise<string> {
    return (await readRow(id)).tier as string;
  }

  async function callSetTier(
    auth: AuthInfo,
    args: { table: string; id: string; tier: string },
  ) {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const deps: ToolDeps = { pool: pool as any, embedFn: async () => null };
    registerSetTier(server, deps);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const originalSend = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message: any, options?: any) =>
      originalSend(message, { ...options, authInfo: auth });

    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      return await client.callTool({ name: "set_tier", arguments: args });
    } finally {
      await client.close();
      await server.close();
    }
  }

  it("persists the new tier for a row in the caller's namespace", async () => {
    const id = await seedThought({
      namespace: OWNER_NS,
      tier: "warm",
      content: "persist-me",
    });

    const result = await callSetTier(ownerAuth, {
      table: "thoughts",
      id,
      tier: "hot",
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content as any)[0].text)).toEqual({
      id,
      table: "thoughts",
      tier: "hot",
    });

    // The response echoes the RETURNING clause. Only this read distinguishes
    // "the row changed" from "the statement reported a change".
    expect(await readTier(id)).toBe("hot");
  });

  it("leaves a foreign-namespace row untouched and reports it as not found", async () => {
    const foreign = await seedThought({
      namespace: FOREIGN_NS,
      tier: "cold",
      content: "not-yours",
    });
    const before = await readRow(foreign);

    const result = await callSetTier(ownerAuth, {
      table: "thoughts",
      id: foreign,
      tier: "hot",
    });

    // Denied and missing are the same reply on purpose: distinguishing them
    // would confirm the existence of a row in a namespace the caller cannot
    // read. Pinned here so the ambiguity is understood as intended.
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toBe("Entry not found or archived");

    // The whole row, not just the tier: this is the assertion the mock cannot
    // make, and the one that fails if the predicate is ever dropped.
    expect(await readRow(foreign)).toEqual(before);
  });

  it("returns the same reply for an id that does not exist at all", async () => {
    // The other half of proof 3: the denial above is only non-informative if a
    // genuinely absent row is reported identically.
    const result = await callSetTier(ownerAuth, {
      table: "thoughts",
      id: "550e8400-e29b-41d4-a716-4466554400ff",
      tier: "hot",
    });

    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toBe("Entry not found or archived");
  });

  it("refuses an archived row in the caller's own namespace", async () => {
    const id = await seedThought({
      namespace: OWNER_NS,
      tier: "warm",
      content: "archived-row",
      archivedAt: new Date("2020-01-01T00:00:00Z"),
    });

    const result = await callSetTier(ownerAuth, {
      table: "thoughts",
      id,
      tier: "hot",
    });

    expect(result.isError).toBe(true);
    expect(await readTier(id)).toBe("warm");
  });

  it("round-trips every tier value through the real column", async () => {
    // The column is plain text with a default; the enum lives in Zod. If a
    // constraint were ever added that disagreed with the enum, the mismatch
    // would surface here rather than in production.
    for (const tier of ["hot", "warm", "cold"]) {
      const id = await seedThought({
        namespace: OWNER_NS,
        tier: "warm",
        content: `roundtrip-${tier}`,
      });
      const result = await callSetTier(ownerAuth, {
        table: "thoughts",
        id,
        tier,
      });
      expect(result.isError).toBeFalsy();
      expect(await readTier(id)).toBe(tier);
    }
  });

  it("reports success when the tier is already the requested value", async () => {
    // A no-change UPDATE still MATCHES the row, so RETURNING yields it and the
    // caller sees success. Worth pinning: if this ever reported "not found",
    // an idempotent retry would look like a failure to the dream engine, which
    // re-runs planned actions.
    const id = await seedThought({
      namespace: OWNER_NS,
      tier: "hot",
      content: "already-hot",
    });

    const result = await callSetTier(ownerAuth, {
      table: "thoughts",
      id,
      tier: "hot",
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content as any)[0].text).tier).toBe("hot");
    expect(await readTier(id)).toBe("hot");
  });
});
