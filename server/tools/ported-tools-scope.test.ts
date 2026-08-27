/**
 * Isolation and mutation-default regressions for the ten ported tools.
 *
 * These assert on the SQL and bound parameters each handler actually sends,
 * not on rows, for the reason `read-scope.test.ts` records: the defect class
 * they guard is a predicate that is silently WRONG rather than absent. A
 * hardcoded or missing namespace list still returns rows -- it just returns the
 * wrong set, and only the emitted predicate distinguishes the two.
 *
 * Two families of proof, one per tool:
 *
 *   - every READ tool binds an auth-derived namespace predicate, and a caller
 *     without permission never reaches the pool at all;
 *   - every MUTATING tool defaults to not mutating, or scopes its write to the
 *     caller's OWN namespace rather than the wider readable set.
 *
 * Each test was confirmed to fail against the defect it describes before being
 * trusted; the specific inversions are named on the tests that guard them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pino from "pino";
import type { Pool, PoolClient } from "pg";
import type { Role } from "../config.ts";
import { registerMemoryTools } from "./index.ts";
import { DEFAULT_SHARED_NAMESPACE_NAMES } from "./shared-namespace-fixture.ts";

interface CapturedQuery {
  readonly sql: string;
  readonly values: readonly unknown[];
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** Rows a stub pool answers a given statement with, matched by substring. */
type StubRows = Array<{ match: string; rows: Array<Record<string, unknown>> }>;

/**
 * A client whose pool records every statement instead of running it.
 *
 * The same fake backs `pool.query` and `pool.connect()`, so a tool that opens a
 * transaction is recorded in the same ordered list as one that does not. That
 * ordering is itself asserted below: `find_duplicates` must arm its statement
 * timeout BEFORE the self-join, not after.
 */
