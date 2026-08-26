import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pino from "pino";
import type { Pool } from "pg";
import { registerMemoryTools } from "./index.ts";
import { DEFAULT_SHARED_NAMESPACE_NAMES } from "./shared-namespace-fixture.ts";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function clientForAgent(): Promise<Client> {
  const server = new McpServer({ name: "memory-tools-test", version: "1.0.0" });
  const pool = {
    query: async () => {
      throw new Error("namespace denial must happen before database access");
    },
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
      authInfo: {
        role: "agent",
        clientId: "parity-namespace",
        namespaceSource: "token",
      },
    } as unknown as Parameters<typeof send>[1]);
  const client = new Client({
    name: "namespace-denial-test",
    version: "1.0.0",
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function textFor(
  tool: string,
  arguments_: Record<string, unknown>,
): Promise<string> {
  const client = await clientForAgent();
  const result = await client.callTool({ name: tool, arguments: arguments_ });
  expect(result.isError).toBe(true);
  return (result.content as Array<{ text: string }>)[0]?.text ?? "";
}

describe("memory tools preserve namespace denial envelopes", () => {
  test("write surfaces name the auth-derived namespace denial", async () => {
    expect(
      await textFor("session_start", {
        session_key: "denied",
        namespace: "attacker",
      }),
    ).toBe(
      "Permission denied: agent role cannot write to namespace 'attacker'",
    );
  });

  test("session reads preserve the named namespace denial", async () => {
    expect(
      await textFor("session_context", {
        session_key: "denied",
        namespace: "attacker",
      }),
    ).toBe("Permission denied: cannot read namespace 'attacker'");
  });

  test("search reads preserve the stable generic denial", async () => {
    expect(
      await textFor("search_brain", {
        query: "denied",
        namespace: "attacker",
      }),
    ).toBe("Permission denied: namespace read access denied");
  });
});
