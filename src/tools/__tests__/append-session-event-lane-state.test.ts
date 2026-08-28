/**
 * Lane-state, defaulting, and event-type coverage for `append_session_event`,
 * split out of append-session-event.test.ts so each half stays a readable size.
 */
import { describe, it, expect } from "bun:test";
import type { AuthInfo } from "../../types.ts";
import { getErrorText, parseToolResult } from "./test-helpers.ts";
import {
  createThrowingEmbed,
  setupToolClient,
  createLaneFoundPool,
} from "./append-session-event-test-helpers.ts";

// ── ARCHIVED LANE ──

async function laneStateCase1() {
  const mockPool = createLaneFoundPool(
    "lane-uuid-1",
    "event-uuid-1",
    "2026-06-08T10:00:00Z",
    "archived",
  );
  const auth: AuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "old-lane",
        event_type: "fact",
        content: "Should not be appended",
      },
    });
    expect(result.isError).toBe(true);
    expect(getErrorText(result)).toContain("archived");
    expect(getErrorText(result)).toContain("reactivate");
  } finally {
    await cleanup();
  }
}

async function laneStateCase2() {
  const mockPool = createLaneFoundPool(
    "lane-uuid-1",
    "event-uuid-1",
    "2026-06-08T10:00:00Z",
    "wrapped",
  );
  const auth: AuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "wrapped-lane",
        event_type: "handoff",
        content: "Late event during wrap",
      },
    });
    expect(result.isError).toBeFalsy();
  } finally {
    await cleanup();
  }
}

// ── DUPLICATE DETECTION ──

async function laneStateCase3() {
  const mockPool = {
    query: async (sql: string, _params?: unknown[]) => {
      if (sql.includes("ob_session_lanes")) {
        return { rows: [{ id: "lane-uuid-1", status: "active" }] };
      }
      // INSERT returns no rows due to ON CONFLICT DO NOTHING
      return { rows: [] };
    },
  };
  const auth: AuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "test",
        event_type: "fact",
        content: "Already exists",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = parseToolResult(result);
    expect(parsed.duplicate).toBe(true);
    expect(parsed.message).toContain("identical content");
    expect(parsed.writer_identity).toBe("skippy");
    expect(parsed.token_identity).toBe("skippy");
    expect(parsed.delegated_agent_id).toBeNull();
    expect(parsed.namespace_source).toBe("token");
  } finally {
    await cleanup();
  }
}

// ── NAMESPACE DEFAULTING ──

async function laneStateCase4() {
  const mockPool = createLaneFoundPool();
  const auth: AuthInfo = { role: "admin", clientId: "bilby-agent" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "my-lane",
        event_type: "fact",
        content: "Something happened",
      },
    });

    // Tool succeeds -- lane was found using the defaulted namespace
    expect(result.isError).toBeFalsy();
    const parsed = parseToolResult(result);
    expect(parsed.event_id).toBe("event-uuid-1");
    expect(parsed.lane_id).toBe("lane-uuid-1");
  } finally {
    await cleanup();
  }
}

// ── IMPORTANCE DEFAULTING ──

async function laneStateCase5() {
  const mockPool = createLaneFoundPool();
  const auth: AuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "test",
        event_type: "fact",
        content: "Default importance test",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = parseToolResult(result);
    expect(parsed.importance).toBe("warm");
  } finally {
    await cleanup();
  }
}

// ── EMBEDDING PATHS ──

async function laneStateCase6() {
  const mockPool = createLaneFoundPool();
  const auth: AuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(
    mockPool,
    auth,
    createThrowingEmbed(new Error("embedding provider timeout")),
  );

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "test",
        event_type: "blocker",
        content: "Something is blocking progress",
      },
    });

    // Should succeed despite embedding failure
    expect(result.isError).toBeFalsy();
    const parsed = parseToolResult(result);
    expect(parsed.event_id).toBe("event-uuid-1");
  } finally {
    await cleanup();
  }
}

// ── ALL EVENT TYPES ──

const allEventTypes = [
  "fact",
  "decision",
  "blocker",
  "action",
  "artifact",
  "receipt",
  "question",
  "correction",
  "handoff",
] as const;

async function laneStateCase7(eventType: (typeof allEventTypes)[number]) {
  const mockPool = createLaneFoundPool();
  const auth: AuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "test",
        event_type: eventType,
        content: `Testing ${eventType} event type`,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = parseToolResult(result);
    expect(parsed.event_type).toBe(eventType);
  } finally {
    await cleanup();
  }
}

// ── OPTIONAL FIELDS ──

async function laneStateCase8() {
  const mockPool = createLaneFoundPool();
  const auth: AuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "test",
        event_type: "fact",
        content: "Minimal event",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = parseToolResult(result);
    expect(parsed.event_id).toBe("event-uuid-1");
    expect(parsed.event_type).toBe("fact");
    expect(parsed.importance).toBe("warm");
  } finally {
    await cleanup();
  }
}

describe("append_session_event lane state, defaults, and event types", () => {
  it("rejects append to archived lane", laneStateCase1);

  it("allows append to wrapped lane", laneStateCase2);

  it("returns duplicate response when content_hash conflicts", laneStateCase3);

  it("defaults namespace to auth.clientId when not provided", laneStateCase4);

  it("defaults importance to 'warm' when not provided", laneStateCase5);

  it("embedding failure is non-fatal — event still inserted", laneStateCase6);

  for (const eventType of allEventTypes) {
    it(`accepts event_type="${eventType}"`, () => laneStateCase7(eventType));
  }

  it(
    "succeeds with only required fields (source, artifact_path omitted)",
    laneStateCase8,
  );
});
