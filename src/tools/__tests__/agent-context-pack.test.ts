import { describe, expect, it } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  registerAgentContextPack,
  registerRecoveryWalAppend,
  registerRecoveryWalMark,
  registerWorkingSetAppend,
} from "../agent-context-pack.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";
import { WorkingSetStore } from "../../realtime/working-set.ts";
import { RecoveryWalStore } from "../../realtime/recovery-wal.ts";

function createMockEmbed(result: number[] | null = Array(768).fill(0.1)) {
  return async (_text: string) => result;
}

async function setupToolClient(
  auth: AuthInfo,
  pool: { query: (...args: any[]) => Promise<{ rows: any[] }> } = {
    query: async () => ({ rows: [] }),
  },
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = {
    pool: pool as any,
    embedFn: createMockEmbed(),
    workingSetStore: new WorkingSetStore(),
    recoveryWalStore: new RecoveryWalStore(),
  };
  registerWorkingSetAppend(server, deps);
  registerRecoveryWalAppend(server, deps);
  registerRecoveryWalMark(server, deps);
  registerAgentContextPack(server, deps);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message: any, options?: any) => {
    return originalSend(message, { ...options, authInfo: auth });
  };

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

const SCOPE = {
  namespace: "rico",
  agent: "nagatha",
  platform: "discord",
  server_id: "rodaddy-live",
  channel_id: "open-brain",
  session_key: "discord:rodaddy-live:open-brain:nagatha",
};

