/**
 * Lane creation and scope coverage for `append_session_event`, split out of
 * append-session-event.test.ts so each half stays a readable size.
 */
import { describe, it, expect } from "bun:test";
import type { AuthInfo } from "../../types.ts";
import { contentHash } from "../../embedding.ts";
import { parseToolResult } from "./test-helpers.ts";
import { withToolClient, expectDefined } from "./append-session-event-test-helpers.ts";

/**
 * The standard active discord lane row these mocks return from
 * `FROM ob_session_lanes`; only the id and the thread differ between cases.
 */
function scopedLaneRow(id: string, threadId: string | null) {
  return {
    id,
    status: "active",
    agent: "nagatha",
    source: "discord",
    channel_id: "channel-1",
    thread_id: threadId,
    metadata: { server_id: "guild-1" },
  };
}

async function createsScopedLane() {
  const captured: {
    laneInsertParams?: unknown[];
    eventInsertParams?: unknown[];
    embedInputs: string[];
  } = { embedInputs: [] };
  const mockPool = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO ob_session_lanes")) {
        captured.laneInsertParams = params;
        return {
          rows: [scopedLaneRow("lane-uuid-new", "thread-1")],
        };
      }
      if (sql.includes("FROM ob_session_lanes")) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO ob_session_events")) {
        captured.eventInsertParams = params;
        return {
          rows: [{ id: "event-uuid-1", created_at: "2026-06-28T18:00:00Z" }],
        };
      }
      return { rows: [] };
    },
  };
  const auth: AuthInfo = { role: "agent", clientId: "nagatha" };
  await withToolClient(
    mockPool,
    auth,
    async (text) => {
      captured.embedInputs.push(text);
      return Array(768).fill(0.1);
    },
    async (client) => {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "discord:guild-1:channel-1:thread-1:nagatha",
          create_if_missing: true,
          agent: "nagatha",
          platform: "discord",
          server_id: "guild-1",
          channel_id: "channel-1",
          thread_id: "thread-1",
          project: "rtech-hermes",
          topic: "Nagatha Discord scoped memory",
          event_type: "correction",
          content: "GitHub issue URLs must use live gh first.",
          source: "nagatha",
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = parseToolResult(result);
      expect(parsed.event_id).toBe("event-uuid-1");
      expect(parsed.lane_id).toBe("lane-uuid-new");
      expect(parsed.lane_created).toBe(true);
      expect(captured.laneInsertParams?.slice(0, 9)).toEqual([
        "discord:guild-1:channel-1:thread-1:nagatha",
        "nagatha",
        "nagatha",
        "discord",
        "channel-1",
        "thread-1",
        "rtech-hermes",
        "Nagatha Discord scoped memory",
        JSON.stringify({ server_id: "guild-1" }),
      ]);
      expect(captured.laneInsertParams?.[9]).toBeNull();
      expect(captured.laneInsertParams?.[10]).toBe(
        contentHash(
          "discord:guild-1:channel-1:thread-1:nagatha|Nagatha Discord scoped memory",
        ),
      );
      expect(captured.laneInsertParams?.[11]).toBeNull();
      expect(captured.laneInsertParams?.[12]).toBeNull();
      expect(captured.laneInsertParams?.[13]).toBe("nagatha");
      expect(captured.embedInputs).toEqual([
        "Nagatha Discord scoped memory\nrtech-hermes",
        "GitHub issue URLs must use live gh first.",
      ]);
      expect(captured.eventInsertParams?.[0]).toBe("lane-uuid-new");
    },
  );
}

