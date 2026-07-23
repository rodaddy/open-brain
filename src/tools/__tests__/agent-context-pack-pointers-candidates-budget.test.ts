import { describe, expect, it } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "../../types.ts";
import type { ToolDeps } from "../index.ts";
import { WorkingSetStore } from "../../realtime/working-set.ts";
import { RecoveryWalStore } from "../../realtime/recovery-wal.ts";
import { registerAgentContextPack } from "../agent-context-pack.ts";
import { registerGetEntry } from "../get-entry.ts";
import {
  AGENT_CONTEXT_PACK_SCOPE as SCOPE,
  admin,
  brainRecord,
  canonical,
  isRecallSql,
  nRecords,
  searchPool,
  setupAgentContextPackToolClient as setupToolClient,
} from "./agent-context-pack-test-helpers.ts";

/**
 * pointers + candidate_memory (#329) — whole-pack budget, cross-section
 * coexistence/allocation-order, and the author-side get_entry resolution proof.
 * These exercise the shared structured-section fitter (one whole-pack budget,
 * citation, and truncation reconciliation) and prove an emitted pointer is a
 * genuine resolvable reference that binds the SAME auth-derived namespace
 * predicate the recall applied. Baseline per-section behavior lives in
 * agent-context-pack-pointers-candidates.test.ts.
 */

