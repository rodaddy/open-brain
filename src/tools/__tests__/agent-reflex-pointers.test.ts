import { describe, expect, it } from "bun:test";
import type { AuthInfo } from "../../types.ts";
import {
  AGENT_CONTEXT_PACK_SCOPE as SCOPE,
  admin,
  canonical,
  isRecallSql,
  nRecords,
  searchPool,
  setupAgentContextPackToolClient as setupToolClient,
  throwingSearchPool,
} from "./agent-context-pack-test-helpers.ts";

/**
 * agent_reflex_pointers (#334) — the smallest explicit per-turn reflex API.
 *
 * The reflex is a PURE PROJECTION over the single agent_context_pack pointers
 * path: it reuses the one durable_memory hybrid recall and the #329 pointer
 * machinery (with #333 prior-context suppression applied) and emits ONLY
 * body-free cited resolvable pointers plus the pointer-relevant envelope. These
 * tests black-box the MCP tool: vary query, prior_context, budget, namespace, and
 * failure, and assert the observable reflex envelope, dedupe/body-free contract,
 * citation bijection, budget bounding, and placement ownership. Internal SQL is
 * asserted only for the single-recall / zero-recall invariants the reflex must
 * prove (no second retrieval stack).
 */

function callReflex(
  client: Awaited<ReturnType<typeof setupToolClient>>["client"],
  args: Record<string, unknown>,
) {
  return client.callTool({
    name: "agent_reflex_pointers",
    arguments: { ...SCOPE, ...args },
  });
}