async function reusesScopedLane() {
  const mockPool = {
    query: async (sql: string, _params?: unknown[]) => {
      if (sql.includes("FROM ob_session_lanes")) {
        return {
          rows: [scopedLaneRow("lane-uuid-existing", "thread-1")],
        };
      }
      if (sql.includes("INSERT INTO ob_session_events")) {
        return {
          rows: [{ id: "event-uuid-1", created_at: "2026-06-28T18:00:00Z" }],
        };
      }
      if (sql.includes("UPDATE ob_session_events")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const auth: AuthInfo = { role: "agent", clientId: "nagatha" };
  await withToolClient(mockPool, auth, undefined, async (client) => {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "discord:guild-1:channel-1:thread-1:nagatha",
        create_if_missing: true,
        agent: "nagatha",
        platform: "discord",
        server_id: "guild-1",
        channel_id: "channel-1",
        thread_id: "thread-1",
        event_type: "fact",
        content: "Existing scoped lane append succeeds.",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = parseToolResult(result);
    expect(parsed.lane_id).toBe("lane-uuid-existing");
    expect(parsed.lane_created).toBe(false);
  });
}

async function handlesCreationRace() {
  let laneSelects = 0;
  const mockPool = {
    query: async (sql: string, _params?: unknown[]) => {
      if (sql.includes("INSERT INTO ob_session_lanes")) {
        return { rows: [] };
      }
      if (sql.includes("FROM ob_session_lanes")) {
        laneSelects += 1;
        if (laneSelects === 1) return { rows: [] };
        return {
          rows: [scopedLaneRow("lane-uuid-raced", null)],
        };
      }
      if (sql.includes("INSERT INTO ob_session_events")) {
        return {
          rows: [{ id: "event-uuid-1", created_at: "2026-06-28T18:00:00Z" }],
        };
      }
      return { rows: [] };
    },
  };
  const auth: AuthInfo = { role: "agent", clientId: "nagatha" };
  await withToolClient(mockPool, auth, undefined, async (client) => {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "discord:guild-1:channel-1:nagatha",
        create_if_missing: true,
        agent: "nagatha",
        platform: "discord",
        server_id: "guild-1",
        channel_id: "channel-1",
        event_type: "fact",
        content: "Raced lane creation still appends.",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = parseToolResult(result);
    expect(parsed.lane_id).toBe("lane-uuid-raced");
    expect(parsed.lane_created).toBe(false);
  });
}

async function deniesExactScopeConflict() {
  let eventInsertAttempted = false;
  const embedInputs: string[] = [];
  const mockPool = {
    query: async (sql: string, _params?: unknown[]) => {
      if (sql.includes("FROM ob_session_lanes")) {
        return {
          rows: [scopedLaneRow("lane-uuid-1", "thread-1")],
        };
      }
      if (sql.includes("INSERT INTO ob_session_events")) {
        eventInsertAttempted = true;
      }
      return { rows: [] };
    },
  };
  const auth: AuthInfo = { role: "agent", clientId: "nagatha" };
  await withToolClient(
    mockPool,
    auth,
    async (text) => {
      embedInputs.push(text);
      return Array(768).fill(0.1);
    },
    async (client) => {
      const result = await client.callTool({
        name: "append_session_event",
        arguments: {
          session_key: "discord:guild-1:channel-1:thread-1:nagatha",
          create_if_missing: true,
          agent: "nagatha",
          platform: "discord",
          server_id: "guild-1",
          channel_id: "other-channel",
          thread_id: "thread-1",
          event_type: "fact",
          content: "This should not spill into another channel.",
        },
      });

      expect(result.isError).toBe(true);
      const parsed = parseToolResult(result);
      expect(parsed.error).toBe("scope_validation");
      expect(parsed.retryable).toBe(false);
      expect(parsed.conflicts).toEqual(["channel_id"]);
      expect(eventInsertAttempted).toBe(false);
      expect(embedInputs).toEqual([]);
    },
  );
}

async function deniesUnthreadedAppend() {
  const mockPool = {
    query: async (sql: string, _params?: unknown[]) => {
      if (sql.includes("FROM ob_session_lanes")) {
        return {
          rows: [scopedLaneRow("lane-uuid-threaded", "thread-1")],
        };
      }
      return { rows: [] };
    },
  };
  const auth: AuthInfo = { role: "agent", clientId: "nagatha" };
  await withToolClient(mockPool, auth, undefined, async (client) => {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "discord:guild-1:channel-1:nagatha",
        create_if_missing: true,
        agent: "nagatha",
        platform: "discord",
        server_id: "guild-1",
        channel_id: "channel-1",
        event_type: "fact",
        content: "Unthreaded writes must not target threaded lanes.",
      },
    });

    expect(result.isError).toBe(true);
    const parsed = parseToolResult(result);
    expect(parsed.error).toBe("scope_validation");
    expect(parsed.conflicts).toEqual(["thread_id"]);
  });
}