describe("agent_context_pack and working_set_append", () => {
  it("round-trips RAM-only working context through exact-scope context pack", async () => {
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth);

    try {
      const append = await client.callTool({
        name: "working_set_append",
        arguments: {
          ...SCOPE,
          kind: "current_intent",
          content: "Finish #222 without deploying core01.",
          trace_id: "trace-222",
        },
      });

      expect(append.isError).toBeFalsy();
      const appendPayload = JSON.parse((append.content as any)[0].text);
      expect(appendPayload).toMatchObject({
        accepted: true,
        not_durable_memory: true,
      });
      expect(appendPayload.item).toMatchObject({
        kind: "current_intent",
        label: "working_context",
      });

      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          requested_sections: ["working_set"],
        },
      });

      expect(pack.isError).toBeFalsy();
      const payload = JSON.parse((pack.content as any)[0].text);
      expect(payload).toMatchObject({
        schema: "openbrain.agent_context_pack.v1",
        status: "ok",
      });
      expect(payload.sections.working_set).toMatchObject({
        label: "working_context",
        exact_scope_required: true,
        not_durable_memory: true,
        item_count: 1,
      });
      expect(payload.sections.working_set.items[0]).toMatchObject({
        content: "Finish #222 without deploying core01.",
        label: "working_context",
        trace_id: "trace-222",
      });
      expect(payload.warnings.scope_denials).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("does not include adjacent-scope working context and reports scope denial", async () => {
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth);

    try {
      await client.callTool({
        name: "working_set_append",
        arguments: {
          ...SCOPE,
          kind: "task_state",
          content: "base task",
        },
      });
      await client.callTool({
        name: "working_set_append",
        arguments: {
          ...SCOPE,
          channel_id: "adjacent-channel",
          kind: "task_state",
          content: "adjacent task",
        },
      });

      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          requested_sections: ["working_set"],
        },
      });

      const payload = JSON.parse((pack.content as any)[0].text);
      expect(payload.sections.working_set.items.map((item: any) => item.content)).toEqual([
        "base task",
      ]);
      expect(payload.warnings.scope_denials).toHaveLength(1);
      expect(payload.warnings.scope_denials[0].reasons).toContain("channel_id");
    } finally {
      await cleanup();
    }
  });

  it("does not include threaded working context in unthreaded scope and reports thread_id denial", async () => {
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth);

    try {
      await client.callTool({
        name: "working_set_append",
        arguments: {
          ...SCOPE,
          kind: "task_state",
          content: "base task",
        },
      });
      await client.callTool({
        name: "working_set_append",
        arguments: {
          ...SCOPE,
          thread_id: "adjacent-thread",
          kind: "task_state",
          content: "threaded task",
        },
      });

      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          requested_sections: ["working_set"],
        },
      });

      const payload = JSON.parse((pack.content as any)[0].text);
      expect(payload.sections.working_set.items.map((item: any) => item.content)).toEqual([
        "base task",
      ]);
      expect(payload.warnings.scope_denials).toHaveLength(1);
      expect(payload.warnings.scope_denials[0].reasons).toContain("thread_id");
    } finally {
      await cleanup();
    }
  });

  it("does not disclose foreign-namespace working-set denials", async () => {
    const adminAuth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(adminAuth);

    try {
      await client.callTool({
        name: "working_set_append",
        arguments: {
          ...SCOPE,
          kind: "task_state",
          content: "base task",
        },
      });
      await client.callTool({
        name: "working_set_append",
        arguments: {
          ...SCOPE,
          namespace: "kevin",
          kind: "task_state",
          content: "foreign task",
        },
      });

      const viewer = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          requested_sections: ["working_set"],
        },
      });

      const payload = JSON.parse((viewer.content as any)[0].text);
      expect(payload.sections.working_set.items.map((item: any) => item.content)).toEqual([
        "base task",
      ]);
      expect(payload.warnings.scope_denials).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("rejects oversized metadata before retaining RAM context", async () => {
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth);

    try {
      const append = await client.callTool({
        name: "working_set_append",
        arguments: {
          ...SCOPE,
          kind: "current_intent",
          content: "valid content",
          metadata: { large: "x".repeat(3000) },
        },
      });

      expect(append.isError).toBe(true);
      const payload = JSON.parse((append.content as any)[0].text);
      expect(payload).toMatchObject({
        accepted: false,
        reason: "metadata_too_large",
      });
    } finally {
      await cleanup();
    }
  });

  it("rejects RAM working-set writes for readonly auth", async () => {
    const auth: AuthInfo = { role: "readonly", clientId: "viewer" };
    const { client, cleanup } = await setupToolClient(auth);

    try {
      const append = await client.callTool({
        name: "working_set_append",
        arguments: {
          ...SCOPE,
          namespace: "viewer",
          kind: "current_intent",
          content: "readonly should fail",
        },
      });

      expect(append.isError).toBe(true);
      expect((append.content as any)[0].text).toContain("Permission denied");
    } finally {
      await cleanup();
    }
  });

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
          return { rows: events.slice(0, 8) };
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
      expect(durable).toMatchObject({
        label: "durable_lane_context",
        exact_scope_required: true,
        event_count: 5,
        truncated: true,
      });
      expect(durable.lane.current_context_md).toHaveLength(6000);
      expect(durable.events).toHaveLength(5);
      expect(durable.events.every((event: any) => event.content.length <= 1000)).toBe(true);
      expect(JSON.stringify(durable)).not.toContain("RAW TRANSCRIPT");
      expect(JSON.stringify(durable)).not.toContain("RAW TOOL OUTPUT");
      expect(JSON.stringify(durable)).not.toContain("must not escape");
      expect(payload.warnings.truncation).not.toEqual([]);
      expect(payload.budget.durable_lane_context).toMatchObject({
        content_char_limit: 10800,
        content_chars_used: 10800,
        max_events: 8,
      });
      expect(payload.citations).toHaveLength(6);

      expect(queries[0]!.sql).toContain("WHERE namespace = $1");
      expect(queries[0]!.sql).toContain("AND session_key = $2");
      expect(queries[0]!.sql).toContain("AND agent = $3");
      expect(queries[0]!.sql).toContain("AND source = $4");
      expect(queries[0]!.sql).toContain("metadata->>'server_id' = $5");
      expect(queries[0]!.sql).toContain("AND channel_id = $6");
      expect(queries[0]!.sql).toContain("thread_id IS NOT DISTINCT FROM $7::text");
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

  it("returns recovery only through explicit unreviewed quarantine request", async () => {
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth);

    try {
      const append = await client.callTool({
        name: "recovery_wal_append",
        arguments: {
          ...SCOPE,
          content: "Recovered interrupted trace",
          trace_id: "trace-221",
        },
      });

      expect(append.isError).toBeFalsy();
      const appendPayload = JSON.parse((append.content as any)[0].text);
      expect(appendPayload).toMatchObject({
        accepted: true,
        not_durable_memory: true,
        not_searchable_recall: true,
        unreviewed_quarantine: true,
      });

      const hidden = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          requested_sections: ["recovery"],
        },
      });
      const hiddenPayload = JSON.parse((hidden.content as any)[0].text);
      expect(hiddenPayload.sections.recovery).toBeUndefined();

      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          requested_sections: ["recovery"],
          include_unreviewed_recovery: true,
        },
      });

      expect(pack.isError).toBeFalsy();
      const payload = JSON.parse((pack.content as any)[0].text);
      expect(payload.sections.recovery).toMatchObject({
        label: "quarantined_recovery",
        exact_scope_required: true,
        not_durable_memory: true,
        not_searchable_recall: true,
        unreviewed_quarantine: true,
        pending_count: 1,
      });
      expect(payload.sections.recovery.items[0]).toMatchObject({
        content_preview: "Recovered interrupted trace",
        trace_id: "trace-221",
        status: "active",
      });
    } finally {
      await cleanup();
    }
  });

  it("marks recovery reviewed so it leaves pending context", async () => {
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth);

    try {
      const append = await client.callTool({
        name: "recovery_wal_append",
        arguments: {
          ...SCOPE,
          content: "Recovered interrupted trace",
        },
      });
      const id = JSON.parse((append.content as any)[0].text).item.id;

      const mark = await client.callTool({
        name: "recovery_wal_mark",
        arguments: {
          ...SCOPE,
          id,
          action: "review",
          status: "reviewed",
        },
      });

      expect(mark.isError).toBeFalsy();
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          requested_sections: ["recovery"],
          include_unreviewed_recovery: true,
        },
      });

      const payload = JSON.parse((pack.content as any)[0].text);
      expect(payload.sections.recovery.pending_count).toBe(0);
    } finally {
      await cleanup();
    }
  });
});
