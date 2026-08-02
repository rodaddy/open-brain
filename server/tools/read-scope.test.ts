/**
 * Read-scope regressions for the memory-tools wave.
 *
 * These assert on the SQL and bound parameters the handler actually sends, not
 * on rows, because the defect class they guard is a predicate that is silently
 * WRONG rather than absent: a hardcoded namespace list still returns rows, it
 * just returns the wrong set. Only the emitted predicate distinguishes the two.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pino from "pino";
import type { Pool } from "pg";
import type { Role } from "../config.ts";
import { registerMemoryTools } from "./index.ts";

interface CapturedQuery {
  readonly sql: string;
  readonly values: readonly unknown[];
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** @returns The single query the handler ran, failing the test if it ran none. */
function onlyQuery(queries: readonly CapturedQuery[]): CapturedQuery {
  expect(queries).toHaveLength(1);
  const query = queries[0];
  if (!query) throw new Error("handler ran no query");
  return query;
}

async function clientCapturingQueries(
  role: Role,
  clientId: string,
): Promise<{ client: Client; queries: CapturedQuery[] }> {
  const queries: CapturedQuery[] = [];
  const server = new McpServer({ name: "read-scope-test", version: "1.0.0" });
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      return { rows: [] };
    },
  } as unknown as Pool;
  registerMemoryTools(server, {
    pool,
    embedFn: async () => null,
    logger: pino({ level: "silent" }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    send(message, {
      ...options,
      authInfo: { role, clientId, namespaceSource: "token" },
    } as unknown as Parameters<typeof send>[1]);
  const client = new Client({ name: "read-scope-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, queries };
}

describe("session_load scopes reads from the auth-derived predicate", () => {
  test("a namespaced role reads its own namespace and shared-kb", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    await client.callTool({ name: "session_load", arguments: {} });

    const query = onlyQuery(queries);
    expect(query.sql).toContain("namespace = ANY($1::text[])");
    expect(query.values).toEqual([["rico", "shared-kb"]]);
  });

  test("a global role reads every namespace with no predicate at all", async () => {
    const { client, queries } = await clientCapturingQueries("ob-admin", "operator");

    await client.callTool({ name: "session_load", arguments: {} });

    const query = onlyQuery(queries);
    expect(query.sql).not.toContain("namespace");
    expect(query.values).toEqual([]);
  });

  test("the project filter and the namespace predicate get distinct placeholders", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    await client.callTool({ name: "session_load", arguments: { project: "open-brain" } });

    const query = onlyQuery(queries);
    expect(query.sql).toContain("project = $1");
    expect(query.sql).toContain("namespace = ANY($2::text[])");
    expect(query.values).toEqual(["open-brain", ["rico", "shared-kb"]]);
  });

  test("a role without session read permission never reaches the pool", async () => {
    const { client, queries } = await clientCapturingQueries("discord", "bot");

    const result = await client.callTool({ name: "session_load", arguments: {} });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toBe(
      "Permission denied: cannot read sessions",
    );
    expect(queries).toHaveLength(0);
  });
});
