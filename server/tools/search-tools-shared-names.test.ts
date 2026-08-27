/**
 * The search tools read their shared-namespace names from `dependencies`.
 *
 * `search_brain`, `search_all`, and `brain_answer` each gate a caller-supplied
 * namespace with `canReadNamespace`. That gate treats the shared namespace as
 * readable by every scoped identity, so a namespace name that ONLY the injected
 * set defines is the sharpest available probe: with the set threaded through
 * `dependencies.sharedNamespaceNames` the request is authorized, and with the
 * set absent the environment default does not know the name and the request is
 * denied before any query runs.
 *
 * The pool is faked and throws, so no arm can return rows; the denial envelope
 * is what separates the two cases.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pino from "pino";
import type { Pool } from "pg";
import { registerMemoryTools } from "./index.ts";
import type { SharedNamespaceConfig } from "./shared-namespace.ts";

const INJECTED_NAMES: SharedNamespaceConfig = {
  canonicalSharedNamespace: "lane3-canonical-shared",
  physicalSharedNamespace: "lane3-physical-shared",
  legacySharedNamespace: "",
  legacyFallbackEnabled: false,
  fallbackMinResults: 5,
  sharedNamespace: "lane3-physical-shared",
  allowLegacySharedWrites: false,
};

const REACHED_POOL = "reached-the-pool";
const NAMESPACE_DENIED = "Permission denied: namespace read access denied";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function clientWith(names?: SharedNamespaceConfig): Promise<Client> {
  const server = new McpServer({ name: "search-names-test", version: "1.0.0" });
  const pool = {
    query: async () => {
      throw new Error(REACHED_POOL);
    },
  } as unknown as Pool;
  registerMemoryTools(server, {
    pool,
    embedFn: async () => null,
    logger: pino({ level: "silent" }),
    sharedNamespaceNames: names,
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    send(message, {
      ...options,
      authInfo: {
        role: "agent",
        clientId: "lane3-caller",
        namespaceSource: "token",
      },
    } as unknown as Parameters<typeof send>[1]);
  const client = new Client({ name: "search-names-test", version: "1.0.0" });
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
  names: SharedNamespaceConfig | undefined,
): Promise<string> {
  const client = await clientWith(names);
  const result = await client.callTool({
    name: tool,
    arguments: {
      query: "anything",
      namespace: INJECTED_NAMES.canonicalSharedNamespace,
    },
  });
  return (result.content as Array<{ text: string }>)[0]?.text ?? "";
}

const TOOLS = ["search_brain", "search_all", "brain_answer"];

describe("search tools take shared-namespace names from dependencies", () => {
  for (const tool of TOOLS) {
    test(`${tool} authorizes the injected shared namespace`, async () => {
      expect(await textFor(tool, INJECTED_NAMES)).not.toContain(
        NAMESPACE_DENIED,
      );
    });

    test(`${tool} fails loudly when no names are injected`, async () => {
      // Not a denial: an unwired composition root is a defect, and the tool
      // says so by name rather than looking like an ordinary refusal.
      expect(await textFor(tool, undefined)).toContain("sharedNamespaceNames");
    });
  }
});
