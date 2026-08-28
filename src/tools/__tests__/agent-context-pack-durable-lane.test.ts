import { describe, expect, it } from "bun:test";
import type { AuthInfo } from "../../types.ts";
import {
  AGENT_CONTEXT_PACK_SCOPE as SCOPE,
  setupAgentContextPackToolClient as setupToolClient,
} from "./agent-context-pack-test-helpers.ts";
import {
  expectDefined,
  parsePackPayload,
  type PackEvent,
  type RecordedQuery,
} from "./agent-context-pack-durable-lane-test-helpers.ts";

async function doesNotQueryOrReturnDurableLaneContextUnless() {
  let queryCount = 0;
  const auth: AuthInfo = { role: "admin", clientId: "rico" };
  const { client, cleanup } = await setupToolClient(auth, {
    query: async () => {
      queryCount += 1;
      return { rows: [] };
    },
  });

  try {
    const pack = await client.callTool({
      name: "agent_context_pack",
      arguments: {
        ...SCOPE,
        requested_sections: ["working_set"],
      },
    });

    const payload = parsePackPayload(pack.content);
    expect(pack.isError).toBeFalsy();
    expect(payload.sections.durable_lane_context).toBeUndefined();
    expect(queryCount).toBe(0);
  } finally {
    await cleanup();
  }
}

// Fixture for the bounded-distillation case: one oversized checkpoint and
// ten oversized events, so the whole-pack fitter has something to spend its
// allocation on.
const lane = {
  id: "lane-durable-1",
  session_key: SCOPE.session_key,
  status: "active",
  agent: SCOPE.agent,
  source: SCOPE.platform,
  channel_id: SCOPE.channel_id,
  thread_id: null,
  project: "open-brain",
  topic: "First-class local memory",
  current_context_md: "C".repeat(9000),
  updated_at: "2026-07-17T18:00:00Z",
  metadata: { private_raw: "must not escape" },
};
const events = Array.from({ length: 10 }, (_, index) => ({
  id: `event-${index}`,
  event_type: index % 2 === 0 ? "decision" : "fact",
  content: `event-${index}:` + "E".repeat(2000),
  source: "shared",
  importance: "warm",
  artifact_path: null,
  transcript_ref: `collab/open-brain/conversations/${index}`,
  transcript: "RAW TRANSCRIPT MUST NOT ESCAPE",
  metadata: { tool_output: "RAW TOOL OUTPUT MUST NOT ESCAPE" },
  occurred_at: null,
  created_at: `2026-07-17T17:00:0${index}Z`,
}));

