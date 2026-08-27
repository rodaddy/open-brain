/**
 * Live-Postgres behavior tests for the ported source registry tools.
 *
 * These cover what the parity fixture structurally cannot: `update_source` and
 * `remove_source` both key on an id returned by a previous call, and the shared
 * fixture harness substitutes namespace tokens only. They are named gaps in
 * `tool-gap-map.json` for exactly that reason, and this file is the coverage
 * that stands in for them.
 *
 * THE RULE THIS PROVES: a source is ingestion-eligible only when it is BOTH
 * approved and active. A caller cannot self-approve, and a retired source can
 * never become eligible again.
 *
 * REQUIRES the test-database variable, and fails hard without it (operator
 * ruling 2026-08-27, issue #878). It must point at an isolated test/playground database, never the
 * dogfood database.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pino from "pino";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";
import { registerSourceRegistryTools } from "./source-registry.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

const NAMESPACE = `source-registry-pg-${process.pid}`;
const OTHER_NAMESPACE = `${NAMESPACE}-other`;
const EXTERNAL_ID = "https://example.invalid/lifecycle-repo.git";

interface Envelope {
  ok: boolean;
  code?: string;
  eligible?: boolean;
  count?: number;
  source?: Record<string, unknown>;
  sources?: Array<Record<string, unknown>>;
  id?: string;
}

async function callTool(
  tool: string,
  namespace: string,
  args: Record<string, unknown>,
  role = "agent",
): Promise<{ isError: boolean; body: Envelope }> {
  const server = new McpServer({
    name: "source-registry-test",
    version: "1.0.0",
  });
  registerSourceRegistryTools(server, {
    pool,
    embedFn: async () => null,
    logger: pino({ level: "silent" }),
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    originalSend(message, {
      ...options,
      authInfo: { role, clientId: namespace, namespaceSource: "token" },
    } as never);
  const client = new Client({ name: "source-registry-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: tool, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    return {
      isError: result.isError === true,
      body: JSON.parse(text) as Envelope,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

/** The registered source every describe below operates on. */
let sourceId = "";

beforeAll(async () => {
  const created = await callTool("register_source", NAMESPACE, {
    source_kind: "git",
    external_id: EXTERNAL_ID,
    title: "Lifecycle Repo",
  });
  sourceId = String(created.body.source?.id ?? "");
  expect(sourceId).not.toBe("");
});

afterAll(async () => {
  await pool.query(`DELETE FROM ob_sources WHERE namespace = ANY($1::text[])`, [
    [NAMESPACE, OTHER_NAMESPACE],
  ]);
  await pool.end();
});

describe("source registry revision and approval (live Postgres)", () => {
  test("update_source advances the revision and applies the change", async () => {
    const { isError, body } = await callTool("update_source", NAMESPACE, {
      id: sourceId,
      expected_revision: 1,
      title: "Lifecycle Repo Renamed",
      language: "typescript",
    });
    expect(isError).toBe(false);
    expect(body.source?.title).toBe("Lifecycle Repo Renamed");
    expect(body.source?.language).toBe("typescript");
    expect(body.source?.revision).toBe(2);
  });

  test("a stale expected_revision is refused (optimistic concurrency)", async () => {
    const { isError, body } = await callTool("update_source", NAMESPACE, {
      id: sourceId,
      expected_revision: 1,
      title: "Should Not Apply",
    });
    expect(isError).toBe(true);
    expect(body.code).toBe("stale_revision");
    // The refused write must not have landed.
    const after = await callTool("list_sources", NAMESPACE, {
      source_kind: "git",
    });
    expect(after.body.sources?.[0]?.title).toBe("Lifecycle Repo Renamed");
  });

  test("an agent cannot self-approve its own source", async () => {
    const { isError } = await callTool("update_source", NAMESPACE, {
      id: sourceId,
      expected_revision: 2,
      approval_state: "approved",
    });
    expect(isError).toBe(true);
    const after = await callTool("list_sources", NAMESPACE, {
      source_kind: "git",
    });
    expect(after.body.sources?.[0]?.approval_state).toBe("pending");
  });

  test("a pending source is not ingestion-eligible", async () => {
    const { body } = await callTool("source_ingestion_eligibility", NAMESPACE, {
      source_kind: "git",
      external_id: EXTERNAL_ID,
    });
    expect(body.eligible).toBe(false);
    expect(body.code).toBe("approval_denied");
  });

  test("an approved active source IS ingestion-eligible", async () => {
    // Approval is an admin transition, which is the point: the agent above
    // could not do this to itself.
    const approved = await callTool(
      "update_source",
      NAMESPACE,
      { id: sourceId, expected_revision: 2, approval_state: "approved" },
      "admin",
    );
    expect(approved.isError).toBe(false);
    expect(approved.body.source?.approval_state).toBe("approved");

    const { body } = await callTool("source_ingestion_eligibility", NAMESPACE, {
      source_kind: "git",
      external_id: EXTERNAL_ID,
    });
    expect(body.eligible).toBe(true);
    expect(body.source?.id).toBe(sourceId);
  });
});

describe("source registry isolation and retirement (live Postgres)", () => {
  test("another namespace cannot see or reach the source", async () => {
    const listed = await callTool("list_sources", OTHER_NAMESPACE, {
      source_kind: "git",
    });
    expect(listed.body.count).toBe(0);

    const eligibility = await callTool(
      "source_ingestion_eligibility",
      OTHER_NAMESPACE,
      { source_kind: "git", external_id: EXTERNAL_ID },
    );
    expect(eligibility.body.eligible).toBe(false);

    const stolen = await callTool("update_source", OTHER_NAMESPACE, {
      id: sourceId,
      expected_revision: 3,
      title: "Taken Over",
    });
    expect(stolen.isError).toBe(true);
  });

  test("remove_source retires it and eligibility never returns", async () => {
    const removed = await callTool("remove_source", NAMESPACE, {
      id: sourceId,
    });
    expect(removed.isError).toBe(false);
    expect(removed.body.id).toBe(sourceId);

    // Retired is terminal: an approved source that is retired stays ineligible.
    const { body } = await callTool("source_ingestion_eligibility", NAMESPACE, {
      source_kind: "git",
      external_id: EXTERNAL_ID,
    });
    expect(body.eligible).toBe(false);

    // Provenance is preserved rather than hard-deleted.
    const { rows } = await pool.query(
      `SELECT lifecycle_state FROM ob_sources WHERE id = $1`,
      [sourceId],
    );
    expect(rows[0]?.lifecycle_state).toBe("retired");
  });

  test("errors stay content-free: no driver text, path, or row value", async () => {
    const { isError, body } = await callTool("update_source", NAMESPACE, {
      id: "00000000-0000-4000-8000-000000000000",
      expected_revision: 1,
      title: "Nothing Here",
    });
    expect(isError).toBe(true);
    expect(Object.keys(body).sort()).toEqual(["code", "error", "ok"]);
    expect(typeof body.code).toBe("string");
  });
});
