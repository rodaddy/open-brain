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

describe("agent_context_pack durable_memory request gating", () => {
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
      const payload = JSON.parse((pack.content as [{ text: string }])[0].text);
      expect(pack.isError).toBeFalsy();
      expect(payload.sections.durable_memory).toBeUndefined();
      expect(captured).toHaveLength(0);
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
      const payload = JSON.parse((pack.content as [{ text: string }])[0].text);
      expect(pack.isError).toBeFalsy();
      // Not requested => section absent, distinct from the empty recall_failed
      // envelope emitted when it IS requested.
      expect(payload.sections.durable_memory).toBeUndefined();
      const degraded = payload.warnings.degraded_sources ?? [];
      expect(degraded.some((d: JsonRecord) => d.source === "durable_memory")).toBe(
        false,
      );
    } finally {
      await cleanup();
    }
  });
});

describe("agent_context_pack durable_memory defined empty sections", () => {
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
      const payload = JSON.parse((pack.content as [{ text: string }])[0].text);
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
      const payload = JSON.parse((pack.content as [{ text: string }])[0].text);
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
});

describe("agent_context_pack durable_memory prior_context validation", () => {
  it("rejects a prior_context reference with no resolvable identity", async () => {
    // A reference must carry citation_id or source_ref; an empty object cannot be
    // resolved and must be rejected at the input boundary rather than silently
    // failing to suppress.
    const { pool } = searchPool([brainRecord()]);
    const auth: AuthInfo = { role: "admin", clientId: "rico" };
    const { client, cleanup } = await setupToolClient(auth, pool);
    try {
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          query: "durable",
          requested_sections: ["durable_memory"],
          prior_context: [{}],
        },
      });
      expect(pack.isError).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