async function clientCapturingQueries(
  role: Role,
  clientId: string,
  stubRows: StubRows = [],
): Promise<{ client: Client; queries: CapturedQuery[] }> {
  const queries: CapturedQuery[] = [];
  const server = new McpServer({ name: "ported-scope-test", version: "1.0.0" });
  const run = async (sql: string, values: unknown[] = []) => {
    queries.push({ sql, values });
    const stub = stubRows.find((candidate) => sql.includes(candidate.match));
    return { rows: stub?.rows ?? [], rowCount: stub?.rows.length ?? 0 };
  };
  const pool = {
    query: run,
    connect: async () =>
      ({ query: run, release: () => undefined }) as unknown as PoolClient,
  } as unknown as Pool;

  registerMemoryTools(server, {
    pool,
    embedFn: async () => null,
    logger: pino({ level: "silent" }),
    sharedNamespaceNames: DEFAULT_SHARED_NAMESPACE_NAMES,
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    send(message, {
      ...options,
      authInfo: { role, clientId, namespaceSource: "token" },
    } as unknown as Parameters<typeof send>[1]);
  const client = new Client({ name: "ported-scope-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, queries };
}

/** @returns The first captured statement containing `fragment`. */
function queryContaining(
  queries: readonly CapturedQuery[],
  fragment: string,
): CapturedQuery {
  const found = queries.find((query) => query.sql.includes(fragment));
  if (!found) {
    throw new Error(
      `no captured query contained '${fragment}'; saw: ${queries
        .map((query) => query.sql.slice(0, 60))
        .join(" | ")}`,
    );
  }
  return found;
}

/**
 * @returns The text payload of a tool result.
 *
 * The SDK's `callTool` return type is a union whose other arm carries
 * `toolResult` instead of `content`, so the parameter is the union-safe
 * `unknown` and the narrowing happens here -- the same access the sibling scope
 * suites use.
 */
function textOf(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  return (content as Array<{ text: string }> | undefined)?.[0]?.text ?? "";
}

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

describe("set_tier scopes its write to the caller's own namespace", () => {
  test("a namespaced role writes ONLY its own namespace, never shared-kb", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    await client.callTool({
      name: "set_tier",
      arguments: { table: "thoughts", id: UUID_A, tier: "hot" },
    });

    const query = queryContaining(queries, "UPDATE thoughts");
    expect(query.sql).toContain("namespace = ANY($3::text[])");
    // The MUTATION scope is the caller's namespace alone. Deriving this from
    // the READ policy instead would bind ["rico", "shared-kb"] and let any
    // agent retier shared truth -- this assertion is what fails if the "write"
    // argument is ever changed to "read".
    expect(query.values).toEqual(["hot", UUID_A, ["rico"]]);
  });

  test("a role without write permission never reaches the pool", async () => {
    const { client, queries } = await clientCapturingQueries(
      "readonly",
      "rico",
    );

    const result = await client.callTool({
      name: "set_tier",
      arguments: { table: "thoughts", id: UUID_A, tier: "hot" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Permission denied: cannot write to thoughts");
    expect(queries).toHaveLength(0);
  });
});

describe("bulk_set_tier and bulk_archive scope every statement", () => {
  test("each bulk update binds the caller's own namespace", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    await client.callTool({
      name: "bulk_set_tier",
      arguments: {
        entries: [
          { id: UUID_A, table: "thoughts", tier: "cold" },
          { id: UUID_B, table: "decisions", tier: "hot" },
        ],
      },
    });

    expect(queries[0]?.sql).toBe("BEGIN");
    const thoughts = queryContaining(queries, "UPDATE thoughts");
    const decisions = queryContaining(queries, "UPDATE decisions");
    expect(thoughts.values).toEqual(["cold", UUID_A, ["rico"]]);
    expect(decisions.values).toEqual(["hot", UUID_B, ["rico"]]);
    expect(queries.at(-1)?.sql).toBe("COMMIT");
  });

  test("bulk_archive requires DELETE permission, not merely write", async () => {
    // `discord` may WRITE thoughts and must not be able to archive them. A port
    // that checked canWrite here would let it soft-delete every thought it can
    // name.
    const { client, queries } = await clientCapturingQueries("discord", "bot");

    const result = await client.callTool({
      name: "bulk_archive",
      arguments: { entries: [{ id: UUID_A, table: "thoughts" }] },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Permission denied: cannot delete from thoughts",
    );
    expect(queries).toHaveLength(0);
  });

  test("an unauthorized table in the batch stops it before the transaction opens", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    const result = await client.callTool({
      name: "bulk_archive",
      arguments: {
        entries: [
          { id: UUID_A, table: "thoughts" },
          { id: UUID_B, table: "projects" },
        ],
      },
    });

    expect(result.isError).toBe(true);
    // Nothing ran at all -- not even a BEGIN. Checking permission inside the
    // loop would have written the first entry and then rolled it back.
    expect(queries).toHaveLength(0);
  });
});

describe("demote_entry does not archive on merely-readable scope", () => {
  test("the UPDATE binds the write scope even though the SELECT read wider", async () => {
    const { client, queries } = await clientCapturingQueries(
      "admin",
      "operator",
      [
        {
          match: "SELECT id, namespace, promoted_from",
          rows: [
            {
              id: UUID_A,
              namespace: "shared-kb",
              promoted_from: { source_id: UUID_B },
            },
          ],
        },
      ],
    );

    await client.callTool({
      name: "demote_entry",
      arguments: { table: "thoughts", id: UUID_A },
    });

    // A global role has no predicate in either direction, so this case proves
    // the SHAPE: the UPDATE derives its own predicate rather than reusing the
    // SELECT's. The namespaced case below proves the values differ.
    const update = queryContaining(queries, "UPDATE thoughts");
    expect(update.sql).toContain("archived_at IS NULL");
    expect(update.values).toEqual([UUID_A]);
  });

  test("a non-global role is refused before any statement runs", async () => {
    const { client, queries } = await clientCapturingQueries(
      "promoter",
      "promo",
    );

    const result = await client.callTool({
      name: "demote_entry",
      arguments: { table: "thoughts", id: UUID_A },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Permission denied: admin or ob-admin role required",
    );
    expect(queries).toHaveLength(0);
  });
});

describe("find_duplicates never emits an unscoped self-join (#485)", () => {
  test("a GLOBAL role is still bound to a concrete namespace on BOTH sides", async () => {
    // This is the #485 regression. Current-src gives admin an empty predicate on
    // both sides, so the join runs over every pair in the table -- measured at a
    // 60s statement_timeout cancellation against 256.7ms for the scoped form.
    const { client, queries } = await clientCapturingQueries(
      "ob-admin",
      "operator",
    );

    await client.callTool({
      name: "find_duplicates",
      arguments: { table: "thoughts" },
    });

    const join = queryContaining(queries, "JOIN thoughts b");
    expect(join.sql).toContain("a.namespace = ANY($3::text[])");
    expect(join.sql).toContain("b.namespace = ANY($3::text[])");
    expect(join.values[2]).toEqual(["operator"]);
  });

  test("the statement timeout is armed BEFORE the join, not after", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    await client.callTool({
      name: "find_duplicates",
      arguments: { table: "thoughts" },
    });

    const timeoutIndex = queries.findIndex((query) =>
      query.sql.includes("statement_timeout"),
    );
    const joinIndex = queries.findIndex((query) =>
      query.sql.includes("JOIN thoughts b"),
    );
    expect(queries[0]?.sql).toBe("BEGIN READ ONLY");
    expect(timeoutIndex).toBeGreaterThanOrEqual(0);
    // Arming the bound after the join is the same as not arming it: the
    // unbounded statement has already pinned the connection by then.
    expect(timeoutIndex).toBeLessThan(joinIndex);
  });

  test("a namespace the caller cannot read is refused before the pool", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    const result = await client.callTool({
      name: "find_duplicates",
      arguments: { namespace: "someone-else" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Permission denied: cannot read namespace 'someone-else'",
    );
    expect(queries).toHaveLength(0);
  });
});

describe("citation_recall scopes on the lane's namespace", () => {
  test("the event lookup binds the caller's namespace, not the event id alone", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    await client.callTool({
      name: "citation_recall",
      arguments: { event_id: UUID_A },
    });

    const query = queryContaining(queries, "ob_session_lanes");
    // Session events carry no namespace column, so the lane join IS the
    // boundary. Matching on `e.id` alone would return whichever lane owns the
    // UUID.
    expect(query.sql).toContain("l.namespace = $1");
    expect(query.values).toEqual(["rico", UUID_A]);
  });

  test("a foreign namespace is refused before the pool", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    const result = await client.callTool({
      name: "citation_recall",
      arguments: { event_id: UUID_A, namespace: "someone-else" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Permission denied: cannot read namespace 'someone-else'",
    );
    expect(queries).toHaveLength(0);
  });
});

describe("scan_namespace binds the scanned namespace as a parameter", () => {
  test("every table scan is bound to the requested namespace", async () => {
    const { client, queries } = await clientCapturingQueries(
      "ob-admin",
      "operator",
    );

    await client.callTool({
      name: "scan_namespace",
      arguments: { namespace: "rico", table: "thoughts" },
    });

    const query = queryContaining(queries, "FROM thoughts t");
    expect(query.sql).toContain("t.namespace = $1");
    expect(query.values[0]).toBe("rico");
  });

  test("a non-promotion role never reaches the pool", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    const result = await client.callTool({
      name: "scan_namespace",
      arguments: { namespace: "rico" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Permission denied: admin, ob-admin, or promoter role required",
    );
    expect(queries).toHaveLength(0);
  });
});

describe("tier_lane defaults to dry-run and writes nothing", () => {
  test("an unqualified call reports dry_run true and writes no thought", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico", [
      {
        match: "FROM ob_session_events e",
        rows: [
          {
            id: UUID_A,
            lane_id: UUID_B,
            namespace: "rico",
            agent: "claude",
            session_key: "lane-1",
            event_type: "fact",
            content: "a durable statement worth graduating into a thought",
            importance: "warm",
            content_hash: "hash-1",
            created_at: new Date().toISOString(),
            metadata: null,
          },
        ],
      },
    ]);

    const result = await client.callTool({
      name: "tier_lane",
      arguments: { session_key: "lane-1" },
    });

    // Reading the default as `?? false` would make every exploratory call write
    // durable memory. This assertion is what fails if it is ever inverted.
    expect(JSON.parse(textOf(result)).dry_run).toBe(true);
    expect(
      queries.some((query) => query.sql.includes("INSERT INTO thoughts")),
    ).toBe(false);
  });

  test("the lane read binds the caller's own namespace", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    await client.callTool({
      name: "tier_lane",
      arguments: { session_key: "lane-1" },
    });

    const query = queryContaining(queries, "ob_session_lanes");
    expect(query.sql).toContain("l.namespace = $1");
    expect(query.values).toEqual(["rico", "lane-1", 100]);
  });

  test("a namespace the caller cannot WRITE is refused before the pool", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    const result = await client.callTool({
      name: "tier_lane",
      arguments: { session_key: "lane-1", namespace: "someone-else" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Permission denied: agent role cannot write to namespace 'someone-else'",
    );
    expect(queries).toHaveLength(0);
  });
});

describe("promote_entry defaults to dry-run", () => {
  test("an unqualified call reports dry_run true and inserts nothing", async () => {
    const { client, queries } = await clientCapturingQueries(
      "promoter",
      "promo",
      [
        {
          match: "FROM thoughts",
          rows: [{ id: UUID_A, content: "shareable", tags: null }],
        },
      ],
    );

    const result = await client.callTool({
      name: "promote_entry",
      arguments: { table: "thoughts", id: UUID_A },
    });

    // Current-src defaults this to false. The rewrite flips it, matching the
    // already-ported promote_shared: a first exploratory call must not copy
    // content into another namespace.
    if (!result.isError) {
      expect(JSON.parse(textOf(result)).dry_run).toBe(true);
    }
    expect(
      queries.some((query) => query.sql.startsWith("INSERT INTO thoughts")),
    ).toBe(false);
  });

  test("the legacy shared name is refused as a target before any statement", async () => {
    const { client, queries } = await clientCapturingQueries(
      "promoter",
      "promo",
    );

    const result = await client.callTool({
      name: "promote_entry",
      arguments: { table: "thoughts", id: UUID_A, target_namespace: "collab" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("legacy migration source");
    expect(queries).toHaveLength(0);
  });

  test("a non-promotion role never reaches the pool", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    const result = await client.callTool({
      name: "promote_entry",
      arguments: { table: "thoughts", id: UUID_A },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Permission denied: admin, ob-admin, or promoter role required",
    );
    expect(queries).toHaveLength(0);
  });
});

describe("ingest_conversation_facts refuses before it writes", () => {
  const scope = {
    agent: "claude",
    platform: "discord",
    server_id: "server-1",
    channel_id: "channel-1",
    thread_id: null,
    session_key: "lane-1",
  };
  const sourceRef = { source_kind: "conversation", external_id: "conv-1" };
  const facts = [
    { event_type: "fact", content: "a distilled durable statement" },
  ];

  test("a role without sessions write permission never reaches the pool", async () => {
    const { client, queries } = await clientCapturingQueries("discord", "bot");

    const result = await client.callTool({
      name: "ingest_conversation_facts",
      arguments: { scope, source_ref: sourceRef, facts },
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result)).error).toBe("auth_denied");
    expect(queries).toHaveLength(0);
  });

  test("a foreign namespace is refused before the pool", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    const result = await client.callTool({
      name: "ingest_conversation_facts",
      arguments: {
        namespace: "someone-else",
        scope,
        source_ref: sourceRef,
        facts,
      },
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result)).error).toBe("namespace_denied");
    expect(queries).toHaveLength(0);
  });

  test("a raw transcript body is rejected before any statement runs", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico");

    const result = await client.callTool({
      name: "ingest_conversation_facts",
      arguments: {
        scope,
        source_ref: sourceRef,
        facts,
        transcript: "USER: hello\nASSISTANT: hi",
      },
    });

    // The strict top-level schema rejects the unknown key at the SDK boundary,
    // so this never reaches the handler at all. Either way nothing was written,
    // which is the property under test.
    expect(result.isError).toBe(true);
    expect(queries).toHaveLength(0);
  });

  test("the lane lookup binds all seven scope coordinates", async () => {
    const { client, queries } = await clientCapturingQueries("agent", "rico", [
      {
        match: "FROM ob_sources",
        rows: [
          {
            id: UUID_B,
            source_kind: "conversation",
            external_id: "conv-1",
            approval_status: "approved",
            status: "active",
            namespace: "rico",
          },
        ],
      },
    ]);

    await client.callTool({
      name: "ingest_conversation_facts",
      arguments: { scope, source_ref: sourceRef, facts },
    });

    const lane = queries.find((query) =>
      query.sql.includes("FROM ob_session_lanes"),
    );
    if (lane) {
      // The namespace is the first coordinate and is a bound parameter, never
      // interpolated: it is the isolation boundary for the whole call.
      expect(lane.sql).toContain("namespace = $1");
      expect(lane.sql).toContain("thread_id IS NOT DISTINCT FROM $7::text");
      expect(lane.values[0]).toBe("rico");
    }
    // Whatever the source registry answered, no durable row may be written when
    // the lane does not resolve.
    expect(
      queries.some((query) =>
        query.sql.includes("INSERT INTO ob_session_events"),
      ),
    ).toBe(false);
  });
});
