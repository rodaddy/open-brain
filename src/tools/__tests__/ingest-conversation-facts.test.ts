import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerIngestConversationFacts } from "../ingest-conversation-facts.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

type QueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[] }>;

async function setupToolClient(
  query: QueryFn,
  auth: AuthInfo,
  embedFn: (text: string) => Promise<number[] | null> = async () =>
    Array(768).fill(0.1),
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = {
    pool: { query } as never,
    embedFn: embedFn as never,
  };
  registerIngestConversationFacts(server, deps);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const originalSend = clientTransport.send.bind(clientTransport);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

const agentAuth: AuthInfo = {
  role: "agent",
  clientId: "agent-ns",
  namespaceSource: "token",
};
const readonlyAuth: AuthInfo = {
  role: "readonly",
  clientId: "ro-ns",
  namespaceSource: "token",
};

const APPROVED_SOURCE_ROW = {
  id: "src-1",
  namespace: "agent-ns",
  scope: {},
  source_kind: "conversation",
  external_id: "conv:room-42",
  title: null,
  approval_state: "approved",
  approved_by: "admin",
  approved_at: "2026-07-01T00:00:00Z",
  lifecycle_state: "active",
  sync_state: "synced",
  language: null,
  config: {},
  content_hash: null,
  last_synced_at: null,
  revision: 1,
  created_by: "admin",
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z",
};

const LANE_ROW = {
  id: "lane-1",
  status: "active",
  agent: "assistant",
  source: "discord",
  channel_id: "chan-1",
  thread_id: null,
  metadata: { server_id: "guild-1" },
};

const VALID_SCOPE = {
  agent: "assistant",
  platform: "discord",
  server_id: "guild-1",
  channel_id: "chan-1",
  thread_id: null,
  session_key: "sess-1",
};

const VALID_SOURCE_REF = {
  source_kind: "conversation" as const,
  external_id: "conv:room-42",
};

const VALID_FACTS = [
  {
    event_type: "decision" as const,
    content: "We chose Postgres over SQLite.",
  },
];

// A stateful mock pool router keyed by SQL substring. Each stage is overridable
// so a test can make the source unapproved, the lane missing, etc.
function makePool(
  opts: {
    sourceRows?: unknown[];
    laneRows?: unknown[];
    insertRows?: unknown[];
    existingEventRows?: unknown[];
    onInsert?: (params?: unknown[]) => void;
  } = {},
): QueryFn {
  const {
    sourceRows = [APPROVED_SOURCE_ROW],
    laneRows = [LANE_ROW],
    insertRows = [{ id: "evt-1" }],
    existingEventRows = [{ id: "evt-existing" }],
    onInsert,
  } = opts;
  return async (sql: string, params?: unknown[]) => {
    if (sql.includes("ob_sources")) return { rows: sourceRows };
    if (sql.includes("ob_session_lanes")) return { rows: laneRows };
    if (sql.includes("INSERT INTO ob_session_events")) {
      onInsert?.(params);
      return { rows: insertRows };
    }
    if (sql.includes("FROM ob_session_events")) {
      return { rows: existingEventRows };
    }
    return { rows: [] };
  };
}

function parse(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text);
}

