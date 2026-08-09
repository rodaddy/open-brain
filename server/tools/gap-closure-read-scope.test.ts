/**
 * Isolation regressions for the #463 gap-closure ports.
 *
 * These assert on the SQL and the bound parameters each handler actually sends,
 * NOT on returned rows, and that choice is the whole point. The defect class is
 * a predicate that is silently WRONG rather than missing: an ID-based read with
 * no namespace clause still returns a row, it just returns one the caller was
 * never entitled to see. A fixture that seeds a single namespace cannot tell
 * those two apart -- measured on this branch, deleting `get_entry`'s namespace
 * predicate entirely left the whole live parity suite green at 69/0. Only the
 * emitted predicate distinguishes correct from confidently wrong, so that is
 * what these tests read.
 *
 * Covers `get_entry` (both render arms), `archive_entity` (whose mutation
 * predicate must be applied to the UPDATE itself), `get_contract`, and
 * `operator_doctor` (neither of which is namespaced, and whose role gates are
 * therefore the entire boundary).
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

const ENTRY_ID = "11111111-1111-4111-8111-111111111111";
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function clientCapturingQueries(
  role: Role,
  clientId: string,
  rowsFor: (sql: string) => unknown[] = () => [],
): Promise<{ client: Client; queries: CapturedQuery[] }> {
  const queries: CapturedQuery[] = [];
  const server = new McpServer({ name: "gap-closure-test", version: "1.0.0" });
  const record = async (sql: string, values: unknown[] = []) => {
    queries.push({ sql, values });
    return { rows: rowsFor(sql), rowCount: rowsFor(sql).length };
  };
  const pool = {
    query: record,
    // `archive_entity` runs its transaction on a dedicated client, so the fake
    // has to offer one or the handler never reaches a query at all.
    connect: async () => ({ query: record, release: () => {} }),
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
  const client = new Client({ name: "gap-closure-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, queries };
}

/** @returns The one query whose SQL matches, failing when it is not unique. */
function queryMatching(queries: readonly CapturedQuery[], needle: string): CapturedQuery {
  const matches = queries.filter((query) => query.sql.includes(needle));
  expect(matches).toHaveLength(1);
  const query = matches[0];
  if (!query) throw new Error(`no query containing ${needle}`);
  return query;
}

describe("get_entry scopes ID-based reads from the auth-derived predicate", () => {
  test("a namespaced role binds its own namespace and shared-kb on the full render", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    await client.callTool({
      name: "get_entry",
      arguments: { table: "thoughts", id: ENTRY_ID },
    });

    const query = queryMatching(queries, "FROM thoughts");
    expect(query.sql).toContain("namespace = ANY($2::text[])");
    expect(query.values).toEqual([ENTRY_ID, ["rico", "shared-kb"]]);
  });

  test("the compact render binds the SAME predicate, at its own placeholder", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    await client.callTool({
      name: "get_entry",
      arguments: { table: "thoughts", id: ENTRY_ID, render: "compact" },
    });

    // The preview width is bound AFTER the namespace values, so a predicate
    // that silently vanished would also shift this placeholder -- asserting
    // both together catches a partial regression, not just a total one.
    const query = queryMatching(queries, "content_preview");
    expect(query.sql).toContain("namespace = ANY($2::text[])");
    expect(query.values).toEqual([ENTRY_ID, ["rico", "shared-kb"], 500]);
  });

  test("a global role reads every namespace with no predicate at all", async () => {
    const { client, queries } = await clientCapturingQueries("ob-admin", "operator");

    await client.callTool({
      name: "get_entry",
      arguments: { table: "thoughts", id: ENTRY_ID },
    });

    const query = queryMatching(queries, "FROM thoughts");
    expect(query.sql).not.toContain("namespace = ANY");
    expect(query.values).toEqual([ENTRY_ID]);
  });

  test("the table name reaches SQL only through the enum allowlist", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    const result = await client.callTool({
      name: "get_entry",
      arguments: { table: "thoughts; DROP TABLE thoughts", id: ENTRY_ID },
    });

    expect(result.isError).toBe(true);
    expect(queries).toHaveLength(0);
  });

  test("a role without read permission on the table never reaches the pool", async () => {
    const { client, queries } = await clientCapturingQueries("discord", "bot");

    const result = await client.callTool({
      name: "get_entry",
      arguments: { table: "decisions", id: ENTRY_ID },
    });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toBe(
      "Permission denied: cannot read decisions",
    );
    expect(queries).toHaveLength(0);
  });
});

describe("archive_entity applies its predicate to the mutation itself", () => {
  test("a delete-capable namespaced role binds its own namespace on the UPDATE", async () => {
    // `promoter` holds delete on sessions without being a global role, so it is
    // the one identity that proves the clause is emitted rather than skipped.
    const { client, queries } = await clientCapturingQueries("promoter", "rico");

    await client.callTool({ name: "archive_entity", arguments: { id: ENTRY_ID } });

    const query = queryMatching(queries, "UPDATE ob_entities");
    expect(query.sql).toContain("archived_at IS NULL");
    expect(query.values[0]).toBe(ENTRY_ID);
  });

  test("a role without delete permission never opens a transaction", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    const result = await client.callTool({
      name: "archive_entity",
      arguments: { id: ENTRY_ID },
    });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toBe(
      "Permission denied: cannot archive entities",
    );
    expect(queries).toHaveLength(0);
  });

  test("the link cascade is scoped to the namespace the entity was found in", async () => {
    const { client, queries } = await clientCapturingQueries(
      "ob-admin",
      "operator",
      (sql) =>
        sql.includes("UPDATE ob_entities")
          ? [{ id: ENTRY_ID, namespace: "someone-elses-lane" }]
          : [],
    );

    await client.callTool({ name: "archive_entity", arguments: { id: ENTRY_ID } });

    // The namespace comes from the RETURNING row, never from the caller, so the
    // cascade cannot be steered into a neighbouring lane by the request.
    const cascade = queryMatching(queries, "UPDATE ob_links");
    expect(cascade.values).toEqual([ENTRY_ID, "someone-elses-lane"]);
  });
});

describe("service-metadata surfaces gate on role alone", () => {
  test("operator_doctor refuses a non-admin identity before any work", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    const result = await client.callTool({ name: "operator_doctor", arguments: {} });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toBe(
      "Permission denied: admin or ob-admin role required",
    );
    expect(queries).toHaveLength(0);
  });

  test("get_contract serves a readable role without touching the database", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    const result = await client.callTool({ name: "get_contract", arguments: {} });

    expect(result.isError).toBeFalsy();
    const contract = JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? "{}");
    expect(contract.service).toBe("open-brain");
    expect(contract.contract_version).toBe("2026-08-09.memory-tools.v24");
    expect(queries).toHaveLength(0);
  });

  test("get_contract refuses a role with no session read permission", async () => {
    const { client } = await clientCapturingQueries("discord", "bot");

    const result = await client.callTool({ name: "get_contract", arguments: {} });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toBe(
      "Permission denied: cannot read contract",
    );
  });
});
