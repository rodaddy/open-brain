import { afterAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import {
  ALL_TABLES,
  executeSearchWithScopedSharedFallback,
  registerSearchBrain,
} from "../search-brain.ts";
import { LINK_RELATIONS } from "../table-constants.ts";
import type { AuthInfo } from "../../types.ts";
import {
  createMockEmbed,
  parseToolResult,
  setupMcpClient,
} from "./test-helpers.ts";

type SourceType = "thought" | "decision" | "session" | "project";

type FixtureEntry = {
  id: string;
  source_type: SourceType;
  namespace: string;
  text: string;
  archived_at?: string | null;
};

type FixtureEntity = {
  id: string;
  namespace: string;
  name: string;
  entity_type: string;
  archived_at?: string | null;
};

type FixtureLink = {
  id: string;
  namespace: string;
  from_type: "entity" | SourceType;
  from_id: string;
  to_type: "entity" | SourceType;
  to_id: string;
  relation: string;
  archived_at?: string | null;
};

type RelationalQuestion = {
  id: string;
  question: string;
  namespace: string;
  seed: string;
  relation: string;
  direction: "incoming" | "outgoing";
  expected_id: string;
  expected_type: SourceType;
};

const entries: FixtureEntry[] = [
  {
    id: "thought-deploy-readiness",
    source_type: "thought",
    namespace: "shared-kb",
    text: "Readiness packet confirms the release train passed local checks.",
  },
  {
    id: "decision-schema-v11",
    source_type: "decision",
    namespace: "shared-kb",
    text: "Schema v11 remains the selected contract after downstream review.",
  },
  {
    id: "session-worker-handoff",
    source_type: "session",
    namespace: "shared-kb",
    text: "Worker handoff captured exact validation evidence for the canary.",
  },
  {
    id: "project-promoter-cleanup",
    source_type: "project",
    namespace: "shared-kb",
    text: "Promoter cleanup project owns stale collab migration follow-through.",
  },
  {
    id: "thought-auth-boundary",
    source_type: "thought",
    namespace: "shared-kb",
    text: "Auth boundary note names server-side namespace predicates as mandatory.",
  },
  {
    id: "decision-qmd-fallback",
    source_type: "decision",
    namespace: "shared-kb",
    text: "QMD fallback stays separate from Open Brain graph evidence.",
  },
  {
    id: "session-review-gauntlet",
    source_type: "session",
    namespace: "shared-kb",
    text: "Review gauntlet receipt lists SME and antagonist verification lanes.",
  },
  {
    id: "thought-hot-memory-defer",
    source_type: "thought",
    namespace: "shared-kb",
    text: "Hot memory prompt placement is deferred until exact-scope tests exist.",
  },
  {
    id: "decision-nats-gate",
    source_type: "decision",
    namespace: "shared-kb",
    text: "NATS rollout gate remains outside the graph retrieval sprint.",
  },
  {
    id: "session-archive-safety",
    source_type: "session",
    namespace: "shared-kb",
    text: "Archive safety session excludes soft-deleted graph nodes from answers.",
  },
  {
    id: "thought-db-owner",
    source_type: "thought",
    namespace: "shared-kb",
    text: "Database owner repair requires backup proof before migration retry.",
  },
  {
    id: "project-docs-site",
    source_type: "project",
    namespace: "shared-kb",
    text: "Docs site project keeps source HTML in specs and published HTML in collab sites.",
  },
  {
    id: "decision-python-floor",
    source_type: "decision",
    namespace: "shared-kb",
    text: "Python package floor moves to 3.13 for fleet bus compatibility.",
  },
  {
    id: "thought-redaction-superset",
    source_type: "thought",
    namespace: "shared-kb",
    text: "Redaction superset adds bare token and high entropy detectors.",
  },
  {
    id: "session-canary-proof",
    source_type: "session",
    namespace: "shared-kb",
    text: "Canary proof records contract version, tool list, and hosted health.",
  },
  {
    id: "decision-shared-kb",
    source_type: "decision",
    namespace: "shared-kb",
    text: "Shared knowledge canonical namespace remains shared-kb.",
  },
  {
    id: "thought-mcp-cache",
    source_type: "thought",
    namespace: "shared-kb",
    text: "MCP schema cache refresh is required after contract deployment.",
  },
  {
    id: "project-dreamengine",
    source_type: "project",
    namespace: "shared-kb",
    text: "DreamEngine decomposition tracks oversized entries for later splitting.",
  },
  {
    id: "session-agent-context",
    source_type: "session",
    namespace: "shared-kb",
    text: "Agent context contract preserves citations and unpromoted working state.",
  },
  {
    id: "thought-rollback-note",
    source_type: "thought",
    namespace: "shared-kb",
    text: "Rollback note names runtime previous path and launchd restart boundary.",
  },
  {
    id: "private-leak-target",
    source_type: "thought",
    namespace: "private-agent",
    text: "Private agent target must never hydrate through shared-kb graph search.",
  },
  {
    id: "archived-link-target",
    source_type: "thought",
    namespace: "shared-kb",
    text: "Archived link target should be invisible to relational traversal.",
  },
  {
    id: "archived-entity-target",
    source_type: "thought",
    namespace: "shared-kb",
    text: "Archived entity target should be invisible to relational traversal.",
  },
];

const entities: FixtureEntity[] = [
  { id: "entity-alpha", namespace: "shared-kb", entity_type: "issue", name: "Alpha" },
  { id: "entity-bravo", namespace: "shared-kb", entity_type: "issue", name: "Bravo" },
  { id: "entity-charlie", namespace: "shared-kb", entity_type: "issue", name: "Charlie" },
  { id: "entity-delta", namespace: "shared-kb", entity_type: "issue", name: "Delta" },
  { id: "entity-echo", namespace: "shared-kb", entity_type: "issue", name: "Echo" },
  { id: "entity-foxtrot", namespace: "shared-kb", entity_type: "issue", name: "Foxtrot" },
  { id: "entity-golf", namespace: "shared-kb", entity_type: "issue", name: "Golf" },
  { id: "entity-hotel", namespace: "shared-kb", entity_type: "issue", name: "Hotel" },
  { id: "entity-india", namespace: "shared-kb", entity_type: "issue", name: "India" },
  { id: "entity-juliet", namespace: "shared-kb", entity_type: "issue", name: "Juliet" },
  { id: "entity-kilo", namespace: "shared-kb", entity_type: "issue", name: "Kilo" },
  { id: "entity-lima", namespace: "shared-kb", entity_type: "issue", name: "Lima" },
  { id: "entity-mike", namespace: "shared-kb", entity_type: "issue", name: "Mike" },
  { id: "entity-november", namespace: "shared-kb", entity_type: "issue", name: "November" },
  { id: "entity-oscar", namespace: "shared-kb", entity_type: "issue", name: "Oscar" },
  { id: "entity-papa", namespace: "shared-kb", entity_type: "issue", name: "Papa" },
  { id: "entity-quebec", namespace: "shared-kb", entity_type: "issue", name: "Quebec" },
  { id: "entity-romeo", namespace: "shared-kb", entity_type: "issue", name: "Romeo" },
  { id: "entity-sierra", namespace: "shared-kb", entity_type: "issue", name: "Sierra" },
  { id: "entity-tango", namespace: "shared-kb", entity_type: "issue", name: "Tango" },
  { id: "entity-private", namespace: "private-agent", entity_type: "issue", name: "Private" },
  {
    id: "entity-archived",
    namespace: "shared-kb",
    entity_type: "issue",
    name: "Archived",
    archived_at: "2026-07-01T00:00:00Z",
  },
];

const relationalQuestionRows = [
  ["q01", "What depends on Alpha?", "Alpha", "depends_on", "thought-deploy-readiness", "thought"],
  ["q02", "What is blocked by Bravo?", "Bravo", "blocked_by", "decision-schema-v11", "decision"],
  ["q03", "What was implemented by Charlie?", "Charlie", "implemented_by", "session-worker-handoff", "session"],
  ["q04", "What was decided by Delta?", "Delta", "decided_by", "project-promoter-cleanup", "project"],
  ["q05", "What supersedes Echo?", "Echo", "supersedes", "thought-auth-boundary", "thought"],
  ["q06", "What duplicates Foxtrot?", "Foxtrot", "duplicates", "decision-qmd-fallback", "decision"],
  ["q07", "What contradicts Golf?", "Golf", "contradicts", "session-review-gauntlet", "session"],
  ["q08", "What mentions Hotel?", "Hotel", "mentions", "thought-hot-memory-defer", "thought"],
  ["q09", "What relates to India?", "India", "relates_to", "decision-nats-gate", "decision"],
  ["q10", "What depends on Juliet?", "Juliet", "depends_on", "session-archive-safety", "session"],
  ["q11", "What is blocked by Kilo?", "Kilo", "blocked_by", "thought-db-owner", "thought"],
  ["q12", "What was implemented by Lima?", "Lima", "implemented_by", "project-docs-site", "project"],
  ["q13", "What was decided by Mike?", "Mike", "decided_by", "decision-python-floor", "decision"],
  ["q14", "What supersedes November?", "November", "supersedes", "thought-redaction-superset", "thought"],
  ["q15", "What duplicates Oscar?", "Oscar", "duplicates", "session-canary-proof", "session"],
  ["q16", "What contradicts Papa?", "Papa", "contradicts", "decision-shared-kb", "decision"],
  ["q17", "What mentions Quebec?", "Quebec", "mentions", "thought-mcp-cache", "thought"],
  ["q18", "What relates to Romeo?", "Romeo", "relates_to", "project-dreamengine", "project"],
  ["q19", "What depends on Sierra?", "Sierra", "depends_on", "session-agent-context", "session"],
  ["q20", "What is blocked by Tango?", "Tango", "blocked_by", "thought-rollback-note", "thought"],
] satisfies Array<[string, string, string, string, string, SourceType]>;

const relationalQuestions: RelationalQuestion[] = relationalQuestionRows.map(
  ([id, question, seed, relation, expected_id, expected_type]) => ({
    id,
    question,
    namespace: "shared-kb",
    seed,
    relation,
    direction: "incoming",
    expected_id,
    expected_type,
  }),
);

const links: FixtureLink[] = [
  ...relationalQuestions.map((question, index) => ({
    id: `link-${index + 1}`,
    namespace: question.namespace,
    from_type: question.expected_type,
    from_id: question.expected_id,
    to_type: "entity" as const,
    to_id: `entity-${question.seed.toLowerCase()}`,
    relation: question.relation,
  })),
  {
    id: "link-outgoing-alpha",
    namespace: "shared-kb",
    from_type: "entity",
    from_id: "entity-alpha",
    to_type: "decision",
    to_id: "decision-qmd-fallback",
    relation: "depends_on",
  },
  {
    id: "link-private-leak",
    namespace: "private-agent",
    from_type: "thought",
    from_id: "private-leak-target",
    to_type: "entity",
    to_id: "entity-private",
    relation: "mentions",
  },
  {
    id: "link-archived-link",
    namespace: "shared-kb",
    from_type: "thought",
    from_id: "archived-link-target",
    to_type: "entity",
    to_id: "entity-alpha",
    relation: "mentions",
    archived_at: "2026-07-01T00:00:00Z",
  },
  {
    id: "link-archived-entity",
    namespace: "shared-kb",
    from_type: "thought",
    from_id: "archived-entity-target",
    to_type: "entity",
    to_id: "entity-archived",
    relation: "mentions",
  },
];

const INCOMING_RELATION_PATTERN =
  /what\s+(?:is\s+)?(?:was\s+)?(?<relation>depends on|blocked by|implemented by|decided by|supersedes|duplicates|contradicts|mentions|relates to)\s+(?<seed>[^?]{1,160})\??$/i;
const OUTGOING_DEPENDS_PATTERN =
  /what\s+does\s+(?<seed>[^?]{1,160})\s+depend\s+on\??$/i;
const OUTGOING_BLOCKED_PATTERN =
  /what\s+(?:is\s+)?(?<seed>[^?]{1,160})\s+blocked\s+by\??$/i;

const relationAliases: Record<string, string> = {
  "depends on": "depends_on",
  "blocked by": "blocked_by",
  "implemented by": "implemented_by",
  "decided by": "decided_by",
  supersedes: "supersedes",
  duplicates: "duplicates",
  contradicts: "contradicts",
  mentions: "mentions",
  "relates to": "relates_to",
};

type ParsedFixtureQuery = {
  relation: string;
  seed: string;
  direction: "incoming" | "outgoing";
};

function parseFixtureQuery(query: string): ParsedFixtureQuery | undefined {
  const outgoingDepends = OUTGOING_DEPENDS_PATTERN.exec(query)?.groups;
  if (outgoingDepends?.seed) {
    return {
      relation: "depends_on",
      seed: outgoingDepends.seed,
      direction: "outgoing",
    };
  }

  const outgoingBlocked = OUTGOING_BLOCKED_PATTERN.exec(query)?.groups;
  if (outgoingBlocked?.seed) {
    return {
      relation: "blocked_by",
      seed: outgoingBlocked.seed,
      direction: "outgoing",
    };
  }

  const incoming = INCOMING_RELATION_PATTERN.exec(query)?.groups;
  if (!incoming?.relation || !incoming.seed) return undefined;
  const relation = relationAliases[incoming.relation.toLowerCase()];
  if (!relation) return undefined;
  return { relation, seed: incoming.seed, direction: "incoming" };
}

const BASELINE_STOPWORDS = new Set([
  "what",
  "is",
  "was",
  "by",
  "on",
  "to",
  "depends",
  "blocked",
  "implemented",
  "decided",
  "supersedes",
  "duplicates",
  "contradicts",
  "mentions",
  "relates",
]);

function keywordBaseline(query: string, readableNamespaces = ["shared-kb"]): FixtureEntry[] {
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((term) => term.length > 2 && !BASELINE_STOPWORDS.has(term));
  return entries.filter(
    (entry) =>
      !entry.archived_at &&
      readableNamespaces.includes(entry.namespace) &&
      terms.some((term) => entry.text.toLowerCase().includes(term)),
  );
}

function graphOracle(query: string, readableNamespaces = ["shared-kb"]): FixtureEntry[] {
  const parsed = parseFixtureQuery(query);
  if (!parsed) return keywordBaseline(query, readableNamespaces);
  const seedName = parsed.seed.toLowerCase();
  const seed = entities.find(
    (entity) =>
      !entity.archived_at &&
      readableNamespaces.includes(entity.namespace) &&
      entity.name.toLowerCase() === seedName,
  );
  if (!seed) return [];
  const linkedIds = links
    .filter(
      (link) =>
        !link.archived_at &&
        link.namespace === seed.namespace &&
        readableNamespaces.includes(link.namespace) &&
        link.relation === parsed.relation &&
        (parsed.direction === "incoming"
          ? link.to_type === "entity" && link.to_id === seed.id
          : link.from_type === "entity" && link.from_id === seed.id),
    )
    .map((link) =>
      parsed.direction === "incoming"
        ? `${link.from_type}:${link.from_id}`
        : `${link.to_type}:${link.to_id}`,
    );
  return entries.filter(
    (entry) =>
      !entry.archived_at &&
      readableNamespaces.includes(entry.namespace) &&
      linkedIds.includes(`${entry.source_type}:${entry.id}`),
  );
}

function graphEntriesFor(
  seedName: string,
  relation: string,
  direction: "incoming" | "outgoing",
  readableNamespaces = ["shared-kb"],
): FixtureEntry[] {
  const seed = entities.find(
    (entity) =>
      !entity.archived_at &&
      readableNamespaces.includes(entity.namespace) &&
      entity.name.toLowerCase() === seedName.toLowerCase(),
  );
  if (!seed) return [];
  const linkedIds = links
    .filter(
      (link) =>
        !link.archived_at &&
        link.namespace === seed.namespace &&
        readableNamespaces.includes(link.namespace) &&
        (direction === "incoming"
          ? link.to_type === "entity" && link.to_id === seed.id
          : link.from_type === "entity" && link.from_id === seed.id) &&
        link.relation === relation,
    )
    .map((link) =>
      direction === "incoming"
        ? `${link.from_type}:${link.from_id}`
        : `${link.to_type}:${link.to_id}`,
    );
  return entries.filter(
    (entry) =>
      !entry.archived_at &&
      readableNamespaces.includes(entry.namespace) &&
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
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    tier: "warm",
    usefulness: 0.5,
    access_count: 0,
    fts_rank: 1,
    distance: null,
  };
}

function namespaceList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
  return typeof value === "string" ? [value] : ["shared-kb"];
}

