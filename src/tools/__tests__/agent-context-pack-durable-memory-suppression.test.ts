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

describe("agent_context_pack durable_memory prior_context suppression", () => {
  it("suppresses a recalled record whose citation_id is echoed in prior_context, retaining the rest in order", async () => {
    // #333: prior-context suppression. A record already supplied to the model
    // this turn is passed back by citation_id; recall must drop it and return
    // only net-new records, preserving the original relevance order.
    const records = [
      brainRecord({ id: "dec-1", source_type: "decision" }),
      brainRecord({
        id: "th-1",
        source_type: "thought",
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
          prior_context: [{ citation_id: "brain_record:decision:dec-1" }],
        },
      });
      const payload = JSON.parse((pack.content as [{ text: string }])[0].text);
      expect(pack.isError).toBeFalsy();
      const section = payload.sections.durable_memory;
      // Only the net-new record survives; the echoed one is gone.
      expect(section.items.map((i: JsonRecord) => i.id)).toEqual(["th-1"]);
      expect(section.item_count).toBe(1);
      // Content-free suppression counters reconcile to what was recalled/emitted.
      expect(section.prior_context_suppression).toEqual({
        recalled: 2,
        suppressed: 1,
        net_new: 1,
        emitted: 1,
      });
      // A suppressed record is NOT a truncation.
      expect(section.truncated).toBe(false);
      expect(section.empty_reason).toBeUndefined();
      // No citation dangles onto the suppressed record.
      const citationIds = new Set(payload.citations.map((c: JsonRecord) => c.id));
      expect(citationIds.has("brain_record:decision:dec-1")).toBe(false);
      const retainedIds = new Set(section.items.map((i: JsonRecord) => i.citation_id));
      for (const citation of payload.citations) {
        expect(retainedIds.has(citation.id)).toBe(true);
      }
      // The counters carry no id, reference, or body — only integers.
      for (const value of Object.values(section.prior_context_suppression)) {
        expect(typeof value).toBe("number");
      }
    } finally {
      await cleanup();
    }
  });

  it("suppresses a record by an echoed structural source_ref that ignores display fields", async () => {
    // Prior context can echo back the item's own structural source_ref; matching
    // is on identity coordinates (source/type/id/namespace) only, so display
    // fields the caller round-trips must not defeat suppression.
    const records = [
      brainRecord({ id: "dec-1", source_type: "decision" }),
      brainRecord({ id: "dec-2", source_type: "decision" }),
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
          prior_context: [
            {
              source_ref: {
                source: "brain",
                type: "decision",
                id: "dec-1",
                namespace: "rico",
                label: "round-tripped display text",
                preview: "round-tripped preview",
              },
            },
          ],
        },
      });
      const payload = JSON.parse((pack.content as [{ text: string }])[0].text);
      expect(pack.isError).toBeFalsy();
      const section = payload.sections.durable_memory;
      expect(section.items.map((i: JsonRecord) => i.id)).toEqual(["dec-2"]);
      expect(section.prior_context_suppression.suppressed).toBe(1);
    } finally {
      await cleanup();
    }
  });
});

describe("agent_context_pack durable_memory suppression retention", () => {
  it("retains recalled records not referenced in prior_context", async () => {
    // An unknown/unmatched prior reference removes nothing: relevant records the
    // model has not already seen are all retained.
    const records = [
      brainRecord({ id: "dec-1", source_type: "decision" }),
      brainRecord({ id: "dec-2", source_type: "decision" }),
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
          prior_context: [{ citation_id: "brain_record:decision:not-recalled" }],
        },
      });
      const payload = JSON.parse((pack.content as [{ text: string }])[0].text);
      expect(pack.isError).toBeFalsy();
      const section = payload.sections.durable_memory;
      expect(section.items.map((i: JsonRecord) => i.id)).toEqual(["dec-1", "dec-2"]);
      expect(section.prior_context_suppression).toMatchObject({
        recalled: 2,
        suppressed: 0,
        net_new: 2,
        emitted: 2,
      });
    } finally {
      await cleanup();
    }
  });

  it("reports all_suppressed (distinct from no_matches) when every recalled record is prior context", async () => {
    // When recall DID find records but every one is already in prior context, the
    // empty envelope must say all_suppressed — not no_matches, which would falsely
    // claim recall found nothing.
    const records = [
      brainRecord({ id: "dec-1", source_type: "decision" }),
      brainRecord({ id: "dec-2", source_type: "decision" }),
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
          prior_context: [
            { citation_id: "brain_record:decision:dec-1" },
            { citation_id: "brain_record:decision:dec-2" },
          ],
        },
      });
      const payload = JSON.parse((pack.content as [{ text: string }])[0].text);
      expect(pack.isError).toBeFalsy();
      const section = payload.sections.durable_memory;
      expect(section.items).toEqual([]);
      expect(section.item_count).toBe(0);
      expect(section.empty_reason).toBe("all_suppressed");
      // Not a truncation — the records were suppressed, not budget-shed.
      expect(section.truncated).toBe(false);
      expect(section.prior_context_suppression).toMatchObject({
        recalled: 2,
        suppressed: 2,
        net_new: 0,
        emitted: 0,
      });
      expect(payload.citations).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

