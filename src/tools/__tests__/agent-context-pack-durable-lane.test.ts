import { afterAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import type { AuthInfo } from "../../types.ts";
import {
  AGENT_CONTEXT_PACK_SCOPE as SCOPE,
  setupAgentContextPackToolClient as setupToolClient,
} from "./agent-context-pack-test-helpers.ts";

describe("agent_context_pack durable lane context", () => {
  it("does not query or return durable lane context unless explicitly requested", async () => {
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

      const payload = JSON.parse((pack.content as any)[0].text);
      expect(pack.isError).toBeFalsy();
      expect(payload.sections.durable_lane_context).toBeUndefined();
      expect(queryCount).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("returns bounded distilled durable context for the exact authorized lane", async () => {
    const queries: Array<{ sql: string; params?: any[] }> = [];
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
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth, {
      query: async (sql: string, params?: any[]) => {
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
      const payload = JSON.parse((pack.content as any)[0].text);
      const durable = payload.sections.durable_lane_context;
      // The whole-pack budget bounds the *serialized* section, so under a 10800
      // whole-pack budget the loader's 5-event content selection is re-fit down
      // to the newest events whose serialized wrappers also fit. Newest events
      // are preserved; the oldest are dropped.
      expect(durable).toMatchObject({
        label: "durable_lane_context",
        exact_scope_required: true,
        event_count: 3,
        truncated: true,
      });
      expect(durable.events.map((e: any) => e.id)).toEqual([
        "event-7",
        "event-8",
        "event-9",
      ]);
      expect(durable.lane.current_context_md).toHaveLength(6000);
      expect(
        durable.events.every((event: any) => event.content.length <= 1000),
      ).toBe(true);
      // The whole serialized section stays within the whole-pack budget.
      expect(JSON.stringify(durable).length).toBeLessThanOrEqual(
        3000 * 4 - 1200,
      );
      expect(JSON.stringify(durable)).not.toContain("RAW TRANSCRIPT");
      expect(JSON.stringify(durable)).not.toContain("RAW TOOL OUTPUT");
      expect(JSON.stringify(durable)).not.toContain("must not escape");
      expect(payload.warnings.truncation).not.toEqual([]);
      // content_chars_used is reconciled to the retained content body (checkpoint
      // 6000 + 3 events x 1000), not the loader's pre-refit selection.
      expect(payload.budget.durable_lane_context).toMatchObject({
        content_chars_used: 9000,
        max_events: 8,
      });
      // One lane citation plus one per retained event, none for dropped events.
      expect(payload.citations).toHaveLength(4);

      expect(queries[0]!.sql).toContain("WHERE namespace = $1");
      expect(queries[0]!.sql).toContain("AND session_key = $2");
      expect(queries[0]!.sql).toContain("AND agent = $3");
      expect(queries[0]!.sql).toContain("AND source = $4");
      expect(queries[0]!.sql).toContain("metadata->>'server_id' = $5");
      expect(queries[0]!.sql).toContain("AND channel_id = $6");
      expect(queries[0]!.sql).toContain(
        "thread_id IS NOT DISTINCT FROM $7::text",
      );
      expect(queries[0]!.params).toEqual([
        "rico",
        SCOPE.session_key,
        SCOPE.agent,
        SCOPE.platform,
        SCOPE.server_id,
        SCOPE.channel_id,
        null,
      ]);
      expect(queries[1]!.sql).toContain("e.lane_id = $1");
      expect(queries[1]!.sql).toContain("l.namespace = $2");
      expect(queries[1]!.params?.slice(0, 3)).toEqual([
        "lane-durable-1",
        "rico",
        SCOPE.session_key,
      ]);
    } finally {
      await cleanup();
    }
  });

  it("declares omitted short events and returns the selected recent subset chronologically", async () => {
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
      const payload = JSON.parse((pack.content as any)[0].text);
      const durable = payload.sections.durable_lane_context;
      expect(durable.events.map((event: any) => event.id)).toEqual([
        "event-1",
        "event-2",
        "event-3",
        "event-4",
        "event-5",
        "event-6",
        "event-7",
        "event-8",
      ]);
      expect(durable).toMatchObject({ event_count: 8, truncated: true });
      expect(payload.warnings.truncation).toContainEqual({
        source: "durable_lane_context.events",
        max_events: 8,
        max_event_chars: 1000,
        content_char_limit: 12000,
      });
    } finally {
      await cleanup();
    }
  });

  it("preserves sub-millisecond database ordering in chronological output", async () => {
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
      const payload = JSON.parse((pack.content as any)[0].text);
      expect(
        payload.sections.durable_lane_context.events.map(
          (event: any) => event.id,
        ),
      ).toEqual([olderId, newerId]);
    } finally {
      await cleanup();
    }
  });

  it("fails closed without event reads when the exact durable lane does not match", async () => {
    const queries: string[] = [];
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth, {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      },
    });

    try {
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          channel_id: "wrong-channel",
          requested_sections: ["durable_lane_context"],
        },
      });

      expect(pack.isError).toBeFalsy();
      const payload = JSON.parse((pack.content as any)[0].text);
      expect(payload.sections.durable_lane_context).toBeUndefined();
      expect(payload.warnings.scope_denials).toContainEqual({
        source: "durable_lane_context",
        reasons: ["exact_scope"],
      });
      expect(queries).toHaveLength(1);
      expect(queries[0]).not.toContain("ob_session_events");
    } finally {
      await cleanup();
    }
  });

  it("fails closed for every mismatched durable exact-scope coordinate", async () => {
    const cases = [
      ["namespace", { namespace: "other" }],
      ["agent", { agent: "other-agent" }],
      ["platform", { platform: "other-platform" }],
      ["server_id", { server_id: "other-server" }],
      ["channel_id", { channel_id: "other-channel" }],
      ["thread_id", { thread_id: "other-thread" }],
      ["session_key", { session_key: "other-session" }],
    ] as const;
    const expectedParams = [
      SCOPE.namespace,
      SCOPE.session_key,
      SCOPE.agent,
      SCOPE.platform,
      SCOPE.server_id,
      SCOPE.channel_id,
      null,
    ];

    for (const [, override] of cases) {
      const queries: Array<{ sql: string; params?: any[] }> = [];
      const auth: AuthInfo = { role: "admin", clientId: "rico" };
      const { client, cleanup } = await setupToolClient(auth, {
        query: async (sql: string, params?: any[]) => {
          queries.push({ sql, params });
          const exact = expectedParams.every(
            (value, index) => params?.[index] === value,
          );
          return {
            rows: exact
              ? [
                  {
                    id: "lane-durable-exact",
                    session_key: SCOPE.session_key,
                    status: "active",
                    agent: SCOPE.agent,
                    source: SCOPE.platform,
                    channel_id: SCOPE.channel_id,
                    thread_id: null,
                    project: "open-brain",
                    topic: "exact scope",
                    current_context_md: "exact context",
                    updated_at: "2026-07-17T00:00:00.000Z",
                  },
                ]
              : [],
          };
        },
      });

      try {
        const pack = await client.callTool({
          name: "agent_context_pack",
          arguments: {
            ...SCOPE,
            ...override,
            requested_sections: ["durable_lane_context"],
          },
        });

        expect(pack.isError).toBeFalsy();
        const payload = JSON.parse((pack.content as any)[0].text);
        expect(payload.sections.durable_lane_context).toBeUndefined();
        expect(payload.warnings.scope_denials).toContainEqual({
          source: "durable_lane_context",
          reasons: ["exact_scope"],
        });
        expect(queries).toHaveLength(1);
        expect(queries[0]!.sql).not.toContain("ob_session_events");
      } finally {
        await cleanup();
      }
    }
  });

  it("degrades durable lane lookup failures without leaking database errors", async () => {
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth, {
      query: async () => {
        throw new Error("postgres://secret-host/internal-detail");
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
      const payload = JSON.parse((pack.content as any)[0].text);
      expect(payload.sections.durable_lane_context).toBeUndefined();
      expect(payload.warnings.degraded_sources).toEqual([
        {
          source: "durable_lane_context",
          reason: "database_unavailable",
        },
      ]);
      expect(JSON.stringify(payload)).not.toContain("secret-host");
      expect(JSON.stringify(payload)).not.toContain("internal-detail");
    } finally {
      await cleanup();
    }
  });

  it("discards the pool client after a timed-out durable read", async () => {
    let statementTimeoutMs = 0;
    let activeQueries = 0;
    let releaseCount = 0;
    let releaseArgument: unknown;
    let rolledBack = false;
    const lane = {
      id: "lane-timeout",
      session_key: SCOPE.session_key,
      status: "active",
      agent: SCOPE.agent,
      source: SCOPE.platform,
      channel_id: SCOPE.channel_id,
      thread_id: null,
      project: "open-brain",
      topic: "timeout",
      current_context_md: "context",
      updated_at: "2026-07-17T18:00:00Z",
    };
    const dbClient = {
      query: async (config: {
        text: string;
        values?: unknown[];
        query_timeout?: number;
      }) => {
        const { text, values, query_timeout: queryTimeoutMs } = config;
        expect(queryTimeoutMs).toBeGreaterThan(0);
        if (text === "BEGIN READ ONLY" || text === "COMMIT") {
          return { rows: [] };
        }
        if (text === "ROLLBACK") {
          rolledBack = true;
          return { rows: [] };
        }
        if (text.includes("set_config('statement_timeout'")) {
          statementTimeoutMs = Number.parseInt(String(values?.[0]), 10);
          return { rows: [] };
        }
        if (text.includes("FROM ob_session_lanes") && !text.includes("JOIN")) {
          return { rows: [lane] };
        }
        if (text.includes("FROM ob_session_events")) {
          activeQueries += 1;
          await new Promise((resolve) =>
            setTimeout(resolve, statementTimeoutMs + 2),
          );
          activeQueries -= 1;
          throw new Error(
            "canceling statement due to statement timeout secret-detail",
          );
        }
        return { rows: [] };
      },
      release: (error?: unknown) => {
        releaseCount += 1;
        releaseArgument = error;
      },
    };
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth, {
      query: async () => {
        throw new Error("budgeted reads must use a checked-out client");
      },
      connect: async () => dbClient,
    });

    try {
      const startedAt = performance.now();
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          requested_sections: ["durable_lane_context"],
          budget: { max_latency_ms: 25 },
        },
      });
      const elapsedMs = performance.now() - startedAt;

      expect(pack.isError).toBeFalsy();
      const payload = JSON.parse((pack.content as any)[0].text);
      expect(payload.sections.durable_lane_context).toBeUndefined();
      expect(payload.warnings.degraded_sources).toEqual([
        {
          source: "durable_lane_context",
          reason: "database_unavailable",
        },
      ]);
      expect(JSON.stringify(payload)).not.toContain("secret-detail");
      expect(elapsedMs).toBeLessThan(250);
      expect(activeQueries).toBe(0);
      expect(rolledBack).toBe(false);
      expect(releaseCount).toBe(1);
      expect(releaseArgument).toBeInstanceOf(Error);
    } finally {
      await cleanup();
    }
  });
});

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;