function graphAwareSearchPool(stats: { graphCalls: number }) {
  return {
    query: async (...args: any[]) => {
      const [sql, params = []] = args;
      const text = String(sql);
      if (text.includes("relational_graph_seed")) {
        stats.graphCalls += 1;
        const direction = text.includes("l.to_type = 'entity'")
          ? "incoming"
          : "outgoing";
        const readableNamespaces = namespaceList(params[3]);
        return {
          rows: graphEntriesFor(
            String(params[0] ?? ""),
            String(params[1] ?? ""),
            direction,
            readableNamespaces,
          ).map(searchRow),
        };
      }
      if (text.includes("FROM ob_links")) return { rows: [] };
      if (text.includes("fts_query")) {
        return {
          rows: keywordBaseline(String(params[0] ?? ""), namespaceList(params[3])).map(
            searchRow,
          ),
        };
      }
      return { rows: [] };
    },
  };
}

function recall(
  questions: RelationalQuestion[],
  search: (query: string, readableNamespaces?: string[]) => FixtureEntry[],
): number {
  const hits = questions.filter((question) =>
    search(question.question, [question.namespace]).some(
      (entry) => entry.id === question.expected_id,
    ),
  ).length;
  return hits / questions.length;
}

describe("search_brain relational retrieval eval fixture", () => {
  it("defines at least 20 Open Brain-native relational questions", () => {
    expect(relationalQuestions).toHaveLength(20);
    expect(new Set(relationalQuestions.map((question) => question.id)).size).toBe(20);
    expect(new Set(relationalQuestions.map((question) => question.relation))).toEqual(
      new Set([
        "depends_on",
        "blocked_by",
        "implemented_by",
        "decided_by",
        "supersedes",
        "duplicates",
        "contradicts",
        "mentions",
        "relates_to",
      ]),
    );
    for (const question of relationalQuestions) {
      expect(LINK_RELATIONS).toContain(question.relation as any);
    }
  });

  it("proves the target graph oracle has material lift over graph-off baseline", () => {
    expect(recall(relationalQuestions, keywordBaseline)).toBe(0);
    expect(recall(relationalQuestions, graphOracle)).toBe(1);
  });

  it("proves current search_brain graph-off behavior cannot recover relational-only answers", async () => {
    const pool = {
      query: async (...args: any[]) => {
        const [sql] = args;
        if (String(sql).includes("FROM ob_links")) return { rows: [] };
        return {
          rows: keywordBaseline(String(args[1]?.[0] ?? "")).map((entry) => ({
            source_type: entry.source_type,
            id: entry.id,
            namespace: entry.namespace,
            content_preview: entry.text,
            tags: [],
            created_by: "test",
            created_at: "2026-01-01T00:00:00Z",
            usefulness: 0,
            fts_rank: 1,
          })),
        };
      },
    };
    const auth: AuthInfo = { role: "agent", clientId: "shared-kb" };
    const { client, cleanup } = await setupMcpClient(
      registerSearchBrain,
      pool,
      createMockEmbed(null),
      auth,
    );
    try {
      const recovered = [];
      for (const question of relationalQuestions) {
        const result = await client.callTool({
          name: "search_brain",
          arguments: {
            query: question.question,
            namespace: question.namespace,
            search_mode: "keyword",
            limit: 10,
          },
        });
        expect(result.isError).toBeFalsy();
        recovered.push(
          parseToolResult(result).some(
            (entry: { id: string }) => entry.id === question.expected_id,
          ),
        );
      }
      expect(recovered.every(Boolean)).toBe(false);
      expect(recovered.filter(Boolean)).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("search_brain graph arm returns relational fixture answers through the real tool", async () => {
    const stats = { graphCalls: 0 };
    const pool = graphAwareSearchPool(stats);
    const auth: AuthInfo = { role: "agent", clientId: "shared-kb" };
    const { client, cleanup } = await setupMcpClient(
      registerSearchBrain,
      pool,
      createMockEmbed(),
      auth,
    );
    try {
      const recovered = [];
      for (const question of relationalQuestions) {
        const result = await client.callTool({
          name: "search_brain",
          arguments: {
            query: question.question,
            namespace: question.namespace,
            limit: 10,
          },
        });
        expect(result.isError).toBeFalsy();
        recovered.push(
          parseToolResult(result).some(
            (entry: { id: string; source_type: string }) =>
              entry.id === question.expected_id &&
              entry.source_type === question.expected_type,
          ),
        );
      }
      expect(recovered.every(Boolean)).toBe(true);
      expect(stats.graphCalls).toBe(relationalQuestions.length);
    } finally {
      await cleanup();
    }
  });

  it("supports explicit outgoing dependency wording through the real tool", async () => {
    const stats = { graphCalls: 0 };
    const pool = graphAwareSearchPool(stats);
    const auth: AuthInfo = { role: "agent", clientId: "shared-kb" };
    const { client, cleanup } = await setupMcpClient(
      registerSearchBrain,
      pool,
      createMockEmbed(),
      auth,
    );
    try {
      const result = await client.callTool({
        name: "search_brain",
        arguments: {
          query: "What does Alpha depend on?",
          namespace: "shared-kb",
          limit: 10,
        },
      });
      expect(result.isError).toBeFalsy();
      expect(
        parseToolResult(result).map(
          (entry: { source_type: string; id: string }) =>
            `${entry.source_type}:${entry.id}`,
        ),
      ).toContain("decision:decision-qmd-fallback");
      expect(stats.graphCalls).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("runs graph retrieval when hybrid embeddings fail", async () => {
    const stats = { graphCalls: 0 };
    const pool = graphAwareSearchPool(stats);
    const auth: AuthInfo = { role: "agent", clientId: "shared-kb" };
    const { client, cleanup } = await setupMcpClient(
      registerSearchBrain,
      pool,
      createMockEmbed(null),
      auth,
    );
    try {
      const result = await client.callTool({
        name: "search_brain",
        arguments: {
          query: "What depends on Alpha?",
          namespace: "shared-kb",
          limit: 10,
        },
      });
      expect(result.isError).toBeFalsy();
      expect(
        parseToolResult(result).map(
          (entry: { source_type: string; id: string }) =>
            `${entry.source_type}:${entry.id}`,
        ),
      ).toContain("thought:thought-deploy-readiness");
      expect(stats.graphCalls).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("keeps shared fallback helpers graph-off unless the direct tool opts in", async () => {
    const stats = { graphCalls: 0 };
    const pool = graphAwareSearchPool(stats);
    const rows = await executeSearchWithScopedSharedFallback(
      {
        pool: pool as unknown as Pool,
        embedFn: createMockEmbed(),
      },
      [...ALL_TABLES, "entities"],
      "What depends on Alpha?",
      10,
      "hybrid",
      undefined,
      0,
      ["shared-kb"],
      false,
    );

    expect(rows).toEqual([]);
    expect(stats.graphCalls).toBe(0);
  });

  it("keeps non-relational query behavior unchanged", () => {
    const query = "schema v11 downstream review";
    expect(graphOracle(query).map((entry) => entry.id)).toEqual(
      keywordBaseline(query).map((entry) => entry.id),
    );
  });

  it("does not run graph SQL for non-relational queries through the real tool", async () => {
    const stats = { graphCalls: 0 };
    const pool = graphAwareSearchPool(stats);
    const auth: AuthInfo = { role: "agent", clientId: "shared-kb" };
    const { client, cleanup } = await setupMcpClient(
      registerSearchBrain,
      pool,
      createMockEmbed(),
      auth,
    );
    try {
      const result = await client.callTool({
        name: "search_brain",
        arguments: {
          query: "schema v11 downstream review",
          namespace: "shared-kb",
          limit: 10,
        },
      });
      expect(result.isError).toBeFalsy();
      const expectedIds = keywordBaseline("schema v11 downstream review").map(
        (entry) => entry.id,
      );
      expect(
        new Set(parseToolResult(result).map((entry: { id: string }) => entry.id)),
      ).toEqual(new Set(expectedIds));
      expect(stats.graphCalls).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("does not run graph SQL for source-scoped searches", async () => {
    const stats = { graphCalls: 0 };
    const pool = graphAwareSearchPool(stats);
    const auth: AuthInfo = { role: "admin", clientId: "admin" };
    const { client, cleanup } = await setupMcpClient(
      registerSearchBrain,
      pool,
      createMockEmbed(),
      auth,
    );
    try {
      const result = await client.callTool({
        name: "search_brain",
        arguments: {
          query: "What depends on Alpha?",
          namespace: "shared-kb",
          source_scope: { client_id: "matter-client" },
          limit: 10,
        },
      });
      expect(result.isError).toBeFalsy();
      expect(parseToolResult(result)).toEqual([]);
      expect(stats.graphCalls).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("excludes unreadable namespaces from graph hydration", () => {
    expect(graphOracle("What mentions Private?", ["shared-kb"])).toEqual([]);
    expect(graphOracle("What mentions Private?", ["private-agent"]).map((entry) => entry.id)).toEqual([
      "private-leak-target",
    ]);
  });

  it("excludes archived links and archived seed entities", () => {
    expect(graphOracle("What mentions Alpha?").map((entry) => entry.id)).not.toContain(
      "archived-link-target",
    );
    expect(graphOracle("What mentions Archived?").map((entry) => entry.id)).not.toContain(
      "archived-entity-target",
    );
  });
});

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;

dbDescribe("search_brain relational retrieval eval fixture (live Postgres)", () => {
  const pool = new Pool({ connectionString: DB_URL });
  const ns = "test-relational-retrieval-eval";
  const privateNs = `${ns}-private`;

  afterAll(async () => {
    await cleanupDbFixture();
    await pool.end();
  });

  async function cleanupDbFixture(): Promise<void> {
    await pool.query(
      `DELETE FROM entry_access_log
       WHERE entry_id = ANY($1::uuid[])`,
      [
        [
          "10000000-0000-4000-8000-000000000001",
          "10000000-0000-4000-8000-000000000002",
          "10000000-0000-4000-8000-000000000003",
          "10000000-0000-4000-8000-000000000004",
          "11000000-0000-4000-8000-000000000001",
          "12000000-0000-4000-8000-000000000001",
          "13000000-0000-4000-8000-000000000001",
        ],
      ],
    );
    await pool.query("DELETE FROM ob_links WHERE namespace = ANY($1::text[])", [
      [ns, privateNs],
    ]);
    await pool.query("DELETE FROM ob_entities WHERE namespace = ANY($1::text[])", [
      [ns, privateNs],
    ]);
    await pool.query("DELETE FROM decisions WHERE namespace = ANY($1::text[])", [
      [ns, privateNs],
    ]);
    await pool.query("DELETE FROM projects WHERE namespace = ANY($1::text[])", [
      [ns, privateNs],
    ]);
    await pool.query("DELETE FROM sessions WHERE namespace = ANY($1::text[])", [
      [ns, privateNs],
    ]);
    await pool.query("DELETE FROM thoughts WHERE namespace = ANY($1::text[])", [
      [ns, privateNs],
    ]);
  }

  async function seedDbFixture(): Promise<void> {
    await cleanupDbFixture();
    await pool.query(
      `INSERT INTO thoughts (id, content, namespace, created_by, content_hash)
       VALUES
         ('10000000-0000-4000-8000-000000000001', 'DB relational target visible only through active graph link', $1, 'test', 'rr-db-visible'),
         ('10000000-0000-4000-8000-000000000002', 'DB private target must not leak', $2, 'test', 'rr-db-private'),
         ('10000000-0000-4000-8000-000000000003', 'DB archived link target must not hydrate', $1, 'test', 'rr-db-archived-link'),
         ('10000000-0000-4000-8000-000000000004', 'DB archived entity target must not hydrate', $1, 'test', 'rr-db-archived-entity')`,
      [ns, privateNs],
    );
    await pool.query(
      `INSERT INTO decisions (id, title, rationale, namespace, created_by, content_hash)
       VALUES ('11000000-0000-4000-8000-000000000001', 'DB decision target', 'Hydrated by graph relation only', $1, 'test', 'rr-db-decision')`,
      [ns],
    );
    await pool.query(
      `INSERT INTO projects (id, name, description, namespace, created_by, content_hash)
       VALUES ('12000000-0000-4000-8000-000000000001', 'DB project target', 'Hydrated by graph relation only', $1, 'test', 'rr-db-project')`,
      [ns],
    );
    await pool.query(
      `INSERT INTO sessions (id, project, summary, namespace, created_by, content_hash)
       VALUES ('13000000-0000-4000-8000-000000000001', 'DB session target', 'Hydrated by graph relation only', $1, 'test', 'rr-db-session')`,
      [ns],
    );
    await pool.query(
      `INSERT INTO ob_entities (id, entity_type, name, namespace, created_by, archived_at)
       VALUES
         ('20000000-0000-4000-8000-000000000001', 'issue', 'VisibleSeed', $1, 'test', NULL),
         ('20000000-0000-4000-8000-000000000002', 'issue', 'PrivateSeed', $2, 'test', NULL),
         ('20000000-0000-4000-8000-000000000003', 'issue', 'ArchivedSeed', $1, 'test', '2026-07-01T00:00:00Z'::timestamptz)`,
      [ns, privateNs],
    );
    await pool.query(
      `INSERT INTO ob_links
         (id, from_type, from_id, to_type, to_id, relation, namespace, created_by, archived_at)
       VALUES
         ('30000000-0000-4000-8000-000000000001', 'thought', '10000000-0000-4000-8000-000000000001', 'entity', '20000000-0000-4000-8000-000000000001', 'depends_on', $1, 'test', NULL),
         ('30000000-0000-4000-8000-000000000002', 'thought', '10000000-0000-4000-8000-000000000002', 'entity', '20000000-0000-4000-8000-000000000002', 'depends_on', $2, 'test', NULL),
         ('30000000-0000-4000-8000-000000000003', 'thought', '10000000-0000-4000-8000-000000000003', 'entity', '20000000-0000-4000-8000-000000000001', 'mentions', $1, 'test', '2026-07-01T00:00:00Z'::timestamptz),
         ('30000000-0000-4000-8000-000000000004', 'thought', '10000000-0000-4000-8000-000000000004', 'entity', '20000000-0000-4000-8000-000000000003', 'mentions', $1, 'test', NULL),
         ('30000000-0000-4000-8000-000000000005', 'decision', '11000000-0000-4000-8000-000000000001', 'entity', '20000000-0000-4000-8000-000000000001', 'decided_by', $1, 'test', NULL),
         ('30000000-0000-4000-8000-000000000006', 'project', '12000000-0000-4000-8000-000000000001', 'entity', '20000000-0000-4000-8000-000000000001', 'implemented_by', $1, 'test', NULL),
         ('30000000-0000-4000-8000-000000000007', 'session', '13000000-0000-4000-8000-000000000001', 'entity', '20000000-0000-4000-8000-000000000001', 'blocked_by', $1, 'test', NULL),
         ('30000000-0000-4000-8000-000000000008', 'entity', '20000000-0000-4000-8000-000000000001', 'decision', '11000000-0000-4000-8000-000000000001', 'depends_on', $1, 'test', NULL)`,
      [ns, privateNs],
    );
  }

  async function relationalDbCandidates(
    seedName: string,
    relation: string,
    readableNamespaces: string[],
    direction: "incoming" | "outgoing" = "incoming",
  ): Promise<Array<{ source_type: string; id: string }>> {
    const linkJoin =
      direction === "incoming"
        ? `l.to_type = 'entity'
          AND l.to_id = s.id`
        : `l.from_type = 'entity'
          AND l.from_id = s.id`;
    const thoughtJoin =
      direction === "incoming"
        ? `l.from_type = 'thought'
          AND t.id = l.from_id`
        : `l.to_type = 'thought'
          AND t.id = l.to_id`;
    const decisionJoin =
      direction === "incoming"
        ? `l.from_type = 'decision'
          AND d.id = l.from_id`
        : `l.to_type = 'decision'
          AND d.id = l.to_id`;
    const projectJoin =
      direction === "incoming"
        ? `l.from_type = 'project'
          AND p.id = l.from_id`
        : `l.to_type = 'project'
          AND p.id = l.to_id`;
    const sessionJoin =
      direction === "incoming"
        ? `l.from_type = 'session'
          AND se.id = l.from_id`
        : `l.to_type = 'session'
          AND se.id = l.to_id`;
    const { rows } = await pool.query<{ source_type: string; id: string }>(
      `WITH seed AS (
         SELECT id, namespace
         FROM ob_entities
         WHERE lower(name) = lower($1)
           AND namespace = ANY($3::text[])
           AND archived_at IS NULL
       )
       SELECT source_type, id
       FROM (
         SELECT 'thought' AS source_type, t.id::text AS id
         FROM seed s
         JOIN ob_links l
           ON ${linkJoin}
          AND l.namespace = s.namespace
          AND l.relation = $2
          AND l.archived_at IS NULL
         JOIN thoughts t
           ON ${thoughtJoin}
          AND t.namespace = l.namespace
          AND t.archived_at IS NULL
         WHERE l.namespace = ANY($3::text[])
         UNION ALL
         SELECT 'decision' AS source_type, d.id::text AS id
         FROM seed s
         JOIN ob_links l
           ON ${linkJoin}
          AND l.namespace = s.namespace
          AND l.relation = $2
          AND l.archived_at IS NULL
         JOIN decisions d
           ON ${decisionJoin}
          AND d.namespace = l.namespace
          AND d.archived_at IS NULL
         WHERE l.namespace = ANY($3::text[])
         UNION ALL
         SELECT 'project' AS source_type, p.id::text AS id
         FROM seed s
         JOIN ob_links l
           ON ${linkJoin}
          AND l.namespace = s.namespace
          AND l.relation = $2
          AND l.archived_at IS NULL
         JOIN projects p
           ON ${projectJoin}
          AND p.namespace = l.namespace
          AND p.archived_at IS NULL
         WHERE l.namespace = ANY($3::text[])
         UNION ALL
         SELECT 'session' AS source_type, se.id::text AS id
         FROM seed s
         JOIN ob_links l
           ON ${linkJoin}
          AND l.namespace = s.namespace
          AND l.relation = $2
          AND l.archived_at IS NULL
         JOIN sessions se
           ON ${sessionJoin}
          AND se.namespace = l.namespace
          AND se.archived_at IS NULL
         WHERE l.namespace = ANY($3::text[])
       ) hydrated
       ORDER BY source_type, id`,
      [seedName, relation, readableNamespaces],
    );
    return rows;
  }

  it("proves real graph predicates enforce namespace and archived lifecycle", async () => {
    await seedDbFixture();
    try {
      await expect(relationalDbCandidates("VisibleSeed", "depends_on", [ns]))
        .resolves.toEqual([
          { source_type: "thought", id: "10000000-0000-4000-8000-000000000001" },
        ]);
      await expect(relationalDbCandidates("PrivateSeed", "depends_on", [ns]))
        .resolves.toEqual([]);
      await expect(relationalDbCandidates("PrivateSeed", "depends_on", [privateNs]))
        .resolves.toEqual([
          { source_type: "thought", id: "10000000-0000-4000-8000-000000000002" },
        ]);
      await expect(relationalDbCandidates("VisibleSeed", "mentions", [ns]))
        .resolves.toEqual([]);
      await expect(relationalDbCandidates("ArchivedSeed", "mentions", [ns]))
        .resolves.toEqual([]);
      await expect(relationalDbCandidates("VisibleSeed", "decided_by", [ns]))
        .resolves.toEqual([
          { source_type: "decision", id: "11000000-0000-4000-8000-000000000001" },
        ]);
      await expect(relationalDbCandidates("VisibleSeed", "implemented_by", [ns]))
        .resolves.toEqual([
          { source_type: "project", id: "12000000-0000-4000-8000-000000000001" },
        ]);
      await expect(relationalDbCandidates("VisibleSeed", "blocked_by", [ns]))
        .resolves.toEqual([
          { source_type: "session", id: "13000000-0000-4000-8000-000000000001" },
        ]);
      await expect(
        relationalDbCandidates("VisibleSeed", "depends_on", [ns], "outgoing"),
      ).resolves.toEqual([
        { source_type: "decision", id: "11000000-0000-4000-8000-000000000001" },
      ]);
    } finally {
      await cleanupDbFixture();
    }
  });

  it("returns graph-hydrated answers through the real search_brain tool", async () => {
    await seedDbFixture();
    const auth: AuthInfo = { role: "admin", clientId: "admin-client" };
    const { client, cleanup } = await setupMcpClient(
      registerSearchBrain,
      pool,
      createMockEmbed(),
      auth,
    );
    try {
      const result = await client.callTool({
        name: "search_brain",
        arguments: {
          query: "What depends on VisibleSeed?",
          namespace: ns,
          limit: 10,
        },
      });
      expect(result.isError).toBeFalsy();
      expect(
        parseToolResult(result).map(
          (entry: { source_type: string; id: string }) =>
            `${entry.source_type}:${entry.id}`,
        ),
      ).toContain("thought:10000000-0000-4000-8000-000000000001");
    } finally {
      await cleanup();
      await cleanupDbFixture();
    }
  });
});
