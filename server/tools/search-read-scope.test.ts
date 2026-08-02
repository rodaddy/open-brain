/**
 * Isolation regressions for the search and recall arms.
 *
 * These assert on the SQL and bound parameters each handler actually sends, not
 * on the rows that come back, because the defect class they guard is a predicate
 * that is silently WRONG rather than absent. A hardcoded namespace list still
 * returns rows — just the wrong ones — so a row-shaped assertion passes while
 * isolation is broken. Only the emitted predicate distinguishes the two.
 *
 * Everything here runs against a fake pool, so there is no database and no
 * fixture state to reset between tests.
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

/** @returns Every query whose SQL mentions the given fragment. */
function queriesMatching(
  queries: readonly CapturedQuery[],
  fragment: string,
): CapturedQuery[] {
  return queries.filter((query) => query.sql.includes(fragment));
}

/** @returns The single captured query, failing when the count is not one. */
function onlyQuery(queries: readonly CapturedQuery[]): CapturedQuery {
  expect(queries).toHaveLength(1);
  const query = queries[0];
  if (!query) throw new Error("handler ran no query");
  return query;
}

async function clientCapturingQueries(
  role: Role,
  clientId: string,
  options: { embedding?: number[] | null } = {},
): Promise<{ client: Client; queries: CapturedQuery[] }> {
  const queries: CapturedQuery[] = [];
  const server = new McpServer({ name: "search-scope-test", version: "1.0.0" });
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      return { rows: [] };
    },
  } as unknown as Pool;
  registerMemoryTools(server, {
    pool,
    embedFn: async () =>
      options.embedding === undefined
        ? Array(768).fill(0.01)
        : options.embedding,
    logger: pino({ level: "silent" }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options_) =>
    send(message, {
      ...options_,
      authInfo: { role, clientId, namespaceSource: "token" },
    } as unknown as Parameters<typeof send>[1]);
  const client = new Client({ name: "search-scope-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, queries };
}

describe("search_brain binds an auth-derived namespace predicate", () => {
  test("a scoped role constrains every table arm to its own namespace and shared-kb", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    await client.callTool({
      name: "search_brain",
      arguments: { query: "needle", search_mode: "keyword" },
    });

    const query = onlyQuery(queries);
    // Every table's CTE must carry the predicate. One unconstrained arm leaks
    // that table's whole corpus while the others look correctly scoped.
    for (const alias of ["t", "d", "r", "p", "s"]) {
      expect(query.sql).toContain(`${alias}.namespace = ANY($4::text[])`);
    }
    expect(query.values).toEqual(["needle", 10, 0, ["rico", "shared-kb"]]);
  });

  test("a global role emits no namespace predicate at all", async () => {
    const { client, queries } = await clientCapturingQueries("ob-admin", "operator");

    await client.callTool({
      name: "search_brain",
      arguments: { query: "needle", search_mode: "keyword" },
    });

    const query = onlyQuery(queries);
    expect(query.sql).not.toContain("namespace = ANY");
    expect(query.values).toEqual(["needle", 10, 0]);
  });

  test("an explicitly requested own namespace binds as a scalar, not an array", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    await client.callTool({
      name: "search_brain",
      arguments: { query: "needle", search_mode: "keyword", namespace: "rico" },
    });

    const query = onlyQuery(queries);
    expect(query.sql).toContain("t.namespace = $4");
    expect(query.sql).not.toContain("t.namespace = ANY($4::text[])");
    expect(query.values).toEqual(["needle", 10, 0, "rico"]);
  });

  test("an unreadable namespace is refused before any query runs", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    const result = await client.callTool({
      name: "search_brain",
      arguments: { query: "needle", namespace: "someone-else" },
    });

    expect(result.isError).toBe(true);
    // Content-free: the denial must not echo the requested namespace back, or it
    // becomes a probe for which namespaces exist.
    expect((result.content as Array<{ text: string }>)[0]?.text).toBe(
      "Permission denied: namespace read access denied",
    );
    expect(queries).toHaveLength(0);
  });

  test("the vector arm binds the same predicate as the lexical arm", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    await client.callTool({
      name: "search_brain",
      arguments: { query: "needle", search_mode: "vector" },
    });

    const query = onlyQuery(queries);
    expect(query.sql).toContain("halfvec(768)");
    for (const alias of ["t", "d", "r", "p", "s"]) {
      expect(query.sql).toContain(`${alias}.namespace = ANY($4::text[])`);
    }
    expect(query.values[3]).toEqual(["rico", "shared-kb"]);
  });

  test("hybrid runs both arms and scopes each of them", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    await client.callTool({
      name: "search_brain",
      arguments: { query: "needle", search_mode: "hybrid" },
    });

    const vectorQueries = queriesMatching(queries, "halfvec(768)");
    const ftsQueries = queriesMatching(queries, "fts_query");
    expect(vectorQueries).toHaveLength(1);
    expect(ftsQueries).toHaveLength(1);
    for (const query of [...vectorQueries, ...ftsQueries]) {
      expect(query.sql).toContain("t.namespace = ANY($4::text[])");
      expect(query.values[3]).toEqual(["rico", "shared-kb"]);
    }
  });
});

