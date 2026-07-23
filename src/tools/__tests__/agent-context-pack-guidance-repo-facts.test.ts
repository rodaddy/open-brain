// Integration tests for the three structured sections (profile_guidance,
// process_guidance, repo_facts) wired into the post-#353 agent_context_pack
// envelope. These drive the real MCP tool end-to-end through a SQL-routing fake
// pool, so they exercise the pack's auth/namespace gating, priority/budget
// allocation, citation reconciliation, and warnings merge — not just the
// standalone section builders (covered by the sibling unit tests).

import { describe, expect, it } from "bun:test";
import type { AuthInfo } from "../../types.ts";
import {
  AGENT_CONTEXT_PACK_SCOPE as SCOPE,
  setupAgentContextPackToolClient as setupToolClient,
} from "./agent-context-pack-test-helpers.ts";

const ADMIN: AuthInfo = { role: "admin", clientId: "rico" };

type Row = Record<string, unknown>;

/** A promoted user_preference lifecycle row for profile_guidance. */
function prefRow(overrides: Partial<Row> & { id: string }): Row {
  return {
    content: "prefer concise answers",
    created_at: "2026-07-20T10:00:00Z",
    memory_lifecycle_action: "promote",
    candidate_type: "user_preference",
    candidate_reason: "stated preference",
    candidate_confidence: 0.9,
    candidate_scope: null,
    ...overrides,
  };
}

/** A promoted process_rule lifecycle row for process_guidance. */
function ruleRow(overrides: Partial<Row> & { id: string }): Row {
  return {
    content: "branch before coding on main",
    created_at: "2026-07-20T10:00:00Z",
    memory_lifecycle_action: "promote",
    candidate_type: "process_rule",
    candidate_reason: "standing rule",
    candidate_confidence: 1,
    candidate_scope: { key: "no-main-commits" },
    ...overrides,
  };
}

/** A repo_fact entity row for repo_facts. */
function factRow(overrides: Partial<Row> & { id: string }): Row {
  const { metadata: metaOverride, ...rest } = overrides;
  return {
    namespace: "rico",
    updated_at: "2026-07-20T10:00:00Z",
    metadata: {
      source_system: "qmd",
      repo: "rodaddy/open-brain",
      collection: "open-brain",
      path: "src/tools/repo-facts.ts",
      subject: "repoFactMetadata",
      fact_type: "api_contract",
      fact: "repo facts require symbol or subject",
      source_commit: "abc1234",
      source_url:
        "https://github.com/rodaddy/open-brain/blob/abc1234/src/tools/repo-facts.ts",
      verified_at: "2026-07-20T09:00:00Z",
      confidence: 1,
      staleness_policy: "stable_fact_verify_source",
      ...(metaOverride as Row | undefined),
    },
    ...rest,
  };
}

/**
 * Build a SQL-routing fake pool. Each handler is chosen by the table/predicate
 * in the SQL, mirroring how the guidance/repo_facts loaders bind. Every call is
 * captured so tests can assert the namespace/repo predicates the pack passed.
 */
function routingPool(handlers: {
  guidance?: (params: unknown[]) => Row[];
  repoFacts?: (params: unknown[]) => Row[];
  onQuery?: (sql: string, params: unknown[]) => void;
}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      handlers.onQuery?.(sql, params);
      if (
        sql.includes("FROM ob_session_events") &&
        sql.includes("candidate_type")
      ) {
        return { rows: handlers.guidance ? handlers.guidance(params) : [] };
      }
      if (sql.includes("entity_type = 'repo_fact'")) {
        return { rows: handlers.repoFacts ? handlers.repoFacts(params) : [] };
      }
      return { rows: [] };
    },
  };
  return { pool, calls };
}

async function callPack(client: any, args: Record<string, unknown>) {
  const pack = await client.callTool({
    name: "agent_context_pack",
    arguments: { ...SCOPE, ...args },
  });
  return {
    isError: pack.isError,
    payload: JSON.parse((pack.content as any)[0].text),
    raw: (pack.content as any)[0].text as string,
  };
}

