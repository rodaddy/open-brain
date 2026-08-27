/**
 * Shared harness for the two live-Postgres suites over ingest_conversation_facts
 * (#340). The write-path suite and the isolation/concurrency suite exercise the
 * same public MCP tool boundary against the same seeded fixtures, so the
 * fixtures and the database-touching helpers live here rather than being
 * duplicated in each file.
 *
 * This module holds no test and creates no pool: each suite owns its own
 * module-scope pool and hands it to createIngestHarness.
 */
import type { Pool } from "pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runMigrations } from "../../db/migrate.ts";
import { registerIngestConversationFacts } from "../ingest-conversation-facts.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

// Every row this suite creates is namespaced under one of these two isolation
// namespaces so cleanup deletes exactly what the suite owns and nothing else.
// The owning namespace is where the approved source + scoped lane live; the
// foreign namespace is used only to prove cross-namespace denial.
export const OWNER_NS = "lane340-owner-ns";
export const FOREIGN_NS = "lane340-foreign-ns";

// The exact seven-coordinate scope (six coordinates + namespace) the owning lane
// is bound to. Matches the shape the tool's lane predicate asserts.
export const OWNER_SCOPE = {
  agent: "assistant",
  platform: "discord",
  server_id: "guild-340",
  channel_id: "chan-340",
  thread_id: null as string | null,
  session_key: "sess-340",
};

export const OWNER_SOURCE_EXTERNAL_ID = "conv:room-340";
export const OWNER_SOURCE_REF = {
  source_kind: "conversation" as const,
  external_id: OWNER_SOURCE_EXTERNAL_ID,
};

// A token-scoped agent whose own namespace is OWNER_NS. This is the happy-path
// writer: it may write its own namespace and is denied any foreign one.
export const ownerAuth: AuthInfo = {
  role: "agent",
  clientId: OWNER_NS,
  namespaceSource: "token",
};

// Deterministic embeddings so no live embedding endpoint is required; the tool
// treats an embed result as opaque and stores it as a bound param.
export const stubEmbed = async (): Promise<number[]> => Array(768).fill(0.01);

// A sentinel content string the test-owned trigger raises on, used only to force
// a deterministic mid-batch failure in proof (3).
export const TRIGGER_SENTINEL = "LANE340_TRIGGER_ROLLBACK_SENTINEL";

/** The database-touching harness the two live suites share. */
export interface IngestHarness {
  parse(result: unknown): Record<string, unknown>;
  withTool(auth: AuthInfo, fn: (client: Client) => Promise<void>): Promise<void>;
  eventCount(laneId: string): Promise<number>;
  cleanupData(): Promise<void>;
  seedOwnerFixtures(): Promise<void>;
  migrateAndClean(): Promise<void>;
  cleanAndEnd(): Promise<void>;
  dropTriggerAndClean(): Promise<void>;
  readonly ownerLaneId: string;
  readonly ownerSourceId: string;
}

/**
 * Build the harness against a caller-owned pool. Every database-touching helper
 * closes over that one pool, so a suite creates it once at module scope and ends
 * it once in its own afterAll.
 */
/**
 * First element of a query result, demanded rather than asserted away.
 *
 * The suites index [0] on rows a proof has already established exist, so the
 * non-null assertion carried no information; throwing names the empty result
 * instead of dereferencing undefined.
 */
export function firstRow<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) {
    throw new Error("expected at least one row, received none");
  }
  return item;
}

let ownerSourceId = "";
export function parse(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(firstRow(content).text);
}

