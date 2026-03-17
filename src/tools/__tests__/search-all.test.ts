import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSearchAll } from "../search-all.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockEmbed(result: number[] | null = Array(768).fill(0.1)) {
  return async (_text: string) => result;
}

/** Build mock OB rows with sensible defaults. */
function makeMockRows(
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

/** Rows spanning all 5 tables. */
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

async function setupClient(
  mockPool: { query: (...args: any[]) => Promise<{ rows: any[] }> },
  mockEmbed: ReturnType<typeof createMockEmbed>,
  auth: AuthInfo | null,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = { pool: mockPool as any, embedFn: mockEmbed };
  registerSearchAll(server, deps);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  if (auth) {
    const originalSend = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message: any, options?: any) => {
      return originalSend(message, { ...options, authInfo: auth });
    };
  }

  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Parse the JSON payload returned by search_all. */
function parseResult(result: any) {
  const text = (result.content as any)[0].text;
  return JSON.parse(text) as {
    total: number;
    brain_hits: number;
    qmd_hits: number;
    results: any[];
  };
}

// We need to intercept Bun.spawn for qmd tests. Store the original and
// restore after each test.
const originalSpawn = Bun.spawn;

function mockBunSpawn(exitCode: number, stdout: string, stderr: string = "") {
  (Bun as any).spawn = (_cmd: any, _opts: any) => {
    const encoder = new TextEncoder();
    return {
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(stdout));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(stderr));
          controller.close();
        },
      }),
      exited: Promise.resolve(exitCode),
    };
  };
}

function restoreBunSpawn() {
  (Bun as any).spawn = originalSpawn;
}

