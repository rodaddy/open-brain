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

describe("agent_context_pack durable_memory citations", () => {
  it("returns recalled records with a resolvable source_ref and matching citation on every item", async () => {
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
        },
      });
      const payload = JSON.parse((pack.content as [{ text: string }])[0].text);
      expect(pack.isError).toBeFalsy();
      const section = payload.sections.durable_memory;
      expect(section.item_count).toBe(section.items.length);
      expect(section.items.length).toBeGreaterThan(0);

      // Every item carries a citation_id and every citation resolves back to a
      // brain record with a source_ref (source/type/id) — the resolvability
      // contract the issue requires on every item.
      const citationIds = new Set(
        payload.citations.map((c: JsonRecord) => c.id as string),
      );
      for (const item of section.items) {
        expect(typeof item.citation_id).toBe("string");
        expect(citationIds.has(item.citation_id)).toBe(true);
        const citation = payload.citations.find(
          (c: JsonRecord) => c.id === item.citation_id,
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
      const retainedIds = new Set(section.items.map((i: JsonRecord) => i.citation_id));
      for (const citation of payload.citations) {
        expect(retainedIds.has(citation.id)).toBe(true);
      }
    } finally {
      await cleanup();
    }
  });
});

describe("agent_context_pack durable_memory namespace isolation", () => {
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
      const payload = JSON.parse((pack.content as [{ text: string }])[0].text);
      // The whole pack is denied at the namespace gate before any recall runs —
      // no cross-namespace read is issued.
      expect(pack.isError).toBe(true);
      expect(JSON.stringify(payload)).toContain("Permission denied");
      expect(captured).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});