// Stand up a public MCP client wired to the real pool for a given auth. This is
// the same public-boundary harness the fake suite uses, so tests assert the
// caller-visible callTool response, never internal SQL or call order.
async function withTool(
  pool: Pool,
  auth: AuthInfo,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = {
    pool: pool as never,
    embedFn: stubEmbed as never,
  };
  registerIngestConversationFacts(server, deps);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const originalSend = clientTransport.send.bind(clientTransport);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  clientTransport.send = (message: any, options?: any) =>
    originalSend(message, { ...options, authInfo: auth });

  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

// Count durable events in a lane whose content matches, so a test can prove
// exactly how many rows a call persisted (or that it persisted none).
async function eventCount(pool: Pool, laneId: string): Promise<number> {
  const { rows } = await pool.query(
    "SELECT count(*)::int AS c FROM ob_session_events WHERE lane_id = $1",
    [laneId],
  );
  return firstRow(rows).c as number;
}

async function cleanupData(pool: Pool): Promise<void> {
  // Events cascade from lanes, but delete explicitly for clarity. Order:
  // events → lanes → sources, all scoped to the suite's two namespaces.
  await pool.query(
    `DELETE FROM ob_session_events
      WHERE lane_id IN (
        SELECT id FROM ob_session_lanes WHERE namespace = ANY($1::text[])
      )`,
    [[OWNER_NS, FOREIGN_NS]],
  );
  await pool.query("DELETE FROM ob_session_lanes WHERE namespace = ANY($1::text[])", [
    [OWNER_NS, FOREIGN_NS],
  ]);
  await pool.query("DELETE FROM ob_sources WHERE namespace = ANY($1::text[])", [
    [OWNER_NS, FOREIGN_NS],
  ]);
}

// Seed the owning approved+active conversation source and the exact-scope lane

export function createIngestHarness(pool: Pool): IngestHarness {
  let ownerLaneId = "";
  // fresh, returning their ids. Called before each proof so no prior state leaks.
  async function seedOwnerFixtures(): Promise<void> {
    const { rows: srcRows } = await pool.query(
      `INSERT INTO ob_sources
         (namespace, source_kind, external_id, approval_state, approved_by,
          approved_at, lifecycle_state, sync_state, created_by)
       VALUES ($1, 'conversation', $2, 'approved', 'admin', now(),
               'active', 'synced', 'admin')
       RETURNING id`,
      [OWNER_NS, OWNER_SOURCE_EXTERNAL_ID],
    );
    ownerSourceId = String(firstRow(srcRows).id);

    const { rows: laneRows } = await pool.query(
      `INSERT INTO ob_session_lanes
         (session_key, namespace, status, agent, source, channel_id, thread_id,
          metadata, created_by)
       VALUES ($1, $2, 'active', $3, $4, $5, $6, $7::jsonb, 'admin')
       RETURNING id`,
      [
        OWNER_SCOPE.session_key,
        OWNER_NS,
        OWNER_SCOPE.agent,
        OWNER_SCOPE.platform,
        OWNER_SCOPE.channel_id,
        OWNER_SCOPE.thread_id,
        JSON.stringify({ server_id: OWNER_SCOPE.server_id }),
      ],
    );
    ownerLaneId = String(firstRow(laneRows).id);
  }

  // The two suites share one lifecycle: migrate once, drop the test-owned
  // trigger and suite data after each proof, and clean up plus end the pool at
  // the end. Living here keeps the two describe bodies to their proofs.
  async function migrateAndClean(): Promise<void> {
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await runMigrations(pool);
    await cleanupData(pool);
  }

  async function cleanAndEnd(): Promise<void> {
    await cleanupData(pool);
    await pool.end();
  }

  async function dropTriggerAndClean(): Promise<void> {
    await pool.query(
      "DROP TRIGGER IF EXISTS lane340_rollback_trigger ON ob_session_events",
    );
    await pool.query("DROP FUNCTION IF EXISTS lane340_rollback_trigger_fn() CASCADE");
    await cleanupData(pool);
  }

  return {
    parse,
    withTool: (auth: AuthInfo, fn: (client: Client) => Promise<void>) =>
      withTool(pool, auth, fn),
    eventCount: (laneId: string) => eventCount(pool, laneId),
    cleanupData: () => cleanupData(pool),
    seedOwnerFixtures,
    migrateAndClean,
    cleanAndEnd,
    dropTriggerAndClean,
    get ownerLaneId() {
      return ownerLaneId;
    },
    get ownerSourceId() {
      return ownerSourceId;
    },
  };
}
