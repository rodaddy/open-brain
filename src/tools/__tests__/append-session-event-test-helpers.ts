/**
 * Shared helpers for the append_session_event test files, extracted when the
 * suite was split into unit, auth-and-lookup, and Postgres halves.
 */
import type { Pool } from "pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAppendSessionEvent } from "../append-session-event.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";
import { createMockEmbed, type MockPool } from "./test-helpers.ts";
import { expectDefined } from "../../../scripts/test-support/expect-defined.ts";

export { expectDefined };

type TransportSend = InMemoryTransport["send"];
type SendMessage = Parameters<TransportSend>[0];
type SendOptions = Parameters<TransportSend>[1];

export function createThrowingEmbed(error: Error) {
  return async (_text: string): Promise<number[] | null> => {
    throw error;
  };
}

export async function setupToolClient(
  mockPool: MockPool,
  auth: AuthInfo,
  embedFn?: (text: string) => Promise<number[] | null>,
  allowNonTransactionalAppendFallback = true,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = {
    pool: mockPool as unknown as Pool,
    embedFn: embedFn ?? createMockEmbed(),
    allowNonTransactionalAppendFallback,
  };
  registerAppendSessionEvent(server, deps);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message: SendMessage, options?: SendOptions) => {
    return originalSend(message, {
      ...options,
      authInfo: auth as unknown as NonNullable<SendOptions>["authInfo"],
    });
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
 * Runs `body` against a tool client built on `mockPool`, closing the client and
 * server afterwards whether the body succeeded or threw.
 */
export async function withToolClient(
  mockPool: MockPool,
  auth: AuthInfo,
  embedFn: ((text: string) => Promise<number[] | null>) | undefined,
  body: (client: Client) => Promise<void>,
): Promise<void> {
  const { client, cleanup } = await setupToolClient(mockPool, auth, embedFn);
  try {
    await body(client);
  } finally {
    await cleanup();
  }
}

/** Mock pool that returns a lane for the lookup query, then returns event data for the insert. */
export function createLaneFoundPool(
  laneId = "lane-uuid-1",
  eventId = "event-uuid-1",
  createdAt = "2026-06-08T10:00:00Z",
  status = "active",
) {
  return {
    query: async (sql: string, _params?: unknown[]) => {
      if (sql.includes("ob_session_lanes")) {
        return { rows: [{ id: laneId, status }] };
      }
      // INSERT into ob_session_events
      return { rows: [{ id: eventId, created_at: createdAt }] };
    },
  };
}

/** Mock pool that returns no lanes (lane not found). */
export function createLaneNotFoundPool() {
  return {
    query: async (sql: string, _params?: unknown[]) => {
      if (sql.includes("ob_session_lanes")) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

/** Lane-found pool that captures the params of the events INSERT. */
export function createCapturingPool(
  priorRejectedResubmits = 0,
  rootRejectedCount = 1,
  priorUnlineagedRejected = 0,
) {
  const captured: {
    createdBy: string | null;
    metadata: Record<string, unknown> | null;
    resubmitQueryCount: number;
  } = {
    createdBy: null,
    metadata: null,
    resubmitQueryCount: 0,
  };
  const pool = {
    captured,
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("ob_session_lanes")) {
        return { rows: [{ id: "lane-uuid-1", status: "active" }] };
      }
      if (sql.includes("AS rejected_count")) {
        captured.resubmitQueryCount += 1;
        if (!sql.includes("root_rejected_count")) {
          return { rows: [{ rejected_count: priorUnlineagedRejected }] };
        }
        return {
          rows: [
            {
              root_rejected_count: rootRejectedCount,
              rejected_count: priorRejectedResubmits,
            },
          ],
        };
      }
      // INSERT INTO ob_session_events — $10 (index 9) is the metadata JSON.
      if (params && typeof params[9] === "string") {
        captured.metadata = JSON.parse(params[9]);
        captured.createdBy = (params[14] as string | undefined) ?? null;
      }
      return {
        rows: [{ id: "event-uuid-1", created_at: "2026-06-08T10:00:00Z" }],
      };
    },
  };
  return pool;
}
