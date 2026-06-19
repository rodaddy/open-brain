import { describe, it, expect, afterAll } from "bun:test";
import { Pool } from "pg";
import { toSql } from "pgvector/pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTierLane } from "../tier-lane.ts";
import { contentHash } from "../../embedding.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

function createMockEmbed(result: number[] | null = Array(768).fill(0.1)) {
  return async (_text: string) => result;
}

/** A graduate-eligible event row joined with its lane. */
function laneEventRow(overrides: Record<string, unknown> = {}) {
  const content =
    "This is a substantive durable fact that exceeds the minimum length";
  return {
    id: "evt-1",
    lane_id: "lane-1",
    namespace: "bilby",
    agent: "bilby",
    session_key: "task-42",
    event_type: "fact",
    content,
    importance: "warm",
    content_hash: contentHash(content),
    created_at: "2026-06-07T15:30:00Z",
    ...overrides,
  };
}

/**
 * Mock pool that routes by SQL shape:
 *  - JOIN ob_session_events → lane events
 *  - exact dedup (content_hash = ...) → controllable hit/miss
 *  - near dedup (embedding <=> ...) → controllable hit/miss
 *  - INSERT INTO thoughts → records a write
 */
function createMockPool(opts: {
  events: Array<Record<string, unknown>>;
  exactDup?: boolean;
  nearDup?: boolean;
}) {
  const writes: Array<{ sql: string; params: any[] }> = [];
  const pool = {
    writes,
    query: async (sql: string, params: any[] = []) => {
      if (sql.includes("FROM ob_session_events")) {
        return { rows: opts.events };
      }
      if (sql.includes("INSERT INTO thoughts")) {
        writes.push({ sql, params });
        return { rows: [{ id: "thought-new", is_new: true }] };
      }
      // exact dedup query
      if (sql.includes("content_hash = $1") && sql.includes("FROM thoughts")) {
        return { rows: opts.exactDup ? [{ id: "dup-exact" }] : [] };
      }
      // near dedup query
      if (sql.includes("embedding <=> $1") && sql.includes("FROM thoughts")) {
        return {
          rows: opts.nearDup ? [{ id: "dup-near", distance: 0.02 }] : [],
        };
      }
      return { rows: [] };
    },
  };
  return pool;
}

