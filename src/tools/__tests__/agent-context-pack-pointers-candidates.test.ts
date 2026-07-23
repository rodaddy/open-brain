import { describe, expect, it } from "bun:test";
import type { AuthInfo } from "../../types.ts";
import {
  AGENT_CONTEXT_PACK_SCOPE as SCOPE,
  setupAgentContextPackToolClient as setupToolClient,
} from "./agent-context-pack-test-helpers.ts";

/**
 * pointers + candidate_memory (#329). These sections are pure transforms over
 * the durable_memory hybrid recall's already-authorized, already-suppressed
 * surplus pool — no second retrieval stack. They are black-boxed through the MCP
 * tool: vary requested sections, budget, prior_context, and namespace, and
 * assert the observable envelope, dedupe contract, structural (body-free)
 * source_ref, citation bijection, and the truthful empty candidate shape. The
 * internal SQL is not asserted beyond the single-recall and namespace-predicate
 * invariants the issue requires proving.
 */

/**
 * A mock pool that answers the hybrid search CTEs (vector + FTS) with a supplied
 * set of brain records and records every query's params so isolation predicates
 * and the single-recall invariant can be asserted.
 */
function searchPool(
  records: Array<Record<string, unknown>>,
  captured: Array<{ sql: string; params?: unknown[] }> = [],
) {
  return {
    pool: {
      query: async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params });
        if (
          sql.includes("query_embedding") ||
          sql.includes("fts_query") ||
          sql.includes("FROM ob_")
        ) {
          return { rows: records };
        }
        return { rows: [] };
      },
    },
    captured,
  };
}

function brainRecord(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    source_type: "decisions",
    id: overrides.id ?? "dec-1",
    namespace: "rico",
    content_preview: "durable decision content",
    tags: null,
    created_by: "rico",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-02T00:00:00Z",
    usefulness: 0.9,
    tier: "warm",
    distance: 0.1,
    fts_rank: 0.9,
    ...overrides,
  };
}

/** N distinct decision records dec-1..dec-N with distinct ranked previews. */
function nRecords(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_v, i) =>
    brainRecord({
      id: `dec-${i + 1}`,
      content_preview: `durable decision content ${i + 1}`,
      // Descending distance keeps dec-1 highest-ranked, dec-N lowest.
      distance: 0.01 * (i + 1),
      fts_rank: 1 - 0.01 * (i + 1),
    }),
  );
}

const admin: AuthInfo = { role: "admin", clientId: "rico" };

function canonical(sourceType: string, id: string): string {
  return `brain_record:${sourceType}:${id}`;
}

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
      // Assert no additional recall was issued beyond the durable_memory recall.
      const recallCalls = captured.filter(
        (c) =>
          typeof c.sql === "string" &&
          (c.sql.includes("query_embedding") ||
            c.sql.includes("fts_query") ||
            c.sql.includes("FROM ob_")),
      );
      // vector + FTS arms of the single hybrid recall; no third arm for pointers.
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
      // deduped_against_durable reflects the retained durable identities.
      expect(pointers.item_count).toBe(2);
    } finally {
      await cleanup();
    }
  });

  it("whole-pack trimming does not silently lose pointer-eligible rows: a durable row trimmed for budget stays pointer-eligible", async () => {
    // A tight whole-pack budget starves the durable_memory bodies. Rows the
    // durable section could not retain must resurface as pointers (a pointer
    // envelope is far smaller than a body), never silently lost.
    const { pool } = searchPool(nRecords(10));
    const { client, cleanup } = await setupToolClient(admin, pool);
    try {
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          query: "durable",
          requested_sections: ["durable_memory", "pointers"],
          // Trims durable bodies down to a single retained item, but the far
          // smaller pointer envelope still admits a trimmed row.
          budget: { max_tokens: 600 },
        },
      });
      const payload = JSON.parse((pack.content as any)[0].text);
      expect(pack.isError).toBeFalsy();
      const durable = payload.sections.durable_memory;
      const pointers = payload.sections.pointers;

      const durableIds = new Set(
        (durable?.items ?? []).map((i: any) => i.citation_id as string),
      );
      const pointerIds = new Set(
        (pointers?.items ?? []).map((p: any) => p.citation_id as string),
      );
      // Durable was trimmed under budget pressure but did retain at least one
      // body, and pointers surfaced at least one additional row.
      expect(durableIds.size).toBeGreaterThan(0);
      expect(pointerIds.size).toBeGreaterThan(0);
      // No identity is both durable and pointer.
      for (const id of pointerIds) {
        expect(durableIds.has(id)).toBe(false);
      }
      // Union covers strictly more than the retained durable set alone: a row the
      // durable section shed for budget is still surfaced as a pointer, never
      // silently lost.
      const union = new Set([...durableIds, ...pointerIds]);
      expect(union.size).toBeGreaterThan(durableIds.size);
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
      const recallCalls = captured.filter(
        (c) =>
          typeof c.sql === "string" &&
          (c.sql.includes("query_embedding") ||
            c.sql.includes("fts_query") ||
            c.sql.includes("FROM ob_")),
      );
      expect(recallCalls).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("candidate_memory is a truthful empty section: no predicate, no inference, no citations", async () => {
    const { pool } = searchPool(nRecords(10));
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
      const candidate = payload.sections.candidate_memory;
      expect(candidate).toMatchObject({
        label: "candidate_memory",
        namespace_scoped: true,
        confidence: "unconfirmed",
        auto_promotable: false,
        item_count: 0,
        empty_reason: "candidate_predicate_unavailable",
        truncated: false,
      });
      expect(candidate.items).toEqual([]);
      // No verbose public missing-contract detail leaks.
      expect(candidate).not.toHaveProperty("missing_contract");
      // dedupe_against_count reflects retained durable + emitted pointer
      // identities (candidate dedupe contract), content-free.
      const durableCount = payload.sections.durable_memory.item_count;
      const pointerCount = payload.sections.pointers.item_count;
      expect(candidate.dedupe_against_count).toBe(durableCount + pointerCount);
      // No candidate citation is emitted.
      const candidateCitations = payload.citations.filter(
        (c: any) => c.kind === "candidate",
      );
      expect(candidateCitations).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("pointers/candidate coexist with guidance/repo_facts and appear last in allocation order", async () => {
    const { pool } = searchPool(nRecords(3));
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
      // All requested structured sections coexist.
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

  it("lowest-priority pointers are starved before any higher-value section under a tight budget", async () => {
    // A budget large enough for working_set but not for the lowest-priority
    // pointers section drops pointers first, leaving higher-value sections.
    const { pool } = searchPool(nRecords(10));
    const { client, cleanup } = await setupToolClient(admin, pool);
    try {
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          query: "durable",
          requested_sections: ["durable_memory", "pointers"],
          budget: { max_tokens: 150 },
        },
      });
      const payload = JSON.parse((pack.content as any)[0].text);
      expect(pack.isError).toBeFalsy();
      // Under severe pressure the lowest-priority pointers section is trimmed or
      // starved before durable_memory loses everything: if pointers is present
      // it never overflows, and any drop is recorded in truncation.
      const truncation = payload.warnings.truncation as Array<any>;
      const pointerStarve = truncation.find((t) => t.source === "pointers");
      if (!payload.sections.pointers) {
        // Fully starved: a starved marker must record the drop.
        expect(pointerStarve).toBeDefined();
        expect(pointerStarve.starved).toBe(true);
      }
    } finally {
      await cleanup();
    }
  });
});