describe("profile_guidance / process_guidance present data", () => {
  it("returns caller-authorized promoted preferences with citations", async () => {
    const { pool } = routingPool({
      guidance: () => [prefRow({ id: "p1", candidate_scope: { key: "tone" } })],
    });
    const { client, cleanup } = await setupToolClient(ADMIN, pool);
    try {
      const { payload } = await callPack(client, {
        requested_sections: ["profile_guidance"],
      });
      const section = payload.sections.profile_guidance;
      expect(section).toMatchObject({
        label: "profile_guidance",
        candidate_type: "user_preference",
        namespace_bound: true,
        item_count: 1,
      });
      const item = section.items[0];
      expect(item.citation_id).toBe("session_event:p1");
      // Every item's citation appears in the pack-level citations array (bijection).
      expect(payload.citations).toContainEqual({
        id: "session_event:p1",
        kind: "session_event",
        source_ref: "ob_session_events/p1",
      });
    } finally {
      await cleanup();
    }
  });

  it("maps process_guidance to promoted process_rule memories", async () => {
    const { pool, calls } = routingPool({
      guidance: () => [ruleRow({ id: "r1" })],
    });
    const { client, cleanup } = await setupToolClient(ADMIN, pool);
    try {
      const { payload } = await callPack(client, {
        requested_sections: ["process_guidance"],
      });
      expect(payload.sections.process_guidance).toMatchObject({
        candidate_type: "process_rule",
        item_count: 1,
      });
      // Selection is by explicit typed candidate_type, bound to the namespace.
      const guidanceCall = calls.find((c) => c.sql.includes("candidate_type"));
      expect(guidanceCall?.params?.[0]).toBe("rico");
      expect(guidanceCall?.params?.[1]).toBe("process_rule");
    } finally {
      await cleanup();
    }
  });
});

