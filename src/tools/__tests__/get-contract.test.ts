import { describe, expect, it } from "bun:test";
import { registerGetContract } from "../get-contract.ts";
import type { AuthInfo } from "../../types.ts";
import { createNatsBridgeHealth } from "../../nats-bridge.ts";
import { readNatsRuntimeBoundary } from "../../nats-runtime.ts";
import {
  createMockEmbed,
  getErrorText,
  parseToolResult,
  setupMcpClient,
} from "./test-helpers.ts";

describe("get_contract", () => {
  it("allows readonly clients to read the contract manifest", async () => {
    const auth: AuthInfo = { role: "readonly", clientId: "viewer" };
    const { client, cleanup } = await setupMcpClient(
      registerGetContract,
      { query: async () => ({ rows: [] }) },
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "get_contract",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      const parsed = parseToolResult(result);
      expect(parsed.service).toBe("open-brain");
      expect(parsed.schema_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(parsed.capabilities.map((c: { name: string }) => c.name)).toContain(
        "lane_upsert",
      );
    } finally {
      await cleanup();
    }
  });

  it("denies unauthenticated contract reads", async () => {
    const { client, cleanup } = await setupMcpClient(
      registerGetContract,
      { query: async () => ({ rows: [] }) },
      createMockEmbed(),
      null,
    );

    try {
      const result = await client.callTool({
        name: "get_contract",
        arguments: {},
      });

      expect(result.isError).toBe(true);
      expect(getErrorText(result)).toContain("Permission denied");
    } finally {
      await cleanup();
    }
  });

  it("advertises hot memory only through the agent_context_pack pull boundary (#271)", async () => {
    const auth: AuthInfo = { role: "readonly", clientId: "viewer" };
    const { client, cleanup } = await setupMcpClient(
      registerGetContract,
      { query: async () => ({ rows: [] }) },
      createMockEmbed(),
      auth,
    );

    try {
      const result = await client.callTool({
        name: "get_contract",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      const parsed = parseToolResult(result);

      // The pack keeps the exact-scope, budget/citation-bearing pull envelope.
      const pack = parsed.agent_context_pack;
      expect(pack.exact_scope_required).toBe(true);
      expect(pack.scope_keys).toEqual([
        "namespace",
        "agent",
        "platform",
        "server_id",
        "channel_id",
        "thread_id",
        "session_key",
      ]);
      expect(pack.envelope_fields).toEqual(["warnings", "budget", "citations"]);
      expect(pack.warning_fields).toContain("scope_denials");
      expect(pack.warning_fields).toContain("truncation");
      expect(pack.working_set.not_durable_memory).toBe(true);
      expect(pack.working_set.exact_scope_required).toBe(true);

      // No gbrain-style server-side response-injection capability is
      // advertised anywhere in the contract (docs/agent-context-pack-contract.md,
      // "Hot Memory Boundary Decision (#271)").
      const serialized = JSON.stringify(parsed);
      expect(serialized).not.toContain("hot_memory");
      expect(serialized).not.toContain("brain_hot_memory");
      expect(serialized).not.toContain("meta_injection");
    } finally {
      await cleanup();
    }
  });

  it("uses live NATS bridge health instead of static startup availability", async () => {
    const auth: AuthInfo = { role: "readonly", clientId: "viewer" };
    const { client, cleanup } = await setupMcpClient(
      registerGetContract,
      { query: async () => ({ rows: [] }) },
      createMockEmbed(),
      auth,
      {
        natsRuntimeBoundary: readNatsRuntimeBoundary({
          OPENBRAIN_TRANSPORT: "nats",
          OPENBRAIN_NATS_ENABLE_BRIDGE: "true",
          OPENBRAIN_NATS_URL: "nats://127.0.0.1:4222",
        }),
        natsBridgeHealth: createNatsBridgeHealth("not_runtime_available"),
      },
    );

    try {
      const result = await client.callTool({
        name: "get_contract",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      const parsed = parseToolResult(result);
      expect(parsed.realtime_transport.nats_jetstream).toMatchObject({
        status: "planned-transport-foundation",
        availability: "not_runtime_available",
      });
      expect(parsed.realtime_transport.nats_jetstream.request_reply_subjects.available)
        .toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