describe("ingest_conversation_facts contract", () => {
  it("rejects a caller without sessions write permission", async () => {
    const { client, cleanup } = await setupToolClient(makePool(), readonlyAuth);
    try {
      const result = await client.callTool({
        name: "ingest_conversation_facts",
        arguments: {
          scope: VALID_SCOPE,
          source_ref: VALID_SOURCE_REF,
          facts: VALID_FACTS,
        },
      });
      expect(result.isError).toBe(true);
      const body = parse(result);
      expect(body.error).toBe("auth_denied");
    } finally {
      await cleanup();
    }
  });

  it("rejects when the cited conversation source is not approved", async () => {
    const { client, cleanup } = await setupToolClient(
      makePool({ sourceRows: [] }),
      agentAuth,
    );
    try {
      const result = await client.callTool({
        name: "ingest_conversation_facts",
        arguments: {
          scope: VALID_SCOPE,
          source_ref: VALID_SOURCE_REF,
          facts: VALID_FACTS,
        },
      });
      expect(result.isError).toBe(true);
      expect(parse(result).error).toBe("source_not_approved");
    } finally {
      await cleanup();
    }
  });

  it("rejects a pending (unapproved) source even when it exists", async () => {
    const pending = { ...APPROVED_SOURCE_ROW, approval_state: "pending" };
    const { client, cleanup } = await setupToolClient(
      makePool({ sourceRows: [pending] }),
      agentAuth,
    );
    try {
      const result = await client.callTool({
        name: "ingest_conversation_facts",
        arguments: {
          scope: VALID_SCOPE,
          source_ref: VALID_SOURCE_REF,
          facts: VALID_FACTS,
        },
      });
      expect(result.isError).toBe(true);
      expect(parse(result).error).toBe("source_not_approved");
    } finally {
      await cleanup();
    }
  });

  it("never persists a raw transcript body supplied as a top-level key", async () => {
    // The tool's declared input schema does not accept a `transcript` field, so
    // a top-level raw body is stripped by the transport before the handler runs
    // and can never reach the durable write. Prove the write path only ever sees
    // the distilled facts: no INSERT param carries the raw transcript text.
    const insertParamSets: Array<unknown[] | undefined> = [];
    const query: QueryFn = async (sql, params) => {
      if (sql.includes("ob_sources")) return { rows: [APPROVED_SOURCE_ROW] };
      if (sql.includes("ob_session_lanes")) return { rows: [LANE_ROW] };
      if (sql.includes("INSERT INTO ob_session_events")) {
        insertParamSets.push(params);
        return { rows: [{ id: "evt-1" }] };
      }
      return { rows: [] };
    };
    const { client, cleanup } = await setupToolClient(query, agentAuth);
    try {
      const result = await client.callTool({
        name: "ingest_conversation_facts",
        arguments: {
          scope: VALID_SCOPE,
          source_ref: VALID_SOURCE_REF,
          facts: [{ event_type: "fact", content: "distilled fact" }],
          transcript: "user: hi\nassistant: hello\n... full raw transcript ...",
        },
      });
      expect(result.isError).toBeFalsy();
      const allInsertParams = JSON.stringify(insertParamSets);
      expect(allInsertParams).not.toContain("full raw transcript");
      expect(allInsertParams).not.toContain("assistant: hello");
    } finally {
      await cleanup();
    }
  });

  it("rejects a turns/messages array payload nested in a fact", async () => {
    const { client, cleanup } = await setupToolClient(makePool(), agentAuth);
    try {
      const result = await client.callTool({
        name: "ingest_conversation_facts",
        arguments: {
          scope: VALID_SCOPE,
          source_ref: VALID_SOURCE_REF,
          facts: [
            {
              event_type: "fact",
              content: "distilled",
              turns: [{ role: "user", text: "hi" }],
            },
          ],
        },
      });
      expect(result.isError).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("rejects a bulk conversation payload exceeding the per-call cap", async () => {
    const { client, cleanup } = await setupToolClient(makePool(), agentAuth);
    try {
      const tooMany = Array.from({ length: 21 }, (_, i) => ({
        event_type: "fact" as const,
        content: `fact ${i}`,
      }));
      const result = await client.callTool({
        name: "ingest_conversation_facts",
        arguments: {
          scope: VALID_SCOPE,
          source_ref: VALID_SOURCE_REF,
          facts: tooMany,
        },
      });
      expect(result.isError).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("rejects an oversized distilled unit (likely a message dump)", async () => {
    const { client, cleanup } = await setupToolClient(makePool(), agentAuth);
    try {
      const result = await client.callTool({
        name: "ingest_conversation_facts",
        arguments: {
          scope: VALID_SCOPE,
          source_ref: VALID_SOURCE_REF,
          facts: [{ event_type: "fact", content: "x".repeat(4001) }],
        },
      });
      expect(result.isError).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("rejects a distilled unit carrying credential-like material", async () => {
    const { client, cleanup } = await setupToolClient(makePool(), agentAuth);
    try {
      const result = await client.callTool({
        name: "ingest_conversation_facts",
        arguments: {
          scope: VALID_SCOPE,
          source_ref: VALID_SOURCE_REF,
          facts: [
            {
              event_type: "fact",
              content:
                "The token is sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefgh",
            },
          ],
        },
      });
      expect(result.isError).toBe(true);
      expect(parse(result).error).toBe("secret_rejected");
    } finally {
      await cleanup();
    }
  });

  it("rejects when no lane matches the exact seven-coordinate scope", async () => {
    const { client, cleanup } = await setupToolClient(
      makePool({ laneRows: [] }),
      agentAuth,
    );
    try {
      const result = await client.callTool({
        name: "ingest_conversation_facts",
        arguments: {
          scope: VALID_SCOPE,
          source_ref: VALID_SOURCE_REF,
          facts: VALID_FACTS,
        },
      });
      expect(result.isError).toBe(true);
      expect(parse(result).error).toBe("scope_validation");
    } finally {
      await cleanup();
    }
  });

  it("binds the lane lookup to the exact scope coordinates and namespace", async () => {
    let laneParams: unknown[] | undefined;
    const query: QueryFn = async (sql, params) => {
      if (sql.includes("ob_sources")) return { rows: [APPROVED_SOURCE_ROW] };
      if (sql.includes("ob_session_lanes")) {
        laneParams = params;
        return { rows: [LANE_ROW] };
      }
      if (sql.includes("INSERT INTO ob_session_events"))
        return { rows: [{ id: "evt-1" }] };
      return { rows: [] };
    };
    const { client, cleanup } = await setupToolClient(query, agentAuth);
    try {
      await client.callTool({
        name: "ingest_conversation_facts",
        arguments: {
          scope: VALID_SCOPE,
          source_ref: VALID_SOURCE_REF,
          facts: VALID_FACTS,
        },
      });
      // namespace, session_key, agent, platform, server_id, channel_id, thread_id
      expect(laneParams).toEqual([
        "agent-ns",
        "sess-1",
        "assistant",
        "discord",
        "guild-1",
        "chan-1",
        null,
      ]);
    } finally {
      await cleanup();
    }
  });

  it("ingests approved distilled facts and returns a content-free receipt", async () => {
    let insertParams: unknown[] | undefined;
    const { client, cleanup } = await setupToolClient(
      makePool({ onInsert: (p) => (insertParams = p) }),
      agentAuth,
    );
    try {
      const result = await client.callTool({
        name: "ingest_conversation_facts",
        arguments: {
          scope: VALID_SCOPE,
          source_ref: VALID_SOURCE_REF,
          facts: [{ event_type: "decision", content: "Chose Postgres." }],
        },
      });
      expect(result.isError).toBeFalsy();
      const body = parse(result);
      expect(body.ok).toBe(true);
      expect(body.ingested).toBe(1);
      expect(body.lane_id).toBe("lane-1");
      expect(body.source_id).toBe("src-1");
      expect(body.writer_identity).toBe("agent-ns");
      // The receipt never echoes the distilled content back.
      expect(JSON.stringify(body)).not.toContain("Chose Postgres");
      // The durable insert is parameterized; the content lands as a bound param.
      expect(insertParams).toBeDefined();
      expect(insertParams).toContain("Chose Postgres.");
    } finally {
      await cleanup();
    }
  });

  it("reports duplicates without double-writing on identical distilled content", async () => {
    const { client, cleanup } = await setupToolClient(
      makePool({ insertRows: [] }),
      agentAuth,
    );
    try {
      const result = await client.callTool({
        name: "ingest_conversation_facts",
        arguments: {
          scope: VALID_SCOPE,
          source_ref: VALID_SOURCE_REF,
          facts: [{ event_type: "fact", content: "Already stored." }],
        },
      });
      expect(result.isError).toBeFalsy();
      const body = parse(result);
      expect(body.ingested).toBe(0);
      expect(body.duplicates).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("rejects a non-conversation source_kind at the schema boundary", async () => {
    const { client, cleanup } = await setupToolClient(makePool(), agentAuth);
    try {
      const result = await client.callTool({
        name: "ingest_conversation_facts",
        arguments: {
          scope: VALID_SCOPE,
          source_ref: { source_kind: "git", external_id: "repo" },
          facts: VALID_FACTS,
        },
      });
      expect(result.isError).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