async function appendsToNullScopeLane() {
  // Lanes created by session_start/lane_upsert do not write the `source`
  // column or `metadata.server_id`. A later scoped realtime append must
  // attach to such a lane rather than fail scope_validation on null vs
  // "discord"/"guild-1".
  let eventInsertAttempted = false;
  let scopeUpdate: { sql: string; params?: unknown[] } | undefined;
  const unscopedLane = {
    id: "lane-uuid-sessionstart",
    status: "active",
    agent: "nagatha",
    source: null,
    channel_id: null,
    thread_id: null,
    metadata: {},
  };
  const mockPool = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("UPDATE ob_session_lanes")) {
        scopeUpdate = { sql, params };
        return {
          rows: [
            {
              ...unscopedLane,
              source: "discord",
              channel_id: "channel-1",
              metadata: { server_id: "guild-1" },
            },
          ],
        };
      }
      if (sql.includes("FROM ob_session_lanes")) {
        return { rows: [unscopedLane] };
      }
      if (sql.includes("INSERT INTO ob_session_events")) {
        eventInsertAttempted = true;
        return {
          rows: [{ id: "event-uuid-1", created_at: "2026-06-28T10:00:00Z" }],
        };
      }
      return { rows: [] };
    },
  };
  const auth: AuthInfo = { role: "agent", clientId: "nagatha" };
  await withToolClient(mockPool, auth, undefined, async (client) => {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "discord:guild-1:channel-1:nagatha",
        agent: "nagatha",
        platform: "discord",
        server_id: "guild-1",
        channel_id: "channel-1",
        event_type: "fact",
        content: "Scoped append onto a session_start-created lane.",
      },
    });

    expect(result.isError).toBeUndefined();
    const parsed = parseToolResult(result);
    expect(parsed.event_id).toBe("event-uuid-1");
    expect(eventInsertAttempted).toBe(true);
    const scope = expectDefined(scopeUpdate, "scopeUpdate");
    expect(scope.sql).toContain("WHERE id = $1");
    expect(scope.sql).toContain("AND namespace = $2");
    expect(scope.sql).toContain("AND session_key = $3");
    expect(scope.params).toEqual([
      "lane-uuid-sessionstart",
      "nagatha",
      "discord:guild-1:channel-1:nagatha",
      "nagatha",
      "discord",
      "guild-1",
      "channel-1",
      null,
      true,
    ]);
  });
}

async function failsClosedOnRacedScope() {
  let laneSelects = 0;
  let eventInsertAttempted = false;
  const mockPool = {
    query: async (sql: string) => {
      if (sql.includes("UPDATE ob_session_lanes")) {
        return { rows: [] };
      }
      if (sql.includes("FROM ob_session_lanes")) {
        laneSelects += 1;
        return {
          rows: [
            {
              id: "lane-uuid-raced-attachment",
              status: "active",
              agent: "nagatha",
              source: laneSelects === 1 ? null : "discord",
              channel_id: laneSelects === 1 ? null : "other-channel",
              thread_id: null,
              metadata: laneSelects === 1 ? {} : { server_id: "guild-1" },
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO ob_session_events")) {
        eventInsertAttempted = true;
      }
      return { rows: [] };
    },
  };
  const auth: AuthInfo = { role: "agent", clientId: "nagatha" };
  await withToolClient(mockPool, auth, undefined, async (client) => {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "discord:guild-1:channel-1:nagatha",
        agent: "nagatha",
        platform: "discord",
        server_id: "guild-1",
        channel_id: "channel-1",
        event_type: "fact",
        content: "Concurrent conflicting attachment must fail closed.",
      },
    });

    expect(result.isError).toBe(true);
    const parsed = parseToolResult(result);
    expect(parsed.error).toBe("scope_validation");
    expect(parsed.conflicts).toEqual(["channel_id"]);
    expect(eventInsertAttempted).toBe(false);
  });
}

