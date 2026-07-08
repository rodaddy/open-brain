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

      // Positive shape: the top-level contract surface is exactly this key
      // set (buildContract in src/contract.ts). Any new top-level capability
      // trips this test loudly and must be consciously acknowledged against
      // the #271 boundary decision before landing.
      expect(Object.keys(parsed).sort()).toEqual([
        "agent_context_pack",
        "agent_memory_adapter",
        "capabilities",
        "compatible_client_ranges",
        "contract_scope",
        "contract_version",
        "generated_at",
        "interchange_profiles",
        "min_client_versions",
        "promotion_lifecycle",
        "realtime_transport",
        "receipt_contract",
        "schema_hash",
        "schema_version",
        "service",
        "tool_contracts",
        "transport",
      ]);

      // Positive shape: the only advertised context-bundle surface is the
      // client-pulled agent_context_pack, and it is runtime-available. No
      // other top-level key names a push/injection/hot-memory/context-bundle
      // capability.
      const contextBundleLikeKeys = Object.keys(parsed).filter((key) =>
        /(hot|inject|push|context|bundle|_meta)/i.test(key),
      );
      expect(contextBundleLikeKeys).toEqual(["agent_context_pack"]);
      expect(pack.status).toBe("runtime-available");
      expect(pack.availability).toBe("mcp_tool_available");

      // No advertised capability or tool contract names a push/injection
      // channel either.
      const advertisedNames = [
        ...parsed.capabilities.map((c: { name: string }) => c.name),
        ...Object.keys(parsed.tool_contracts),
      ];
      expect(
        advertisedNames.filter((name) =>
          /(hot_memory|inject|push|_meta)/i.test(name),
        ),
      ).toEqual([]);

      // Tripwire only -- enforcement is the #271 preconditions plus human
      // review (docs/agent-context-pack-contract.md, "get_contract
      // Advertisement"): no gbrain-style server-side response-injection
      // capability appears in the serialized contract under its known names.
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
