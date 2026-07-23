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

// A transactional pg pool mock. The tool opens a real transaction
// (connect → BEGIN → … → COMMIT/ROLLBACK → release), so the mock pool exposes a
// `connect()` that hands back a checked-out client. Both the pool and the client
// route every statement through the same caller-supplied `query`, so tests
// observe the exact SQL/params issued inside the transaction. BEGIN/COMMIT/
// ROLLBACK are handled here and recorded on `txnLog` for assertions.
type TxnPool = {
  query: QueryFn;
  connect: () => Promise<{
    query: QueryFn;
    release: () => void;
  }>;
  txnLog: string[];
  released: number;
};

function makeTxnPool(query: QueryFn): TxnPool {
  const txnLog: string[] = [];
  const pool: TxnPool = {
    query,
    txnLog,
    released: 0,
    connect: async () => ({
      query: async (sql: string, params?: unknown[]) => {
        const trimmed = sql.trim().toUpperCase();
        if (
          trimmed === "BEGIN" ||
          trimmed === "COMMIT" ||
          trimmed === "ROLLBACK"
        ) {
          txnLog.push(trimmed);
          return { rows: [] };
        }
        return query(sql, params);
      },
      release: () => {
        pool.released += 1;
      },
    }),
  };
  return pool;
}

async function setupToolClient(
  query: QueryFn,
  auth: AuthInfo,
  embedFn: (text: string) => Promise<number[] | null> = async () =>
    Array(768).fill(0.1),
): Promise<{ client: Client; cleanup: () => Promise<void>; pool: TxnPool }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const pool = makeTxnPool(query);
  const deps: ToolDeps = {
    pool: pool as never,
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
    pool,
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
    onUpdate?: (params?: unknown[]) => void;
  } = {},
): QueryFn {
  const {
    sourceRows = [APPROVED_SOURCE_ROW],
    laneRows = [LANE_ROW],
    insertRows = [{ id: "evt-1" }],
    existingEventRows = [
      { id: "evt-existing", event_type: "fact", metadata: {} },
    ],
    onInsert,
    onUpdate,
  } = opts;
  return async (sql: string, params?: unknown[]) => {
    if (sql.includes("ob_sources")) return { rows: sourceRows };
    if (sql.includes("ob_session_lanes")) return { rows: laneRows };
    if (sql.includes("INSERT INTO ob_session_events")) {
      onInsert?.(params);
      return { rows: insertRows };
    }
    if (sql.includes("UPDATE ob_session_events")) {
      onUpdate?.(params);
      return { rows: [] };
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

  it("rejects a raw transcript body supplied as a top-level key with zero mutation", async () => {
    // The public input schema is a single .strict() object, so the MCP SDK
    // rejects an unrecognized top-level `transcript` key at the validation
    // boundary — BEFORE the handler runs — and surfaces a caller-visible error.
    // Prove the rejection is observable AND that no statement ever executed: no
    // source lookup, no lane lookup, no INSERT, no transaction opened.
    const statements: string[] = [];
    const query: QueryFn = async (sql) => {
      statements.push(sql);
      if (sql.includes("ob_sources")) return { rows: [APPROVED_SOURCE_ROW] };
      if (sql.includes("ob_session_lanes")) return { rows: [LANE_ROW] };
      if (sql.includes("INSERT INTO ob_session_events"))
        return { rows: [{ id: "evt-1" }] };
      return { rows: [] };
    };
    const { client, cleanup, pool } = await setupToolClient(query, agentAuth);
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
      // Caller-visible rejection at the schema boundary.
      expect(result.isError).toBe(true);
      const text = JSON.stringify(result);
      expect(text).toContain("Input validation error");
      expect(text).toContain("transcript");
      // Zero mutation: the handler never ran, so no statement was issued and no
      // transaction was opened. The raw body never reached the write path.
      expect(statements).toEqual([]);
      expect(pool.txnLog).toEqual([]);
      // The rejection error itself never echoes the raw transcript body.
      expect(text).not.toContain("assistant: hello");
      expect(text).not.toContain("full raw transcript");
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
    // Existing stored row carries the same (event_type, no-locator) evidence, so
    // a re-submission with identical content and no new evidence is a plain
    // duplicate: no merge UPDATE is issued.
    let updateCalled = false;
    const { client, cleanup } = await setupToolClient(
      makePool({
        insertRows: [],
        onUpdate: () => {
          updateCalled = true;
        },
      }),
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
      expect(body.evidence_merged).toBe(0);
      const events = body.events as Array<Record<string, unknown>>;
      expect(events[0]!.disposition).toBe("duplicate");
      expect(updateCalled).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("preserves new locator evidence on a content-duplicate rather than dropping it", async () => {
    // Same content already stored (INSERT conflicts), but this unit cites a NEW
    // source_locator the stored row does not carry. The new structural evidence
    // must be preserved on the existing row's metadata, not silently dropped.
    let updateParams: unknown[] | undefined;
    const query = makePool({
      insertRows: [], // conflict → duplicate path
      existingEventRows: [
        {
          id: "evt-existing",
          event_type: "fact",
          metadata: { source_locator: "anchor-A" },
        },
      ],
      onUpdate: (p) => (updateParams = p),
    });
    const { client, cleanup } = await setupToolClient(query, agentAuth);
    try {
      const result = await client.callTool({
        name: "ingest_conversation_facts",
        arguments: {
          scope: VALID_SCOPE,
          source_ref: VALID_SOURCE_REF,
          facts: [
            {
              event_type: "fact",
              content: "Shared statement.",
              source_locator: "anchor-B",
            },
          ],
        },
      });
      expect(result.isError).toBeFalsy();
      const body = parse(result);
      expect(body.ingested).toBe(0);
      expect(body.duplicates).toBe(1);
      expect(body.evidence_merged).toBe(1);
      expect(body.evidence_not_stored).toBe(0);
      const events = body.events as Array<Record<string, unknown>>;
      expect(events[0]!.disposition).toBe("duplicate_evidence_merged");
      // The merge preserved the new locator as a bounded structural pointer.
      expect(updateParams).toBeDefined();
      const merged = JSON.stringify(updateParams);
      expect(merged).toContain("anchor-B");
      // Content is never echoed into the evidence UPDATE.
      expect(merged).not.toContain("Shared statement");
    } finally {
      await cleanup();
    }
  });

  it("reports evidence_not_stored when the duplicated row cannot be found for merge", async () => {
    // INSERT conflicts (duplicate) but the readback finds no row (e.g. a
    // concurrent archive/delete). The new evidence could not be preserved, so
    // the caller is told explicitly rather than given a benign duplicate success.
    let updateCalled = false;
    const query = makePool({
      insertRows: [],
      existingEventRows: [], // readback finds nothing
      onUpdate: () => {
        updateCalled = true;
      },
    });
    const { client, cleanup } = await setupToolClient(query, agentAuth);
    try {
      const result = await client.callTool({
        name: "ingest_conversation_facts",
        arguments: {
          scope: VALID_SCOPE,
          source_ref: VALID_SOURCE_REF,
          facts: [
            {
              event_type: "decision",
              content: "Vanished row.",
              source_locator: "anchor-Z",
            },
          ],
        },
      });
      expect(result.isError).toBeFalsy();
      const body = parse(result);
      expect(body.evidence_not_stored).toBe(1);
      const events = body.events as Array<Record<string, unknown>>;
      expect(events[0]!.disposition).toBe("evidence_not_stored");
      expect(updateCalled).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("is transactionally all-or-nothing: a mid-batch failure rolls back the whole batch", async () => {
    // Two units: the first INSERT succeeds, the second throws. The batch must
    // roll back (no COMMIT), surface a caller-visible retryable error, and never
    // report partial progress for the committed-then-rolled-back first row.
    let insertCount = 0;
    const query: QueryFn = async (sql) => {
      if (sql.includes("ob_sources")) return { rows: [APPROVED_SOURCE_ROW] };
      if (sql.includes("ob_session_lanes")) return { rows: [LANE_ROW] };
      if (sql.includes("INSERT INTO ob_session_events")) {
        insertCount += 1;
        if (insertCount === 2) {
          throw new Error("simulated mid-batch db failure with row values");
        }
        return { rows: [{ id: `evt-${insertCount}` }] };
      }
      return { rows: [] };
    };
    const { client, cleanup, pool } = await setupToolClient(query, agentAuth);
    try {
      const result = await client.callTool({
        name: "ingest_conversation_facts",
        arguments: {
          scope: VALID_SCOPE,
          source_ref: VALID_SOURCE_REF,
          facts: [
            { event_type: "fact", content: "First unit." },
            { event_type: "fact", content: "Second unit that fails." },
          ],
        },
      });
      // Caller-visible failure, not a benign or partial success.
      expect(result.isError).toBe(true);
      const body = parse(result);
      expect(body.error).toBe("retryable_outage");
      expect(body.ingested).toBeUndefined();
      // The transaction rolled back and never committed; the client was released.
      expect(pool.txnLog).toContain("BEGIN");
      expect(pool.txnLog).toContain("ROLLBACK");
      expect(pool.txnLog).not.toContain("COMMIT");
      expect(pool.released).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("does not leak raw DB error text into the response on a mid-batch failure", async () => {
    const sentinel = "SENTINEL_DB_ROW_VALUE_should_never_leak";
    const query: QueryFn = async (sql) => {
      if (sql.includes("ob_sources")) return { rows: [APPROVED_SOURCE_ROW] };
      if (sql.includes("ob_session_lanes")) return { rows: [LANE_ROW] };
      if (sql.includes("INSERT INTO ob_session_events")) {
        throw new Error(`pg detail: ${sentinel}`);
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
          facts: [{ event_type: "fact", content: "unit" }],
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain(sentinel);
      expect(parse(result).error).toBe("retryable_outage");
    } finally {
      await cleanup();
    }
  });

  it("does not leak raw embedding error text into the response", async () => {
    const sentinel = "SENTINEL_EMBED_CONTENT_should_never_leak";
    const failingEmbed = async () => {
      throw new Error(`embed provider echoed content: ${sentinel}`);
    };
    const { client, cleanup } = await setupToolClient(
      makePool(),
      agentAuth,
      failingEmbed,
    );
    try {
      const result = await client.callTool({
        name: "ingest_conversation_facts",
        arguments: {
          scope: VALID_SCOPE,
          source_ref: VALID_SOURCE_REF,
          facts: [{ event_type: "fact", content: "unit" }],
        },
      });
      // Embedding failure is non-fatal: the row still writes without a vector.
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result)).not.toContain(sentinel);
    } finally {
      await cleanup();
    }
  });

  it("returns per-unit dispositions and exact aggregate counts for a mixed new+duplicate batch", async () => {
    // Three units through one transaction: unit 0 is new (INSERT returns a row),
    // units 1 and 2 conflict (duplicates); unit 1 carries a new locator (merged),
    // unit 2 matches the stored evidence exactly (plain duplicate).
    let insertCount = 0;
    const query: QueryFn = async (sql, params) => {
      if (sql.includes("ob_sources")) return { rows: [APPROVED_SOURCE_ROW] };
      if (sql.includes("ob_session_lanes")) return { rows: [LANE_ROW] };
      if (sql.includes("INSERT INTO ob_session_events")) {
        insertCount += 1;
        // First unit stores; the rest conflict.
        return { rows: insertCount === 1 ? [{ id: "evt-new" }] : [] };
      }
      if (sql.includes("UPDATE ob_session_events")) return { rows: [] };
      if (sql.includes("FROM ob_session_events")) {
        // Readback keyed by content_hash param. Unit 1 ("Dup with new
        // locator.") gets a stored row with a DIFFERENT locator → merge; unit 2
        // ("Exact duplicate.") gets a stored row whose evidence matches → plain.
        const hash = String((params as unknown[])[1]);
        void hash;
        return {
          rows: [
            {
              id: "evt-existing",
              event_type: "fact",
              metadata: { source_locator: "stored-anchor" },
            },
          ],
        };
      }
      return { rows: [] };
    };
    const { client, cleanup, pool } = await setupToolClient(query, agentAuth);
    try {
      const result = await client.callTool({
        name: "ingest_conversation_facts",
        arguments: {
          scope: VALID_SCOPE,
          source_ref: VALID_SOURCE_REF,
          facts: [
            { event_type: "fact", content: "Brand new fact." },
            {
              event_type: "fact",
              content: "Dup with new locator.",
              source_locator: "fresh-anchor",
            },
            {
              event_type: "fact",
              content: "Exact duplicate.",
              source_locator: "stored-anchor",
            },
          ],
        },
      });
      expect(result.isError).toBeFalsy();
      const body = parse(result);
      expect(body.submitted).toBe(3);
      expect(body.ingested).toBe(1);
      expect(body.duplicates).toBe(2);
      expect(body.evidence_merged).toBe(1);
      expect(body.evidence_not_stored).toBe(0);
      const events = body.events as Array<Record<string, unknown>>;
      expect(events.map((e) => e.disposition)).toEqual([
        "stored",
        "duplicate_evidence_merged",
        "duplicate",
      ]);
      // Whole batch committed in one transaction.
      expect(pool.txnLog).toEqual(["BEGIN", "COMMIT"]);
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