async function deniesNonNullMismatch() {
  // The null-tolerance above must not weaken real spill protection: a lane
  // that DID assert a channel still rejects a mismatched scoped append.
  let eventInsertAttempted = false;
  const mockPool = {
    query: async (sql: string, _params?: unknown[]) => {
      if (sql.includes("FROM ob_session_lanes")) {
        return {
          rows: [scopedLaneRow("lane-uuid-asserted", null)],
        };
      }
      if (sql.includes("INSERT INTO ob_session_events")) {
        eventInsertAttempted = true;
      }
      return { rows: [] };
    },
  };
  const auth: AuthInfo = { role: "agent", clientId: "nagatha" };
  await withToolClient(mockPool, auth, undefined, async (client) => {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "discord:guild-1:channel-1:nagatha",
        agent: "nagatha",
        platform: "discord",
        server_id: "guild-1",
        channel_id: "channel-2",
        event_type: "fact",
        content: "Mismatched channel must still be denied.",
      },
    });

    expect(result.isError).toBe(true);
    const parsed = parseToolResult(result);
    expect(parsed.error).toBe("scope_validation");
    expect(parsed.conflicts).toEqual(["channel_id"]);
    expect(eventInsertAttempted).toBe(false);
  });
}

async function treatsNullThreadAsAsserted() {
  let eventInsertAttempted = false;
  const mockPool = {
    query: async (sql: string) => {
      if (sql.includes("FROM ob_session_lanes")) {
        return {
          rows: [scopedLaneRow("lane-uuid-unthreaded", null)],
        };
      }
      if (sql.includes("INSERT INTO ob_session_events")) {
        eventInsertAttempted = true;
      }
      return { rows: [] };
    },
  };
  const auth: AuthInfo = { role: "agent", clientId: "nagatha" };
  await withToolClient(mockPool, auth, undefined, async (client) => {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "discord:guild-1:channel-1:nagatha",
        agent: "nagatha",
        platform: "discord",
        server_id: "guild-1",
        channel_id: "channel-1",
        thread_id: "thread-2",
        event_type: "fact",
        content: "Threaded append must not claim an asserted unthreaded lane.",
      },
    });

    expect(result.isError).toBe(true);
    const parsed = parseToolResult(result);
    expect(parsed.error).toBe("scope_validation");
    expect(parsed.conflicts).toEqual(["thread_id"]);
    expect(eventInsertAttempted).toBe(false);
  });
}

describe("append_session_event lane creation and scope", () => {
  it(
    "creates a scoped lane on first append when create_if_missing is true",
    createsScopedLane,
  );
  it("reuses an existing scoped lane when create_if_missing is true", reusesScopedLane);
  it(
    "handles first-write lane creation races by returning the existing lane",
    handlesCreationRace,
  );
  it(
    "denies append when supplied exact scope conflicts with the existing lane",
    deniesExactScopeConflict,
  );
  it(
    "denies unthreaded realtime append against an existing threaded lane",
    deniesUnthreadedAppend,
  );
  it(
    "appends to a session_start-created lane with null scope without false conflict",
    appendsToNullScopeLane,
  );
  it(
    "fails closed when a concurrent writer asserts a conflicting scope during attachment",
    failsClosedOnRacedScope,
  );
  it(
    "still denies a non-null scope mismatch against an existing lane",
    deniesNonNullMismatch,
  );
  it(
    "treats null thread as asserted unthreaded scope once the lane is otherwise exact",
    treatsNullThreadAsAsserted,
  );
});