async function setupToolClient(
  mockPool: { query: (...args: any[]) => Promise<{ rows: any[] }> },
  auth: AuthInfo,
  embedFn?: (text: string) => Promise<number[] | null>,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = {
    pool: mockPool as any,
    embedFn: embedFn ?? createMockEmbed(),
  };
  registerTierLane(server, deps);

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

describe("tier_lane", () => {
  // ── AUTH ──

  it("denies when auth is missing entirely", async () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const deps: ToolDeps = { pool: mockPool as any, embedFn: createMockEmbed() };
    registerTierLane(server, deps);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "tc", version: "1.0.0" });
    await server.connect(st);
    await client.connect(ct);

    try {
      const res = await client.callTool({
        name: "tier_lane",
        arguments: { session_key: "task-42" },
      });
      expect(res.isError).toBe(true);
      expect((res.content as any)[0].text).toContain("Permission denied");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("denies readonly role", async () => {
    const mockPool = createMockPool({ events: [] });
    const auth: AuthInfo = { role: "readonly", clientId: "viewer" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);
    try {
      const res = await client.callTool({
        name: "tier_lane",
        arguments: { session_key: "task-42" },
      });
      expect(res.isError).toBe(true);
      expect((res.content as any)[0].text).toContain("Permission denied");
    } finally {
      await cleanup();
    }
  });

  it("agent CAN tier its OWN namespace", async () => {
    const mockPool = createMockPool({ events: [] });
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);
    try {
      const res = await client.callTool({
        name: "tier_lane",
        arguments: { session_key: "task-42", namespace: "bilby" },
      });
      expect(res.isError).toBeFalsy();
    } finally {
      await cleanup();
    }
  });

  it("agent CANNOT tier another agent's namespace", async () => {
    const mockPool = createMockPool({ events: [] });
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);
    try {
      const res = await client.callTool({
        name: "tier_lane",
        arguments: { session_key: "task-42", namespace: "skippy" },
      });
      expect(res.isError).toBe(true);
      expect((res.content as any)[0].text).toContain("Permission denied");
    } finally {
      await cleanup();
    }
  });

  it("agent with X-Namespace header cannot tier a different namespace", async () => {
    const mockPool = createMockPool({ events: [] });
    const auth: AuthInfo = {
      role: "agent",
      clientId: "bilby",
      namespaceSource: "header",
    };
    const { client, cleanup } = await setupToolClient(mockPool, auth);
    try {
      const res = await client.callTool({
        name: "tier_lane",
        arguments: { session_key: "task-42", namespace: "other" },
      });
      expect(res.isError).toBe(true);
      expect((res.content as any)[0].text).toContain("Permission denied");
    } finally {
      await cleanup();
    }
  });

  // ── DRY RUN ──

  it("dry-run (default) performs NO writes and reports would-graduate", async () => {
    const mockPool = createMockPool({ events: [laneEventRow()] });
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);
    try {
      const res = await client.callTool({
        name: "tier_lane",
        arguments: { session_key: "task-42", namespace: "bilby" },
      });
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse((res.content as any)[0].text);
      expect(parsed.dry_run).toBe(true);
      expect(parsed.scanned).toBe(1);
      expect(parsed.graduated).toBe(1);
      expect(mockPool.writes.length).toBe(0);
    } finally {
      await cleanup();
    }
  });

  // ── APPLY ──

  it("apply mode writes a graduated thought", async () => {
    const mockPool = createMockPool({ events: [laneEventRow()] });
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);
    try {
      const res = await client.callTool({
        name: "tier_lane",
        arguments: {
          session_key: "task-42",
          namespace: "bilby",
          dry_run: false,
        },
      });
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse((res.content as any)[0].text);
      expect(parsed.graduated).toBe(1);
      expect(mockPool.writes.length).toBe(1);
      // provenance + tags carried into the INSERT params
      const write = mockPool.writes[0]!;
      const provenance = JSON.parse(write.params[8]);
      expect(provenance.source).toBe("session-lane");
      expect(provenance.lane_id).toBe("lane-1");
      expect(provenance.event_id).toBe("evt-1");
      const tags = write.params[1];
      expect(tags).toContain("tiered-from-lane");
      expect(tags).toContain("lane:task-42");
    } finally {
      await cleanup();
    }
  });

  // ── DEDUP ──

  it("skips an exact-hash duplicate (no write)", async () => {
    const mockPool = createMockPool({
      events: [laneEventRow()],
      exactDup: true,
    });
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);
    try {
      const res = await client.callTool({
        name: "tier_lane",
        arguments: {
          session_key: "task-42",
          namespace: "bilby",
          dry_run: false,
        },
      });
      const parsed = JSON.parse((res.content as any)[0].text);
      expect(parsed.duplicates).toBe(1);
      expect(parsed.graduated).toBe(0);
      expect(mockPool.writes.length).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("skips a near-embedding duplicate (no write)", async () => {
    const mockPool = createMockPool({
      events: [laneEventRow({ content_hash: null })],
      nearDup: true,
    });
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);
    try {
      const res = await client.callTool({
        name: "tier_lane",
        arguments: {
          session_key: "task-42",
          namespace: "bilby",
          dry_run: false,
        },
      });
      const parsed = JSON.parse((res.content as any)[0].text);
      expect(parsed.duplicates).toBe(1);
      expect(parsed.graduated).toBe(0);
      expect(mockPool.writes.length).toBe(0);
    } finally {
      await cleanup();
    }
  });

  // ── RECEIPT SHAPE / CLASSIFICATION ──

  it("returns the full receipt shape across mixed event types", async () => {
    const long = "x".repeat(40);
    const mockPool = createMockPool({
      events: [
        laneEventRow({ id: "e-fact", event_type: "fact", content: long }),
        laneEventRow({
          id: "e-q",
          event_type: "question",
          content: long,
          content_hash: contentHash(`q-${long}`),
        }),
        laneEventRow({
          id: "e-blocker",
          event_type: "blocker",
          content: long,
          content_hash: contentHash(`b-${long}`),
        }),
        laneEventRow({
          id: "e-short",
          event_type: "decision",
          content: "tiny",
          content_hash: contentHash("tiny"),
        }),
        laneEventRow({
          id: "e-cold",
          event_type: "handoff",
          importance: "cold",
          content: long,
          content_hash: contentHash(`c-${long}`),
        }),
      ],
    });
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);
    try {
      const res = await client.callTool({
        name: "tier_lane",
        arguments: { session_key: "task-42", namespace: "bilby" },
      });
      const parsed = JSON.parse((res.content as any)[0].text);
      expect(parsed.scanned).toBe(5);
      expect(parsed.graduated).toBe(1); // fact/warm/long
      expect(parsed.archived).toBe(2); // question + cold handoff
      expect(parsed.kept).toBe(1); // blocker
      expect(parsed.manual_review).toBe(1); // short decision
      expect(parsed).toHaveProperty("duplicates");
      expect(parsed).toHaveProperty("dry_run");
    } finally {
      await cleanup();
    }
  });

  it("defaults namespace to caller clientId", async () => {
    const mockPool = createMockPool({ events: [] });
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupToolClient(mockPool, auth);
    try {
      const res = await client.callTool({
        name: "tier_lane",
        arguments: { session_key: "task-42" },
      });
      const parsed = JSON.parse((res.content as any)[0].text);
      expect(parsed.namespace).toBe("bilby");
    } finally {
      await cleanup();
    }
  });

  it("returns isError when the DB query throws", async () => {
    const mockPool = {
      query: async () => {
        throw new Error("connection refused");
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "bilby" };
    const { client, cleanup } = await setupToolClient(mockPool as any, auth);
    try {
      const res = await client.callTool({
        name: "tier_lane",
        arguments: { session_key: "task-42", namespace: "bilby" },
      });
      expect(res.isError).toBe(true);
      expect((res.content as any)[0].text).toContain("connection refused");
    } finally {
      await cleanup();
    }
  });
});

