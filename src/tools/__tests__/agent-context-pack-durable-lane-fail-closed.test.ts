import { describe, expect, it } from "bun:test";
import type { AuthInfo } from "../../types.ts";
import {
  AGENT_CONTEXT_PACK_SCOPE as SCOPE,
  setupAgentContextPackToolClient as setupToolClient,
} from "./agent-context-pack-test-helpers.ts";
import {
  expectDefined,
  parsePackPayload,
  type RecordedQuery,
} from "./agent-context-pack-durable-lane-test-helpers.ts";

async function failsClosedWithoutEventReadsWhenTheExactDura() {
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
    const payload = parsePackPayload(pack.content);
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
}

async function failsClosedForEveryMismatchedDurableExactsco() {
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
    const queries: RecordedQuery[] = [];
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth, {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        const exact = expectedParams.every((value, index) => params?.[index] === value);
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
      const payload = parsePackPayload(pack.content);
      expect(payload.sections.durable_lane_context).toBeUndefined();
      expect(payload.warnings.scope_denials).toContainEqual({
        source: "durable_lane_context",
        reasons: ["exact_scope"],
      });
      expect(queries).toHaveLength(1);
      expect(expectDefined(queries[0], "query 0").sql).not.toContain(
        "ob_session_events",
      );
    } finally {
      await cleanup();
    }
  }
}

async function degradesDurableLaneLookupFailuresWithoutLeak() {
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
    const payload = parsePackPayload(pack.content);
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
}

async function discardsThePoolClientAfterATimedoutDurableRe() {
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
        await new Promise((resolve) => setTimeout(resolve, statementTimeoutMs + 2));
        activeQueries -= 1;
        throw new Error("canceling statement due to statement timeout secret-detail");
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
    const payload = parsePackPayload(pack.content);
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
}

describe("agent_context_pack durable lane fail-closed context", () => {
  it(
    "fails closed without event reads when the exact durable lane does not match",
    failsClosedWithoutEventReadsWhenTheExactDura,
  );

  it(
    "fails closed for every mismatched durable exact-scope coordinate",
    failsClosedForEveryMismatchedDurableExactsco,
  );

  it(
    "degrades durable lane lookup failures without leaking database errors",
    degradesDurableLaneLookupFailuresWithoutLeak,
  );

  it(
    "discards the pool client after a timed-out durable read",
    discardsThePoolClientAfterATimedoutDurableRe,
  );
});