async function returnsBoundedDistilledDurableContextForTheE() {
  const queries: RecordedQuery[] = [];
  const auth: AuthInfo = { role: "admin", clientId: "rico" };
  const { client, cleanup } = await setupToolClient(auth, {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes("FROM ob_session_lanes") && !sql.includes("JOIN")) {
        return { rows: [lane] };
      }
      if (sql.includes("FROM ob_session_events")) {
        // Real SQL selects newest-first (created_at DESC); mirror it so the
        // loader's chronological reverse() lands the newest event at the tail.
        return { rows: [...events].reverse().slice(0, 8) };
      }
      return { rows: [] };
    },
  });

  try {
    const pack = await client.callTool({
      name: "agent_context_pack",
      arguments: {
        ...SCOPE,
        requested_sections: ["durable_lane_context"],
        budget: { max_tokens: 3000 },
      },
    });

    expect(pack.isError).toBeFalsy();
    const payload = parsePackPayload(pack.content);
    const durable = expectDefined(
      payload.sections.durable_lane_context,
      "the durable lane section",
    );
    // THIS caller asked for a bound (budget.max_tokens: 3000), so it gets one
    // -- that path is unchanged. What changed on 2026-07-30 is what the bound
    // spends its room on. Previously a fixed 6,000-char checkpoint ceiling and
    // a 1,000-char-per-event ceiling meant three events arrived, each severed
    // mid-content. Now the checkpoint takes at most half the allocation and
    // the events that fit arrive WHOLE: fewer events, none of them mutilated.
    // An event the caller can read beats three it cannot.
    expect(durable).toMatchObject({
      label: "durable_lane_context",
      exact_scope_required: true,
      event_count: 2,
      truncated: true,
    });
    expect(durable.events.map((e: PackEvent) => e.id)).toEqual(["event-8", "event-9"]);
    // Checkpoint bounded to half the allocation, not to a hardcoded 6000.
    // Slightly under half after the whole-pack fitter charges serialization
    // framing; the assertion is the share, not an exact byte count.
    const halfAllocation = Math.floor((3000 * 4 - 1200) / 2);
    expect(durable.lane.current_context_md.length).toBeLessThanOrEqual(halfAllocation);
    expect(durable.lane.current_context_md.length).toBeGreaterThan(
      halfAllocation - 100,
    );
    // No per-event ceiling is applied any more. The old 1,000-char cut is
    // gone, so retained bodies run past it -- the last one is bounded only by
    // whatever allocation remains, not by a fixed number.
    expect(
      durable.events.every((event: PackEvent) => event.content.length > 1000),
    ).toBe(true);
    // The whole serialized section stays within the whole-pack budget.
    expect(JSON.stringify(durable).length).toBeLessThanOrEqual(3000 * 4 - 1200);
    expect(JSON.stringify(durable)).not.toContain("RAW TRANSCRIPT");
    expect(JSON.stringify(durable)).not.toContain("RAW TOOL OUTPUT");
    expect(JSON.stringify(durable)).not.toContain("must not escape");
    expect(payload.warnings.truncation).not.toEqual([]);
    // Reconciled to what was actually retained -- the halved checkpoint plus
    // the whole events that fit -- and reported as unbounded, because no
    // per-section ceiling exists any more.
    const laneBudget = payload.budget.durable_lane_context;
    expect(laneBudget.max_events).toBe(Number.MAX_SAFE_INTEGER);
    expect(laneBudget.max_event_chars).toBe(Number.MAX_SAFE_INTEGER);
    expect(laneBudget.content_chars_used).toBeGreaterThan(halfAllocation + 3000);
    expect(laneBudget.content_chars_used).toBeLessThanOrEqual(
      laneBudget.content_char_limit,
    );
    // One lane citation plus one per retained event.
    expect(payload.citations).toHaveLength(3);

    const laneQuery = expectDefined(queries[0], "the lane query");

    const eventQuery = expectDefined(queries[1], "the event query");

    expect(laneQuery.sql).toContain("WHERE namespace = $1");
    expect(laneQuery.sql).toContain("AND session_key = $2");
    expect(laneQuery.sql).toContain("AND agent = $3");
    expect(laneQuery.sql).toContain("AND source = $4");
    expect(laneQuery.sql).toContain("metadata->>'server_id' = $5");
    expect(laneQuery.sql).toContain("AND channel_id = $6");
    expect(laneQuery.sql).toContain("thread_id IS NOT DISTINCT FROM $7::text");
    expect(laneQuery.params).toEqual([
      "rico",
      SCOPE.session_key,
      SCOPE.agent,
      SCOPE.platform,
      SCOPE.server_id,
      SCOPE.channel_id,
      null,
    ]);
    expect(eventQuery.sql).toContain("e.lane_id = $1");
    expect(eventQuery.sql).toContain("l.namespace = $2");
    expect(eventQuery.params?.slice(0, 3)).toEqual([
      "lane-durable-1",
      "rico",
      SCOPE.session_key,
    ]);
  } finally {
    await cleanup();
  }
}