/** Build qmd CLI JSON output (direct array, no mcp2cli wrapper). */
function qmdWrapper(docs: any[]) {
  return JSON.stringify(docs);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("search_all", () => {
  afterEach(() => {
    restoreBunSpawn();
  });

  // -----------------------------------------------------------------------
  // SMALL
  // -----------------------------------------------------------------------
  describe("Small -- basic behaviour", () => {
    it("returns permission denied when auth is missing", async () => {
      const mockPool = { query: async () => ({ rows: [] }) };
      const { client, cleanup } = await setupClient(
        mockPool,
        createMockEmbed(),
        null,
      );

      try {
        const result = await client.callTool({
          name: "search_all",
          arguments: { query: "test" },
        });
        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain("Permission denied");
      } finally {
        await cleanup();
      }
    });

    it("returns brain-only results when sources='brain'", async () => {
      // qmd should NOT be called; mock spawn to fail so we'd notice
      mockBunSpawn(1, "", "should not be called");
      const mockPool = {
        query: async () => ({ rows: makeMockRows(2) }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setupClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_all",
          arguments: { query: "brain only", sources: "brain" },
        });
        expect(result.isError).toBeFalsy();
        const parsed = parseResult(result);
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
      const qmdDocs = [
        { path: "/a.md", content: "hello", score: 0.9 },
        { path: "/b.md", content: "world", score: 0.8 },
      ];
      mockBunSpawn(0, qmdWrapper(qmdDocs));

      // Pool should NOT be queried for brain search
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setupClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_all",
          arguments: { query: "qmd only", sources: "qmd" },
        });
        expect(result.isError).toBeFalsy();
        const parsed = parseResult(result);
        expect(parsed.brain_hits).toBe(0);
        expect(parsed.qmd_hits).toBe(2);
        expect(parsed.results.every((r: any) => r.source === "qmd")).toBe(true);
        // OB pool should not have been queried (no search SELECT)
        expect(queryCalls.length).toBe(0);
      } finally {
        await cleanup();
      }
    });

    it("returns empty results when both sources return nothing", async () => {
      mockBunSpawn(0, qmdWrapper([]));
      const mockPool = { query: async () => ({ rows: [] }) };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setupClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_all",
          arguments: { query: "nothing here" },
        });
        expect(result.isError).toBeFalsy();
        const parsed = parseResult(result);
        expect(parsed.total).toBe(0);
        expect(parsed.brain_hits).toBe(0);
        expect(parsed.qmd_hits).toBe(0);
        expect(parsed.results).toEqual([]);
      } finally {
        await cleanup();
      }
    });

    it("returns single table OB result correctly", async () => {
      mockBunSpawn(1, ""); // qmd fails gracefully
      const mockPool = {
        query: async () => ({
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
        }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setupClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_all",
          arguments: { query: "bun vs node" },
        });
        expect(result.isError).toBeFalsy();
        const parsed = parseResult(result);
        expect(parsed.brain_hits).toBe(1);
        expect(parsed.results[0].source).toBe("brain");
        expect(parsed.results[0].type).toBe("decision");
        expect(parsed.results[0].id).toBe("dec-1");
        expect(parsed.results[0].tags).toEqual(["runtime"]);
      } finally {
        await cleanup();
      }
    });
  });

  // -----------------------------------------------------------------------
  // MEDIUM
  // -----------------------------------------------------------------------
  describe("Medium -- merging and scoring", () => {
    it("merges OB and qmd results, sorted by score descending", async () => {
      // qmd returns one high-score result
      const qmdDocs = [
        { path: "/top.md", content: "top qmd hit", score: 0.95 },
      ];
      mockBunSpawn(0, qmdWrapper(qmdDocs));

      // OB returns two results: distance 0.1 => score 0.9, distance 0.3 => score 0.7
      const mockPool = {
        query: async () => ({
          rows: [
            {
              source_type: "thought",
              id: "t1",
              content_preview: "brain hit 1",
              distance: 0.1,
              tags: [],
              created_at: "2026-01-01",
              usefulness: 0.5,
            },
            {
              source_type: "thought",
              id: "t2",
              content_preview: "brain hit 2",
              distance: 0.3,
              tags: [],
              created_at: "2026-01-01",
              usefulness: 0.5,
            },
          ],
        }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setupClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_all",
          arguments: { query: "merge test", limit: 10 },
        });
        const parsed = parseResult(result);
        expect(parsed.total).toBe(3);
        expect(parsed.brain_hits).toBe(2);
        expect(parsed.qmd_hits).toBe(1);

        // Scores: qmd=0.95, brain1=0.9 (1-0.1), brain2=0.7 (1-0.3)
        expect(parsed.results[0].source).toBe("qmd");
        expect(parsed.results[0].score).toBe(0.95);
        expect(parsed.results[1].source).toBe("brain");
        expect(parsed.results[1].score).toBeCloseTo(0.9);
        expect(parsed.results[2].source).toBe("brain");
        expect(parsed.results[2].score).toBeCloseTo(0.7);
      } finally {
        await cleanup();
      }
    });

    it("normalizes OB distance to score via 1-distance inversion", async () => {
      mockBunSpawn(1, ""); // no qmd
      const mockPool = {
        query: async () => ({
          rows: [
            {
              source_type: "thought",
              id: "t1",
              content_preview: "close match",
              distance: 0.05,
              tags: [],
              created_at: "2026-01-01",
              usefulness: 0.5,
            },
            {
              source_type: "thought",
              id: "t2",
              content_preview: "far match",
              distance: 0.85,
              tags: [],
              created_at: "2026-01-01",
              usefulness: 0.5,
            },
          ],
        }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setupClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_all",
          arguments: { query: "distance check", sources: "brain" },
        });
        const parsed = parseResult(result);
        expect(parsed.results[0].score).toBeCloseTo(0.95); // 1 - 0.05
        expect(parsed.results[1].score).toBeCloseTo(0.15); // 1 - 0.85
      } finally {
        await cleanup();
      }
    });

    it("enforces limit by slicing merged results", async () => {
      // 3 from qmd + 3 from OB = 6 total, limit 4
      const qmdDocs = [
        { path: "/a.md", content: "a", score: 0.9 },
        { path: "/b.md", content: "b", score: 0.7 },
        { path: "/c.md", content: "c", score: 0.5 },
      ];
      mockBunSpawn(0, qmdWrapper(qmdDocs));
      const mockPool = {
        query: async () => ({ rows: makeMockRows(3) }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setupClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_all",
          arguments: { query: "limit test", limit: 4 },
        });
        const parsed = parseResult(result);
        expect(parsed.total).toBe(4);
        expect(parsed.results.length).toBe(4);
      } finally {
        await cleanup();
      }
    });

    it("sources='brain' skips embedding when sources='qmd'", async () => {
      // When sources=qmd, embedFn should NOT be called
      let embedCalled = false;
      const mockEmbed = async (_text: string) => {
        embedCalled = true;
        return Array(768).fill(0.1);
      };
      mockBunSpawn(
        0,
        qmdWrapper([{ path: "/x.md", content: "x", score: 0.5 }]),
      );
      const mockPool = { query: async () => ({ rows: [] }) };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setupClient(mockPool, mockEmbed, auth);

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

    it("multiple OB tables merged with distinct source_type labels", async () => {
      mockBunSpawn(1, ""); // no qmd
      const mockPool = {
        query: async () => ({
          rows: [
            {
              source_type: "thought",
              id: "t1",
              content_preview: "thought content",
              distance: 0.1,
              tags: [],
              created_at: "2026-01-01",
              usefulness: 0.5,
            },
            {
              source_type: "decision",
              id: "d1",
              content_preview: "decision content",
              distance: 0.2,
              tags: [],
              created_at: "2026-01-01",
              usefulness: 0.5,
            },
            {
              source_type: "session",
              id: "s1",
              content_preview: "session content",
              distance: 0.3,
              tags: [],
              created_at: "2026-01-01",
              usefulness: 0.5,
            },
          ],
        }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setupClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_all",
          arguments: { query: "multi table", sources: "brain" },
        });
        const parsed = parseResult(result);
        const types = parsed.results.map((r: any) => r.type);
        expect(types).toContain("thought");
        expect(types).toContain("decision");
        expect(types).toContain("session");
      } finally {
        await cleanup();
      }
    });
  });

  // -----------------------------------------------------------------------
  // LARGE
  // -----------------------------------------------------------------------
  describe("Large -- max limit, all 5 tables", () => {
    it("accepts max limit of 50", async () => {
      mockBunSpawn(1, "");
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setupClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_all",
          arguments: { query: "max limit", limit: 50 },
        });
        expect(result.isError).toBeFalsy();
        // Verify limit passed to SQL
        const [, params] = queryCalls[0];
        expect(params).toContain(50);
      } finally {
        await cleanup();
      }
    });

    it("merges results from all 5 OB tables and qmd, ranked by score", async () => {
      const qmdDocs = [
        { path: "/doc1.md", content: "qmd doc 1", score: 0.88 },
        { path: "/doc2.md", content: "qmd doc 2", score: 0.72 },
      ];
      mockBunSpawn(0, qmdWrapper(qmdDocs));

      const mockPool = {
        query: async () => ({ rows: makeMultiTableRows(1) }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setupClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_all",
          arguments: { query: "full merge", limit: 20 },
        });
        const parsed = parseResult(result);
        // 5 OB rows + 2 qmd rows = 7 total
        expect(parsed.brain_hits).toBe(5);
        expect(parsed.qmd_hits).toBe(2);
        expect(parsed.total).toBe(7);

        // Verify both sources present
        const sources = new Set(parsed.results.map((r: any) => r.source));
        expect(sources.has("brain")).toBe(true);
        expect(sources.has("qmd")).toBe(true);

        // Verify sorted descending by score
        for (let i = 1; i < parsed.results.length; i++) {
          expect(parsed.results[i - 1].score).toBeGreaterThanOrEqual(
            parsed.results[i].score,
          );
        }
      } finally {
        await cleanup();
      }
    });

    it("SQL includes CTEs for all 5 tables for admin role", async () => {
      mockBunSpawn(1, "");
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setupClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        await client.callTool({
          name: "search_all",
          arguments: { query: "all tables" },
        });
        const [sql] = queryCalls[0];
        expect(sql).toContain("thoughts_results");
        expect(sql).toContain("decisions_results");
        expect(sql).toContain("relationships_results");
        expect(sql).toContain("projects_results");
        expect(sql).toContain("sessions_results");
        expect(sql).toContain("UNION ALL");
      } finally {
        await cleanup();
      }
    });
  });

  // -----------------------------------------------------------------------
  // RAPID -- multiple sequential calls
  // -----------------------------------------------------------------------
  describe("Rapid -- sequential calls return independently", () => {
    it("three sequential calls each return their own results", async () => {
      let callIndex = 0;
      const mockPool = {
        query: async () => {
          callIndex++;
          return {
            rows: makeMockRows(callIndex, { source_type: `type-${callIndex}` }),
          };
        },
      };
      // qmd returns different things per invocation
      let spawnCount = 0;
      (Bun as any).spawn = () => {
        spawnCount++;
        const docs = [
          {
            path: `/rapid-${spawnCount}.md`,
            content: `rapid ${spawnCount}`,
            score: 0.5,
          },
        ];
        const stdout = qmdWrapper(docs);
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
              c.close();
            },
          }),
          exited: Promise.resolve(0),
        };
      };

      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setupClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const r1 = await client.callTool({
          name: "search_all",
          arguments: { query: "rapid 1" },
        });
        const r2 = await client.callTool({
          name: "search_all",
          arguments: { query: "rapid 2" },
        });
        const r3 = await client.callTool({
          name: "search_all",
          arguments: { query: "rapid 3" },
        });

        const p1 = parseResult(r1);
        const p2 = parseResult(r2);
        const p3 = parseResult(r3);

        // Each call got a different brain_hits count (1, 2, 3)
        expect(p1.brain_hits).toBe(1);
        expect(p2.brain_hits).toBe(2);
        expect(p3.brain_hits).toBe(3);

        // Each call got qmd results
        expect(p1.qmd_hits).toBe(1);
        expect(p2.qmd_hits).toBe(1);
        expect(p3.qmd_hits).toBe(1);
      } finally {
        await cleanup();
      }
    });
  });

  // -----------------------------------------------------------------------
  // EDGE CASES
  // -----------------------------------------------------------------------
  describe("Edge cases", () => {
    it("returns OB-only results when embedFn returns null (brain skipped)", async () => {
      // When embedding fails, brain search is skipped entirely
      const qmdDocs = [
        { path: "/fallback.md", content: "qmd only", score: 0.7 },
      ];
      mockBunSpawn(0, qmdWrapper(qmdDocs));

      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: makeMockRows(2) };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setupClient(
        mockPool,
        createMockEmbed(null),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_all",
          arguments: { query: "embed fail" },
        });
        expect(result.isError).toBeFalsy();
        const parsed = parseResult(result);
        // Brain search should be skipped (embedding is null)
        expect(parsed.brain_hits).toBe(0);
        expect(parsed.qmd_hits).toBe(1);
        // Pool should not have been queried for search
        expect(queryCalls.length).toBe(0);
      } finally {
        await cleanup();
      }
    });

    it("gracefully returns brain-only results when qmd spawn exits non-zero", async () => {
      mockBunSpawn(1, "", "qmd process crashed");
      const mockPool = {
        query: async () => ({ rows: makeMockRows(2) }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setupClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_all",
          arguments: { query: "qmd fail" },
        });
        expect(result.isError).toBeFalsy();
        const parsed = parseResult(result);
        expect(parsed.brain_hits).toBe(2);
        expect(parsed.qmd_hits).toBe(0);
      } finally {
        await cleanup();
      }
    });

    it("gracefully handles qmd returning malformed JSON", async () => {
      mockBunSpawn(0, "this is not json at all {{{");
      const mockPool = {
        query: async () => ({ rows: makeMockRows(1) }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setupClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_all",
          arguments: { query: "bad json" },
        });
        expect(result.isError).toBeFalsy();
        const parsed = parseResult(result);
        expect(parsed.brain_hits).toBe(1);
        expect(parsed.qmd_hits).toBe(0); // qmd parse failure => 0 results
      } finally {
        await cleanup();
      }
    });

    it("handles qmd returning valid wrapper but no text content", async () => {
      const emptyWrapper = JSON.stringify({
        success: true,
        result: { content: [] },
      });
      mockBunSpawn(0, emptyWrapper);
      const mockPool = {
        query: async () => ({ rows: makeMockRows(1) }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setupClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_all",
          arguments: { query: "empty qmd wrapper" },
        });
        expect(result.isError).toBeFalsy();
        const parsed = parseResult(result);
        expect(parsed.qmd_hits).toBe(0);
      } finally {
        await cleanup();
      }
    });

    it("handles qmd returning non-array docs inside text", async () => {
      const nonArrayWrapper = JSON.stringify({
        success: true,
        result: {
          content: [{ type: "text", text: '{"not":"an array"}' }],
        },
      });
      mockBunSpawn(0, nonArrayWrapper);
      const mockPool = {
        query: async () => ({ rows: makeMockRows(1) }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setupClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_all",
          arguments: { query: "non-array qmd" },
        });
        expect(result.isError).toBeFalsy();
        const parsed = parseResult(result);
        expect(parsed.qmd_hits).toBe(0);
      } finally {
        await cleanup();
      }
    });

    it("discord role gets no brain results (no readable tables) but still gets qmd", async () => {
      const qmdDocs = [{ path: "/pub.md", content: "public info", score: 0.6 }];
      mockBunSpawn(0, qmdWrapper(qmdDocs));

      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "discord", clientId: "discord-bot" };
      const { client, cleanup } = await setupClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_all",
          arguments: { query: "discord search" },
        });
        expect(result.isError).toBeFalsy();
        const parsed = parseResult(result);
        // discord has WO on thoughts, no read on anything
        expect(parsed.brain_hits).toBe(0);
        expect(parsed.qmd_hits).toBe(1);
        // pool should NOT have been queried (no accessible tables => skip)
        expect(queryCalls.length).toBe(0);
      } finally {
        await cleanup();
      }
    });

    it("content_preview is truncated to 300 chars for brain results", async () => {
      mockBunSpawn(1, "");
      const longContent = "x".repeat(500);
      const mockPool = {
        query: async () => ({
          rows: [
            {
              source_type: "thought",
              id: "long-1",
              content_preview: longContent,
              distance: 0.1,
              tags: [],
              created_at: "2026-01-01",
              usefulness: 0.5,
            },
          ],
        }),
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setupClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_all",
          arguments: { query: "long content", sources: "brain" },
        });
        const parsed = parseResult(result);
        expect(parsed.results[0].content.length).toBe(300);
      } finally {
        await cleanup();
      }
    });

    it("qmd doc content is truncated to 300 chars", async () => {
      const longContent = "y".repeat(500);
      const qmdDocs = [{ path: "/long.md", content: longContent, score: 0.5 }];
      mockBunSpawn(0, qmdWrapper(qmdDocs));
      const mockPool = { query: async () => ({ rows: [] }) };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setupClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_all",
          arguments: { query: "long qmd", sources: "qmd" },
        });
        const parsed = parseResult(result);
        expect(parsed.results[0].content.length).toBe(300);
      } finally {
        await cleanup();
      }
    });

    it("qmd doc uses 'text' field when 'content' is absent", async () => {
      const qmdDocs = [{ path: "/t.md", text: "from text field", score: 0.6 }];
      mockBunSpawn(0, qmdWrapper(qmdDocs));
      const mockPool = { query: async () => ({ rows: [] }) };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setupClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_all",
          arguments: { query: "text fallback", sources: "qmd" },
        });
        const parsed = parseResult(result);
        expect(parsed.results[0].content).toBe("from text field");
      } finally {
        await cleanup();
      }
    });

    it("qmd doc uses 'preview' field when content and text are absent", async () => {
      const qmdDocs = [{ path: "/p.md", preview: "from preview", score: 0.6 }];
      mockBunSpawn(0, qmdWrapper(qmdDocs));
      const mockPool = { query: async () => ({ rows: [] }) };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setupClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_all",
          arguments: { query: "preview fallback", sources: "qmd" },
        });
        const parsed = parseResult(result);
        expect(parsed.results[0].content).toBe("from preview");
      } finally {
        await cleanup();
      }
    });

    it("qmd doc uses 'similarity' field when 'score' is absent", async () => {
      const qmdDocs = [{ path: "/s.md", content: "sim", similarity: 0.77 }];
      mockBunSpawn(0, qmdWrapper(qmdDocs));
      const mockPool = { query: async () => ({ rows: [] }) };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setupClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_all",
          arguments: { query: "similarity field", sources: "qmd" },
        });
        const parsed = parseResult(result);
        expect(parsed.results[0].score).toBe(0.77);
      } finally {
        await cleanup();
      }
    });

    it("qmd doc defaults score to 0.5 when neither score nor similarity is present", async () => {
      const qmdDocs = [{ path: "/d.md", content: "no score" }];
      mockBunSpawn(0, qmdWrapper(qmdDocs));
      const mockPool = { query: async () => ({ rows: [] }) };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setupClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_all",
          arguments: { query: "default score", sources: "qmd" },
        });
        const parsed = parseResult(result);
        expect(parsed.results[0].score).toBe(0.5);
      } finally {
        await cleanup();
      }
    });

    it("qmd doc maps 'file' field to 'path' when 'path' is absent", async () => {
      const qmdDocs = [
        { file: "/via-file.md", content: "file field", score: 0.5 },
      ];
      mockBunSpawn(0, qmdWrapper(qmdDocs));
      const mockPool = { query: async () => ({ rows: [] }) };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setupClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_all",
          arguments: { query: "file field", sources: "qmd" },
        });
        const parsed = parseResult(result);
        expect(parsed.results[0].path).toBe("/via-file.md");
      } finally {
        await cleanup();
      }
    });

    it("fires usage tracking UPDATEs for brain results", async () => {
      mockBunSpawn(1, "");
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return {
            rows: [
              {
                source_type: "thought",
                id: "track-1",
                content_preview: "tracked",
                distance: 0.1,
                tags: [],
                created_at: "2026-01-01",
                usefulness: 0.5,
              },
              {
                source_type: "decision",
                id: "track-2",
                content_preview: "also tracked",
                distance: 0.2,
                tags: [],
                created_at: "2026-01-01",
                usefulness: 0.5,
              },
            ],
          };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setupClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        await client.callTool({
          name: "search_all",
          arguments: { query: "tracking test", sources: "brain" },
        });

        // Wait for fire-and-forget tracking
        await new Promise((r) => setTimeout(r, 50));

        // First call is the search SELECT, rest are tracking UPDATEs
        expect(queryCalls.length).toBeGreaterThan(1);
        const trackingCalls = queryCalls.slice(1);
        for (const call of trackingCalls) {
          expect(call[0]).toContain("access_count");
          expect(call[0]).toContain("last_accessed_at");
        }
      } finally {
        await cleanup();
      }
    });

    it("default limit is 10 when not specified", async () => {
      mockBunSpawn(1, "");
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: [] };
        },
      };
      const auth: AuthInfo = { role: "admin", clientId: "admin" };
      const { client, cleanup } = await setupClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        await client.callTool({
          name: "search_all",
          arguments: { query: "default limit" },
        });
        const [, params] = queryCalls[0];
        expect(params).toContain(10);
      } finally {
        await cleanup();
      }
    });

    it("readonly role can search brain (has read on all tables)", async () => {
      mockBunSpawn(1, "");
      const queryCalls: any[] = [];
      const mockPool = {
        query: async (...args: any[]) => {
          queryCalls.push(args);
          return { rows: makeMockRows(1) };
        },
      };
      const auth: AuthInfo = { role: "readonly", clientId: "ro" };
      const { client, cleanup } = await setupClient(
        mockPool,
        createMockEmbed(),
        auth,
      );

      try {
        const result = await client.callTool({
          name: "search_all",
          arguments: { query: "readonly search", sources: "brain" },
        });
        expect(result.isError).toBeFalsy();
        const parsed = parseResult(result);
        expect(parsed.brain_hits).toBe(1);
        // Verify all 5 table CTEs in SQL
        const [sql] = queryCalls[0];
        expect(sql).toContain("thoughts_results");
        expect(sql).toContain("decisions_results");
        expect(sql).toContain("relationships_results");
        expect(sql).toContain("projects_results");
        expect(sql).toContain("sessions_results");
      } finally {
        await cleanup();
      }
    });
  });
});
