import { describe, it, expect, afterEach } from "bun:test";
import { registerSearchAll } from "../search-all.ts";
import type { AuthInfo } from "../../types.ts";
import {
  createMockEmbed,
  enableLegacyCollabFallback,
  makeMockRows,
  setupMcpClient,
  parseToolResult,
  getErrorText,
} from "./test-helpers.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockRowsWithMeta(
  count: number,
  overrides: Partial<{
    source_type: string;
    distance: number;
    usefulness: number;
  }> = {},
) {
  return Array.from({ length: count }, (_, i) => ({
    source_type: overrides.source_type ?? "thought",
    id: `uuid-${i}`,
    content_preview: `Content preview ${i}`,
    distance: overrides.distance ?? 0.1 + i * 0.05,
    tags: ["tag-a"],
    created_at: "2026-01-01T00:00:00Z",
    usefulness: overrides.usefulness ?? 0.5,
  }));
}

function makeMultiTableRows(perTable: number = 1) {
  const types = ["thought", "decision", "relationship", "project", "session"];
  return types.flatMap((t, ti) =>
    Array.from({ length: perTable }, (_, i) => ({
      source_type: t,
      id: `${t}-uuid-${i}`,
      content_preview: `${t} content ${i}`,
      distance: 0.05 + ti * 0.02 + i * 0.01,
      tags: [`${t}-tag`],
      created_at: "2026-01-01T00:00:00Z",
      usefulness: 0.6,
    })),
  );
}

const setupClient = (
  mockPool: { query: (...a: any[]) => Promise<{ rows: any[] }> },
  auth: AuthInfo | null,
  embed = createMockEmbed(),
) => setupMcpClient(registerSearchAll, mockPool, embed, auth);

const abortAwareNeverResolvingEmbed =
  (onAbort: () => void) =>
  async (
    _text: string,
    _embeddingUrl?: string,
    options?: { signal?: AbortSignal },
  ) =>
    new Promise<number[] | null>((resolve) => {
      options?.signal?.addEventListener(
        "abort",
        () => {
          onAbort();
          resolve(null);
        },
        { once: true },
      );
    });

/** Parse search_all structured response. */
function parseSearchAll(result: any) {
  return parseToolResult(result) as {
    total: number;
    brain_hits: number;
    qmd_hits: number;
    results: any[];
  };
}

const originalSpawn = Bun.spawn;

function mockBunSpawn(exitCode: number, stdout: string, stderr = "") {
  (Bun as any).spawn = () => {
    const encoder = new TextEncoder();
    return {
      stdout: new ReadableStream({
        start(c) {
          c.enqueue(encoder.encode(stdout));
          c.close();
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.enqueue(encoder.encode(stderr));
          c.close();
        },
      }),
      exited: Promise.resolve(exitCode),
    };
  };
}

function restoreBunSpawn() {
  (Bun as any).spawn = originalSpawn;
}