describe("defined empty and degraded states", () => {
  it("returns a defined empty state, not fabricated guidance, when nothing is promoted", async () => {
    const { pool } = routingPool({ guidance: () => [] });
    const { client, cleanup } = await setupToolClient(ADMIN, pool);
    try {
      const { payload } = await callPack(client, {
        requested_sections: ["profile_guidance"],
      });
      expect(payload.sections.profile_guidance).toMatchObject({
        label: "profile_guidance",
        items: [],
        item_count: 0,
        truncated: false,
      });
    } finally {
      await cleanup();
    }
  });

  it("omits the profile_guidance section when it is not requested", async () => {
    const { pool } = routingPool({ guidance: () => [prefRow({ id: "p1" })] });
    const { client, cleanup } = await setupToolClient(ADMIN, pool);
    try {
      const { payload } = await callPack(client, {
        requested_sections: ["working_set"],
      });
      expect(payload.sections.profile_guidance).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("degrades content-free and omits the section body when the guidance query throws", async () => {
    const pool = {
      query: async (sql: string) => {
        if (sql.includes("candidate_type")) {
          throw new Error("connection reset to 10.71.20.49");
        }
        return { rows: [] };
      },
    };
    const { client, cleanup } = await setupToolClient(ADMIN, pool);
    try {
      const { payload, raw } = await callPack(client, {
        requested_sections: ["profile_guidance"],
      });
      expect(payload.sections.profile_guidance).toBeUndefined();
      expect(payload.warnings.degraded_sources).toContainEqual({
        source: "profile_guidance",
        reason: "database_unavailable",
      });
      // No dependency/error detail leaks into the envelope.
      expect(raw).not.toContain("10.71.20.49");
      expect(raw).not.toContain("connection reset");
    } finally {
      await cleanup();
    }
  });
});

describe("repo_facts exact-repo binding and non-fallback", () => {
  it("binds the requested active repo exactly and cites source refs", async () => {
    const { pool, calls } = routingPool({
      repoFacts: () => [factRow({ id: "f1" })],
    });
    const { client, cleanup } = await setupToolClient(ADMIN, pool);
    try {
      const { payload } = await callPack(client, {
        requested_sections: ["repo_facts"],
        repo: "rodaddy/open-brain",
      });
      const section = payload.sections.repo_facts;
      expect(section).toMatchObject({
        label: "repo_facts",
        repo: "rodaddy/open-brain",
        repo_bound: true,
        item_count: 1,
      });
      const repoCall = calls.find((c) =>
        c.sql.includes("entity_type = 'repo_fact'"),
      );
      expect(repoCall?.params?.[0]).toBe("rico");
      expect(repoCall?.params?.[1]).toBe("rodaddy/open-brain");
      expect(payload.citations).toContainEqual({
        id: "repo_fact:f1",
        kind: "repo_fact",
        source_ref: "ob_entities/f1",
        source_url: section.items[0].source_url,
        source_commit: "abc1234",
      });
    } finally {
      await cleanup();
    }
  });

  it("never falls back to another repo: a drifted row is dropped, not surfaced", async () => {
    // The fake pool returns a foreign-repo row even though the DB predicate would
    // exclude it — proving the in-process guard holds even if the predicate were
    // bypassed.
    const { pool } = routingPool({
      repoFacts: () => [
        factRow({ id: "match" }),
        factRow({ id: "foreign", metadata: { repo: "rodaddy/king-signals" } }),
      ],
    });
    const { client, cleanup } = await setupToolClient(ADMIN, pool);
    try {
      const { payload } = await callPack(client, {
        requested_sections: ["repo_facts"],
        repo: "rodaddy/open-brain",
      });
      const ids = payload.sections.repo_facts.items.map((i: Row) => i.id);
      expect(ids).toEqual(["match"]);
    } finally {
      await cleanup();
    }
  });

  it("returns the no-active-repo empty state and never queries when repo is absent", async () => {
    let repoQueried = false;
    const { pool } = routingPool({
      repoFacts: () => {
        repoQueried = true;
        return [factRow({ id: "f1" })];
      },
    });
    const { client, cleanup } = await setupToolClient(ADMIN, pool);
    try {
      const { payload } = await callPack(client, {
        requested_sections: ["repo_facts"],
        // no repo supplied
      });
      expect(repoQueried).toBe(false);
      expect(payload.sections.repo_facts).toMatchObject({
        repo: null,
        repo_bound: false,
        item_count: 0,
      });
      expect(payload.warnings.scope_denials).toContainEqual({
        source: "repo_facts",
        reasons: ["no_active_repo"],
      });
    } finally {
      await cleanup();
    }
  });
});

describe("two namespaces and two repositories bind exactly", () => {
  it("carries the auth-derived namespace predicate for a different namespace", async () => {
    const kingAuth: AuthInfo = { role: "admin", clientId: "king-capital" };
    const { pool, calls } = routingPool({
      guidance: () => [prefRow({ id: "k1", candidate_scope: { key: "tone" } })],
      repoFacts: () => [
        factRow({
          id: "kf1",
          namespace: "king-capital",
          metadata: {
            repo: "rodaddy/king-signals",
            source_url:
              "https://github.com/rodaddy/king-signals/blob/def5678/src/x.ts",
            source_commit: "def5678",
            path: "src/x.ts",
          },
        }),
      ],
    });
    const { client, cleanup } = await setupToolClient(kingAuth, pool);
    try {
      // Omit the explicit namespace so it resolves from auth.clientId
      // (king-capital), exercising the auth-derived namespace predicate.
      const { payload } = await callPack(client, {
        namespace: undefined,
        requested_sections: ["profile_guidance", "repo_facts"],
        repo: "rodaddy/king-signals",
      });
      const guidanceCall = calls.find((c) => c.sql.includes("candidate_type"));
      const repoCall = calls.find((c) =>
        c.sql.includes("entity_type = 'repo_fact'"),
      );
      // Both structured reads bind the caller's own namespace, not "rico".
      expect(guidanceCall?.params?.[0]).toBe("king-capital");
      expect(repoCall?.params?.[0]).toBe("king-capital");
      expect(repoCall?.params?.[1]).toBe("rodaddy/king-signals");
      expect(payload.sections.repo_facts.repo).toBe("rodaddy/king-signals");
    } finally {
      await cleanup();
    }
  });

  it("binds distinct repos for two pack builds without leaking across repositories", async () => {
    const { pool, calls } = routingPool({
      repoFacts: (params) =>
        params[1] === "rodaddy/open-brain" ? [factRow({ id: "ob" })] : [],
    });
    const { client, cleanup } = await setupToolClient(ADMIN, pool);
    try {
      const first = await callPack(client, {
        requested_sections: ["repo_facts"],
        repo: "rodaddy/open-brain",
      });
      const second = await callPack(client, {
        requested_sections: ["repo_facts"],
        repo: "someone/other-repo",
      });
      expect(first.payload.sections.repo_facts.item_count).toBe(1);
      // The second repo has no facts -> empty state, never the first repo's facts.
      expect(second.payload.sections.repo_facts.item_count).toBe(0);
      const repoParams = calls
        .filter((c) => c.sql.includes("entity_type = 'repo_fact'"))
        .map((c) => c.params?.[1]);
      expect(repoParams).toEqual(["rodaddy/open-brain", "someone/other-repo"]);
    } finally {
      await cleanup();
    }
  });
});

describe("unauthorized namespace override fails before any query", () => {
  it("denies a header-scoped caller overriding to a foreign namespace, with no read", async () => {
    // A header-derived (non-admin) caller may only read its own clientId + shared.
    const headerAuth: AuthInfo = {
      role: "agent",
      clientId: "rico",
      namespaceSource: "header",
    };
    let queried = false;
    const pool = {
      query: async () => {
        queried = true;
        return { rows: [] };
      },
    };
    const { client, cleanup } = await setupToolClient(headerAuth, pool);
    try {
      const { isError, payload } = await callPack(client, {
        namespace: "king-capital",
        requested_sections: ["profile_guidance", "repo_facts"],
        repo: "rodaddy/king-signals",
      });
      expect(isError).toBe(true);
      expect(payload.error).toContain("cannot read namespace 'king-capital'");
      // The permission gate fires before any structured-section query runs.
      expect(queried).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

describe("citation bijection reconciles after deterministic trimming", () => {
  it("keeps exactly the citations for the items that survived a tight item budget", async () => {
    // Ten promoted, distinct-key preferences under a whole-pack budget too small
    // for all of them. Trimming is deterministic (drop oldest first), and the
    // surviving citations must be exactly the surviving items — no more, no less.
    const rows = Array.from({ length: 10 }, (_, i) =>
      prefRow({
        id: `p${i}`,
        created_at: `2026-07-${10 + i}T10:00:00Z`,
        candidate_scope: { key: `k${i}` },
        content: "pref " + "x".repeat(120),
      }),
    );
    const { pool } = routingPool({ guidance: () => [...rows].reverse() });
    const { client, cleanup } = await setupToolClient(ADMIN, pool);
    try {
      const { payload } = await callPack(client, {
        requested_sections: ["profile_guidance"],
        budget: { max_tokens: 600 },
      });
      const section = payload.sections.profile_guidance;
      const itemCitationIds = new Set(
        section.items.map((i: Row) => i.citation_id),
      );
      const packCitationIds = payload.citations
        .filter((c: Row) => c.kind === "session_event")
        .map((c: Row) => c.id);
      // Bijection: same count, and every pack citation maps to a surviving item.
      expect(packCitationIds.length).toBe(section.items.length);
      for (const id of packCitationIds) {
        expect(itemCitationIds.has(id)).toBe(true);
      }
      // Trimming actually happened.
      expect(section.items.length).toBeLessThan(10);
    } finally {
      await cleanup();
    }
  });
});

describe("whole-pack trim stamps section-body truth", () => {
  it("sets truncated=true on the emitted body when a partial trim drops items", async () => {
    // Ten promoted preferences under a whole-pack budget that admits some but not
    // all of them. The loader itself did NOT truncate (all ten fit its own item
    // budget), so a body that read truncated=false would lie about the re-fit.
    const rows = Array.from({ length: 10 }, (_, i) =>
      prefRow({
        id: `p${i}`,
        created_at: `2026-07-${10 + i}T10:00:00Z`,
        candidate_scope: { key: `k${i}` },
        content: "pref " + "x".repeat(120),
      }),
    );
    const { pool } = routingPool({ guidance: () => [...rows].reverse() });
    const { client, cleanup } = await setupToolClient(ADMIN, pool);
    try {
      const { payload } = await callPack(client, {
        requested_sections: ["profile_guidance"],
        budget: { max_tokens: 600 },
      });
      const section = payload.sections.profile_guidance;
      // A real partial trim: some survived, but fewer than all ten.
      expect(section.item_count).toBeGreaterThan(0);
      expect(section.item_count).toBeLessThan(10);
      // The emitted body — not just the warnings channel — declares the trim.
      expect(section.truncated).toBe(true);
      // A partial trim is not an empty state.
      expect(section.empty_reason).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("stamps empty_reason=whole_pack_budget when trim empties an admitted body", async () => {
    // A single large promoted preference under a budget that admits the empty
    // section envelope but not the one item. The item is dropped to zero, the
    // empty envelope is still admitted, and its emptiness is budget-caused — not
    // a genuine no-data empty — so the body must say so and carry no citations.
    const rows = [
      prefRow({
        id: "big",
        candidate_scope: { key: "k-big" },
        content: "pref " + "x".repeat(400),
      }),
    ];
    const { pool } = routingPool({ guidance: () => rows });
    const { client, cleanup } = await setupToolClient(ADMIN, pool);
    try {
      const { payload } = await callPack(client, {
        requested_sections: ["profile_guidance"],
        budget: { max_tokens: 360 },
      });
      const section = payload.sections.profile_guidance;
      // The section survived as an admitted envelope, trimmed to empty.
      expect(section).toBeTruthy();
      expect(section.item_count).toBe(0);
      expect(section.items).toEqual([]);
      // Budget-caused empty is distinguished from a genuine no-data empty.
      expect(section.truncated).toBe(true);
      expect(section.empty_reason).toBe("whole_pack_budget");
      // Citation bijection: no item survived, so no session_event citation remains.
      expect(
        payload.citations.filter((c: Row) => c.kind === "session_event"),
      ).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("leaves a genuine no-data empty state unstamped (truncated=false, no empty_reason)", async () => {
    // Nothing promoted: the loader emits its defined empty state. The whole-pack
    // re-fit must not stamp a budget reason onto an empty that budget did not
    // cause — mutation-killing the naive "always stamp when items===0" fix.
    const { pool } = routingPool({ guidance: () => [] });
    const { client, cleanup } = await setupToolClient(ADMIN, pool);
    try {
      const { payload } = await callPack(client, {
        requested_sections: ["profile_guidance"],
        budget: { max_tokens: 600 },
      });
      const section = payload.sections.profile_guidance;
      expect(section.item_count).toBe(0);
      expect(section.truncated).toBe(false);
      expect(section.empty_reason).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

describe("hard serialized whole-pack budget and higher-priority survival", () => {
  it("never lets structured sections push the serialized pack past the budget", async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      prefRow({
        id: `p${i}`,
        created_at: `2026-07-${10 + i}T10:00:00Z`,
        candidate_scope: { key: `k${i}` },
        content: "pref " + "y".repeat(200),
      }),
    );
    const { pool } = routingPool({ guidance: () => [...rows].reverse() });
    const { client, cleanup } = await setupToolClient(ADMIN, pool);
    try {
      const maxTokens = 500;
      const { payload } = await callPack(client, {
        requested_sections: ["profile_guidance"],
        budget: { max_tokens: maxTokens },
      });
      const contentBudget = maxTokens * 4 - 1200;
      // The serialized sections object must never exceed the declared limit.
      const serializedSections = JSON.stringify(payload.sections);
      expect(serializedSections.length).toBeLessThanOrEqual(
        Math.max(2, contentBudget),
      );
    } finally {
      await cleanup();
    }
  });

  it("preserves the higher-priority working_set and starves guidance under pressure", async () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      prefRow({
        id: `p${i}`,
        created_at: `2026-07-${10 + (i % 20)}T10:00:00Z`,
        candidate_scope: { key: `k${i}` },
        content: "pref " + "z".repeat(500),
      }),
    );
    const { pool } = routingPool({ guidance: () => [...rows].reverse() });
    const { client, cleanup } = await setupToolClient(ADMIN, pool);
    try {
      // One small working-set item that must survive.
      await client.callTool({
        name: "working_set_append",
        arguments: {
          ...SCOPE,
          kind: "current_intent",
          content: "keep-me",
          trace_id: "trace-keep",
        },
      });
      // Budget large enough for the small working_set item but far too small for
      // the 20 * ~500-char guidance rows on top of it (max_tokens 700 => 1600
      // content chars after the 1200 envelope reserve).
      const { payload } = await callPack(client, {
        requested_sections: ["working_set", "profile_guidance"],
        budget: { max_tokens: 700 },
      });
      // The highest-priority section survives whole.
      expect(payload.sections.working_set.item_count).toBe(1);
      expect(payload.sections.working_set.items[0].content).toBe("keep-me");
      // The lowest-priority guidance section is trimmed or starved: if present it
      // holds fewer than all rows; if omitted, a starved marker is recorded.
      const guidance = payload.sections.profile_guidance;
      if (guidance) {
        expect(guidance.item_count).toBeLessThan(20);
      } else {
        expect(payload.warnings.truncation).toContainEqual(
          expect.objectContaining({
            source: "profile_guidance",
            starved: true,
          }),
        );
      }
      // No citation ever references an item that was dropped/omitted.
      const survivingItemCitationIds = new Set(
        (guidance?.items ?? []).map((i: Row) => i.citation_id),
      );
      for (const c of payload.citations) {
        if (c.kind === "session_event") {
          expect(survivingItemCitationIds.has(c.id)).toBe(true);
        }
      }
    } finally {
      await cleanup();
    }
  });
});

describe("newest-first whole-pack trim preserves the current head", () => {
  it("keeps the newest guidance item and drops the older one when only one fits", async () => {
    // Two promoted, distinct-key preferences. The loader emits them newest-first
    // (SQL returns created_at DESC), so items[0] is the NEWEST/current guidance
    // and items[1] the older one. Under a whole-pack budget that admits exactly
    // one, the head-drop fitter used by working_set/recovery would have kept the
    // OLDER tail item and shed the newest — the #328 bug. The newest-first fitter
    // must keep the current head and drop the oldest tail instead.
    const older = prefRow({
      id: "old",
      created_at: "2026-07-10T10:00:00Z",
      candidate_scope: { key: "k-old" },
      content: "STALE " + "o".repeat(300),
    });
    const newer = prefRow({
      id: "new",
      created_at: "2026-07-20T10:00:00Z",
      candidate_scope: { key: "k-new" },
      content: "CURRENT " + "n".repeat(300),
    });
    // Real SQL orders created_at DESC: newest ("new") first, older ("old") last.
    const { pool } = routingPool({ guidance: () => [newer, older] });
    const { client, cleanup } = await setupToolClient(ADMIN, pool);
    try {
      // A budget that admits the section envelope plus exactly one ~300-char
      // item (one-item sections serialize to 716 chars) but not both (1252).
      // max_tokens 480 => 720-char whole-pack budget lands in that window.
      const maxTokens = 480;
      const { payload } = await callPack(client, {
        requested_sections: ["profile_guidance"],
        budget: { max_tokens: maxTokens },
      });
      const section = payload.sections.profile_guidance;
      // Exactly one item survived — a genuine one-of-two trim.
      expect(section.item_count).toBe(1);
      expect(section.items).toHaveLength(1);
      // The survivor is the NEWEST/current item, not the older tail one.
      expect(section.items[0].id).toBe("new");
      expect(section.items[0].guidance).toContain("CURRENT");
      // The emitted body declares the partial trim; it is not an empty state.
      expect(section.truncated).toBe(true);
      expect(section.empty_reason).toBeUndefined();
      // Hard serialized budget: the whole sections object stays within the limit.
      const contentBudget = maxTokens * 4 - 1200;
      expect(JSON.stringify(payload.sections).length).toBeLessThanOrEqual(
        Math.max(2, contentBudget),
      );
      // Citation bijection: exactly the surviving item's citation remains — the
      // dropped older item's citation is gone.
      const sessionCitations = payload.citations.filter(
        (c: Row) => c.kind === "session_event",
      );
      expect(sessionCitations).toEqual([
        {
          id: "session_event:new",
          kind: "session_event",
          source_ref: "ob_session_events/new",
        },
      ]);
      // A whole-pack truncation marker names the trimmed section.
      expect(payload.warnings.truncation).toContainEqual(
        expect.objectContaining({
          source: "profile_guidance",
          reason: "whole_pack_budget",
        }),
      );
    } finally {
      await cleanup();
    }
  });
});

describe("prompt-placement ownership and no MCP _meta injection", () => {
  it("returns structured sections in the payload body only, with no _meta channel", async () => {
    const { pool } = routingPool({
      guidance: () => [prefRow({ id: "p1", candidate_scope: { key: "tone" } })],
      repoFacts: () => [factRow({ id: "f1" })],
    });
    const { client, cleanup } = await setupToolClient(ADMIN, pool);
    try {
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          ...SCOPE,
          requested_sections: ["profile_guidance", "repo_facts"],
          repo: "rodaddy/open-brain",
        },
      });
      // The tool result carries the pack only as returned text content; it never
      // injects an _meta side channel for prompt placement — placement stays
      // client/runtime-owned.
      expect((pack as any)._meta).toBeUndefined();
      const payload = JSON.parse((pack.content as any)[0].text);
      expect(payload.schema).toBe("openbrain.agent_context_pack.v1");
      expect(payload.sections.profile_guidance).toBeTruthy();
      expect(payload.sections.repo_facts).toBeTruthy();
    } finally {
      await cleanup();
    }
  });
});
