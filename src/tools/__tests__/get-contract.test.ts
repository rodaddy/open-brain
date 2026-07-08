import { describe, expect, it } from "bun:test";
import { registerGetContract } from "../get-contract.ts";
import {
  registerAgentContextPack,
  registerWorkingSetAppend,
} from "../agent-context-pack.ts";
import type { AuthInfo } from "../../types.ts";
import { createNatsBridgeHealth } from "../../nats-bridge.ts";
import { readNatsRuntimeBoundary } from "../../nats-runtime.ts";
import { WorkingSetStore } from "../../realtime/working-set.ts";
import { RecoveryWalStore } from "../../realtime/recovery-wal.ts";
import {
  createMockEmbed,
  getErrorText,
  parseToolResult,
  setupMcpClient,
} from "./test-helpers.ts";

// #271 tripwire: normalized case-insensitive patterns for hot-memory
// injection surfaces. Keys and string values are lowercased before matching,
// so camelCase/snake_case/spaced variants (brainHotMemory, hot_memory,
// "hot memory", mcp_meta) all normalize into a match.
const TRIPWIRE_PATTERNS = [
  /hot.?memory/,
  /brain.?hot/,
  /inject/,
  /push/,
  /_meta/,
] as const;

// Exact-match allowlist of terms in the real buildContract() output that
// legitimately contain a tripwire hit (both embed "_meta" inside
// "_metadata"). Derived from the actual contract output; any new match
// anywhere in the contract trips the test and must be consciously
// allowlisted here.
const TRIPWIRE_ALLOWED_TERMS = ["max_metadata_chars", "resubmit_metadata"];

function maskAllowedTerms(normalized: string): string {
  let masked = normalized;
  for (const term of TRIPWIRE_ALLOWED_TERMS) {
    masked = masked.split(term).join("allowed_term");
  }
  return masked;
}

/** Recursively collect tripwire hits across all keys and string values. */
function collectTripwireHits(
  node: unknown,
  path: string,
  hits: string[],
): void {
  if (Array.isArray(node)) {
    node.forEach((value, index) =>
      collectTripwireHits(value, `${path}[${index}]`, hits),
    );
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "_meta") {
        hits.push(`${path}.${key}: exact _meta key`);
      } else {
        const maskedKey = maskAllowedTerms(key.toLowerCase());
        for (const pattern of TRIPWIRE_PATTERNS) {
          if (pattern.test(maskedKey)) {
            hits.push(`${path}.${key}: key matches ${pattern}`);
          }
        }
      }
      collectTripwireHits(value, `${path}.${key}`, hits);
    }
    return;
  }
  if (typeof node === "string") {
    const masked = maskAllowedTerms(node.toLowerCase());
    for (const pattern of TRIPWIRE_PATTERNS) {
      if (pattern.test(masked)) {
        hits.push(
          `${path}: value ${JSON.stringify(node).slice(0, 80)} matches ${pattern}`,
        );
      }
    }
  }
}

/** Recursively collect the paths of every key literally named "_meta". */
function findMetaKeyPaths(node: unknown, path: string, paths: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((value, index) =>
      findMetaKeyPaths(value, `${path}[${index}]`, paths),
    );
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "_meta") paths.push(`${path}.${key}`);
      findMetaKeyPaths(value, `${path}.${key}`, paths);
    }
  }
}

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
      // Advertisement"): recursively walk every contract key and string
      // value with normalized case-insensitive injection patterns and an
      // exact-match allowlist, so renamed/camelCase variants trip too.
      const tripwireHits: string[] = [];
      collectTripwireHits(parsed, "contract", tripwireHits);
      expect(tripwireHits).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("returns ordinary MCP tool results without _meta hot-memory injection (#271)", async () => {
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupMcpClient(
      (server, deps) => {
        registerGetContract(server, deps);
        registerWorkingSetAppend(server, deps);
        registerAgentContextPack(server, deps);
      },
      { query: async () => ({ rows: [] }) },
      createMockEmbed(),
      auth,
      {
        workingSetStore: new WorkingSetStore(),
        recoveryWalStore: new RecoveryWalStore(),
      },
    );

    const scope = {
      namespace: "rico",
      agent: "nagatha",
      platform: "discord",
      server_id: "rodaddy-live",
      channel_id: "open-brain",
      session_key: "discord:rodaddy-live:open-brain:nagatha",
    };

    try {
      // Seed hot working context so a hypothetical response middleware would
      // have a payload to leak into ordinary tool results.
      const append = await client.callTool({
        name: "working_set_append",
        arguments: {
          ...scope,
          kind: "current_intent",
          content: "seed working context for the #271 response regression",
        },
      });
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...scope,
          requested_sections: ["working_set"],
        },
      });
      const contract = await client.callTool({
        name: "get_contract",
        arguments: {},
      });

      const results = [
        ["working_set_append", append],
        ["agent_context_pack", pack],
        ["get_contract", contract],
      ] as const;

      for (const [name, result] of results) {
        expect(result.isError).toBeFalsy();

        // The raw MCP result carries no _meta key at any depth, so no
        // gbrain-style _meta.brain_hot_memory payload can ride along.
        const metaPaths: string[] = [];
        findMetaKeyPaths(result, name, metaPaths);
        expect(metaPaths).toEqual([]);

        // And no hot-memory payload names appear anywhere in the normalized
        // serialized result.
        const normalized = JSON.stringify(result).toLowerCase();
        expect(normalized).not.toMatch(/hot.?memory/);
        expect(normalized).not.toMatch(/brain.?hot/);
        expect(normalized).not.toMatch(/meta.?injection/);
      }

      // Sanity: the pack still returns the seeded hot state through the
      // explicit pull path, proving the working set was populated when the
      // ordinary results above stayed injection-free.
      const packPayload = parseToolResult(pack);
      expect(packPayload.sections.working_set.item_count).toBe(1);
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
