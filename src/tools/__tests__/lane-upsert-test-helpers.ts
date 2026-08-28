/**
 * Helpers shared by the split lane_upsert test files.
 *
 * Holds no test and creates no pool: a database-touching helper takes its
 * `pool` as a parameter so each split half owns its own connection lifecycle.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Pool } from "pg";
import { registerLaneUpsert } from "../lane-upsert.ts";
import { createMockEmbed, type MockPool } from "./test-helpers.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo as ObAuthInfo } from "../../types.ts";
import { expectDefined } from "../../../scripts/test-support/expect-defined.ts";

export { expectDefined };

export type { ObAuthInfo };

type TransportSend = InMemoryTransport["send"];
type SendMessage = Parameters<TransportSend>[0];
type SendOptions = Parameters<TransportSend>[1];

export type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
/** Typed read of the first text block of a tool result. */
export function firstText(result: ToolResult): string {
  const content = expectDefined(
    result.content as Array<{ text?: string }> | undefined,
    "result.content",
  );
  const block = expectDefined(content[0], "result.content[0]");
  return expectDefined(block.text, "result.content[0].text");
}

export function createThrowingEmbed(error: Error) {
  return async (_text: string): Promise<number[] | null> => {
    throw error;
  };
}

export async function setupToolClient(
  mockPool: MockPool,
  auth: ObAuthInfo,
  embedFn?: (text: string) => Promise<number[] | null>,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = {
    pool: mockPool as unknown as Pool,
    embedFn: embedFn ?? createMockEmbed(),
  };
  registerLaneUpsert(server, deps);

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
