/**
 * #268: graph-expanded evidence at the consumer surfaces.
 *
 * brain_answer and search_all inherit search_brain's relational graph arm
 * (#267/PR #274) instead of running their own traversal. These tests prove,
 * at the consumer surface, that graph-hydrated rows are cited with normal
 * Open Brain source refs, that the auth-derived namespace predicate reaches
 * the graph SQL, that unreadable and archived targets never surface, that
 * brain_answer still reports gaps instead of fabricating from edges, and
 * that search_all's qmd federation stays decoupled and fail-open.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { registerBrainAnswer } from "../brain-answer.ts";
import { registerSearchAll } from "../search-all.ts";
import type { AuthInfo } from "../../types.ts";
import {
  createMockEmbed,
  parseToolResult,
  getErrorText,
  setupMcpClient,
} from "./test-helpers.ts";

// ---------------------------------------------------------------------------
// Fixture: two namespaces, one archived seed, one archived link
// ---------------------------------------------------------------------------

type SourceType = "thought" | "decision";

type FixtureEntry = {
  id: string;
  source_type: SourceType;
  namespace: string;
  text: string;
  created_at: string;
  archived_at?: string | null;
};

type FixtureEntity = {
  id: string;
  namespace: string;
  name: string;
  archived_at?: string | null;
};

type FixtureLink = {
  namespace: string;
  from_type: SourceType;
  from_id: string;
  to_entity: string;
  relation: string;
  archived_at?: string | null;
};

const READER_NS = "agent-a";
const PRIVATE_NS = "agent-b";

const entries: FixtureEntry[] = [
  {
    id: "graph-target",
    source_type: "thought",
    namespace: READER_NS,
    text: "Deploy gate depends on the schema freeze decision.",
    created_at: "2026-06-01T00:00:00Z",
  },
  {
    id: "stale-target",
    source_type: "decision",
    namespace: READER_NS,
    text: "Legacy pipeline decision predates the current rollout policy.",
    created_at: "2020-01-01T00:00:00Z",
  },
  {
    id: "private-target",
    source_type: "thought",
    namespace: PRIVATE_NS,
    text: "Private namespace target must never surface for agent-a.",
    created_at: "2026-06-01T00:00:00Z",
  },
  {
    id: "archived-link-target",
    source_type: "thought",
    namespace: READER_NS,
    text: "Archived link target must not hydrate.",
    created_at: "2026-06-01T00:00:00Z",
  },
  {
    id: "archived-entity-target",
    source_type: "thought",
    namespace: READER_NS,
    text: "Archived entity target must not hydrate.",
    created_at: "2026-06-01T00:00:00Z",
  },
];

const entities: FixtureEntity[] = [
  { id: "entity-alpha", namespace: READER_NS, name: "Alpha" },
  { id: "entity-legacy", namespace: READER_NS, name: "Legacy" },
  { id: "entity-private", namespace: PRIVATE_NS, name: "Private" },
  {
    id: "entity-archived",
    namespace: READER_NS,
    name: "Archived",
    archived_at: "2026-07-01T00:00:00Z",
  },
];

const links: FixtureLink[] = [
  {
    namespace: READER_NS,
    from_type: "thought",
    from_id: "graph-target",
    to_entity: "entity-alpha",
    relation: "depends_on",
  },
  {
    namespace: READER_NS,
    from_type: "decision",
    from_id: "stale-target",
    to_entity: "entity-legacy",
    relation: "depends_on",
  },
  {
    namespace: PRIVATE_NS,
    from_type: "thought",
    from_id: "private-target",
    to_entity: "entity-private",
    relation: "mentions",
  },
  {
    namespace: READER_NS,
    from_type: "thought",
    from_id: "archived-link-target",
    to_entity: "entity-alpha",
    relation: "mentions",
    archived_at: "2026-07-01T00:00:00Z",
  },
  {
    namespace: READER_NS,
    from_type: "thought",
    from_id: "archived-entity-target",
    to_entity: "entity-archived",
    relation: "mentions",
  },
];

function namespaceList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return typeof value === "string" ? [value] : undefined;
}

function graphEntriesFor(
  seedName: string,
  relation: string,
  readableNamespaces: string[] | undefined,
): FixtureEntry[] {
  const readable = (namespace: string) =>
    readableNamespaces === undefined || readableNamespaces.includes(namespace);
  const seed = entities.find(
    (entity) =>
      !entity.archived_at &&
      readable(entity.namespace) &&
      entity.name.toLowerCase() === seedName.toLowerCase(),
  );
  if (!seed) return [];
  const linkedIds = links
    .filter(
      (link) =>
        !link.archived_at &&
        link.namespace === seed.namespace &&
        link.relation === relation &&
        link.to_entity === seed.id,
    )
    .map((link) => `${link.from_type}:${link.from_id}`);
  return entries.filter(
    (entry) =>
      !entry.archived_at &&
      entry.namespace === seed.namespace &&
      linkedIds.includes(`${entry.source_type}:${entry.id}`),
  );
}

function searchRow(entry: FixtureEntry) {
  return {
    source_type: entry.source_type,
    id: entry.id,
    namespace: entry.namespace,
    content_preview: entry.text,
    tags: [],
    created_by: "test",
    created_at: entry.created_at,
    updated_at: entry.created_at,
    tier: "warm",
    usefulness: 0.5,
    access_count: 0,
    fts_rank: 1,
    distance: null,
  };
}

type GraphPoolStats = {
  graphCalls: number;
  graphNamespaceParams: unknown[];
  writeQueries: string[];
  totalQueries: number;
};

function graphAwarePool(): { pool: { query: (...args: any[]) => Promise<{ rows: any[] }> }; stats: GraphPoolStats } {
  const stats: GraphPoolStats = {
    graphCalls: 0,
    graphNamespaceParams: [],
    writeQueries: [],
    totalQueries: 0,
  };
  const pool = {
    query: async (...args: any[]) => {
      const [sql, params = []] = args;
      const text = String(sql);
      stats.totalQueries += 1;
      if (/^\s*(UPDATE|INSERT)/i.test(text)) {
        stats.writeQueries.push(text);
        return { rows: [] };
      }
      if (text.includes("relational_graph_seed")) {
        stats.graphCalls += 1;
        stats.graphNamespaceParams.push(params[3]);
        return {
          rows: graphEntriesFor(
            String(params[0] ?? ""),
            String(params[1] ?? ""),
            namespaceList(params[3]),
          ).map(searchRow),
        };
      }
      // vector, fts, and explicit-link lookups return nothing so every hit
      // below is attributable to the graph arm alone.
      return { rows: [] };
    },
  };
  return { pool, stats };
}

const readerAuth: AuthInfo = { role: "agent", clientId: READER_NS };

// ---------------------------------------------------------------------------
// qmd spawn mocking (same convention as search-all.test.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// brain_answer
// ---------------------------------------------------------------------------

describe("brain_answer graph-expanded evidence (#268)", () => {
  it("cites graph-expanded evidence with normal Open Brain source refs", async () => {
    const { pool, stats } = graphAwarePool();
    const { client, cleanup } = await setupMcpClient(
      registerBrainAnswer,
      pool,
      createMockEmbed(),
      readerAuth,
    );
    try {
      const result = await client.callTool({
        name: "brain_answer",
        arguments: { query: "What depends on Alpha?", namespace: READER_NS },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseToolResult(result);
      expect(parsed.evidence_count).toBe(1);
      expect(parsed.answer).toContain("[1]");
      expect(parsed.answer).toContain("schema freeze decision");
      expect(parsed.citations).toHaveLength(1);
      expect(parsed.citations[0].source_ref).toMatchObject({
        source: "brain",
        type: "thought",
        id: "graph-target",
        namespace: READER_NS,
      });
      expect(parsed.citations[0].excerpt).toContain("Deploy gate depends on");
      expect(stats.graphCalls).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("does not expose link-path metadata in citations", async () => {
    const { pool } = graphAwarePool();
    const { client, cleanup } = await setupMcpClient(
      registerBrainAnswer,
      pool,
      createMockEmbed(),
      readerAuth,
    );
    try {
      const parsed = parseToolResult(
        await client.callTool({
          name: "brain_answer",
          arguments: { query: "What depends on Alpha?", namespace: READER_NS },
        }),
      );
      expect(Object.keys(parsed.citations[0]).sort()).toEqual([
        "excerpt",
        "index",
        "score",
        "source_ref",
        "stale",
      ]);
      const serialized = JSON.stringify(parsed);
      expect(serialized).not.toContain("explicit_links");
      expect(serialized).not.toContain("entity-alpha");
    } finally {
      await cleanup();
    }
  });

  it("reports a gap instead of fabricating when the graph arm finds nothing", async () => {
    const { pool, stats } = graphAwarePool();
    const { client, cleanup } = await setupMcpClient(
      registerBrainAnswer,
      pool,
      createMockEmbed(),
      readerAuth,
    );
    try {
      const parsed = parseToolResult(
        await client.callTool({
          name: "brain_answer",
          arguments: { query: "What depends on Ghost?", namespace: READER_NS },
        }),
      );
      expect(parsed.answer).toBeNull();
      expect(parsed.citations).toEqual([]);
      expect(parsed.known_gaps[0]).toContain("No readable Open Brain evidence");
      expect(stats.graphCalls).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("flags stale graph-cited evidence instead of hiding age", async () => {
    const { pool } = graphAwarePool();
    const { client, cleanup } = await setupMcpClient(
      registerBrainAnswer,
      pool,
      createMockEmbed(),
      readerAuth,
    );
    try {
      const parsed = parseToolResult(
        await client.callTool({
          name: "brain_answer",
          arguments: {
            query: "What depends on Legacy?",
            namespace: READER_NS,
            max_age_days: 30,
          },
        }),
      );
      expect(parsed.citations).toHaveLength(1);
      expect(parsed.citations[0].source_ref.id).toBe("stale-target");
      expect(parsed.citations[0].stale).toBe(true);
      expect(parsed.uncertainty.join(" ")).toContain("older than 30 days");
    } finally {
      await cleanup();
    }
  });

  it("denies unreadable namespace filters before any graph retrieval", async () => {
    const { pool, stats } = graphAwarePool();
    const { client, cleanup } = await setupMcpClient(
      registerBrainAnswer,
      pool,
      createMockEmbed(),
      readerAuth,
    );
    try {
      const result = await client.callTool({
        name: "brain_answer",
        arguments: { query: "What mentions Private?", namespace: PRIVATE_NS },
      });
      expect(result.isError).toBe(true);
      expect(getErrorText(result)).toContain("namespace read access denied");
      expect(stats.graphCalls).toBe(0);
      expect(stats.totalQueries).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("passes the auth-derived namespace predicate into the graph SQL and hydrates nothing unreadable", async () => {
    const { pool, stats } = graphAwarePool();
    const { client, cleanup } = await setupMcpClient(
      registerBrainAnswer,
      pool,
      createMockEmbed(),
      readerAuth,
    );
    try {
      const parsed = parseToolResult(
        await client.callTool({
          name: "brain_answer",
          arguments: { query: "What mentions Private?" },
        }),
      );
      expect(stats.graphCalls).toBe(1);
      const namespaces = namespaceList(stats.graphNamespaceParams[0]);
      expect(namespaces).toBeDefined();
      expect(namespaces).toContain(READER_NS);
      expect(namespaces).not.toContain(PRIVATE_NS);
      expect(parsed.answer).toBeNull();
      expect(parsed.citations).toEqual([]);
      expect(JSON.stringify(parsed)).not.toContain("private-target");
    } finally {
      await cleanup();
    }
  });

  it("excludes archived links and archived entities from graph-cited evidence", async () => {
    const { pool, stats } = graphAwarePool();
    const { client, cleanup } = await setupMcpClient(
      registerBrainAnswer,
      pool,
      createMockEmbed(),
      readerAuth,
    );
    try {
      const viaArchivedLink = parseToolResult(
        await client.callTool({
          name: "brain_answer",
          arguments: { query: "What mentions Alpha?", namespace: READER_NS },
        }),
      );
      expect(viaArchivedLink.citations).toEqual([]);
      expect(JSON.stringify(viaArchivedLink)).not.toContain(
        "archived-link-target",
      );

      const viaArchivedEntity = parseToolResult(
        await client.callTool({
          name: "brain_answer",
          arguments: { query: "What mentions Archived?", namespace: READER_NS },
        }),
      );
      expect(viaArchivedEntity.citations).toEqual([]);
      expect(JSON.stringify(viaArchivedEntity)).not.toContain(
        "archived-entity-target",
      );
      expect(stats.graphCalls).toBe(2);
    } finally {
      await cleanup();
    }
  });

  it("performs no tracking writes when graph evidence is cited", async () => {
    const { pool, stats } = graphAwarePool();
    const { client, cleanup } = await setupMcpClient(
      registerBrainAnswer,
      pool,
      createMockEmbed(),
      readerAuth,
    );
    try {
      const result = await client.callTool({
        name: "brain_answer",
        arguments: { query: "What depends on Alpha?", namespace: READER_NS },
      });
      expect(result.isError).toBeFalsy();
      await new Promise((r) => setTimeout(r, 20));
      expect(stats.writeQueries).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// search_all
// ---------------------------------------------------------------------------

describe("search_all graph-expanded evidence (#268)", () => {
  afterEach(restoreBunSpawn);

  it("surfaces graph-expanded brain evidence with normal source refs", async () => {
    mockBunSpawn(1, "");
    const { pool, stats } = graphAwarePool();
    const { client, cleanup } = await setupMcpClient(
      registerSearchAll,
      pool,
      createMockEmbed(),
      readerAuth,
    );
    try {
      const result = await client.callTool({
        name: "search_all",
        arguments: {
          query: "What depends on Alpha?",
          namespace: READER_NS,
          sources: "brain",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseToolResult(result);
      expect(parsed.brain_hits).toBe(1);
      expect(parsed.results[0].source).toBe("brain");
      expect(parsed.results[0].type).toBe("thought");
      expect(parsed.results[0].id).toBe("graph-target");
      expect(parsed.results[0].source_ref).toMatchObject({
        source: "brain",
        type: "thought",
        id: "graph-target",
        namespace: READER_NS,
      });
      expect(stats.graphCalls).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("stays stable and keeps graph evidence when qmd is unavailable", async () => {
    mockBunSpawn(1, "", "qmd crashed");
    const { pool, stats } = graphAwarePool();
    const { client, cleanup } = await setupMcpClient(
      registerSearchAll,
      pool,
      createMockEmbed(),
      readerAuth,
    );
    try {
      const result = await client.callTool({
        name: "search_all",
        arguments: {
          query: "What depends on Alpha?",
          namespace: READER_NS,
          sources: "all",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseToolResult(result);
      expect(parsed.brain_hits).toBe(1);
      expect(parsed.qmd_hits).toBe(0);
      expect(parsed.results[0].id).toBe("graph-target");
      expect(stats.graphCalls).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("keeps qmd federation decoupled from graph retrieval", async () => {
    mockBunSpawn(
      0,
      JSON.stringify([{ path: "/doc.md", content: "qmd hit", score: 0.9 }]),
    );
    const { pool, stats } = graphAwarePool();
    const { client, cleanup } = await setupMcpClient(
      registerSearchAll,
      pool,
      createMockEmbed(),
      readerAuth,
    );
    try {
      const parsed = parseToolResult(
        await client.callTool({
          name: "search_all",
          arguments: { query: "What depends on Alpha?", sources: "qmd" },
        }),
      );
      expect(parsed.qmd_hits).toBe(1);
      expect(parsed.brain_hits).toBe(0);
      expect(stats.graphCalls).toBe(0);
      expect(stats.totalQueries).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("denies unreadable namespace filters before any graph retrieval", async () => {
    mockBunSpawn(1, "");
    const { pool, stats } = graphAwarePool();
    const { client, cleanup } = await setupMcpClient(
      registerSearchAll,
      pool,
      createMockEmbed(),
      readerAuth,
    );
    try {
      const result = await client.callTool({
        name: "search_all",
        arguments: { query: "What mentions Private?", namespace: PRIVATE_NS },
      });
      expect(result.isError).toBe(true);
      expect(getErrorText(result)).toContain("namespace read access denied");
      expect(stats.graphCalls).toBe(0);
      expect(stats.totalQueries).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("passes the auth-derived namespace predicate into the graph SQL and leaks nothing unreadable", async () => {
    mockBunSpawn(1, "");
    const { pool, stats } = graphAwarePool();
    const { client, cleanup } = await setupMcpClient(
      registerSearchAll,
      pool,
      createMockEmbed(),
      readerAuth,
    );
    try {
      const parsed = parseToolResult(
        await client.callTool({
          name: "search_all",
          arguments: { query: "What mentions Private?", sources: "brain" },
        }),
      );
      expect(stats.graphCalls).toBe(1);
      const namespaces = namespaceList(stats.graphNamespaceParams[0]);
      expect(namespaces).toBeDefined();
      expect(namespaces).toContain(READER_NS);
      expect(namespaces).not.toContain(PRIVATE_NS);
      expect(parsed.brain_hits).toBe(0);
      expect(JSON.stringify(parsed)).not.toContain("private-target");
    } finally {
      await cleanup();
    }
  });

  it("excludes archived links and archived entities from graph results", async () => {
    mockBunSpawn(1, "");
    const { pool, stats } = graphAwarePool();
    const { client, cleanup } = await setupMcpClient(
      registerSearchAll,
      pool,
      createMockEmbed(),
      readerAuth,
    );
    try {
      const viaArchivedLink = parseToolResult(
        await client.callTool({
          name: "search_all",
          arguments: {
            query: "What mentions Alpha?",
            namespace: READER_NS,
            sources: "brain",
          },
        }),
      );
      expect(viaArchivedLink.brain_hits).toBe(0);
      expect(JSON.stringify(viaArchivedLink)).not.toContain(
        "archived-link-target",
      );

      const viaArchivedEntity = parseToolResult(
        await client.callTool({
          name: "search_all",
          arguments: {
            query: "What mentions Archived?",
            namespace: READER_NS,
            sources: "brain",
          },
        }),
      );
      expect(viaArchivedEntity.brain_hits).toBe(0);
      expect(JSON.stringify(viaArchivedEntity)).not.toContain(
        "archived-entity-target",
      );
      expect(stats.graphCalls).toBe(2);
    } finally {
      await cleanup();
    }
  });

  it("does not run graph SQL when source_scope is set", async () => {
    mockBunSpawn(1, "");
    const { pool, stats } = graphAwarePool();
    const { client, cleanup } = await setupMcpClient(
      registerSearchAll,
      pool,
      createMockEmbed(),
      { role: "admin", clientId: "admin" },
    );
    try {
      const result = await client.callTool({
        name: "search_all",
        arguments: {
          query: "What depends on Alpha?",
          sources: "brain",
          source_scope: { client_id: "acme" },
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseToolResult(result);
      expect(parsed.brain_hits).toBe(0);
      expect(stats.graphCalls).toBe(0);
    } finally {
      await cleanup();
    }
  });
});