describe("search_brain gates the non-English FTS configuration", () => {
  test("an ordinary role asking for german on a keyword search is denied", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    const result = await client.callTool({
      name: "search_brain",
      arguments: { query: "nadel", search_mode: "keyword", fts_config: "german" },
    });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toBe(
      "Permission denied: non-English FTS configuration requires admin or ob-admin",
    );
    expect(queries).toHaveLength(0);
  });

  test("vector mode ignores fts_config entirely rather than denying", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    const result = await client.callTool({
      name: "search_brain",
      arguments: { query: "nadel", search_mode: "vector", fts_config: "german" },
    });

    // Vector mode runs no FTS, so the argument cannot influence execution — and
    // an argument that cannot influence execution must not deny (#368).
    expect(result.isError).toBeFalsy();
    expect(onlyQuery(queries).sql).toContain("halfvec(768)");
  });

  test("an admin gets the on-the-fly to_tsvector path with the requested config", async () => {
    const { client, queries } = await clientCapturingQueries("admin", "operator");

    await client.callTool({
      name: "search_brain",
      arguments: { query: "nadel", search_mode: "keyword", fts_config: "german" },
    });

    const query = onlyQuery(queries);
    expect(query.sql).toContain("to_tsvector('german'");
    expect(query.sql).toContain("plainto_tsquery('german'");
    // The query TEXT stays a bound parameter even though the config is inlined.
    expect(query.sql).not.toContain("nadel");
    expect(query.values[0]).toBe("nadel");
  });

  test("english reads the stored GIN-indexed column, never a recomputed vector", async () => {
    const { client, queries } = await clientCapturingQueries("admin", "operator");

    await client.callTool({
      name: "search_brain",
      arguments: { query: "needle", search_mode: "keyword", fts_config: "english" },
    });

    const query = onlyQuery(queries);
    expect(query.sql).toContain("t.search_vector");
    expect(query.sql).not.toContain("to_tsvector(");
  });

  test("an unrecognized language token falls back rather than reaching SQL", async () => {
    const { client, queries } = await clientCapturingQueries("admin", "operator");

    await client.callTool({
      name: "search_brain",
      arguments: { query: "needle", search_mode: "keyword", fts_config: "klingon" },
    });

    const query = onlyQuery(queries);
    // Only allowlisted values can ever be interpolated, so an unknown token
    // resolves to the deployment default instead of appearing in the statement.
    expect(query.sql).not.toContain("klingon");
    expect(query.sql).toContain("t.search_vector");
  });
});

describe("brain_answer scopes its retrieval identically", () => {
  test("a scoped role constrains recall to its readable namespaces", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    await client.callTool({
      name: "brain_answer",
      arguments: { query: "what is known", search_mode: "keyword" },
    });

    const query = onlyQuery(queries);
    expect(query.sql).toContain("t.namespace = ANY($4::text[])");
    expect(query.values).toEqual(["what is known", 5, 0, ["rico", "shared-kb"]]);
  });

  test("an unreadable namespace is refused before any query runs", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    const result = await client.callTool({
      name: "brain_answer",
      arguments: { query: "what is known", namespace: "someone-else" },
    });

    expect(result.isError).toBe(true);
    expect(queries).toHaveLength(0);
  });
});

describe("list_recent scopes both its data and its count query", () => {
  test("the two queries bind the same namespaces at their own parameter indexes", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    await client.callTool({ name: "list_recent", arguments: {} });

    const dataQuery = queriesMatching(queries, "ORDER BY created_at DESC")[0];
    const countQuery = queriesMatching(queries, "SUM(cnt)")[0];
    if (!dataQuery || !countQuery) throw new Error("expected both queries");

    // Different indexes because the two queries bind different numbers of
    // preceding parameters. A count computed over a different predicate than the
    // rows produces a has_more that lies.
    expect(dataQuery.sql).toContain("t.namespace = ANY($4::text[])");
    expect(countQuery.sql).toContain("t.namespace = ANY($2::text[])");
    expect(dataQuery.values[3]).toEqual(["rico", "shared-kb"]);
    expect(countQuery.values[1]).toEqual(["rico", "shared-kb"]);
  });

  test("a global role emits no predicate in either query", async () => {
    const { client, queries } = await clientCapturingQueries("ob-admin", "operator");

    await client.callTool({ name: "list_recent", arguments: {} });

    for (const query of queries) {
      expect(query.sql).not.toContain("namespace = ANY");
    }
  });

  test("a role without read permission on the requested table never queries", async () => {
    const { client, queries } = await clientCapturingQueries("discord", "bot");

    const result = await client.callTool({
      name: "list_recent",
      arguments: { table: "decisions" },
    });

    expect(result.isError).toBe(true);
    expect(queries).toHaveLength(0);
  });
});

describe("adjacent_context binds the namespace it was authorized for", () => {
  const nodeId = "11111111-2222-4333-8444-555555555555";

  test("the traversal is constrained to the caller's own namespace by default", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    await client.callTool({
      name: "adjacent_context",
      arguments: { type: "thought", id: nodeId },
    });

    const query = onlyQuery(queries);
    expect(query.sql).toContain("l.namespace = $3");
    expect(query.values).toEqual(["thought", nodeId, "rico", 50]);
  });

  test("an optional relation filter does not shift the limit onto its index", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    await client.callTool({
      name: "adjacent_context",
      arguments: { type: "thought", id: nodeId, relation: "depends_on" },
    });

    const query = onlyQuery(queries);
    expect(query.sql).toContain("l.relation = $4");
    expect(query.sql).toContain("LIMIT $5");
    expect(query.values).toEqual(["thought", nodeId, "rico", "depends_on", 50]);
  });

  test("an unreadable namespace is refused before any query runs", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    const result = await client.callTool({
      name: "adjacent_context",
      arguments: { type: "thought", id: nodeId, namespace: "someone-else" },
    });

    expect(result.isError).toBe(true);
    expect(queries).toHaveLength(0);
  });
});