describe("agent_context_pack pointers + candidate_memory budget/integration (#329)", () => {
  it("whole-pack trimming actually trims durable and resurfaces the trimmed row as a pointer, never silently losing it", async () => {
    // A calibrated whole-pack budget (max_tokens 600) trims the durable_memory
    // bodies from the normal cap of 8 down to a SINGLE retained item and stamps a
    // durable_memory whole_pack_budget truncation marker. The row the durable
    // section shed for budget must resurface as a pointer (a pointer envelope is
    // far smaller than a body), never silently lost.
    const { pool } = searchPool(nRecords(10));
    const { client, cleanup } = await setupToolClient(admin, pool);
    try {
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          query: "durable",
          requested_sections: ["durable_memory", "pointers"],
          budget: { max_tokens: 600 },
        },
      });
      const payload = JSON.parse((pack.content as any)[0].text);
      expect(pack.isError).toBeFalsy();
      const durable = payload.sections.durable_memory;
      const pointers = payload.sections.pointers;

      // Durable was ACTUALLY trimmed: retained count is below the normal cap of 8
      // (exactly 1 at this calibrated budget) and its body is marked truncated.
      expect(durable.item_count).toBe(1);
      expect(durable.item_count).toBeLessThan(8);
      expect(durable.truncated).toBe(true);
      // A whole_pack_budget durable_memory truncation marker is present.
      const truncation = payload.warnings.truncation as Array<any>;
      const durableMarker = truncation.find(
        (t) =>
          t.source === "durable_memory" && t.reason === "whole_pack_budget",
      );
      expect(durableMarker).toBeDefined();

      // The trimmed durable row resurfaces as a pointer.
      const durableIds = new Set(
        durable.items.map((i: any) => i.citation_id as string),
      );
      const pointerIds = new Set(
        pointers.items.map((p: any) => p.citation_id as string),
      );
      expect(pointerIds.size).toBeGreaterThan(0);
      // No identity is both durable and pointer.
      for (const id of pointerIds) {
        expect(durableIds.has(id)).toBe(false);
      }
      // The pointer surfaces a row that was NOT retained as a durable item: the
      // top-ranked dec-1 was kept durable, dec-2 (next-ranked, trimmed for
      // budget) resurfaces as the pointer.
      expect(durableIds.has(canonical("decisions", "dec-1"))).toBe(true);
      expect(pointerIds.has(canonical("decisions", "dec-2"))).toBe(true);
      // Union covers strictly more than the retained durable set alone.
      const union = new Set([...durableIds, ...pointerIds]);
      expect(union.size).toBeGreaterThan(durableIds.size);
    } finally {
      await cleanup();
    }
  });

  it("an emitted pointer's structural source_ref resolves through get_entry under the same auth-derived namespace predicate", async () => {
    // Author-side proof that a pointer is a genuine resolvable reference: take the
    // structural source_ref (type + id) an emitted pointer carries and resolve it
    // through get_entry using a token-scoped agent, then assert the resolution
    // query bound the caller's auth-derived namespace predicate (the SAME
    // isolation boundary the recall applied), not an arbitrary namespace.
    const agentAuth: AuthInfo = {
      role: "agent",
      clientId: "team-alpha",
      namespaceSource: "token",
    };
    // Two recallable records in the agent's own namespace. Real UUIDs so
    // get_entry's uuid-typed id input accepts the resolved id.
    const idA = "11111111-1111-4111-8111-111111111111";
    const idB = "22222222-2222-4222-8222-222222222222";
    const records = [
      brainRecord({
        id: idA,
        namespace: "team-alpha",
        content_preview: "record A",
        distance: 0.01,
        fts_rank: 0.99,
      }),
      brainRecord({
        id: idB,
        namespace: "team-alpha",
        content_preview: "record B",
        distance: 0.02,
        fts_rank: 0.98,
      }),
    ];

    const captured: Array<{ sql: string; params?: unknown[] }> = [];
    // A shared fake pool: recall arms return the records; a get_entry SELECT
    // against the decisions table returns the matching row only when its id and
    // the namespace predicate param are satisfied.
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params });
        if (isRecallSql(sql)) {
          return { rows: records };
        }
        // get_entry full-render SELECT ... FROM decisions d WHERE d.id = $1 ...
        if (sql.includes("FROM decisions")) {
          const id = params?.[0];
          const nsParam = params?.[1];
          const namespaces = Array.isArray(nsParam)
            ? (nsParam as string[])
            : null;
          const match = records.find(
            (r) =>
              r.id === id &&
              (!namespaces || namespaces.includes(r.namespace as string)),
          );
          return { rows: match ? [{ ...match }] : [] };
        }
        return { rows: [] };
      },
    };

    // Register both tools against the one shared pool.
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const deps: ToolDeps = {
      pool: pool as any,
      embedFn: async () => Array(768).fill(0.1),
      workingSetStore: new WorkingSetStore(),
      recoveryWalStore: new RecoveryWalStore(),
    };
    registerAgentContextPack(server, deps);
    registerGetEntry(server, deps);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const originalSend = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message: any, options?: any) =>
      originalSend(message, { ...options, authInfo: agentAuth });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      // No namespace override: the token-scoped agent reads its own namespace.
      const { namespace: _drop, ...unnamespacedScope } = SCOPE;
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...unnamespacedScope,
          query: "durable",
          requested_sections: ["pointers"],
        },
      });
      const payload = JSON.parse((pack.content as any)[0].text);
      expect(pack.isError).toBeFalsy();
      const pointers = payload.sections.pointers;
      expect(pointers.item_count).toBeGreaterThan(0);

      // Take the FIRST emitted pointer's STRUCTURAL source_ref (type + id) and
      // resolve it. type is the source_type ("decisions"), which is exactly the
      // get_entry table name; id is the entry UUID.
      const pointer = pointers.items[0];
      const table = pointer.source_ref.type as string;
      const id = pointer.source_ref.id as string;
      expect(table).toBe("decisions");

      // Clear captured so we inspect only the resolution query's params.
      captured.length = 0;
      const entry = await client.callTool({
        name: "get_entry",
        arguments: { table, id, render: "full" },
      });
      const entryPayload = JSON.parse((entry.content as any)[0].text);
      expect(entry.isError).toBeFalsy();
      // The pointer resolved to the exact record it referenced.
      expect(entryPayload.id).toBe(id);
      expect(entryPayload.namespace).toBe("team-alpha");

      // The resolution bound the auth-derived namespace predicate: the SELECT
      // carried a `= ANY($n::text[])` namespace filter and the param array is the
      // caller's readable namespaces (includes their own clientId), never open.
      const resolveQuery = captured.find((c) =>
        (c.sql as string).includes("FROM decisions"),
      );
      expect(resolveQuery).toBeDefined();
      expect(resolveQuery!.sql).toContain("namespace = ANY(");
      const nsParam = resolveQuery!.params?.[1];
      expect(Array.isArray(nsParam)).toBe(true);
      expect(nsParam as string[]).toContain("team-alpha");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("pointers/candidate coexist with actually-present guidance + repo_facts envelopes and appear last in allocation order", async () => {
    // A query fake that returns the RIGHT row shapes per SQL so profile_guidance,
    // process_guidance, and repo_facts each produce a real non-empty envelope —
    // proving coexistence, not just that pointers/candidate appear.
    const repoFactId = "33333333-3333-4333-8333-333333333333";
    const pool = {
      query: async (sql: string) => {
        if (
          sql.includes("FROM ob_session_events") &&
          sql.includes("candidate_type")
        ) {
          // profile_guidance (user_preference) and process_guidance
          // (process_rule) both read this shape; return one promoted row for each
          // candidate_type the loader asks for. The loader filters by $2, but the
          // in-process filter also checks row.candidateType, so return both.
          return {
            rows: [
              {
                id: "evt-pref",
                content: "prefer brevity",
                created_at: "2026-07-01T00:00:00Z",
                memory_lifecycle_action: "promote",
                candidate_type: "user_preference",
                candidate_reason: "stated",
                candidate_confidence: 0.9,
                candidate_scope: { key: "brevity" },
              },
              {
                id: "evt-rule",
                content: "branch before coding",
                created_at: "2026-07-01T00:00:00Z",
                memory_lifecycle_action: "promote",
                candidate_type: "process_rule",
                candidate_reason: "policy",
                candidate_confidence: 0.9,
                candidate_scope: { key: "branching" },
              },
            ],
          };
        }
        if (sql.includes("FROM ob_entities") && sql.includes("repo_fact")) {
          return {
            rows: [
              {
                id: repoFactId,
                namespace: "rico",
                updated_at: "2026-07-01T00:00:00Z",
                metadata: {
                  repo: "rodaddy/open-brain",
                  fact: "uses Bun runtime",
                  source_url: "https://example/repo",
                  source_commit: "abc123",
                  verified_at: "2026-07-01T00:00:00Z",
                },
              },
            ],
          };
        }
        if (
          sql.includes("query_embedding") ||
          sql.includes("fts_query") ||
          sql.includes("FROM ob_")
        ) {
          return { rows: nRecords(3) };
        }
        return { rows: [] };
      },
    };
    const { client, cleanup } = await setupToolClient(admin, pool);
    try {
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          query: "durable",
          repo: "rodaddy/open-brain",
          requested_sections: [
            "profile_guidance",
            "process_guidance",
            "repo_facts",
            "pointers",
            "candidate_memory",
          ],
          budget: { max_tokens: 4000 },
        },
      });
      const payload = JSON.parse((pack.content as any)[0].text);
      expect(pack.isError).toBeFalsy();

      // Requested guidance + repo_facts envelopes are ACTUALLY present and
      // non-empty — coexistence is proven, not just pointers/candidate presence.
      const profile = payload.sections.profile_guidance;
      const process = payload.sections.process_guidance;
      const repoFacts = payload.sections.repo_facts;
      expect(profile).toBeDefined();
      expect(profile.item_count).toBeGreaterThan(0);
      expect(process).toBeDefined();
      expect(process.item_count).toBeGreaterThan(0);
      expect(repoFacts).toBeDefined();
      expect(repoFacts.item_count).toBeGreaterThan(0);

      // pointers + candidate_memory coexist alongside them.
      expect(payload.sections.pointers).toBeDefined();
      expect(payload.sections.candidate_memory).toBeDefined();

      // Allocation order lists pointers + candidate_memory LAST, after repo_facts.
      const order = payload.budget.whole_pack.allocation_order as string[];
      expect(order[order.length - 2]).toBe("pointers");
      expect(order[order.length - 1]).toBe("candidate_memory");
      expect(order.indexOf("pointers")).toBeGreaterThan(
        order.indexOf("repo_facts"),
      );
    } finally {
      await cleanup();
    }
  });

  it("under a calibrated tight budget the lowest-priority pointers section is starved while a higher-value section survives", async () => {
    // Budget max_tokens 700: working_set (a real appended item) and durable_memory
    // both survive, but the lowest-priority pointers section is fully STARVED with
    // an explicit starved marker — a non-vacuous ordering proof.
    const { pool } = searchPool(nRecords(10));
    const { client, cleanup } = await setupToolClient(admin, pool);
    try {
      // Append a real working_set item so a higher-value section has content to
      // survive the budget (an empty working_set would starve regardless).
      await client.callTool({
        name: "working_set_append",
        arguments: {
          ...SCOPE,
          kind: "current_intent",
          content: "active intent to keep",
        },
      });
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          query: "durable",
          requested_sections: ["working_set", "durable_memory", "pointers"],
          budget: { max_tokens: 700 },
        },
      });
      const payload = JSON.parse((pack.content as any)[0].text);
      expect(pack.isError).toBeFalsy();

      // Higher-value sections survived the same budget that starved pointers.
      expect(payload.sections.working_set).toBeDefined();
      expect(payload.sections.working_set.item_count).toBeGreaterThan(0);
      expect(payload.sections.durable_memory).toBeDefined();
      expect(payload.sections.durable_memory.item_count).toBeGreaterThan(0);

      // Lowest-priority pointers section was fully starved out.
      expect(payload.sections.pointers).toBeUndefined();
      const truncation = payload.warnings.truncation as Array<any>;
      const pointerStarve = truncation.find((t) => t.source === "pointers");
      expect(pointerStarve).toBeDefined();
      expect(pointerStarve.starved).toBe(true);
      expect(pointerStarve.reason).toBe("whole_pack_budget");
    } finally {
      await cleanup();
    }
  });
});
