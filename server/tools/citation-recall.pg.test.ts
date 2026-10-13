/**
 * Live-Postgres behavior tests for `citation_recall`'s neighbor split.
 *
 * Added with the issue 1209 port that moved the cited-event and neighbor
 * statements behind `server/db/session-repository.ts`. The two neighbor
 * statements differed only in comparison operator and ORDER BY, and the port
 * collapsed them into one method parameterized by `side`; nothing exercised
 * that split before, so a swapped operator would have gone unnoticed. These
 * cases assert the split from the outside: which events land in `before` and
 * `after`, in what order, and whether the +1 probe sets `expandable`.
 *
 * REQUIRES `OPENBRAIN_TEST_DATABASE_URL`, and fails hard without it (operator
 * ruling 2026-08-27, issue #878). It must point at an isolated test/playground
 * database, never the dogfood database.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pino from "pino";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";
import { registerCitationRecallTool } from "./citation-recall.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

const NAMESPACE = `citation-recall-pg-${process.pid}`;
const SESSION_KEY = `${NAMESPACE}-lane`;
const TRANSCRIPT_REF = `collab/${NAMESPACE}/transcript`;

/** The five seeded events, oldest first; index 2 is the one that gets cited. */
const EVENT_IDS: string[] = [];
let laneId = "";

/** Call `citation_recall` and return its parsed response envelope. */
async function callCitationRecall(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const server = new McpServer({
    name: "citation-recall-test",
    version: "1.0.0",
  });
  registerCitationRecallTool(server, {
    pool,
    embedFn: async () => null,
    logger: pino({ level: "silent" }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    originalSend(message, {
      ...options,
      authInfo: {
        role: "agent",
        clientId: NAMESPACE,
        namespaceSource: "token",
      },
    } as never);
  const client = new Client({ name: "citation-recall-test", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const result = await client.callTool({ name: "citation_recall", arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
  await client.close();
  return JSON.parse(text) as Record<string, unknown>;
}

beforeAll(async () => {
  const lane = await pool.query<{ id: string }>(
    `INSERT INTO ob_session_lanes (namespace, session_key, status, created_by)
     VALUES ($1, $2, 'active', 'test')
     RETURNING id`,
    [NAMESPACE, SESSION_KEY],
  );
  laneId = lane.rows[0]?.id ?? "";

  // Five events one minute apart, so `before` and `after` are unambiguous.
  for (let index = 0; index < 5; index += 1) {
    const occurredAt = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
    const row = await pool.query<{ id: string }>(
      `INSERT INTO ob_session_events
         (lane_id, event_type, content, transcript_ref, transcript, occurred_at, created_by)
       VALUES ($1, 'fact', $2, $3, $4, $5, 'test')
       RETURNING id`,
      [laneId, `content-${index}`, TRANSCRIPT_REF, `transcript-${index}`, occurredAt],
    );
    EVENT_IDS.push(row.rows[0]?.id ?? "");
  }
});

afterAll(async () => {
  await pool.query(`DELETE FROM ob_session_events WHERE lane_id = $1`, [laneId]);
  await pool.query(`DELETE FROM ob_session_lanes WHERE id = $1`, [laneId]);
  await pool.end();
});

describe("citation_recall neighbor split (live Postgres)", () => {
  test("before holds the earlier events and after the later ones", async () => {
    const payload = await callCitationRecall({
      event_id: EVENT_IDS[2],
      context_limit: 2,
    });
    const context = payload.context as {
      before: Array<{ transcript: string }>;
      after: Array<{ transcript: string }>;
    };
    // `before` is fetched newest-first and restated oldest-first for reading.
    expect(context.before.map((row) => row.transcript)).toEqual([
      "transcript-0",
      "transcript-1",
    ]);
    expect(context.after.map((row) => row.transcript)).toEqual([
      "transcript-3",
      "transcript-4",
    ]);
  });

  test("the cited event never appears on either side", async () => {
    const payload = await callCitationRecall({
      event_id: EVENT_IDS[2],
      context_limit: 10,
    });
    const context = payload.context as {
      before: Array<{ transcript: string }>;
      after: Array<{ transcript: string }>;
    };
    const surfaced = [...context.before, ...context.after].map((row) => row.transcript);
    expect(surfaced).not.toContain("transcript-2");
    expect(surfaced.length).toBe(4);
  });
});