dbDescribe("agent_context_pack durable lane reads (live Postgres)", () => {
  const pool = new Pool({
    connectionString: DB_URL,
    max: 2,
    connectionTimeoutMillis: 500,
  });
  const namespace = `test-context-pack-${process.pid}`;
  const liveScope = {
    namespace,
    agent: "nagatha",
    platform: "discord",
    server_id: "live-server",
    channel_id: "live-channel",
    session_key: `live-context-pack-${process.pid}`,
  };
  const laneId = "10000000-0000-0000-0000-000000000001";

  async function cleanupDatabaseRows() {
    await pool.query(
      `DELETE FROM ob_session_events
        WHERE lane_id IN (SELECT id FROM ob_session_lanes WHERE namespace = $1)`,
      [namespace],
    );
    await pool.query("DELETE FROM ob_session_lanes WHERE namespace = $1", [
      namespace,
    ]);
  }

  async function insertLane() {
    await pool.query(
      `INSERT INTO ob_session_lanes
         (id, session_key, namespace, agent, source, channel_id, thread_id,
          project, topic, current_context_md, metadata, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, 'open-brain', 'live context',
               'live checkpoint', jsonb_build_object('server_id', $7::text), 'test')`,
      [
        laneId,
        liveScope.session_key,
        namespace,
        liveScope.agent,
        liveScope.platform,
        liveScope.channel_id,
        liveScope.server_id,
      ],
    );
  }

  async function callLivePack(maxLatencyMs?: number) {
    const { client, cleanup } = await setupToolClient(
      { role: "admin", clientId: namespace },
      pool as any,
    );
    try {
      return await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...liveScope,
          requested_sections: ["durable_lane_context"],
          ...(maxLatencyMs === undefined
            ? {}
            : { budget: { max_latency_ms: maxLatencyMs } }),
        },
      });
    } finally {
      await cleanup();
    }
  }

  afterAll(async () => {
    await cleanupDatabaseRows();
    await pool.end();
  });

  it("selects equal-timestamp events by UUID and returns the eight recent events chronologically", async () => {
    await cleanupDatabaseRows();
    try {
      await insertLane();
      const createdAt = "2026-07-17T17:00:00.000Z";
      for (let index = 1; index <= 9; index += 1) {
        const id = `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`;
        await pool.query(
          `INSERT INTO ob_session_events
             (id, lane_id, event_type, content, source, importance, created_by, created_at)
           VALUES ($1, $2, 'fact', $3, 'test', 'warm', 'test', $4)`,
          [id, laneId, `short event ${index}`, createdAt],
        );
      }

      const pack = await callLivePack();
      const payload = JSON.parse((pack.content as any)[0].text);
      expect(pack.isError).toBeFalsy();
      expect(payload.sections.durable_lane_context).toBeDefined();
      expect(
        payload.sections.durable_lane_context.events.map(
          (event: Record<string, unknown>) => event.id,
        ),
      ).toEqual(
        Array.from(
          { length: 8 },
          (_, index) =>
            `00000000-0000-0000-0000-${String(index + 2).padStart(12, "0")}`,
        ),
      );
      expect(payload.sections.durable_lane_context).toMatchObject({
        event_count: 8,
        truncated: true,
      });
    } finally {
      await cleanupDatabaseRows();
    }
  });

  it("cancels a lock-delayed event read before returning and releases its pool client", async () => {
    await cleanupDatabaseRows();
    const blocker = await pool.connect();
    try {
      await insertLane();
      await blocker.query("BEGIN");
      await blocker.query(
        "LOCK TABLE ob_session_events IN ACCESS EXCLUSIVE MODE",
      );

      const startedAt = performance.now();
      const pack = await callLivePack(50);
      const elapsedMs = performance.now() - startedAt;
      const payload = JSON.parse((pack.content as any)[0].text);

      expect(pack.isError).toBeFalsy();
      expect(payload.sections.durable_lane_context).toBeUndefined();
      expect(payload.warnings.degraded_sources).toEqual([
        {
          source: "durable_lane_context",
          reason: "database_unavailable",
        },
      ]);
      expect(elapsedMs).toBeLessThan(500);
      await pool.query("SELECT 1");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      await cleanupDatabaseRows();
    }
  });
});
