import { describe, it, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { registerTierLane } from "../tier-lane.ts";
import { contentHash } from "../../embedding.ts";
import {
  createMockEmbed,
  setupMcpClient,
  parseToolResult,
  getErrorText,
  type MockPool,
} from "./test-helpers.ts";
import type { AuthInfo } from "../../types.ts";

/** A graduate-eligible event row joined with its lane. */
function laneEventRow(overrides: Record<string, unknown> = {}) {
  const content = "This is a substantive durable fact that exceeds the minimum length";
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
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    writes,
    query: async (sql: string, params: unknown[] = []) => {
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

function setupToolClient(
  mockPool: MockPool,
  auth: AuthInfo,
  embedFn?: ReturnType<typeof createMockEmbed>,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  return setupMcpClient(registerTierLane, mockPool, embedFn ?? createMockEmbed(), auth);
}

describe("tier_lane AUTH", () => {
  it("denies when auth is missing entirely", async () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    // `auth: null` leaves the transport unwired, so the call arrives with no
    // AuthInfo at all -- which is the case under test.
    const { client, cleanup } = await setupMcpClient(
      registerTierLane,
      mockPool,
      createMockEmbed(),
      null,
    );

    try {
      const res = await client.callTool({
        name: "tier_lane",
        arguments: { session_key: "task-42" },
      });
      expect(res.isError).toBe(true);
      expect(getErrorText(res)).toContain("Permission denied");
    } finally {
      await cleanup();
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
      expect(getErrorText(res)).toContain("Permission denied");
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
      expect(getErrorText(res)).toContain("Permission denied");
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
      expect(getErrorText(res)).toContain("Permission denied");
    } finally {
      await cleanup();
    }
  });
});

describe("tier_lane DRY RUN", () => {
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
      const parsed = parseToolResult(res);
      expect(parsed.dry_run).toBe(true);
      expect(parsed.scanned).toBe(1);
      expect(parsed.graduated).toBe(1);
      expect(mockPool.writes.length).toBe(0);
    } finally {
      await cleanup();
    }
  });
});

describe("tier_lane APPLY", () => {
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
      const parsed = parseToolResult(res);
      expect(parsed.graduated).toBe(1);
      expect(mockPool.writes.length).toBe(1);
      // provenance + tags carried into the INSERT params
      const write = mockPool.writes[0];
      expect(write).toBeDefined();
      const provenance = JSON.parse(String(write?.params[8]));
      expect(provenance.source).toBe("session-lane");
      expect(provenance.lane_id).toBe("lane-1");
      expect(provenance.event_id).toBe("evt-1");
      const tags = write?.params[1];
      expect(tags).toContain("tiered-from-lane");
      expect(tags).toContain("lane:task-42");
    } finally {
      await cleanup();
    }
  });
});

describe("tier_lane DEDUP", () => {
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
      const parsed = parseToolResult(res);
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
      const parsed = parseToolResult(res);
      expect(parsed.duplicates).toBe(1);
      expect(parsed.graduated).toBe(0);
      expect(mockPool.writes.length).toBe(0);
    } finally {
      await cleanup();
    }
  });
});

describe("tier_lane RECEIPT SHAPE / CLASSIFICATION", () => {
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
      const parsed = parseToolResult(res);
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
      const parsed = parseToolResult(res);
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
    const { client, cleanup } = await setupToolClient(mockPool as MockPool, auth);
    try {
      const res = await client.callTool({
        name: "tier_lane",
        arguments: { session_key: "task-42", namespace: "bilby" },
      });
      expect(res.isError).toBe(true);
      expect(getErrorText(res)).toContain("connection refused");
    } finally {
      await cleanup();
    }
  });
});
