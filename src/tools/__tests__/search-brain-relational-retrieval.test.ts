import { describe, expect, it } from "bun:test";
import type { Pool } from "pg";
import {
  ALL_TABLES,
  executeSearchWithScopedSharedFallback,
  registerSearchBrain,
} from "../search-brain.ts";
import { LINK_RELATIONS } from "../table-constants.ts";
import type { AuthInfo } from "../../types.ts";
import { createMockEmbed, parseToolResult, setupMcpClient } from "./test-helpers.ts";
import { relationalQuestions } from "./search-brain-relational-retrieval-fixture-data.ts";
import {
  graphAwareSearchPool,
  graphOracle,
  keywordBaseline,
  recall,
} from "./search-brain-relational-retrieval-fixture.ts";

function case1(): void {
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
    expect(LINK_RELATIONS).toContain(
      question.relation as (typeof LINK_RELATIONS)[number],
    );
  }
}

function case2(): void {
  expect(recall(relationalQuestions, keywordBaseline)).toBe(0);
  expect(recall(relationalQuestions, graphOracle)).toBe(1);
}

async function case3(): Promise<void> {
  const pool = {
    query: async (...args: unknown[]) => {
      const [sql, rawParams] = args;
      const params = (rawParams ?? []) as unknown[];
      if (String(sql).includes("FROM ob_links")) return { rows: [] };
      return {
        rows: keywordBaseline(String(params[0] ?? "")).map((entry) => ({
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
}

async function case4(): Promise<void> {
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
}

async function case5(): Promise<void> {
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
}

async function case6(): Promise<void> {
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
}

async function case7(): Promise<void> {
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
}

function case8(): void {
  const query = "schema v11 downstream review";
  expect(graphOracle(query).map((entry) => entry.id)).toEqual(
    keywordBaseline(query).map((entry) => entry.id),
  );
}

async function case9(): Promise<void> {
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
}

async function case10(): Promise<void> {
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
}

function case11(): void {
  expect(graphOracle("What mentions Private?", ["shared-kb"])).toEqual([]);
  expect(
    graphOracle("What mentions Private?", ["private-agent"]).map((entry) => entry.id),
  ).toEqual(["private-leak-target"]);
}

function case12(): void {
  expect(graphOracle("What mentions Alpha?").map((entry) => entry.id)).not.toContain(
    "archived-link-target",
  );
  expect(graphOracle("What mentions Archived?").map((entry) => entry.id)).not.toContain(
    "archived-entity-target",
  );
}

describe("search_brain relational retrieval eval fixture", () => {
  it("defines at least 20 Open Brain-native relational questions", case1);
  it("proves the target graph oracle has material lift over graph-off baseline", case2);
  it(
    "proves current search_brain graph-off behavior cannot recover relational-only answers",
    case3,
  );
  it(
    "search_brain graph arm returns relational fixture answers through the real tool",
    case4,
  );
  it("supports explicit outgoing dependency wording through the real tool", case5);
  it("runs graph retrieval when hybrid embeddings fail", case6);
  it("keeps shared fallback helpers graph-off unless the direct tool opts in", case7);
  it("keeps non-relational query behavior unchanged", case8);
  it("does not run graph SQL for non-relational queries through the real tool", case9);
  it("does not run graph SQL for source-scoped searches", case10);
  it("excludes unreadable namespaces from graph hydration", case11);
  it("excludes archived links and archived seed entities", case12);
});
