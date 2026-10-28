/**
 * Shared fixtures for the `agent_context_pack` / `agent_reflex_pointers`
 * functional tests, extracted from `context-pack.test.ts` so the behavior
 * suites can live in sibling files without duplicating the harness.
 *
 * Everything here runs against a fake pool, so there is no database and no
 * fixture state to reset. Assertions in the importing suites are on emitted
 * SQL/parameters and on the returned payload, never on rows a real database
 * happened to hold.
 *
 * The `afterEach` below is registered by whichever suite imports this module,
 * so each sibling file closes its own clients.
 */
import { afterEach, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pino from "pino";
import type { Pool } from "pg";
import type { Role } from "../../config.ts";
import { WorkingSetStore } from "../../realtime/working-set.ts";
import { registerMemoryTools } from "../index.ts";
import { DEFAULT_SHARED_NAMESPACE_NAMES } from "../shared-namespace-fixture.ts";

export interface CapturedQuery {
  readonly sql: string;
  readonly values: readonly unknown[];
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** One recalled brain row, shaped as the search engine emits it. */
export function searchRow(id: string, preview: string, namespace = "dana") {
  return {
    source_type: "thought",
    id,
    namespace,
    content_preview: preview,
    tags: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: null,
    usefulness: 1,
    tier: "warm",
  };
}

/**
 * Whether a captured statement belongs to the hybrid recall.
 *
 * A hybrid `executeSearch` issues TWO statements — the vector arm and the FTS
 * arm, in parallel — so counting statements counts arms, not retrieval stacks.
 * The vector arm is identified by its `query_embedding` CTE and the FTS arm by
 * its `fts_query` CTE, which lets a test count either one to count STACKS.
 */
export function isRecallSql(sql: string): boolean {
  return sql.includes("query_embedding") || sql.includes("fts_query");
}

/** @returns The count of hybrid recall STACKS run (one per `executeSearch`). */
export function recallStackCount(queries: readonly CapturedQuery[]): number {
  // Count only the vector arm: exactly one is issued per hybrid executeSearch.
  return queries.filter((query) => query.sql.includes("query_embedding")).length;
}

export interface HarnessOptions {
  /** Rows every recall query returns. */
  readonly rows?: Array<Record<string, unknown>>;
  readonly workingSetStore?: WorkingSetStore;
  /** Forces the recall query to throw, exercising the degraded path. */
  readonly failRecall?: boolean;
}

function fakeQueryRows(
  sql: string,
  options: HarnessOptions,
): Array<Record<string, unknown>> {
  if (!isRecallSql(sql)) return [];
  const rows = options.rows ?? [];
  if (!sql.includes("fts_query")) return rows;
  // The hybrid FTS statement projects these two columns. Preserve any
  // explicitly supplied metadata so malformed-row controls still fail closed.
  return rows.map((row) => ({
    lexical_coverage: 1,
    query_lexeme_count: 1,
    ...row,
  }));
}

export async function harness(
  role: Role,
  clientId: string,
  options: HarnessOptions = {},
): Promise<{ client: Client; queries: CapturedQuery[] }> {
  const queries: CapturedQuery[] = [];
  const server = new McpServer({ name: "context-pack-test", version: "1.0.0" });
  const query = async (sql: string, values: unknown[] = []) => {
    if (
      sql === "BEGIN READ ONLY" ||
      sql === "COMMIT" ||
      sql === "ROLLBACK" ||
      sql.includes("set_config('hnsw.")
    ) {
      return { rows: [] };
    }
    queries.push({ sql, values });
    const isRecall = isRecallSql(sql);
    if (isRecall && options.failRecall) throw new Error("recall exploded");
    return { rows: fakeQueryRows(sql, options) };
  };
  const pool = {
    query,
    connect: async () => ({ query, release: () => undefined }),
  } as unknown as Pool;
  registerMemoryTools(server, {
    pool,
    embedFn: async () => Array(768).fill(0.01),
    logger: pino({ level: "silent" }),
    sharedNamespaceNames: DEFAULT_SHARED_NAMESPACE_NAMES,
    ...(options.workingSetStore ? { workingSetStore: options.workingSetStore } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, sendOptions) =>
    send(message, {
      ...sendOptions,
      authInfo: { role, clientId, namespaceSource: "token" },
    } as unknown as Parameters<typeof send>[1]);
  const client = new Client({ name: "context-pack-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, queries };
}

/** Call a tool and parse its single JSON text payload. */
export async function callJson(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ payload: Record<string, unknown>; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
  return {
    payload: JSON.parse(text) as Record<string, unknown>,
    isError: result.isError === true,
  };
}

export const SCOPE = {
  agent: "fixture-agent",
  platform: "test",
  server_id: "server-1",
  channel_id: "channel-1",
  session_key: "pack/test",
};

export function sectionsOf(payload: Record<string, unknown>) {
  return payload.sections as Record<string, Record<string, unknown> | undefined>;
}

/**
 * The named section, failing loudly when it is absent.
 *
 * Asserting presence here rather than optional-chaining downstream means a
 * missing section fails as "expected pointers to be defined" instead of as a
 * confusing `undefined` mismatch several assertions later.
 */
export function sectionOf(
  payload: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  const section = sectionsOf(payload)[name];
  expect(section).toBeDefined();
  return section as Record<string, unknown>;
}

/** Items of a named section, typed for the field each test reads. */
export function itemsOf<T extends Record<string, unknown>>(
  payload: Record<string, unknown>,
  name: string,
): T[] {
  return (sectionOf(payload, name).items ?? []) as T[];
}

export function citationIds(payload: Record<string, unknown>): string[] {
  return (payload.citations as Array<{ id: string }>).map((citation) => citation.id);
}

/**
 * Every `citation_id` emitted across all sections of a pack.
 *
 * Hoisted out of the bijection test so the flattening reads as one named
 * operation rather than three levels of nested callbacks at the call site.
 */
export function emittedCitationIds(payload: Record<string, unknown>): string[] {
  const sections = Object.values(sectionsOf(payload));
  const items = sections.flatMap(
    (section) => (section?.items ?? []) as Array<{ citation_id?: string }>,
  );
  const ids = items.map((item) => item.citation_id);
  return ids.filter((id): id is string => typeof id === "string");
}
