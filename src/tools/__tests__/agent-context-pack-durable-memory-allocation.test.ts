import { describe, expect, it } from "bun:test";
import type { AuthInfo } from "../../types.ts";
import {
  AGENT_CONTEXT_PACK_SCOPE as SCOPE,
  setupAgentContextPackToolClient as setupToolClient,
} from "./agent-context-pack-test-helpers.ts";
import {
  brainRecord,
  searchPool,
  type JsonRecord,
} from "./agent-context-pack-durable-memory-test-helpers.ts";
import { expectDefined } from "../../../scripts/test-support/expect-defined.ts";

describe("agent_context_pack durable_memory whole-pack allocation", () => {
  it("bounds the section to the whole-pack budget, dropping the lowest-ranked records first", async () => {
    // RRF orders records best-first; under budget pressure the lowest-ranked
    // (tail) records are shed while the highest-ranked head is preserved.
    const records = Array.from({ length: 8 }, (_, index) =>
      brainRecord({
        id: `rank-${index}`,
        source_type: "decision",
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
      const payload = JSON.parse((pack.content as [{ text: string }])[0].text);
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
      const ids = section.items.map((i: JsonRecord) => i.id);
      expect(ids[0]).toBe("rank-0");
      expect(ids).not.toContain("rank-7");
      // Retained records are the highest-ranked contiguous prefix.
      const retained = ids.map((id: string) =>
        Number(expectDefined(/rank-(\d+)/.exec(id), `rank match in ${id}`)[1]),
      );
      for (let k = 1; k < retained.length; k += 1) {
        expect(retained[k]).toBe(retained[k - 1] + 1);
      }
      // item_count reconciles to retained items; citations never dangle.
      expect(section.item_count).toBe(section.items.length);
      const retainedCitationIds = new Set(
        section.items.map((i: JsonRecord) => i.citation_id),
      );
      for (const citation of payload.citations) {
        expect(retainedCitationIds.has(citation.id)).toBe(true);
      }
      // Budget accounting reconciles to the retained content body.
      const bodyChars = section.items.reduce(
        (sum: number, i: JsonRecord) => sum + String(i.content ?? "").length,
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
});

describe("agent_context_pack durable_memory trim reconciliation", () => {
  it("reconciles section.truncated to true when a partial whole-pack trim drops records", async () => {
    // A partial trim (some records survive, some are dropped) must flip the
    // section's own `truncated` flag to true — a stale false would tell the
    // caller the recall was complete when the tail was actually shed. Counters,
    // citations, and the whole-pack warning must stay consistent with the
    // retained items.
    const records = Array.from({ length: 8 }, (_, index) =>
      brainRecord({
        id: `trim-${index}`,
        source_type: "decision",
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
      const payload = JSON.parse((pack.content as [{ text: string }])[0].text);
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
        section.items.map((i: JsonRecord) => i.citation_id),
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
});

describe("agent_context_pack durable_memory trimmed citation integrity", () => {
  it("preserves item.source_ref == citation.source_ref with no dangling refs after a partial whole-pack trim", async () => {
    // After a partial trim, every surviving item must still carry its own
    // source_ref, that source_ref must equal its citation's source_ref, and no
    // citation (source_ref) may reference a dropped item — the item-carried
    // source_ref must reconcile alongside the citation.
    const records = Array.from({ length: 8 }, (_, index) =>
      brainRecord({
        id: `ref-${index}`,
        source_type: "decision",
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
      const payload = JSON.parse((pack.content as [{ text: string }])[0].text);
      const section = payload.sections.durable_memory;
      expect(section).toBeDefined();
      // A genuine partial trim.
      expect(section.items.length).toBeGreaterThan(0);
      expect(section.items.length).toBeLessThan(8);

      const citationById = new Map<string, JsonRecord>(
        payload.citations.map((c: JsonRecord) => [c.id as string, c]),
      );
      // Every retained item has its own source_ref equal to its citation's.
      for (const item of section.items) {
        expect(item.source_ref).toBeDefined();
        const citation = citationById.get(item.citation_id);
        if (citation === undefined) {
          throw new Error(`no citation for item ${String(item.id)}`);
        }
        expect(item.source_ref).toEqual(citation.source_ref);
        expect(item.source_ref.id).toBe(item.id);
      }
      // No dangling citation/source_ref: every citation maps to a retained item.
      const retainedIds = new Set(section.items.map((i: JsonRecord) => i.citation_id));
      expect(payload.citations.length).toBe(section.items.length);
      for (const citation of payload.citations) {
        expect(retainedIds.has(citation.id)).toBe(true);
      }
      // No dropped record's source_ref survives on any retained item.
      const retainedRecordIds = new Set(section.items.map((i: JsonRecord) => i.id));
      for (const item of section.items) {
        expect(retainedRecordIds.has(item.source_ref.id)).toBe(true);
      }
    } finally {
      await cleanup();
    }
  });
});

describe("agent_context_pack durable_memory emptied-by-trim envelope", () => {
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
        source_type: "decision",
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
      const payload = JSON.parse((pack.content as [{ text: string }])[0].text);
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
      expect(JSON.stringify(payload.sections).length).toBeLessThanOrEqual(budget);
      // Budget accounting reports zero content emitted, never more than the limit.
      expect(payload.budget.durable_memory.content_chars_used).toBe(0);
      expect(payload.budget.whole_pack.content_chars_used).toBeLessThanOrEqual(
        payload.budget.whole_pack.content_char_limit,
      );
    } finally {
      await cleanup();
    }
  });
});

describe("agent_context_pack durable_memory section priority", () => {
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
      const payload = JSON.parse((pack.content as [{ text: string }])[0].text);
      const contentBudget = 900 * 4 - 1200;
      // Highest-priority working_set survives whole.
      expect(payload.sections.working_set.item_count).toBe(1);
      expect(payload.sections.working_set.items[0].content).toContain("keep-ws");
      // Whole serialized sections stay within the shared budget.
      expect(JSON.stringify(payload.sections).length).toBeLessThanOrEqual(
        contentBudget,
      );
      // durable_memory, not working_set, is the trimmed/starved source.
      const wsMarker = payload.warnings.truncation.find(
        (t: JsonRecord) =>
          t.source === "working_set" && t.reason === "whole_pack_budget",
      );
      expect(wsMarker).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});