function qmdJson(docs: any[]) {
  return JSON.stringify(docs);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("search_all", () => {
  afterEach(restoreBunSpawn);

  describe("Small -- basic behaviour", () => {
    it("returns permission denied when auth is missing", async () => {
      const pool = { query: async () => ({ rows: [] }) };
      const { client, cleanup } = await setupClient(pool, null);
      try {
        const result = await client.callTool({
          name: "search_all",
          arguments: { query: "test" },
        });
        expect(result.isError).toBe(true);
        expect(getErrorText(result)).toContain("Permission denied");
      } finally {
        await cleanup();
      }
    });

    it("returns brain-only results when sources='brain'", async () => {
      mockBunSpawn(1, "", "should not be called");
      const pool = { query: async () => ({ rows: makeMockRowsWithMeta(2) }) };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setupClient(pool, auth);
      try {
        const result = await client.callTool({
          name: "search_all",
          arguments: { query: "brain only", sources: "brain" },
        });
        expect(result.isError).toBeFalsy();
        const parsed = parseSearchAll(result);
        expect(parsed.brain_hits).toBe(2);
        expect(parsed.qmd_hits).toBe(0);
        expect(parsed.results.every((r: any) => r.source === "brain")).toBe(
          true,
        );
      } finally {
        await cleanup();
      }
    });

    it("returns qmd-only results when sources='qmd'", async () => {
      mockBunSpawn(
        0,
        qmdJson([
          { path: "/a.md", content: "hello", score: 0.9 },
          { path: "/b.md", content: "world", score: 0.8 },
        ]),
      );
      const pool = { query: async () => ({ rows: [] }) };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setupClient(pool, auth);
      try {
        const result = await client.callTool({
          name: "search_all",
          arguments: { query: "qmd only", sources: "qmd" },
        });
        const parsed = parseSearchAll(result);
        expect(parsed.brain_hits).toBe(0);
        expect(parsed.qmd_hits).toBe(2);
        expect(parsed.results.every((r: any) => r.source === "qmd")).toBe(
          true,
        );
        expect(parsed.results[0].source_ref).toEqual({
          source: "qmd",
          type: "file",
          path: "/a.md",
        });
      } finally {
        await cleanup();
      }
    });

    it("returns empty results when both sources return nothing", async () => {
      mockBunSpawn(0, qmdJson([]));
      const pool = { query: async () => ({ rows: [] }) };
      const { client, cleanup } = await setupClient(pool, {
        role: "admin",
        clientId: "admin",
      });
      try {
        const parsed = parseSearchAll(
          await client.callTool({
            name: "search_all",
            arguments: { query: "nothing" },
          }),
        );
        expect(parsed.total).toBe(0);
        expect(parsed.results).toEqual([]);
      } finally {
        await cleanup();
      }
    });

    it("returns single brain result correctly", async () => {
      mockBunSpawn(1, "");
      const queries: string[] = [];
      const pool = {
        query: async (sql: string) => {
          queries.push(sql);
          return {
            rows: [
              {
                source_type: "decision",
                id: "dec-1",
                content_preview: "Use Bun over Node",
                distance: 0.08,
                tags: ["runtime"],
                created_at: "2026-01-10",
                usefulness: 0.7,
              },
            ],
          };
        },
      };
      const { client, cleanup } = await setupClient(pool, {
        role: "admin",
        clientId: "admin",
      });
      try {
        const parsed = parseSearchAll(
          await client.callTool({
            name: "search_all",
            arguments: { query: "bun vs node" },
          }),
        );
        expect(parsed.brain_hits).toBe(1);
        expect(parsed.results[0].source).toBe("brain");
        expect(parsed.results[0].type).toBe("decision");
        expect(parsed.results[0].id).toBe("dec-1");
        expect(parsed.results[0].tags).toEqual(["runtime"]);
        expect(parsed.results[0].source_ref).toEqual({
          source: "brain",
          type: "decision",
          id: "dec-1",
          created_at: "2026-01-10T00:00:00.000Z",
          last_updated_at: "2026-01-10T00:00:00.000Z",
          label: "Use Bun over Node",
          preview: "Use Bun over Node",
        });
        expect(queries.some((sql) => sql.includes("FROM ob_links"))).toBe(
          false,
        );
      } finally {
        await cleanup();
      }
    });
  });

  describe("Medium -- merging and scoring", () => {
    it("merges OB and qmd results, sorted by score descending", async () => {
      mockBunSpawn(
        0,
        qmdJson([{ path: "/top.md", content: "top qmd hit", score: 0.95 }]),
      );
      const pool = {
        query: async () => ({
          rows: [
            {
              source_type: "thought",
              id: "t1",
              content_preview: "brain 1",
              distance: 0.1,
              tags: [],
              created_at: "2026-01-01",
              usefulness: 0.5,
            },
            {
              source_type: "thought",
              id: "t2",
              content_preview: "brain 2",
              distance: 0.3,
              tags: [],
              created_at: "2026-01-01",
              usefulness: 0.5,
            },
          ],
        }),
      };
      const { client, cleanup } = await setupClient(pool, {
        role: "admin",
        clientId: "admin",
      });
      try {
        const parsed = parseSearchAll(
          await client.callTool({
            name: "search_all",
            arguments: { query: "merge", limit: 10 },
          }),
        );
        expect(parsed.total).toBe(3);
        expect(parsed.brain_hits).toBe(2);
        expect(parsed.qmd_hits).toBe(1);
        const sources = new Set(parsed.results.map((r: any) => r.source));
        expect(sources.has("brain")).toBe(true);
        expect(sources.has("qmd")).toBe(true);
        for (let i = 1; i < parsed.results.length; i++) {
          expect(parsed.results[i - 1].score).toBeGreaterThanOrEqual(
            parsed.results[i].score,
          );
        }
      } finally {
        await cleanup();
      }
    });

    it("brain results have positive RRF-based scores", async () => {
      mockBunSpawn(1, "");
      const pool = {
        query: async () => ({
          rows: [
            {
              source_type: "thought",
              id: "t1",
              content_preview: "close",
              distance: 0.05,
              tags: [],
              created_at: "2026-01-01",
              usefulness: 0.5,
            },
            {
              source_type: "thought",
              id: "t2",
              content_preview: "far",
              distance: 0.85,
              tags: [],
              created_at: "2026-01-01",
              usefulness: 0.5,
            },
          ],
        }),
      };
      const { client, cleanup } = await setupClient(pool, {
        role: "admin",
        clientId: "admin",
      });
      try {
        const parsed = parseSearchAll(
          await client.callTool({
            name: "search_all",
            arguments: { query: "dist", sources: "brain" },
          }),
        );
        expect(parsed.results[0].score).toBeGreaterThan(
          parsed.results[1].score,
        );
        expect(parsed.results[0].score).toBeGreaterThan(0);
      } finally {
        await cleanup();
      }
    });

    it("enforces limit by slicing merged results", async () => {
      mockBunSpawn(
        0,
        qmdJson([
          { path: "/a.md", content: "a", score: 0.9 },
          { path: "/b.md", content: "b", score: 0.7 },
          { path: "/c.md", content: "c", score: 0.5 },
        ]),
      );
      const pool = { query: async () => ({ rows: makeMockRowsWithMeta(3) }) };
      const { client, cleanup } = await setupClient(pool, {
        role: "admin",
        clientId: "admin",
      });
      try {
        const parsed = parseSearchAll(
          await client.callTool({
            name: "search_all",
            arguments: { query: "limit", limit: 4 },
          }),
        );
        expect(parsed.total).toBe(4);
        expect(parsed.results.length).toBe(4);
      } finally {
        await cleanup();
      }
    });

    it("does not call embedFn when sources='qmd'", async () => {
      let embedCalled = false;
      const embed = async (_text: string) => {
        embedCalled = true;
        return Array(768).fill(0.1);
      };
      mockBunSpawn(0, qmdJson([{ path: "/x.md", content: "x", score: 0.5 }]));
      const pool = { query: async () => ({ rows: [] }) };
      const { client, cleanup } = await setupMcpClient(
        registerSearchAll,
        pool,
        embed,
        { role: "admin", clientId: "admin" },
      );
      try {
        await client.callTool({
          name: "search_all",
          arguments: { query: "skip embed", sources: "qmd" },
        });
        expect(embedCalled).toBe(false);
      } finally {
        await cleanup();
      }
    });

    it("multiple OB tables merged with distinct type labels", async () => {
      mockBunSpawn(1, "");
      const pool = {
        query: async () => ({
          rows: [
            {
              source_type: "thought",
              id: "t1",
              content_preview: "t",
              distance: 0.1,
              tags: [],
              created_at: "2026-01-01",
              usefulness: 0.5,
            },
            {
              source_type: "decision",
              id: "d1",
              content_preview: "d",
              distance: 0.2,
              tags: [],
              created_at: "2026-01-01",
              usefulness: 0.5,
            },
            {
              source_type: "session",
              id: "s1",
              content_preview: "s",
              distance: 0.3,
              tags: [],
              created_at: "2026-01-01",
              usefulness: 0.5,
            },
          ],
        }),
      };
      const { client, cleanup } = await setupClient(pool, {
        role: "admin",
        clientId: "admin",
      });
      try {
        const types = parseSearchAll(
          await client.callTool({
            name: "search_all",
            arguments: { query: "multi", sources: "brain" },
          }),
        ).results.map((r: any) => r.type);
        expect(types).toContain("thought");
        expect(types).toContain("decision");
        expect(types).toContain("session");
      } finally {
        await cleanup();
      }
    });

    it("falls back from shared-kb to legacy collab for brain results and canonicalizes output", async () => {
      const fallbackEnv = enableLegacyCollabFallback();
      mockBunSpawn(1, "");
      const seenNamespaces: unknown[] = [];
      const pool = {
        query: async (_sql: string, params: unknown[] = []) => {
          const namespace = params.at(-1);
          seenNamespaces.push(namespace);
          if (namespace === "shared-kb") return { rows: [] };
          if (namespace === "collab") {
            return {
              rows: [
                {
                  source_type: "thought",
                  id: "legacy-1",
                  namespace: "collab",
                  content_preview: "Legacy shared knowledge",
                  distance: 0.1,
                  tags: [],
                  created_at: "2026-01-01",
                  usefulness: 0.5,
                },
              ],
            };
          }
          return { rows: [] };
        },
      };
      const { client, cleanup } = await setupClient(pool, {
        role: "admin",
        clientId: "admin",
      });
      try {
        const parsed = parseSearchAll(
          await client.callTool({
            name: "search_all",
            arguments: {
              query: "legacy",
              namespace: "shared-kb",
              sources: "brain",
              search_mode: "keyword",
            },
          }),
        );
        expect(parsed.brain_hits).toBe(1);
        expect(parsed.results[0].source_ref.namespace).toBe("shared-kb");
        expect(
          seenNamespaces.filter((value) => typeof value === "string"),
        ).toEqual(["shared-kb", "collab", "admin"]);
      } finally {
        fallbackEnv.restore();
        await cleanup();
      }
    });
  });

  describe("Large -- max limit, all 5 tables", () => {
    it("accepts max limit of 50 without error", async () => {
      mockBunSpawn(1, "");
      const pool = { query: async () => ({ rows: [] }) };
      const { client, cleanup } = await setupClient(pool, {
        role: "admin",
        clientId: "admin",
      });
      try {
        const result = await client.callTool({
          name: "search_all",
          arguments: { query: "max", limit: 50, search_mode: "vector" },
        });
        expect(result.isError).toBeFalsy();
      } finally {
        await cleanup();
      }
    });

    it("merges all 5 OB tables and qmd, ranked by score", async () => {
      mockBunSpawn(
        0,
        qmdJson([
          { path: "/doc1.md", content: "qmd 1", score: 0.88 },
          { path: "/doc2.md", content: "qmd 2", score: 0.72 },
        ]),
      );
      const pool = { query: async () => ({ rows: makeMultiTableRows(1) }) };
      const { client, cleanup } = await setupClient(pool, {
        role: "admin",
        clientId: "admin",
      });
      try {
        const parsed = parseSearchAll(
          await client.callTool({
            name: "search_all",
            arguments: { query: "full", limit: 20 },
          }),
        );
        expect(parsed.brain_hits).toBe(5);
        expect(parsed.qmd_hits).toBe(2);
        expect(parsed.total).toBe(7);
        for (let i = 1; i < parsed.results.length; i++) {
          expect(parsed.results[i - 1].score).toBeGreaterThanOrEqual(
            parsed.results[i].score,
          );
        }
      } finally {
        await cleanup();
      }
    });

    it("admin sees results from all 5 OB table types", async () => {
      mockBunSpawn(1, "");
      const pool = { query: async () => ({ rows: makeMultiTableRows(1) }) };
      const { client, cleanup } = await setupClient(pool, {
        role: "admin",
        clientId: "admin",
      });
      try {
        const types = new Set(
          parseSearchAll(
            await client.callTool({
              name: "search_all",
              arguments: { query: "all", sources: "brain" },
            }),
          ).results.map((r: any) => r.type),
        );
        for (const t of [
          "thought",
          "decision",
          "relationship",
          "project",
          "session",
        ]) {
          expect(types.has(t)).toBe(true);
        }
      } finally {
        await cleanup();
      }
    });
  });

  describe("Rapid -- sequential calls return independently", () => {
    it("three calls each return their own results", async () => {
      let callIndex = 0;
      const pool = {
        query: async (...args: any[]) => {
          if (String(args[0]).includes("FROM ob_links")) return { rows: [] };
          callIndex++;
          return {
            rows: makeMockRowsWithMeta(callIndex, {
              source_type: `type-${callIndex}`,
            }),
          };
        },
      };
      let spawnCount = 0;
      (Bun as any).spawn = () => {
        spawnCount++;
        const encoder = new TextEncoder();
        const stdout = qmdJson([
          {
            path: `/r-${spawnCount}.md`,
            content: `r ${spawnCount}`,
            score: 0.5,
          },
        ]);
        return {
          stdout: new ReadableStream({
            start(c) {
              c.enqueue(encoder.encode(stdout));
              c.close();
            },
          }),
          stderr: new ReadableStream({
            start(c) {
              c.close();
            },
          }),
          exited: Promise.resolve(0),
        };
      };
      const { client, cleanup } = await setupClient(pool, {
        role: "admin",
        clientId: "admin",
      });
      try {
        const p1 = parseSearchAll(
          await client.callTool({
            name: "search_all",
            arguments: { query: "r1", search_mode: "vector" },
          }),
        );
        const p2 = parseSearchAll(
          await client.callTool({
            name: "search_all",
            arguments: { query: "r2", search_mode: "vector" },
          }),
        );
        const p3 = parseSearchAll(
          await client.callTool({
            name: "search_all",
            arguments: { query: "r3", search_mode: "vector" },
          }),
        );
        expect(p1.brain_hits).toBe(1);
        expect(p2.brain_hits).toBe(2);
        expect(p3.brain_hits).toBe(3);
        expect(p1.qmd_hits).toBe(1);
      } finally {
        await cleanup();
      }
    });
  });

  describe("Edge cases", () => {
    it("returns qmd-only when vector embedding times out", async () => {
      const previousTimeout = process.env.OPENBRAIN_SEARCH_EMBEDDING_TIMEOUT_MS;
      process.env.OPENBRAIN_SEARCH_EMBEDDING_TIMEOUT_MS = "10";
      let aborted = false;
      mockBunSpawn(
        0,
        qmdJson([{ path: "/f.md", content: "qmd only", score: 0.7 }]),
      );
      const pool = { query: async () => ({ rows: makeMockRowsWithMeta(2) }) };
      const { client, cleanup } = await setupClient(
        pool,
        { role: "admin", clientId: "admin" },
        abortAwareNeverResolvingEmbed(() => {
          aborted = true;
        }),
      );
      try {
        const parsed = parseSearchAll(
          await client.callTool({
            name: "search_all",
            arguments: { query: "embed timeout", search_mode: "vector" },
          }),
        );
        expect(parsed.brain_hits).toBe(0);
        expect(parsed.qmd_hits).toBe(1);
        expect(aborted).toBe(true);
      } finally {
        if (previousTimeout === undefined) {
          delete process.env.OPENBRAIN_SEARCH_EMBEDDING_TIMEOUT_MS;
        } else {
          process.env.OPENBRAIN_SEARCH_EMBEDDING_TIMEOUT_MS = previousTimeout;
        }
        await cleanup();
      }
    });

    it("returns qmd-only when embedFn returns null (brain skipped)", async () => {
      mockBunSpawn(
        0,
        qmdJson([{ path: "/f.md", content: "qmd only", score: 0.7 }]),
      );
      const pool = { query: async () => ({ rows: makeMockRowsWithMeta(2) }) };
      const { client, cleanup } = await setupClient(
        pool,
        { role: "admin", clientId: "admin" },
        createMockEmbed(null),
      );
      try {
        const parsed = parseSearchAll(
          await client.callTool({
            name: "search_all",
            arguments: { query: "embed fail", search_mode: "vector" },
          }),
        );
        expect(parsed.brain_hits).toBe(0);
        expect(parsed.qmd_hits).toBe(1);
      } finally {
        await cleanup();
      }
    });

    it("gracefully returns brain-only when qmd exits non-zero", async () => {
      mockBunSpawn(1, "", "qmd crashed");
      const pool = { query: async () => ({ rows: makeMockRowsWithMeta(2) }) };
      const { client, cleanup } = await setupClient(pool, {
        role: "admin",
        clientId: "admin",
      });
      try {
        const parsed = parseSearchAll(
          await client.callTool({
            name: "search_all",
            arguments: { query: "qmd fail" },
          }),
        );
        expect(parsed.brain_hits).toBe(2);
        expect(parsed.qmd_hits).toBe(0);
      } finally {
        await cleanup();
      }
    });

    it("handles qmd malformed JSON gracefully", async () => {
      mockBunSpawn(0, "this is not json {{{");
      const pool = { query: async () => ({ rows: makeMockRowsWithMeta(1) }) };
      const { client, cleanup } = await setupClient(pool, {
        role: "admin",
        clientId: "admin",
      });
      try {
        const parsed = parseSearchAll(
          await client.callTool({
            name: "search_all",
            arguments: { query: "bad json" },
          }),
        );
        expect(parsed.brain_hits).toBe(1);
        expect(parsed.qmd_hits).toBe(0);
      } finally {
        await cleanup();
      }
    });

    it("handles qmd valid wrapper but no text content", async () => {
      mockBunSpawn(
        0,
        JSON.stringify({ success: true, result: { content: [] } }),
      );
      const pool = { query: async () => ({ rows: makeMockRowsWithMeta(1) }) };
      const { client, cleanup } = await setupClient(pool, {
        role: "admin",
        clientId: "admin",
      });
      try {
        expect(
          parseSearchAll(
            await client.callTool({
              name: "search_all",
              arguments: { query: "empty wrapper" },
            }),
          ).qmd_hits,
        ).toBe(0);
      } finally {
        await cleanup();
      }
    });

    it("handles qmd non-array docs", async () => {
      mockBunSpawn(
        0,
        JSON.stringify({
          success: true,
          result: { content: [{ type: "text", text: '{"not":"an array"}' }] },
        }),
      );
      const pool = { query: async () => ({ rows: makeMockRowsWithMeta(1) }) };
      const { client, cleanup } = await setupClient(pool, {
        role: "admin",
        clientId: "admin",
      });
      try {
        expect(
          parseSearchAll(
            await client.callTool({
              name: "search_all",
              arguments: { query: "non-array" },
            }),
          ).qmd_hits,
        ).toBe(0);
      } finally {
        await cleanup();
      }
    });

    it("discord gets no brain results but still gets qmd", async () => {
      mockBunSpawn(
        0,
        qmdJson([{ path: "/pub.md", content: "public info", score: 0.6 }]),
      );
      const pool = { query: async () => ({ rows: [] }) };
      const { client, cleanup } = await setupClient(pool, {
        role: "discord",
        clientId: "discord-bot",
      });
      try {
        const parsed = parseSearchAll(
          await client.callTool({
            name: "search_all",
            arguments: { query: "discord" },
          }),
        );
        expect(parsed.brain_hits).toBe(0);
        expect(parsed.qmd_hits).toBe(1);
      } finally {
        await cleanup();
      }
    });

    it("brain content_preview truncated to 300 chars", async () => {
      mockBunSpawn(1, "");
      const pool = {
        query: async () => ({
          rows: [
            {
              source_type: "thought",
              id: "long-1",
              content_preview: "x".repeat(500),
              distance: 0.1,
              tags: [],
              created_at: "2026-01-01",
              usefulness: 0.5,
            },
          ],
        }),
      };
      const { client, cleanup } = await setupClient(pool, {
        role: "admin",
        clientId: "admin",
      });
      try {
        expect(
          parseSearchAll(
            await client.callTool({
              name: "search_all",
              arguments: { query: "long", sources: "brain" },
            }),
          ).results[0].content.length,
        ).toBe(300);
      } finally {
        await cleanup();
      }
    });

    it("qmd content truncated to 300 chars", async () => {
      mockBunSpawn(
        0,
        qmdJson([{ path: "/long.md", content: "y".repeat(500), score: 0.5 }]),
      );
      const pool = { query: async () => ({ rows: [] }) };
      const { client, cleanup } = await setupClient(pool, {
        role: "admin",
        clientId: "admin",
      });
      try {
        expect(
          parseSearchAll(
            await client.callTool({
              name: "search_all",
              arguments: { query: "long qmd", sources: "qmd" },
            }),
          ).results[0].content.length,
        ).toBe(300);
      } finally {
        await cleanup();
      }
    });

    it("qmd uses 'text' field when 'content' absent", async () => {
      mockBunSpawn(
        0,
        qmdJson([{ path: "/t.md", text: "from text field", score: 0.6 }]),
      );
      const pool = { query: async () => ({ rows: [] }) };
      const { client, cleanup } = await setupClient(pool, {
        role: "admin",
        clientId: "admin",
      });
      try {
        expect(
          parseSearchAll(
            await client.callTool({
              name: "search_all",
              arguments: { query: "text fb", sources: "qmd" },
            }),
          ).results[0].content,
        ).toBe("from text field");
      } finally {
        await cleanup();
      }
    });

    it("qmd uses 'preview' field when content and text absent", async () => {
      mockBunSpawn(
        0,
        qmdJson([{ path: "/p.md", preview: "from preview", score: 0.6 }]),
      );
      const pool = { query: async () => ({ rows: [] }) };
      const { client, cleanup } = await setupClient(pool, {
        role: "admin",
        clientId: "admin",
      });
      try {
        expect(
          parseSearchAll(
            await client.callTool({
              name: "search_all",
              arguments: { query: "preview fb", sources: "qmd" },
            }),
          ).results[0].content,
        ).toBe("from preview");
      } finally {
        await cleanup();
      }
    });

    it("qmd uses 'snippet' field when other content fields are absent", async () => {
      mockBunSpawn(
        0,
        qmdJson([{ path: "/s.md", snippet: "from snippet", score: 0.6 }]),
      );
      const pool = { query: async () => ({ rows: [] }) };
      const { client, cleanup } = await setupClient(pool, {
        role: "admin",
        clientId: "admin",
      });
      try {
        expect(
          parseSearchAll(
            await client.callTool({
              name: "search_all",
              arguments: { query: "snippet fb", sources: "qmd" },
            }),
          ).results[0].content,
        ).toBe("from snippet");
      } finally {
        await cleanup();
      }
    });

    it("passes collection filter to qmd search", async () => {
      let spawnArgs: string[] | undefined;
      (Bun as any).spawn = (args: string[]) => {
        spawnArgs = args;
        const encoder = new TextEncoder();
        return {
          stdout: new ReadableStream({
            start(c) {
              c.enqueue(
                encoder.encode(
                  qmdJson([
                    {
                      path: "qmd://open-brain-runtime/src/tools/search-all.ts",
                      snippet: "scoped qmd result",
                      score: 0.6,
                    },
                  ]),
                ),
              );
              c.close();
            },
          }),
          stderr: new ReadableStream({
            start(c) {
              c.close();
            },
          }),
          exited: Promise.resolve(0),
        };
      };
      const pool = { query: async () => ({ rows: [] }) };
      const { client, cleanup } = await setupClient(pool, {
        role: "admin",
        clientId: "admin",
      });
      try {
        const parsed = parseSearchAll(
          await client.callTool({
            name: "search_all",
            arguments: {
              query: "collection scoped",
              sources: "qmd",
              collection: "open-brain-runtime",
            },
          }),
        );
        expect(parsed.results[0].content).toBe("scoped qmd result");
        expect(spawnArgs).toContain("-c");
        expect(spawnArgs).toContain("open-brain-runtime");
      } finally {
        await cleanup();
      }
    });

    it("qmd 'similarity' field accepted with positive score", async () => {
      mockBunSpawn(
        0,
        qmdJson([{ path: "/s.md", content: "sim", similarity: 0.77 }]),
      );
      const pool = { query: async () => ({ rows: [] }) };
      const { client, cleanup } = await setupClient(pool, {
        role: "admin",
        clientId: "admin",
      });
      try {
        expect(
          parseSearchAll(
            await client.callTool({
              name: "search_all",
              arguments: { query: "sim", sources: "qmd" },
            }),
          ).results[0].score,
        ).toBeGreaterThan(0);
      } finally {
        await cleanup();
      }
    });

    it("qmd without score fields still gets valid score", async () => {
      mockBunSpawn(0, qmdJson([{ path: "/d.md", content: "no score" }]));
      const pool = { query: async () => ({ rows: [] }) };
      const { client, cleanup } = await setupClient(pool, {
        role: "admin",
        clientId: "admin",
      });
      try {
        expect(
          parseSearchAll(
            await client.callTool({
              name: "search_all",
              arguments: { query: "default", sources: "qmd" },
            }),
          ).results[0].score,
        ).toBeGreaterThan(0);
      } finally {
        await cleanup();
      }
    });

    it("qmd maps 'file' field to 'path'", async () => {
      mockBunSpawn(
        0,
        qmdJson([{ file: "/via-file.md", content: "file field", score: 0.5 }]),
      );
      const pool = { query: async () => ({ rows: [] }) };
      const { client, cleanup } = await setupClient(pool, {
        role: "admin",
        clientId: "admin",
      });
      try {
        expect(
          parseSearchAll(
            await client.callTool({
              name: "search_all",
              arguments: { query: "file", sources: "qmd" },
            }),
          ).results[0].path,
        ).toBe("/via-file.md");
      } finally {
        await cleanup();
      }
    });

    it("fires usage tracking for brain results", async () => {
      mockBunSpawn(1, "");
      const queryCalls: any[] = [];
      const pool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return {
            rows: [
              {
                source_type: "thought",
                id: "t-1",
                content_preview: "tracked",
                distance: 0.1,
                tags: [],
                created_at: "2026-01-01",
                usefulness: 0.5,
              },
              {
                source_type: "decision",
                id: "d-1",
                content_preview: "also",
                distance: 0.2,
                tags: [],
                created_at: "2026-01-01",
                usefulness: 0.5,
              },
            ],
          };
        },
      };
      const { client, cleanup } = await setupClient(pool, {
        role: "admin",
        clientId: "admin",
      });
      try {
        const result = await client.callTool({
          name: "search_all",
          arguments: {
            query: "tracking",
            sources: "brain",
            search_mode: "vector",
          },
        });
        expect(result.isError).toBeFalsy();
        expect(parseSearchAll(result).brain_hits).toBe(2);
        await new Promise((r) => setTimeout(r, 50));
        expect(queryCalls.length).toBeGreaterThan(1);
      } finally {
        await cleanup();
      }
    });

    it("default limit is 10", async () => {
      mockBunSpawn(1, "");
      const pool = { query: async () => ({ rows: makeMockRowsWithMeta(15) }) };
      const { client, cleanup } = await setupClient(pool, {
        role: "admin",
        clientId: "admin",
      });
      try {
        expect(
          parseSearchAll(
            await client.callTool({
              name: "search_all",
              arguments: { query: "default limit", search_mode: "vector" },
            }),
          ).results.length,
        ).toBeLessThanOrEqual(10);
      } finally {
        await cleanup();
      }
    });

    it("readonly role can search brain", async () => {
      mockBunSpawn(1, "");
      const pool = { query: async () => ({ rows: makeMockRowsWithMeta(1) }) };
      const { client, cleanup } = await setupClient(pool, {
        role: "readonly",
        clientId: "ro",
      });
      try {
        expect(
          parseSearchAll(
            await client.callTool({
              name: "search_all",
              arguments: { query: "ro search", sources: "brain" },
            }),
          ).brain_hits,
        ).toBe(1);
      } finally {
        await cleanup();
      }
    });
  });
});
