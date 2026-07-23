import { describe, expect, it } from "bun:test";
import type { AuthInfo } from "../../types.ts";
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
 * pointers + candidate_memory (#329) — baseline section behavior. These sections
 * are pure transforms over the durable_memory hybrid recall's already-authorized,
 * already-suppressed surplus pool (pointers) or independently truthful-empty
 * (candidate_memory) — no second retrieval stack. They are black-boxed through
 * the MCP tool: vary requested sections, prior_context, and namespace, and assert
 * the observable envelope, dedupe contract, structural (body-free) source_ref,
 * citation bijection, and the truthful empty candidate shape. The internal SQL is
 * not asserted beyond the single-recall, zero-recall, and namespace-predicate
 * invariants the issue requires proving.
 *
 * Whole-pack budget/coexistence and the get_entry resolution proof live in the
 * companion file agent-context-pack-pointers-candidates-budget.test.ts.
 */

describe("agent_context_pack pointers + candidate_memory (#329)", () => {
  it("pointers-only request makes every authorized recalled row pointer-eligible, including the top durable-memory rows", async () => {
    // 10 distinct rows; durable cap is 8. A pointers-only request suppresses the
    // durable_memory section, so the top-ranked rows must NOT be hidden — every
    // authorized row is pointer-eligible.
    const captured: Array<{ sql: string; params?: unknown[] }> = [];
    const { pool } = searchPool(nRecords(10), captured);
    const { client, cleanup } = await setupToolClient(admin, pool);
    try {
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          query: "durable",
          requested_sections: ["pointers"],
        },
      });
      const payload = JSON.parse((pack.content as any)[0].text);
      expect(pack.isError).toBeFalsy();
      // durable_memory section body is suppressed for a pointers-only request.
      expect(payload.sections.durable_memory).toBeUndefined();

      const pointers = payload.sections.pointers;
      expect(pointers.label).toBe("pointers");
      expect(pointers.namespace_scoped).toBe(true);
      expect(pointers.resolvable_reference_only).toBe(true);
      // All 10 authorized rows are pointer-eligible — the top durable rows are
      // NOT hidden behind the durable cap just because recall built bodies.
      expect(pointers.item_count).toBe(10);
      const ids = pointers.items.map((p: any) => p.id);
      expect(ids).toContain("dec-1"); // top-ranked, would be durable item #1
      expect(ids).toContain("dec-10"); // lowest-ranked

      // The recall ran exactly once (one executeSearch => one vector CTE + one
      // FTS CTE call is the search stack; no second retrieval stack for pointers).
      // vector + FTS arms of the single hybrid recall; no third arm for pointers.
      const recallCalls = captured.filter((c) => isRecallSql(c.sql));
      expect(recallCalls.length).toBeLessThanOrEqual(2);
    } finally {
      await cleanup();
    }
  });

  it("durable_memory + pointers share no duplicate canonical identity", async () => {
    const { pool } = searchPool(nRecords(10));
    const { client, cleanup } = await setupToolClient(admin, pool);
    try {
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          query: "durable",
          requested_sections: ["durable_memory", "pointers"],
        },
      });
      const payload = JSON.parse((pack.content as any)[0].text);
      expect(pack.isError).toBeFalsy();
      const durable = payload.sections.durable_memory;
      const pointers = payload.sections.pointers;
      expect(durable.item_count).toBe(8); // hard durable cap
      // The 2 rows beyond the cap are pointers; none of the retained durable
      // rows re-appear as a pointer.
      const durableIds = new Set(
        durable.items.map((i: any) => i.citation_id as string),
      );
      const pointerIds = new Set(
        pointers.items.map((p: any) => p.citation_id as string),
      );
      for (const id of pointerIds) {
        expect(durableIds.has(id)).toBe(false);
      }
      // Every id is canonical brain_record:${source_type}:${id}; no bare key.
      for (const item of [...durable.items, ...pointers.items]) {
        expect(item.citation_id).toBe(canonical(item.source_type, item.id));
      }
      // The rows beyond the cap surface as pointers.
      expect(pointers.item_count).toBe(2);
    } finally {
      await cleanup();
    }
  });

  it("pointers carry no body: no content, content_preview, label, or preview leaks", async () => {
    const { pool } = searchPool(nRecords(10));
    const { client, cleanup } = await setupToolClient(admin, pool);
    try {
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          query: "durable",
          requested_sections: ["pointers"],
        },
      });
      const payload = JSON.parse((pack.content as any)[0].text);
      const pointers = payload.sections.pointers;
      expect(pointers.item_count).toBeGreaterThan(0);
      for (const item of pointers.items) {
        expect(item).not.toHaveProperty("content");
        expect(item).not.toHaveProperty("content_preview");
        expect(item).not.toHaveProperty("label");
        expect(item).not.toHaveProperty("preview");
        // source_ref is identity coordinates only — no label/preview/body.
        expect(item.source_ref).not.toHaveProperty("label");
        expect(item.source_ref).not.toHaveProperty("preview");
        expect(Object.keys(item.source_ref).sort()).toEqual(
          ["id", "namespace", "source", "type"].sort(),
        );
      }
      // Serialized section must not carry the raw preview text anywhere.
      const serialized = JSON.stringify(pointers);
      expect(serialized).not.toContain("durable decision content");
    } finally {
      await cleanup();
    }
  });

  it("pointer source_ref is structural and citations are a bijection of emitted pointers", async () => {
    const { pool } = searchPool(nRecords(10));
    const { client, cleanup } = await setupToolClient(admin, pool);
    try {
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          query: "durable",
          requested_sections: ["pointers"],
        },
      });
      const payload = JSON.parse((pack.content as any)[0].text);
      const pointers = payload.sections.pointers;
      const pointerCitations = payload.citations.filter(
        (c: any) => c.kind === "pointer",
      );
      // Bijection: exactly one pointer citation per emitted pointer item, keyed
      // on the canonical citation_id, with a structural source_ref.
      expect(pointerCitations.length).toBe(pointers.items.length);
      const citationIds = new Set(pointerCitations.map((c: any) => c.id));
      for (const item of pointers.items) {
        expect(citationIds.has(item.citation_id)).toBe(true);
        const citation = pointerCitations.find(
          (c: any) => c.id === item.citation_id,
        );
        expect(citation.source_ref).toEqual(item.source_ref);
        expect(citation.source_ref.source).toBe("brain");
        expect(citation.source_ref.type).toBe(item.source_type);
        expect(citation.source_ref.id).toBe(item.id);
      }
      // No pointer citation references an unemitted item.
      const emittedIds = new Set(pointers.items.map((i: any) => i.citation_id));
      for (const citation of pointerCitations) {
        expect(emittedIds.has(citation.id)).toBe(true);
      }
    } finally {
      await cleanup();
    }
  });

  it("prior_context suppression still removes referenced records before they become pointers", async () => {
    const { pool } = searchPool(nRecords(4));
    const { client, cleanup } = await setupToolClient(admin, pool);
    try {
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          query: "durable",
          requested_sections: ["pointers"],
          prior_context: [{ citation_id: canonical("decisions", "dec-1") }],
        },
      });
      const payload = JSON.parse((pack.content as any)[0].text);
      const pointers = payload.sections.pointers;
      const ids = pointers.items.map((p: any) => p.id);
      // The suppressed record is never surfaced as a pointer either.
      expect(ids).not.toContain("dec-1");
      expect(ids).toContain("dec-2");
      expect(pointers.item_count).toBe(3);
    } finally {
      await cleanup();
    }
  });

  it("unauthorized namespace override fails before any recall runs", async () => {
    // A token-scoped agent cannot read an arbitrary namespace. The override must
    // be denied BEFORE the recall (no query issued).
    const captured: Array<{ sql: string; params?: unknown[] }> = [];
    const { pool } = searchPool(nRecords(4), captured);
    const agentAuth: AuthInfo = {
      role: "agent",
      clientId: "team-alpha",
      namespaceSource: "token",
    };
    const { client, cleanup } = await setupToolClient(agentAuth, pool);
    try {
      const { namespace: _drop, ...unnamespacedScope } = SCOPE;
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...unnamespacedScope,
          namespace: "someone-elses-namespace",
          query: "durable",
          requested_sections: ["pointers"],
        },
      });
      const payload = JSON.parse((pack.content as any)[0].text);
      expect(pack.isError).toBe(true);
      expect(String(payload.error)).toContain("Permission denied");
      // No recall query was ever issued.
      const recallCalls = captured.filter((c) => isRecallSql(c.sql));
      expect(recallCalls).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("candidate_memory alone runs ZERO recall queries and is a truthful empty section", async () => {
    // candidate_memory has no write-side candidate predicate, so it always emits
    // a truthful empty envelope. A candidate-only request must therefore NOT run
    // the durable hybrid recall just to compute anything: zero recall queries.
    const captured: Array<{ sql: string; params?: unknown[] }> = [];
    const { pool } = searchPool(nRecords(10), captured);
    const { client, cleanup } = await setupToolClient(admin, pool);
    try {
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          query: "durable",
          requested_sections: ["candidate_memory"],
        },
      });
      const payload = JSON.parse((pack.content as any)[0].text);
      expect(pack.isError).toBeFalsy();

      // Zero recall queries: candidate_memory alone never drives the hybrid
      // retrieval stack.
      const recallCalls = captured.filter((c) => isRecallSql(c.sql));
      expect(recallCalls).toHaveLength(0);

      const candidate = payload.sections.candidate_memory;
      // Exact truthful-empty candidate contract.
      expect(candidate).toEqual({
        label: "candidate_memory",
        namespace_scoped: true,
        confidence: "unconfirmed",
        auto_promotable: false,
        items: [],
        item_count: 0,
        empty_reason: "candidate_predicate_unavailable",
        truncated: false,
      });
      // No durable_memory or pointers section leaked into a candidate-only pack.
      expect(payload.sections.durable_memory).toBeUndefined();
      expect(payload.sections.pointers).toBeUndefined();
      // No candidate citation is emitted.
      const candidateCitations = payload.citations.filter(
        (c: any) => c.kind === "candidate",
      );
      expect(candidateCitations).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("candidate_memory co-requested with durable/pointers reuses the single recall and stays a truthful empty section", async () => {
    // When durable_memory or pointers is also requested the recall runs once for
    // them; candidate_memory reuses nothing extra and still emits its exact
    // truthful empty envelope with no dedupe-count field and no citations.
    const captured: Array<{ sql: string; params?: unknown[] }> = [];
    const { pool } = searchPool(nRecords(10), captured);
    const { client, cleanup } = await setupToolClient(admin, pool);
    try {
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          query: "durable",
          requested_sections: [
            "durable_memory",
            "pointers",
            "candidate_memory",
          ],
        },
      });
      const payload = JSON.parse((pack.content as any)[0].text);
      expect(pack.isError).toBeFalsy();
      // A single hybrid recall (its two arms) serves durable + pointers; the
      // candidate section adds no third arm.
      const recallCalls = captured.filter((c) => isRecallSql(c.sql));
      expect(recallCalls.length).toBeLessThanOrEqual(2);

      const candidate = payload.sections.candidate_memory;
      expect(candidate).toEqual({
        label: "candidate_memory",
        namespace_scoped: true,
        confidence: "unconfirmed",
        auto_promotable: false,
        items: [],
        item_count: 0,
        empty_reason: "candidate_predicate_unavailable",
        truncated: false,
      });
      // No synthetic dedupe observability is emitted.
      expect(candidate).not.toHaveProperty("dedupe_against_count");
      expect(candidate).not.toHaveProperty("missing_contract");
      const candidateCitations = payload.citations.filter(
        (c: any) => c.kind === "candidate",
      );
      expect(candidateCitations).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});
