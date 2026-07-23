import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  registerAgentContextPack,
  registerAgentReflexPointers,
  registerRecoveryWalAppend,
  registerRecoveryWalMark,
  registerWorkingSetAppend,
} from "../agent-context-pack.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";
import { WorkingSetStore } from "../../realtime/working-set.ts";
import { RecoveryWalStore } from "../../realtime/recovery-wal.ts";

export const AGENT_CONTEXT_PACK_SCOPE = {
  namespace: "rico",
  agent: "nagatha",
  platform: "discord",
  server_id: "rodaddy-live",
  channel_id: "open-brain",
  session_key: "discord:rodaddy-live:open-brain:nagatha",
};

function createMockEmbed(result: number[] | null = Array(768).fill(0.1)) {
  return async (_text: string) => result;
}

export async function setupAgentContextPackToolClient(
  auth: AuthInfo,
  pool: {
    query: (...args: any[]) => Promise<{ rows: any[] }>;
    connect?: () => Promise<unknown>;
  } = {
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
  registerAgentReflexPointers(server, deps);

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

/**
 * A mock pool that answers the hybrid search CTEs (vector + FTS) with a supplied
 * set of brain records and records every query's sql/params so the single-recall
 * / zero-recall invariants and namespace predicates can be asserted.
 */
export function searchPool(
  records: Array<Record<string, unknown>>,
  captured: Array<{ sql: string; params?: unknown[] }> = [],
) {
  return {
    pool: {
      query: async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params });
        if (
          sql.includes("query_embedding") ||
          sql.includes("fts_query") ||
          sql.includes("FROM ob_")
        ) {
          return { rows: records };
        }
        return { rows: [] };
      },
    },
    captured,
  };
}

/**
 * A mock pool whose recall arms (vector/FTS/entity table) reject, so
 * `executeSearch` throws and the durable-memory loader takes its `recall_failed`
 * degraded path. Non-recall queries still answer empty so unrelated reads work.
 */
export function throwingSearchPool(
  captured: Array<{ sql: string; params?: unknown[] }> = [],
) {
  return {
    pool: {
      query: async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params });
        if (isRecallSql(sql)) {
          throw new Error("recall boom");
        }
        return { rows: [] };
      },
    },
    captured,
  };
}

/** True for any SQL that is a durable recall arm (vector/FTS/entity table). */
export function isRecallSql(sql: unknown): boolean {
  return (
    typeof sql === "string" &&
    (sql.includes("query_embedding") ||
      sql.includes("fts_query") ||
      sql.includes("FROM ob_"))
  );
}

export function brainRecord(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    // Production executeSearch labels rows with the SINGULAR source_type
    // (SOURCE_LABELS: decisions -> "decision"); the plural is the table name.
    // Emit singular here so the canonical identity is brain_record:decision:<id>
    // and get_entry resolution must derive the table as source_type + "s".
    source_type: "decision",
    id: overrides.id ?? "dec-1",
    namespace: "rico",
    content_preview: "durable decision content",
    tags: null,
    created_by: "rico",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-02T00:00:00Z",
    usefulness: 0.9,
    tier: "warm",
    distance: 0.1,
    fts_rank: 0.9,
    ...overrides,
  };
}

/** N distinct decision records dec-1..dec-N with distinct ranked previews. */
export function nRecords(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_v, i) =>
    brainRecord({
      id: `dec-${i + 1}`,
      content_preview: `durable decision content ${i + 1}`,
      // Descending distance keeps dec-1 highest-ranked, dec-N lowest.
      distance: 0.01 * (i + 1),
      fts_rank: 1 - 0.01 * (i + 1),
    }),
  );
}

export const admin: AuthInfo = { role: "admin", clientId: "rico" };

export function canonical(sourceType: string, id: string): string {
  return `brain_record:${sourceType}:${id}`;
}