async function declaresOmittedShortEventsAndReturnsTheSelec() {
  const lane = {
    id: "lane-nine-events",
    session_key: SCOPE.session_key,
    status: "active",
    agent: SCOPE.agent,
    source: SCOPE.platform,
    channel_id: SCOPE.channel_id,
    thread_id: null,
    project: "open-brain",
    topic: "bounded recent events",
    current_context_md: "short checkpoint",
    updated_at: "2026-07-17T18:00:00Z",
  };
  const events = Array.from({ length: 9 }, (_, index) => ({
    id: `event-${index}`,
    event_type: "fact",
    content: `short event ${index}`,
    source: "shared",
    importance: "warm",
    artifact_path: null,
    transcript_ref: null,
    occurred_at: null,
    created_at: `2026-07-17T17:00:0${index}Z`,
  })).reverse();
  const auth: AuthInfo = { role: "admin", clientId: "rico" };
  const { client, cleanup } = await setupToolClient(auth, {
    query: async (sql: string) => {
      if (sql.includes("FROM ob_session_lanes") && !sql.includes("JOIN")) {
        return { rows: [lane] };
      }
      if (sql.includes("FROM ob_session_events")) {
        return { rows: events };
      }
      return { rows: [] };
    },
  });

  try {
    const pack = await client.callTool({
      name: "agent_context_pack",
      arguments: {
        ...SCOPE,
        requested_sections: ["durable_lane_context"],
      },
    });

    expect(pack.isError).toBeFalsy();
    const payload = parsePackPayload(pack.content);
    const durable = expectDefined(
      payload.sections.durable_lane_context,
      "the durable lane section",
    );
    // No budget was requested, so every event in the lane comes back whole.
    // This used to expect events 1..8 and `truncated: true` -- event-0 was
    // dropped by the 8-event ceiling and the caller was told the lane had
    // been shortened. Both the ceiling and the marker are gone as of
    // 2026-07-30; the oldest event is no longer the price of a full read.
    expect(durable.events.map((event: PackEvent) => event.id)).toEqual([
      "event-0",
      "event-1",
      "event-2",
      "event-3",
      "event-4",
      "event-5",
      "event-6",
      "event-7",
      "event-8",
    ]);
    expect(durable).toMatchObject({ event_count: 9, truncated: false });
    expect(payload.warnings.truncation).toEqual([]);
  } finally {
    await cleanup();
  }
}

async function preservesSubmillisecondDatabaseOrderingInChr() {
  const lane = {
    id: "lane-sub-millisecond-events",
    session_key: SCOPE.session_key,
    status: "active",
    agent: SCOPE.agent,
    source: SCOPE.platform,
    channel_id: SCOPE.channel_id,
    thread_id: null,
    project: "open-brain",
    topic: "precision-preserving event order",
    current_context_md: "checkpoint",
    updated_at: "2026-07-17T18:00:00Z",
  };
  const newerId = "00000000-0000-4000-8000-000000000001";
  const olderId = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const events = [
    {
      id: newerId,
      event_type: "fact",
      content: "newer event",
      source: "shared",
      importance: "warm",
      artifact_path: null,
      transcript_ref: null,
      occurred_at: null,
      created_at: "2026-07-17T17:00:00.123900Z",
    },
    {
      id: olderId,
      event_type: "fact",
      content: "older event",
      source: "shared",
      importance: "warm",
      artifact_path: null,
      transcript_ref: null,
      occurred_at: null,
      created_at: "2026-07-17T17:00:00.123100Z",
    },
  ];
  const auth: AuthInfo = { role: "admin", clientId: "rico" };
  const { client, cleanup } = await setupToolClient(auth, {
    query: async (sql: string) => {
      if (sql.includes("FROM ob_session_lanes") && !sql.includes("JOIN")) {
        return { rows: [lane] };
      }
      if (sql.includes("FROM ob_session_events")) {
        return { rows: events };
      }
      return { rows: [] };
    },
  });

  try {
    const pack = await client.callTool({
      name: "agent_context_pack",
      arguments: {
        ...SCOPE,
        requested_sections: ["durable_lane_context"],
      },
    });

    expect(pack.isError).toBeFalsy();
    const payload = parsePackPayload(pack.content);
    expect(
      expectDefined(
        payload.sections.durable_lane_context,
        "the durable lane section",
      ).events.map((event: PackEvent) => event.id),
    ).toEqual([olderId, newerId]);
  } finally {
    await cleanup();
  }
}

describe("agent_context_pack durable lane context", () => {
  it(
    "does not query or return durable lane context unless explicitly requested",
    doesNotQueryOrReturnDurableLaneContextUnless,
  );

  it(
    "returns bounded distilled durable context for the exact authorized lane",
    returnsBoundedDistilledDurableContextForTheE,
  );

  it(
    "declares omitted short events and returns the selected recent subset chronologically",
    declaresOmittedShortEventsAndReturnsTheSelec,
  );

  it(
    "preserves sub-millisecond database ordering in chronological output",
    preservesSubmillisecondDatabaseOrderingInChr,
  );
});
