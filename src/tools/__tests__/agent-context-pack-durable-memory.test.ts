import { describe, expect, it } from "bun:test";
import type { AuthInfo } from "../../types.ts";
import {
  AGENT_CONTEXT_PACK_SCOPE as SCOPE,
  setupAgentContextPackToolClient as setupToolClient,
} from "./agent-context-pack-test-helpers.ts";

/**
 * The durable_memory section is a query-driven hybrid-RRF recall over the
 * caller's readable durable brain records, isolated to the auth-derived
 * namespace. These tests black-box the section through the MCP tool: they vary
 * scope, query, budget, and role, and assert the observable envelope, citations,
 * isolation predicate, and defined empty/degraded states — not the internal SQL
 * shape beyond the namespace security boundary the issue requires proving.
 */

/**
 * A mock pool that answers the hybrid search CTEs (vector + FTS) with a supplied
 * set of brain records and records every query's params so isolation predicates
 * can be asserted.
 */
function searchPool(
  records: Array<Record<string, unknown>>,
  captured: Array<{ sql: string; params?: unknown[] }> = [],
) {
  return {
    pool: {
      query: async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params });
        // Vector CTE and FTS CTE both select from the brain tables; return the
        // records for either search path so RRF has both lists to merge.
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

describe("agent_context_pack durable_memory", () => {
  it("does not query or return durable_memory unless explicitly requested", async () => {
    const captured: Array<{ sql: string; params?: unknown[] }> = [];
    const { pool } = searchPool([brainRecord()], captured);
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth, pool);
    try {
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          query: "durable decision",
          requested_sections: ["working_set"],
        },
      });
      const payload = JSON.parse((pack.content as any)[0].text);
      expect(pack.isError).toBeFalsy();
      expect(payload.sections.durable_memory).toBeUndefined();
      expect(captured).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("returns a defined empty section with no_query reason when requested without a query", async () => {
    const captured: Array<{ sql: string; params?: unknown[] }> = [];
    const { pool } = searchPool([brainRecord()], captured);
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth, pool);
    try {
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          requested_sections: ["durable_memory"],
        },
      });
      const payload = JSON.parse((pack.content as any)[0].text);
      expect(pack.isError).toBeFalsy();
      const section = payload.sections.durable_memory;
      expect(section).toMatchObject({
        label: "durable_memory",
        namespace_scoped: true,
        query: null,
        empty_reason: "no_query",
        item_count: 0,
        truncated: false,
      });
      expect(section.items).toEqual([]);
      expect(payload.citations).toEqual([]);
      // No recall query is issued when there is no query.
      expect(captured).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("returns a defined empty section with no_matches when the recall finds nothing", async () => {
    const { pool } = searchPool([]);
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth, pool);
    try {
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          query: "nothing matches this",
          requested_sections: ["durable_memory"],
        },
      });
      const payload = JSON.parse((pack.content as any)[0].text);
      expect(pack.isError).toBeFalsy();
      const section = payload.sections.durable_memory;
      expect(section).toMatchObject({
        label: "durable_memory",
        namespace_scoped: true,
        query: "nothing matches this",
        empty_reason: "no_matches",
        item_count: 0,
        truncated: false,
      });
      expect(section.items).toEqual([]);
      expect(payload.citations).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("returns recalled records with a resolvable source_ref and matching citation on every item", async () => {
    const records = [
      brainRecord({ id: "dec-1", source_type: "decisions" }),
      brainRecord({
        id: "th-1",
        source_type: "thoughts",
        content_preview: "a durable thought",
      }),
    ];
    const { pool } = searchPool(records);
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth, pool);
    try {
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          query: "durable",
          requested_sections: ["durable_memory"],
        },
      });
      const payload = JSON.parse((pack.content as any)[0].text);
      expect(pack.isError).toBeFalsy();
      const section = payload.sections.durable_memory;
      expect(section.item_count).toBe(section.items.length);
      expect(section.items.length).toBeGreaterThan(0);

      // Every item carries a citation_id and every citation resolves back to a
      // brain record with a source_ref (source/type/id) — the resolvability
      // contract the issue requires on every item.
      const citationIds = new Set(
        payload.citations.map((c: any) => c.id as string),
      );
      for (const item of section.items) {
        expect(typeof item.citation_id).toBe("string");
        expect(citationIds.has(item.citation_id)).toBe(true);
        const citation = payload.citations.find(
          (c: any) => c.id === item.citation_id,
        );
        expect(citation.kind).toBe("brain_record");
        expect(citation.source_ref).toBeDefined();
        expect(citation.source_ref.source).toBe("brain");
        expect(citation.source_ref.id).toBe(item.id);
        expect(citation.source_ref.type).toBe(item.source_type);
        // Every item carries its OWN bounded source_ref, not just a citation_id,
        // and it is the same source_ref the citation exposes — the item is
        // independently resolvable back to its brain record.
        expect(item.source_ref).toBeDefined();
        expect(item.source_ref).toEqual(citation.source_ref);
        expect(item.source_ref.source).toBe("brain");
        expect(item.source_ref.id).toBe(item.id);
        expect(item.source_ref.type).toBe(item.source_type);
      }
      // No citation is emitted without a corresponding retained item.
      const retainedIds = new Set(section.items.map((i: any) => i.citation_id));
      for (const citation of payload.citations) {
        expect(retainedIds.has(citation.id)).toBe(true);
      }
    } finally {
      await cleanup();
    }
  });

  it("isolates recall to the auth-derived namespace for a token-scoped role", async () => {
    // A token-sourced agent role reads only its own namespace plus shared. The
    // recall must bind that namespace predicate on every search path — this is
    // the isolation security boundary, enforced server-side.
    const captured: Array<{ sql: string; params?: unknown[] }> = [];
    const { pool } = searchPool([brainRecord()], captured);
    const auth: AuthInfo = {
      role: "agent",
      clientId: "team-alpha",
      namespaceSource: "token",
    };
    const { client, cleanup } = await setupToolClient(auth, pool);
    try {
      const { namespace: _drop, ...unnamespacedScope } = SCOPE;
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...unnamespacedScope,
          // No explicit namespace: the auth-derived clientId is the boundary.
          query: "durable",
          requested_sections: ["durable_memory"],
        },
      });
      expect(pack.isError).toBeFalsy();
      // Every issued search query binds a namespace predicate whose params
      // include the caller's own namespace and never a foreign one.
      expect(captured.length).toBeGreaterThan(0);
      for (const q of captured) {
        expect(q.sql).toContain("namespace");
        const flat = (q.params ?? []).flat();
        expect(flat).toContain("team-alpha");
        expect(flat).not.toContain("rico");
        expect(flat).not.toContain("other-tenant");
      }
    } finally {
      await cleanup();
    }
  });

  it("out-of-scope negative regression: a foreign-namespace record is never surfaced across the boundary", async () => {
    // The DB layer is the authority. Simulate a leaky store that would return a
    // foreign-namespace row: the section still binds the caller's namespace
    // predicate, and the tool never widens the predicate to a foreign namespace.
    // This fails on any change that drops or broadens the namespace binding.
    const captured: Array<{ sql: string; params?: unknown[] }> = [];
    const auth: AuthInfo = {
      role: "agent",
      clientId: "tenant-a",
      namespaceSource: "token",
    };
    const { client, cleanup } = await setupToolClient(auth, {
      query: async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params });
        return { rows: [] };
      },
    });
    try {
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          // An explicit foreign namespace is NOT authorized for a token role and
          // must not be honored: the tool denies the section rather than reading
          // across the boundary.
          namespace: "tenant-b",
          query: "secret",
          requested_sections: ["durable_memory"],
        },
      });
      const payload = JSON.parse((pack.content as any)[0].text);
      // The whole pack is denied at the namespace gate before any recall runs —
      // no cross-namespace read is issued.
      expect(pack.isError).toBe(true);
      expect(JSON.stringify(payload)).toContain("Permission denied");
      expect(captured).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("bounds the section to the whole-pack budget, dropping the lowest-ranked records first", async () => {
    // RRF orders records best-first; under budget pressure the lowest-ranked
    // (tail) records are shed while the highest-ranked head is preserved.
    const records = Array.from({ length: 8 }, (_, index) =>
      brainRecord({
        id: `rank-${index}`,
        source_type: "decisions",
        content_preview: `rank-${index}:` + "D".repeat(800),
        // Descending relevance so RRF keeps rank-0 first, rank-7 last.
        distance: 0.1 + index * 0.05,
        fts_rank: 1 - index * 0.1,
        usefulness: 1 - index * 0.05,
        created_at: "2026-07-01T00:00:00Z",
      }),
    );
    const { pool } = searchPool(records);
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth, pool);
    try {
      const maxTokens = 900;
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          query: "rank",
          requested_sections: ["durable_memory"],
          budget: { max_tokens: maxTokens },
        },
      });
      const payload = JSON.parse((pack.content as any)[0].text);
      const contentBudget = maxTokens * 4 - 1200;
      const section = payload.sections.durable_memory;
      expect(section).toBeDefined();
      // A real trim happened: some but not all records survived.
      expect(section.items.length).toBeGreaterThan(0);
      expect(section.items.length).toBeLessThan(8);
      // The serialized section stays within the whole-pack budget.
      expect(JSON.stringify(payload.sections).length).toBeLessThanOrEqual(
        contentBudget,
      );
      // The highest-ranked record survives; the lowest-ranked is shed.
      const ids = section.items.map((i: any) => i.id);
      expect(ids[0]).toBe("rank-0");
      expect(ids).not.toContain("rank-7");
      // Retained records are the highest-ranked contiguous prefix.
      const retained = ids.map((id: string) =>
        Number(/rank-(\d+)/.exec(id)![1]),
      );
      for (let k = 1; k < retained.length; k += 1) {
        expect(retained[k]).toBe(retained[k - 1] + 1);
      }
      // item_count reconciles to retained items; citations never dangle.
      expect(section.item_count).toBe(section.items.length);
      const retainedCitationIds = new Set(
        section.items.map((i: any) => i.citation_id),
      );
      for (const citation of payload.citations) {
        expect(retainedCitationIds.has(citation.id)).toBe(true);
      }
      // Budget accounting reconciles to the retained content body.
      const bodyChars = section.items.reduce(
        (sum: number, i: any) => sum + (i.content ?? "").length,
        0,
      );
      expect(payload.budget.durable_memory.content_chars_used).toBe(bodyChars);
      // A whole-pack truncation marker names the trimmed section.
      expect(payload.warnings.truncation).toContainEqual(
        expect.objectContaining({
          source: "durable_memory",
          reason: "whole_pack_budget",
        }),
      );
    } finally {
      await cleanup();
    }
  });

  it("reconciles section.truncated to true when a partial whole-pack trim drops records", async () => {
    // A partial trim (some records survive, some are dropped) must flip the
    // section's own `truncated` flag to true — a stale false would tell the
    // caller the recall was complete when the tail was actually shed. Counters,
    // citations, and the whole-pack warning must stay consistent with the
    // retained items.
    const records = Array.from({ length: 8 }, (_, index) =>
      brainRecord({
        id: `trim-${index}`,
        source_type: "decisions",
        content_preview: `trim-${index}:` + "D".repeat(800),
        distance: 0.1 + index * 0.05,
        fts_rank: 1 - index * 0.1,
        usefulness: 1 - index * 0.05,
        created_at: "2026-07-01T00:00:00Z",
      }),
    );
    const { pool } = searchPool(records);
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth, pool);
    try {
      const maxTokens = 900;
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          query: "trim",
          requested_sections: ["durable_memory"],
          budget: { max_tokens: maxTokens },
        },
      });
      const payload = JSON.parse((pack.content as any)[0].text);
      const section = payload.sections.durable_memory;
      expect(section).toBeDefined();
      // A genuine partial trim: some but not all records survived.
      expect(section.items.length).toBeGreaterThan(0);
      expect(section.items.length).toBeLessThan(8);
      // The section's own truncated flag reflects the drop — not a stale false.
      expect(section.truncated).toBe(true);
      // A partial trim retained records, so it is not marked empty.
      expect(section.empty_reason).toBeUndefined();
      // item_count reconciles to the retained items.
      expect(section.item_count).toBe(section.items.length);
      // Citations never dangle: every citation maps to a retained item and every
      // retained item has a citation.
      const retainedCitationIds = new Set(
        section.items.map((i: any) => i.citation_id),
      );
      expect(payload.citations.length).toBe(section.items.length);
      for (const citation of payload.citations) {
        expect(retainedCitationIds.has(citation.id)).toBe(true);
      }
      for (const item of section.items) {
        expect(typeof item.citation_id).toBe("string");
      }
      // The whole-pack truncation warning names the trimmed section.
      expect(payload.warnings.truncation).toContainEqual(
        expect.objectContaining({
          source: "durable_memory",
          reason: "whole_pack_budget",
        }),
      );
      // Serialized sections stay within the whole-pack budget.
      expect(JSON.stringify(payload.sections).length).toBeLessThanOrEqual(
        maxTokens * 4 - 1200,
      );
    } finally {
      await cleanup();
    }
  });

  it("preserves item.source_ref == citation.source_ref with no dangling refs after a partial whole-pack trim", async () => {
    // After a partial trim, every surviving item must still carry its own
    // source_ref, that source_ref must equal its citation's source_ref, and no
    // citation (source_ref) may reference a dropped item — the item-carried
    // source_ref must reconcile alongside the citation.
    const records = Array.from({ length: 8 }, (_, index) =>
      brainRecord({
        id: `ref-${index}`,
        source_type: "decisions",
        content_preview: `ref-${index}:` + "D".repeat(800),
        distance: 0.1 + index * 0.05,
        fts_rank: 1 - index * 0.1,
        usefulness: 1 - index * 0.05,
        created_at: "2026-07-01T00:00:00Z",
      }),
    );
    const { pool } = searchPool(records);
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth, pool);
    try {
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          query: "ref",
          requested_sections: ["durable_memory"],
          budget: { max_tokens: 900 },
        },
      });
      const payload = JSON.parse((pack.content as any)[0].text);
      const section = payload.sections.durable_memory;
      expect(section).toBeDefined();
      // A genuine partial trim.
      expect(section.items.length).toBeGreaterThan(0);
      expect(section.items.length).toBeLessThan(8);

      const citationById = new Map<string, any>(
        payload.citations.map((c: any) => [c.id as string, c]),
      );
      // Every retained item has its own source_ref equal to its citation's.
      for (const item of section.items) {
        expect(item.source_ref).toBeDefined();
        const citation = citationById.get(item.citation_id);
        expect(citation).toBeDefined();
        expect(item.source_ref).toEqual(citation.source_ref);
        expect(item.source_ref.id).toBe(item.id);
      }
      // No dangling citation/source_ref: every citation maps to a retained item.
      const retainedIds = new Set(section.items.map((i: any) => i.citation_id));
      expect(payload.citations.length).toBe(section.items.length);
      for (const citation of payload.citations) {
        expect(retainedIds.has(citation.id)).toBe(true);
      }
      // No dropped record's source_ref survives on any retained item.
      const retainedRecordIds = new Set(section.items.map((i: any) => i.id));
      for (const item of section.items) {
        expect(retainedRecordIds.has(item.source_ref.id)).toBe(true);
      }
    } finally {
      await cleanup();
    }
  });

  it("emits a zero-item durable_memory envelope with a truthful whole_pack_budget empty_reason when trimming empties it but the envelope still fits", async () => {
    // A single record whose serialized body cannot fit the surviving budget, but
    // where the empty durable_memory envelope (label/query/counters/empty_reason)
    // can. The retained list is trimmed to empty; the emitted envelope must state
    // a stable empty_reason of whole_pack_budget rather than reporting no reason
    // or claiming a complete-but-empty recall, and its truncated flag must be
    // true with counts zeroed and no dangling citations.
    const records = [
      brainRecord({
        id: "solo-1",
        source_type: "decisions",
        content_preview: "solo:" + "D".repeat(2000),
      }),
    ];
    const { pool } = searchPool(records);
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth, pool);
    try {
      // max_tokens 500 => 800-char whole-pack budget: too small for the ~2000-char
      // record body, large enough for the empty envelope.
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          query: "solo",
          requested_sections: ["durable_memory"],
          budget: { max_tokens: 500 },
        },
      });
      const payload = JSON.parse((pack.content as any)[0].text);
      const budget = 500 * 4 - 1200;
      const section = payload.sections.durable_memory;
      // The empty envelope is preserved because it fits the surviving budget.
      expect(section).toBeDefined();
      expect(section.items).toEqual([]);
      expect(section.item_count).toBe(0);
      // Truthful empty state: the whole-pack budget starved the section, and the
      // section reports it was truncated.
      expect(section.empty_reason).toBe("whole_pack_budget");
      expect(section.truncated).toBe(true);
      // No citations reference a record that was not emitted.
      expect(payload.citations).toEqual([]);
      // The whole-pack truncation warning names the trimmed section.
      expect(payload.warnings.truncation).toContainEqual(
        expect.objectContaining({
          source: "durable_memory",
          reason: "whole_pack_budget",
        }),
      );
      // The serialized sections object stays within the whole-pack budget.
      expect(JSON.stringify(payload.sections).length).toBeLessThanOrEqual(
        budget,
      );
      // Budget accounting reports zero content emitted, never more than the limit.
      expect(payload.budget.durable_memory.content_chars_used).toBe(0);
      expect(payload.budget.whole_pack.content_chars_used).toBeLessThanOrEqual(
        payload.budget.whole_pack.content_char_limit,
      );
    } finally {
      await cleanup();
    }
  });

  it("preserves higher-priority sections and allocates durable_memory last under one shared budget", async () => {
    const records = Array.from({ length: 4 }, (_, index) =>
      brainRecord({
        id: `mem-${index}`,
        content_preview: `mem-${index}:` + "M".repeat(800),
      }),
    );
    const { pool } = searchPool(records);
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth, pool);
    try {
      // A modest working-set item that must survive whole; durable_memory is the
      // lowest priority and absorbs the remaining pressure.
      await client.callTool({
        name: "working_set_append",
        arguments: {
          ...SCOPE,
          kind: "task_state",
          content: "keep-ws:" + "W".repeat(400),
          trace_id: "ws-keep",
        },
      });

      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          query: "mem",
          requested_sections: ["working_set", "durable_memory"],
          budget: { max_tokens: 900 },
        },
      });
      const payload = JSON.parse((pack.content as any)[0].text);
      const contentBudget = 900 * 4 - 1200;
      // Highest-priority working_set survives whole.
      expect(payload.sections.working_set.item_count).toBe(1);
      expect(payload.sections.working_set.items[0].content).toContain(
        "keep-ws",
      );
      // Whole serialized sections stay within the shared budget.
      expect(JSON.stringify(payload.sections).length).toBeLessThanOrEqual(
        contentBudget,
      );
      // durable_memory, not working_set, is the trimmed/starved source.
      const wsMarker = payload.warnings.truncation.find(
        (t: any) =>
          t.source === "working_set" && t.reason === "whole_pack_budget",
      );
      expect(wsMarker).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("emits a truthful recall_failed durable_memory envelope for an explicitly requested section without leaking database errors", async () => {
    // When recall throws for an explicitly requested durable_memory section, the
    // section is NOT omitted: a truthful empty envelope is emitted (items [],
    // item_count 0, truncated false, empty_reason recall_failed) alongside the
    // content-free degraded_sources warning and empty citations. This is distinct
    // from an unrequested section (which is absent entirely).
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth, {
      query: async () => {
        throw new Error("postgres://secret-host/internal-detail");
      },
    });
    try {
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          query: "durable",
          requested_sections: ["durable_memory"],
        },
      });
      const payload = JSON.parse((pack.content as any)[0].text);
      expect(pack.isError).toBeFalsy();
      const section = payload.sections.durable_memory;
      // The requested section is present and truthful, not omitted.
      expect(section).toBeDefined();
      expect(section).toMatchObject({
        label: "durable_memory",
        namespace_scoped: true,
        query: "durable",
        empty_reason: "recall_failed",
        item_count: 0,
        truncated: false,
      });
      expect(section.items).toEqual([]);
      expect(payload.citations).toEqual([]);
      // The content-free degraded_sources warning is retained.
      expect(payload.warnings.degraded_sources).toContainEqual({
        source: "durable_memory",
        reason: "recall_failed",
      });
      // No dependency/error detail leaks anywhere in the emitted pack — not the
      // envelope, the warning, the citations, or the section body.
      expect(JSON.stringify(payload)).not.toContain("secret-host");
      expect(JSON.stringify(payload)).not.toContain("internal-detail");
      expect(JSON.stringify(payload)).not.toContain("postgres");
      // The only reason string anywhere is the stable, content-free recall_failed
      // marker — no raw error message or dependency detail is carried through.
      expect(section.empty_reason).toBe("recall_failed");
      expect(JSON.stringify(payload)).not.toContain("Error");
    } finally {
      await cleanup();
    }
  });

  it("omits durable_memory entirely (no recall_failed envelope) when the section is not requested even if recall would fail", async () => {
    // Behavior must stay distinct from "requested": an unrequested durable_memory
    // section is absent from the pack. No recall runs, so no recall_failed
    // envelope or degraded_sources warning is emitted for it.
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth, {
      query: async () => {
        throw new Error("postgres://secret-host/internal-detail");
      },
    });
    try {
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          query: "durable",
          requested_sections: ["working_set"],
        },
      });
      const payload = JSON.parse((pack.content as any)[0].text);
      expect(pack.isError).toBeFalsy();
      // Not requested => section absent, distinct from the empty recall_failed
      // envelope emitted when it IS requested.
      expect(payload.sections.durable_memory).toBeUndefined();
      const degraded = payload.warnings.degraded_sources ?? [];
      expect(degraded.some((d: any) => d.source === "durable_memory")).toBe(
        false,
      );
    } finally {
      await cleanup();
    }
  });

  it("multi-query determinism: identical inputs produce identical durable_memory allocation", async () => {
    const records = Array.from({ length: 5 }, (_, index) =>
      brainRecord({
        id: `stable-${index}`,
        content_preview: `stable-${index}:` + "S".repeat(700),
        distance: 0.1 + index * 0.05,
        fts_rank: 1 - index * 0.1,
      }),
    );
    async function run() {
      const { pool } = searchPool(records);
      const auth: AuthInfo = { role: "admin", clientId: "rico" };
      const { client, cleanup } = await setupToolClient(auth, pool);
      try {
        const pack = await client.callTool({
          name: "agent_context_pack",
          arguments: {
            ...SCOPE,
            query: "stable",
            requested_sections: ["durable_memory"],
            budget: { max_tokens: 900 },
          },
        });
        return JSON.parse((pack.content as any)[0].text);
      } finally {
        await cleanup();
      }
    }
    const first = await run();
    const second = await run();
    expect(first.sections.durable_memory.items.map((i: any) => i.id)).toEqual(
      second.sections.durable_memory.items.map((i: any) => i.id),
    );
    expect(first.budget.durable_memory).toEqual(second.budget.durable_memory);
    expect(first.warnings.truncation).toEqual(second.warnings.truncation);
  });
});
