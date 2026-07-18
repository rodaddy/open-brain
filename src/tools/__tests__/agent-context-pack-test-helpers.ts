import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  registerAgentContextPack,
  registerRecoveryWalAppend,
  registerRecoveryWalMark,
  registerWorkingSetAppend,
} from "../agent-context-pack.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";
import { WorkingSetStore } from "../../realtime/working-set.ts";
import { RecoveryWalStore } from "../../realtime/recovery-wal.ts";

export const AGENT_CONTEXT_PACK_SCOPE = {
  namespace: "rico",
  agent: "nagatha",
  platform: "discord",
  server_id: "rodaddy-live",
  channel_id: "open-brain",
  session_key: "discord:rodaddy-live:open-brain:nagatha",
};

function createMockEmbed(result: number[] | null = Array(768).fill(0.1)) {
  return async (_text: string) => result;
}

export async function setupAgentContextPackToolClient(
  auth: AuthInfo,
  pool: {
    query: (...args: any[]) => Promise<{ rows: any[] }>;
    connect?: () => Promise<unknown>;
  } = {
    query: async () => ({ rows: [] }),
  },
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = {
    pool: pool as any,
    embedFn: createMockEmbed(),
    workingSetStore: new WorkingSetStore(),
    recoveryWalStore: new RecoveryWalStore(),
  };
  registerWorkingSetAppend(server, deps);
  registerRecoveryWalAppend(server, deps);
  registerRecoveryWalMark(server, deps);
  registerAgentContextPack(server, deps);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message: any, options?: any) => {
    return originalSend(message, { ...options, authInfo: auth });
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