// ── DB-BACKED INTEGRATION ──
// Mocks can't catch real Postgres halfvec/embedding behavior, the ON CONFLICT
// idempotency, or cosine-distance dedup. Gated on OPENBRAIN_TEST_DATABASE_URL.
//   OPENBRAIN_TEST_DATABASE_URL=postgres://... bun test src/tools/__tests__/tier-lane.test.ts
const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;

dbDescribe("tier_lane (live Postgres)", () => {
  const pool = new Pool({ connectionString: DB_URL });
  const ns = "test-tier-lane-live";
  const sessionKey = "live-tier-lane";
  // Deterministic embeddings so near-dup behavior is testable.
  const baseEmbedding = Array(768).fill(0.1);
  const embedFn = createMockEmbed(baseEmbedding);

  async function callTierLane(args: Record<string, unknown>, auth: AuthInfo) {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const deps: ToolDeps = { pool: pool as any, embedFn };
    registerTierLane(server, deps);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const original = ct.send.bind(ct);
    ct.send = (m: any, o?: any) => original(m, { ...o, authInfo: auth });
    const client = new Client({ name: "tc", version: "1.0.0" });
    await server.connect(st);
    await client.connect(ct);
    const res = await client.callTool({ name: "tier_lane", arguments: args });
    await client.close();
    await server.close();
    return res;
  }

  async function seedLaneWithEvent(content: string, eventType = "fact") {
    const { rows } = await pool.query(
      `INSERT INTO ob_session_lanes (session_key, namespace, agent, created_by)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (namespace, session_key) DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      [sessionKey, ns, ns],
    );
    const laneId = rows[0].id as string;
    await pool.query(
      `INSERT INTO ob_session_events
         (lane_id, event_type, content, importance, content_hash, embedding, created_by)
       VALUES ($1, $2, $3, 'warm', $4, $5, $6)
       ON CONFLICT (lane_id, content_hash) WHERE content_hash IS NOT NULL
       DO NOTHING`,
      [laneId, eventType, content, contentHash(content), toSql(baseEmbedding), ns],
    );
    return laneId;
  }

  async function cleanup() {
    await pool.query("DELETE FROM ob_session_lanes WHERE namespace = $1", [ns]);
    await pool.query("DELETE FROM thoughts WHERE namespace = $1", [ns]);
  }

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("graduates a fact into the namespace with provenance, idempotent on re-run", async () => {
    await cleanup();
    const content =
      "Live durable fact about the open-brain tiering integration test path";
    await seedLaneWithEvent(content);
    const auth: AuthInfo = { role: "agent", clientId: ns };

    const first = await callTierLane(
      { session_key: sessionKey, namespace: ns, dry_run: false },
      auth,
    );
    expect(first.isError).toBeFalsy();
    expect(JSON.parse((first.content as any)[0].text).graduated).toBe(1);

    const { rows: afterFirst } = await pool.query(
      "SELECT id, promoted_from, tags FROM thoughts WHERE namespace = $1",
      [ns],
    );
    expect(afterFirst.length).toBe(1);
    expect(afterFirst[0].promoted_from.source).toBe("session-lane");
    expect(afterFirst[0].tags).toContain("tiered-from-lane");

    // Re-run: ON CONFLICT idempotency — exact-hash dedup skips, no new row.
    const second = await callTierLane(
      { session_key: sessionKey, namespace: ns, dry_run: false },
      auth,
    );
    expect(second.isError).toBeFalsy();
    expect(JSON.parse((second.content as any)[0].text).duplicates).toBe(1);

    const { rows: afterSecond } = await pool.query(
      "SELECT count(*)::int AS n FROM thoughts WHERE namespace = $1",
      [ns],
    );
    expect(afterSecond[0].n).toBe(1);
  });

  it("skips a near-duplicate by embedding distance", async () => {
    await cleanup();
    const auth: AuthInfo = { role: "agent", clientId: ns };
    // First event graduates.
    await seedLaneWithEvent(
      "Original durable statement that should graduate into thoughts cleanly",
    );
    await callTierLane(
      { session_key: sessionKey, namespace: ns, dry_run: false },
      auth,
    );

    // Second event: different text + hash but identical embedding → near-dup.
    await seedLaneWithEvent(
      "A slightly reworded but semantically identical durable statement here",
    );
    const res = await callTierLane(
      { session_key: sessionKey, namespace: ns, dry_run: false },
      auth,
    );
    const parsed = JSON.parse((res.content as any)[0].text);
    // The tool re-scans the whole lane, so BOTH events are now duplicates:
    // event 1 by exact content_hash (already graduated), event 2 by near
    // embedding distance. The point is that the near-dup event 2 did NOT
    // graduate (no new row), proving embedding dedup works.
    expect(parsed.graduated).toBe(0);
    expect(parsed.duplicates).toBe(2);

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM thoughts WHERE namespace = $1",
      [ns],
    );
    expect(rows[0].n).toBe(1);
  });
});
