/**
 * Issue 672: the scenario gate's teardown archives its memory-kind records
 * (seeded thoughts/decisions and checkpoint sessions) through the SERVED
 * `archive_entry` tool, and this drives that exact path end to end.
 *
 * Nothing here is a stub of the code under test: `LiveScenarioTransport.cleanup`
 * is the shipped teardown, `createMcpCaller` is the shipped caller, and the
 * server half is the real `registerCurationTools` from `server/tools/`, reached
 * over the SDK's in-memory transport with the identity a delegated admin token
 * carries (`namespaceSource: "delegated"`, the X-Namespace binding).
 *
 * REQUIRES `OPENBRAIN_TEST_DATABASE_URL`; run it with `npm run test:isolated`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pino from "pino";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../../../scripts/test-support/require-test-database.ts";
import { registerCurationTools } from "../../../../server/tools/curation.ts";
import { createMcpCaller } from "../transport.ts";
import type { McpClientLike } from "../transport-types.ts";
import { LiveScenarioTransport } from "../scenario-transport.ts";
import type { LiveEvalConfig } from "../config.ts";
import type { ScenarioRecord } from "../scenario-types.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const NAMESPACE = `eval-live-recall-t672${randomUUID().replaceAll("-", "").slice(0, 12)}`;

afterAll(async () => {
  for (const table of ["thoughts", "decisions", "sessions"]) {
    await pool.query(`DELETE FROM ${table} WHERE namespace = $1`, [NAMESPACE]);
  }
  await pool.end();
});

/** An SDK client wired to an in-process server as a delegated admin. */
function inProcessClient(): { client: McpClientLike; transport: unknown } {
  const server = new McpServer({ name: "t672", version: "1.0.0" });
  registerCurationTools(server, {
    pool,
    embedFn: async () => null,
    logger: pino({ level: "silent" }),
    embeddingModel: "t672",
  } as never);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    originalSend(message, {
      ...options,
      authInfo: { role: "admin", clientId: NAMESPACE, namespaceSource: "delegated" },
    } as never);
  void server.connect(serverTransport);
  const client = new Client({ name: "t672", version: "1.0.0" });
  return { client: client as unknown as McpClientLike, transport: clientTransport };
}

async function seed(table: "thoughts" | "decisions" | "sessions"): Promise<string> {
  const sql = {
    thoughts: `INSERT INTO thoughts (content, namespace, created_by) VALUES ('t672 seed', $1, 't672') RETURNING id`,
    decisions: `INSERT INTO decisions (title, rationale, namespace, created_by) VALUES ('t672 seed', 't672 seed', $1, 't672') RETURNING id`,
    sessions: `INSERT INTO sessions (summary, namespace, created_by) VALUES ('t672 seed', $1, 't672') RETURNING id`,
  }[table];
  const { rows } = await pool.query(sql, [NAMESPACE]);
  return rows[0].id as string;
}

describe("scenario teardown archives memory-kind records (live Postgres)", () => {
  test("every memory-kind record archives with no failure label", async () => {
    const caller = await createMcpCaller({
      baseUrl: "http://in-process.invalid",
      token: "unused",
      namespace: NAMESPACE,
      timeoutMs: 10_000,
      clientFactory: inProcessClient,
    });
    const records: ScenarioRecord[] = [];
    for (const table of ["thoughts", "decisions", "sessions"] as const) {
      records.push({ kind: "memory", table, id: await seed(table) });
    }
    const transport = new LiveScenarioTransport(
      caller,
      {} as LiveEvalConfig,
      new Pool({ connectionString: requireTestDatabaseUrl() }),
    );
    const { tally } = await transport.cleanup(records, NAMESPACE);
    await transport.close();
    console.log(`T672 tally ${JSON.stringify(tally)}`);
    expect(tally.failure_labels).toEqual([]);
    expect(tally.failed).toBe(0);
    expect(tally.archived).toBe(3);
  });
});
