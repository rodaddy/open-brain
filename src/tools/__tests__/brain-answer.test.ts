import { describe, it, expect } from "bun:test";
import { registerBrainAnswer } from "../brain-answer.ts";
import type { AuthInfo } from "../../types.ts";
import {
  createMockEmbed,
  enableLegacyCollabFallback,
  setupMcpClient,
  parseToolResult,
  getErrorText,
} from "./test-helpers.ts";

function row(overrides: Record<string, unknown> = {}) {
  return {
    source_type: "thought",
    id: "thought-1",
    namespace: "skippy",
    content_preview: "Use Open Brain for durable Codex memory.",
    distance: 0.1,
    tags: ["memory"],
    created_by: "codex",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    usefulness: 0.7,
    ...overrides,
  };
}

function setupClient(
  rows: Record<string, unknown>[],
  auth: AuthInfo | null = { role: "admin", clientId: "admin" },
) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return { rows };
    },
  };
  return {
    queries,
    setup: setupMcpClient(registerBrainAnswer, pool, createMockEmbed(), auth),
  };
}

describe("brain_answer", () => {
  it("returns cited answer bullets tied to source refs", async () => {
    const { setup } = setupClient([
      row({
        id: "decision-1",
        source_type: "decision",
        content_preview: "Prefer Open Brain as the durable Codex memory system.",
      }),
    ]);
    const { client, cleanup } = await setup;
    try {
      const result = await client.callTool({
        name: "brain_answer",
        arguments: { query: "What memory system should Codex use?", limit: 1 },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseToolResult(result);
      expect(parsed.answer).toContain("[1]");
      expect(parsed.answer).toContain("Prefer Open Brain");
      expect(parsed.known_gaps).toEqual([]);
      expect(parsed.citations).toHaveLength(1);
      expect(parsed.citations[0].source_ref).toMatchObject({
        source: "brain",
        type: "decision",
        id: "decision-1",
        namespace: "skippy",
      });
      expect(parsed.citations[0].excerpt).toContain("Prefer Open Brain");
    } finally {
      await cleanup();
    }
  });

  it("fails closed with a gap instead of fabricating when no evidence is readable", async () => {
    const { setup } = setupClient([]);
    const { client, cleanup } = await setup;
    try {
      const result = await client.callTool({
        name: "brain_answer",
        arguments: { query: "Unknown policy" },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseToolResult(result);
      expect(parsed.answer).toBeNull();
      expect(parsed.citations).toEqual([]);
      expect(parsed.known_gaps[0]).toContain("No readable Open Brain evidence");
    } finally {
      await cleanup();
    }
  });

  it("uses namespace predicates before synthesis", async () => {
    const { setup, queries } = setupClient([row()]);
    const { client, cleanup } = await setup;
    try {
      const result = await client.callTool({
        name: "brain_answer",
        arguments: { query: "memory", namespace: "skippy" },
      });
      expect(result.isError).toBeFalsy();
      expect(queries.some(({ params }) => params.includes("skippy"))).toBe(true);
      expect(
        queries.some(({ sql }) =>
          /WHERE[\s\S]*\.namespace\s*=/.test(sql),
        ),
      ).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("falls back from shared-kb to legacy collab and canonicalizes citations", async () => {
    const fallbackEnv = enableLegacyCollabFallback();
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        const namespace = params.at(-1);
        if (namespace === "shared-kb") return { rows: [] };
        if (namespace === "collab") {
          return {
            rows: [
              row({
                id: "legacy-1",
                namespace: "collab",
                content_preview: "Legacy collab row should answer shared-kb reads.",
              }),
            ],
          };
        }
        return { rows: [] };
      },
    };
    const { client, cleanup } = await setupMcpClient(
      registerBrainAnswer,
      pool,
      createMockEmbed(),
      { role: "admin", clientId: "admin" },
    );
    try {
      const parsed = parseToolResult(
        await client.callTool({
          name: "brain_answer",
          arguments: {
            query: "legacy shared knowledge",
            namespace: "shared-kb",
            search_mode: "keyword",
          },
        }),
      );
      expect(parsed.evidence_count).toBe(1);
      expect(parsed.citations[0].source_ref.namespace).toBe("shared-kb");
      expect(queries.map(({ params }) => params.at(-1))).toEqual([
        "shared-kb",
        "collab",
      ]);
    } finally {
      fallbackEnv.restore();
      await cleanup();
    }
  });

  it("does not perform usage-tracking writes from the read-only answer tool", async () => {
    const { setup, queries } = setupClient([row()]);
    const { client, cleanup } = await setup;
    try {
      const result = await client.callTool({
        name: "brain_answer",
        arguments: { query: "memory" },
      });
      expect(result.isError).toBeFalsy();
      expect(
        queries.some(({ sql }) =>
          /\b(UPDATE|INSERT\s+INTO\s+entry_access_log)\b/i.test(sql),
        ),
      ).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("denies unreadable namespace filters", async () => {
    const { setup } = setupClient([], { role: "agent", clientId: "agent-a" });
    const { client, cleanup } = await setup;
    try {
      const result = await client.callTool({
        name: "brain_answer",
        arguments: { query: "memory", namespace: "other-agent" },
      });
      expect(result.isError).toBe(true);
      expect(getErrorText(result)).toContain("namespace read access denied");
    } finally {
      await cleanup();
    }
  });

  it("surfaces stale evidence as uncertainty", async () => {
    const { setup } = setupClient([
      row({
        created_at: "2020-01-01T00:00:00Z",
        updated_at: "2020-01-01T00:00:00Z",
      }),
    ]);
    const { client, cleanup } = await setup;
    try {
      const parsed = parseToolResult(
        await client.callTool({
          name: "brain_answer",
          arguments: { query: "old memory", max_age_days: 30 },
        }),
      );
      expect(parsed.citations[0].stale).toBe(true);
      expect(parsed.uncertainty.join(" ")).toContain("older than 30 days");
    } finally {
      await cleanup();
    }
  });

  it("surfaces mixed affirmative and negative evidence as uncertainty", async () => {
    const { setup } = setupClient([
      row({
        id: "yes-1",
        content_preview: "Codex should use Open Brain for durable memory.",
      }),
      row({
        id: "no-1",
        content_preview: "Codex should not use Open Brain for durable memory.",
      }),
    ]);
    const { client, cleanup } = await setup;
    try {
      const parsed = parseToolResult(
        await client.callTool({
          name: "brain_answer",
          arguments: { query: "should codex use open brain" },
        }),
      );
      expect(parsed.citations).toHaveLength(2);
      expect(parsed.uncertainty.join(" ")).toContain(
        "affirmative and negative",
      );
    } finally {
      await cleanup();
    }
  });

  it("surfaces imperative use and do-not-use contradictions as uncertainty", async () => {
    const { setup } = setupClient([
      row({
        id: "use-1",
        content_preview: "Use the lowercase Codex home path only.",
      }),
      row({
        id: "do-not-1",
        content_preview: "Do not use the lowercase Codex home path only.",
      }),
    ]);
    const { client, cleanup } = await setup;
    try {
      const parsed = parseToolResult(
        await client.callTool({
          name: "brain_answer",
          arguments: { query: "which codex home path should be used" },
        }),
      );
      expect(parsed.citations).toHaveLength(2);
      expect(parsed.uncertainty.join(" ")).toContain(
        "affirmative and negative",
      );
    } finally {
      await cleanup();
    }
  });

  it("does not flag reinforcing do-not and use guidance as contradiction", async () => {
    const { setup } = setupClient([
      row({
        id: "avoid-1",
        content_preview:
          "Do not use ~/.codex-clean; use the lowercase Codex home path only.",
      }),
      row({
        id: "use-1",
        content_preview: "Use the lowercase Codex home path only.",
      }),
    ]);
    const { client, cleanup } = await setup;
    try {
      const parsed = parseToolResult(
        await client.callTool({
          name: "brain_answer",
          arguments: { query: "which codex home path should be used" },
        }),
      );
      expect(parsed.uncertainty.join(" ")).not.toContain(
        "affirmative and negative",
      );
    } finally {
      await cleanup();
    }
  });

  it("omits malformed evidence and reports a gap instead of uncited bullets", async () => {
    const { setup } = setupClient([
      row({
        id: "blank-1",
        content_preview: "   ",
      }),
    ]);
    const { client, cleanup } = await setup;
    try {
      const parsed = parseToolResult(
        await client.callTool({
          name: "brain_answer",
          arguments: { query: "malformed evidence", include_raw: true },
        }),
      );
      expect(parsed.answer).toBeNull();
      expect(parsed.citations).toEqual([]);
      expect(parsed.known_gaps.join(" ")).toContain(
        "lacked citation metadata or usable preview text",
      );
      expect(parsed.raw_results).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it("omits null previews and counts only citable evidence", async () => {
    const { setup } = setupClient([
      row({
        id: "valid-1",
        content_preview: "Use Open Brain when prior Codex context matters.",
      }),
      row({
        id: "null-1",
        content_preview: null,
      }),
    ]);
    const { client, cleanup } = await setup;
    try {
      const parsed = parseToolResult(
        await client.callTool({
          name: "brain_answer",
          arguments: { query: "codex memory" },
        }),
      );
      expect(parsed.evidence_count).toBe(1);
      expect(parsed.citations).toHaveLength(1);
      expect(parsed.answer).toContain("Use Open Brain");
      expect(parsed.known_gaps.join(" ")).toContain(
        "lacked citation metadata or usable preview text",
      );
      expect(parsed.uncertainty.join(" ")).toContain("omitted");
    } finally {
      await cleanup();
    }
  });
});