describe("agent_context_pack durable_memory content availability", () => {
  it("reports content_unavailable (not no_matches) when a net-new record has a null content_preview", async () => {
    // #359 P2: a record survives suppression (net_new > 0) but carries no
    // emittable body (null content_preview). The section is empty and truncated,
    // but the ONLY net-new record was unemittable — so the reason must be the
    // distinct content_unavailable, never no_matches (which would falsely claim
    // recall found nothing) and never all_suppressed (nothing was suppressed).
    const records = [brainRecord({ id: "dec-1", content_preview: null })];
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
      const payload = JSON.parse((pack.content as [{ text: string }])[0].text);
      expect(pack.isError).toBeFalsy();
      const section = payload.sections.durable_memory;
      // Empty because the sole net-new record had no emittable body.
      expect(section.items).toEqual([]);
      expect(section.item_count).toBe(0);
      // The truthful reason: net-new content existed but could not be emitted.
      expect(section.empty_reason).toBe("content_unavailable");
      // Counters reconcile: recall returned one net-new record, none emitted.
      expect(section.prior_context_suppression).toMatchObject({
        recalled: 1,
        suppressed: 0,
        net_new: 1,
        emitted: 0,
      });
      // A net-new-but-unemittable record IS a truncation of the section body.
      expect(section.truncated).toBe(true);
      // No citation dangles onto a record that was never emitted.
      expect(payload.citations).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("reports content_unavailable when a net-new record has an empty-string content_preview", async () => {
    // #359 P2 sibling case: an empty-string (not null) content_preview is equally
    // unemittable. boundedText treats "" and null identically (no body, not a
    // truncation of a non-empty string), so the same content_unavailable reason
    // and the same counters/truncation/citation reconciliation must hold.
    const records = [brainRecord({ id: "dec-1", content_preview: "" })];
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
      const payload = JSON.parse((pack.content as [{ text: string }])[0].text);
      expect(pack.isError).toBeFalsy();
      const section = payload.sections.durable_memory;
      expect(section.items).toEqual([]);
      expect(section.item_count).toBe(0);
      expect(section.empty_reason).toBe("content_unavailable");
      expect(section.prior_context_suppression).toMatchObject({
        recalled: 1,
        suppressed: 0,
        net_new: 1,
        emitted: 0,
      });
      expect(section.truncated).toBe(true);
      expect(payload.citations).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

describe("agent_context_pack durable_memory over-suppression guard", () => {
  it("does not over-suppress: an emittable net-new record is still emitted when a lower-ranked sibling is content-free", async () => {
    // #359 P2 no-over-suppression guard: a content-free (null-body) net-new record
    // must not starve or hide an emittable net-new record, and the section is not
    // content_unavailable when something WAS emitted. The emittable record is
    // ranked first (better relevance) so it emits before the loop halts on the
    // unemittable tail record; both are counted net-new, only the good one emits.
    const records = [
      brainRecord({
        id: "good-1",
        content_preview: "a real durable body",
        distance: 0.05,
        fts_rank: 0.99,
        usefulness: 0.99,
      }),
      brainRecord({
        id: "empty-1",
        content_preview: null,
        distance: 0.5,
        fts_rank: 0.1,
        usefulness: 0.1,
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
      const payload = JSON.parse((pack.content as [{ text: string }])[0].text);
      expect(pack.isError).toBeFalsy();
      const section = payload.sections.durable_memory;
      // The emittable record surfaces; the empty-body one is dropped, not hidden
      // behind an all-empty envelope.
      expect(section.items.map((i: JsonRecord) => i.id)).toEqual(["good-1"]);
      expect(section.item_count).toBe(1);
      // Something was emitted, so this is NOT the content-free empty state.
      expect(section.empty_reason).toBeUndefined();
      // Both recalled records are net-new; only one was emittable.
      expect(section.prior_context_suppression).toMatchObject({
        recalled: 2,
        suppressed: 0,
        net_new: 2,
        emitted: 1,
      });
      // Only the emitted record's citation exists; the empty-body one dangles nowhere.
      const citationIds = new Set(payload.citations.map((c: JsonRecord) => c.id));
      expect(citationIds.has("brain_record:decision:good-1")).toBe(true);
      expect(citationIds.has("brain_record:decision:empty-1")).toBe(false);
      const retainedIds = new Set(section.items.map((i: JsonRecord) => i.citation_id));
      for (const citation of payload.citations) {
        expect(retainedIds.has(citation.id)).toBe(true);
      }
    } finally {
      await cleanup();
    }
  });
});