describe("agent_reflex_pointers (#334)", () => {
  it("returns budget-bounded body-free cited pointers over the single shared recall", async () => {
    const captured: Array<{ sql: string; params?: unknown[] }> = [];
    const { pool } = searchPool(nRecords(10), captured);
    const { client, cleanup } = await setupToolClient(admin, pool);
    try {
      const res = await callReflex(client, { query: "durable" });
      const payload = JSON.parse((res.content as any)[0].text);
      expect(res.isError).toBeFalsy();

      // Reflex-shaped envelope, not a whole pack.
      expect(payload.schema).toBe("openbrain.agent_reflex_pointers.v1");
      expect(payload.status).toBe("ok");
      expect(payload.placement).toBe("client_owned");
      expect(payload.resolvable_reference_only).toBe(true);
      // No durable_memory / working_set / other sections leak into the reflex.
      expect(payload.sections).toBeUndefined();
      expect(payload.durable_memory).toBeUndefined();

      const pointers = payload.pointers;
      expect(pointers.label).toBe("pointers");
      expect(pointers.namespace_scoped).toBe(true);
      expect(pointers.resolvable_reference_only).toBe(true);
      // A pointers-only reflex makes every authorized recalled row pointer-eligible.
      expect(pointers.item_count).toBe(10);

      // Every pointer is body-free: identity + structural source_ref only.
      for (const p of pointers.items) {
        expect(p.content).toBeUndefined();
        expect(p.content_preview).toBeUndefined();
        expect(p.label).toBeUndefined();
        expect(p.preview).toBeUndefined();
        expect(p.citation_id).toBe(canonical(p.source_type, p.id));
        expect(p.source_ref.source).toBeDefined();
        expect(p.source_ref.type).toBe(p.source_type);
        expect(p.source_ref.id).toBe(p.id);
        // Structural source_ref carries no display/body fields.
        expect((p.source_ref as any).label).toBeUndefined();
        expect((p.source_ref as any).preview).toBeUndefined();
      }

      // Citations are a bijection with the emitted pointers.
      const pointerIds = new Set(pointers.items.map((p: any) => p.citation_id));
      const citationIds = new Set(payload.citations.map((c: any) => c.id));
      expect(citationIds).toEqual(pointerIds);
      for (const c of payload.citations) {
        expect(c.kind).toBe("pointer");
      }

      // Single retrieval stack: only the hybrid recall arms ran (<= 2), no
      // second retrieval or pointer query.
      const recallCalls = captured.filter((c) => isRecallSql(c.sql));
      expect(recallCalls.length).toBeLessThanOrEqual(2);
    } finally {
      await cleanup();
    }
  });

  it("every pointer is resolvable through the authorized read path (table = type + s)", async () => {
    const { pool } = searchPool(nRecords(3));
    const { client, cleanup } = await setupToolClient(admin, pool);
    try {
      const res = await callReflex(client, { query: "durable" });
      const payload = JSON.parse((res.content as any)[0].text);
      expect(res.isError).toBeFalsy();
      for (const p of payload.pointers.items) {
        // Resolution contract: get_entry table derives from the singular
        // source_type by appending "s"; the id is the pointer's own id.
        const resolveTable = `${p.source_ref.type}s`;
        expect(resolveTable).toBe("decisions");
        expect(p.source_ref.id).toBe(p.id);
      }
    } finally {
      await cleanup();
    }
  });

  it("prior_context suppression removes already-supplied records before pointing", async () => {
    const { pool } = searchPool(nRecords(4));
    const { client, cleanup } = await setupToolClient(admin, pool);
    try {
      const suppressed = canonical("decision", "dec-2");
      const res = await callReflex(client, {
        query: "durable",
        prior_context: [{ citation_id: suppressed }],
      });
      const payload = JSON.parse((res.content as any)[0].text);
      expect(res.isError).toBeFalsy();
      const ids = payload.pointers.items.map((p: any) => p.citation_id);
      expect(ids).not.toContain(suppressed);
      // The remaining net-new records still point.
      expect(ids).toContain(canonical("decision", "dec-1"));
    } finally {
      await cleanup();
    }
  });

  it("budget bounds emitted pointers and reports whole-pack accounting", async () => {
    const { pool } = searchPool(nRecords(10));
    const { client, cleanup } = await setupToolClient(admin, pool);
    try {
      // A tiny token budget cannot admit all pointers; the reflex must stay
      // within budget and report the pressure rather than overflow.
      const res = await callReflex(client, {
        query: "durable",
        budget: { max_tokens: 320 },
      });
      const payload = JSON.parse((res.content as any)[0].text);
      expect(res.isError).toBeFalsy();
      expect(payload.budget.whole_pack).toBeDefined();
      const wp = payload.budget.whole_pack;
      expect(wp.content_chars_used).toBeLessThanOrEqual(wp.content_char_limit);
    } finally {
      await cleanup();
    }
  });

  it("failed shared recall degrades content-free without an error and points at nothing", async () => {
    const { pool } = throwingSearchPool();
    const { client, cleanup } = await setupToolClient(admin, pool);
    try {
      const res = await callReflex(client, { query: "durable" });
      const payload = JSON.parse((res.content as any)[0].text);
      // The reflex itself does not error on a degraded recall.
      expect(res.isError).toBeFalsy();
      expect(payload.pointers.item_count).toBe(0);
      expect(payload.citations).toEqual([]);
      // The degraded shared recall is surfaced content-free, never swallowed.
      const degraded = payload.warnings.degraded_sources as Array<any>;
      expect(degraded.length).toBeGreaterThan(0);
      for (const d of degraded) {
        expect(typeof d.reason).toBe("string");
        // Content-free: no bodies, ids, or error detail beyond a reason label.
        expect(d.content).toBeUndefined();
      }
    } finally {
      await cleanup();
    }
  });

  it("denies an unauthorized explicit namespace override content-free", async () => {
    const readonly: AuthInfo = { role: "readonly", clientId: "rico" };
    const { pool } = searchPool(nRecords(3));
    const { client, cleanup } = await setupToolClient(readonly, pool);
    try {
      const res = await callReflex(client, {
        query: "durable",
        namespace: "someone-else",
      });
      const payload = JSON.parse((res.content as any)[0].text);
      expect(res.isError).toBe(true);
      // Content-free denial passed through from the shared pack path.
      expect(typeof payload.error).toBe("string");
      expect(payload.pointers).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});
