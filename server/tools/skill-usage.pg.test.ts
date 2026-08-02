/**
 * Live-Postgres behavior tests for skill and canon usage telemetry (#469).
 *
 * The operator's definition of done for this issue is that usage data is
 * provably SAVED and QUERYABLE through the report surface, so these tests drive
 * the two tools end to end against a real database rather than asserting on a
 * mocked pool: record an invocation, then read it back out of the report.
 *
 * The namespace boundary is the test that matters most. `skill_usage_log`
 * carries no namespace column of its own (046_skill_usage_log.sql), exactly
 * like `entry_access_log`, so the ONLY thing keeping one tenant's usage pattern
 * away from another is the join back to `ob_entities` and the auth predicate
 * applied there. A dropped join would still return plausible-looking counts --
 * which is why it needs a test that fails on the old behavior rather than a
 * reviewer's eye. `hides another namespace's usage` below is that test: it
 * seeds a foreign namespace's invocations and proves the report cannot see
 * them, in both the counted rows and the never-used list.
 *
 * Skips loudly (via `describe.skip`) when `OPENBRAIN_TEST_DATABASE_URL` is
 * unset. It must point at an isolated test/playground database, never the
 * dogfood database.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pino from "pino";
import { Pool } from "pg";
import { registerSkillUsageTools } from "./skill-usage.ts";

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;
const pool = DB_URL ? new Pool({ connectionString: DB_URL }) : null;

const NAMESPACE = `skill-usage-pg-${process.pid}`;
const OTHER_NAMESPACE = `${NAMESPACE}-other`;

interface UsageRow {
  skill_slug: string;
  usage_kind: string;
  agent: string | null;
  repo: string | null;
  runtime: string | null;
  invocations: number;
  last_used_at: string;
  prior_window_invocations: number;
}

async function callTool(
  tool: string,
  namespace: string,
  args: Record<string, unknown>,
  role: "agent" | "readonly" = "agent",
): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  if (!pool) throw new Error("OPENBRAIN_TEST_DATABASE_URL is required");
  const server = new McpServer({ name: "skill-usage-test", version: "1.0.0" });
  registerSkillUsageTools(server, {
    pool,
    embedFn: async () => null,
    logger: pino({ level: "silent" }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    originalSend(message, {
      ...options,
      authInfo: { role, clientId: namespace, namespaceSource: "token" },
    } as never);
  const client = new Client({ name: "skill-usage-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: tool, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text);
    } catch {
      body = { text };
    }
    return { isError: result.isError === true, body };
  } finally {
    await client.close();
    await server.close();
  }
}

/** @returns The report's usage rows for one skill slug. */
function rowsFor(body: Record<string, unknown>, slug: string): UsageRow[] {
  return (body.usage as UsageRow[]).filter((row) => row.skill_slug === slug);
}

dbDescribe("skill usage telemetry (live Postgres)", () => {
  beforeAll(async () => {
    // A foreign namespace's invocations, seeded through the tool so the entity
    // and log row are built exactly the way production builds them.
    await callTool("record_skill_usage", OTHER_NAMESPACE, {
      skill_slug: "foreign-only-skill",
      agent: "other-agent",
      repo: "other-repo",
      runtime: "codex",
    });
  });

  afterAll(async () => {
    await pool?.query(
      `DELETE FROM skill_usage_log
        WHERE entity_id IN (SELECT id FROM ob_entities WHERE namespace = ANY($1::text[]))`,
      [[NAMESPACE, OTHER_NAMESPACE]],
    );
    await pool?.query(`DELETE FROM ob_entities WHERE namespace = ANY($1::text[])`, [
      [NAMESPACE, OTHER_NAMESPACE],
    ]);
    await pool?.end();
  });

  test("records an invocation and reads it back through the report", async () => {
    const recorded = await callTool("record_skill_usage", NAMESPACE, {
      skill_slug: "brain",
      agent: "claude-opus-5",
      repo: "open-brain",
      runtime: "claude-code",
      session_id: "sess-1",
    });
    expect(recorded.isError).toBe(false);
    expect(recorded.body.recorded).toBe(true);

    const report = await callTool("skill_usage_report", NAMESPACE, {});
    expect(report.isError).toBe(false);
    const rows = rowsFor(report.body, "brain");
    expect(rows.length).toBe(1);
    expect(rows[0]!.invocations).toBe(1);
    expect(rows[0]!.agent).toBe("claude-opus-5");
    expect(rows[0]!.repo).toBe("open-brain");
    expect(rows[0]!.runtime).toBe("claude-code");
    expect(rows[0]!.usage_kind).toBe("skill");
    expect(Number.isNaN(Date.parse(rows[0]!.last_used_at))).toBe(false);
  });

  test("counts repeat invocations of the same skill", async () => {
    for (let i = 0; i < 3; i += 1) {
      await callTool("record_skill_usage", NAMESPACE, {
        skill_slug: "wayfinder",
        agent: "claude-opus-5",
        repo: "open-brain",
        runtime: "claude-code",
      });
    }
    const report = await callTool("skill_usage_report", NAMESPACE, {});
    const rows = rowsFor(report.body, "wayfinder");
    expect(rows.length).toBe(1);
    expect(rows[0]!.invocations).toBe(3);
  });

  test("separates the same skill by agent, repo, and runtime", async () => {
    await callTool("record_skill_usage", NAMESPACE, {
      skill_slug: "caveman",
      agent: "agent-one",
      repo: "repo-one",
      runtime: "claude-code",
    });
    await callTool("record_skill_usage", NAMESPACE, {
      skill_slug: "caveman",
      agent: "agent-two",
      repo: "repo-one",
      runtime: "codex",
    });
    const report = await callTool("skill_usage_report", NAMESPACE, {});
    const rows = rowsFor(report.body, "caveman");
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((row) => row.agent))).toEqual(
      new Set(["agent-one", "agent-two"]),
    );
    expect(new Set(rows.map((row) => row.runtime))).toEqual(
      new Set(["claude-code", "codex"]),
    );
  });

  test("counts canon loads separately from skill invocations", async () => {
    await callTool("record_skill_usage", NAMESPACE, {
      skill_slug: "law-0",
      usage_kind: "canon",
      agent: "claude-opus-5",
      repo: "open-brain",
      runtime: "claude-code",
    });
    const canonOnly = await callTool("skill_usage_report", NAMESPACE, {
      usage_kind: "canon",
    });
    const canonSlugs = (canonOnly.body.usage as UsageRow[]).map(
      (row) => row.skill_slug,
    );
    expect(canonSlugs).toContain("law-0");
    expect(canonSlugs).not.toContain("brain");

    const skillOnly = await callTool("skill_usage_report", NAMESPACE, {
      usage_kind: "skill",
    });
    const skillSlugs = (skillOnly.body.usage as UsageRow[]).map(
      (row) => row.skill_slug,
    );
    expect(skillSlugs).not.toContain("law-0");
  });

  test("hides another namespace's usage from the report and the never-used list", async () => {
    // The whole point of the join-and-scope rule. `foreign-only-skill` was
    // recorded under OTHER_NAMESPACE in beforeAll; nothing about it may reach a
    // NAMESPACE reader -- not as a counted row, and not as a name leaked
    // through the never-used list, which reads `ob_entities` directly and so
    // needs its own predicate.
    const report = await callTool("skill_usage_report", NAMESPACE, {});
    const slugs = (report.body.usage as UsageRow[]).map((row) => row.skill_slug);
    expect(slugs).not.toContain("foreign-only-skill");
    expect(report.body.never_used as string[]).not.toContain(
      "skill.foreign-only-skill",
    );

    // Proven visible from its OWN namespace, so the assertion above is the
    // predicate working rather than the row simply being absent.
    const ownReport = await callTool("skill_usage_report", OTHER_NAMESPACE, {});
    const ownSlugs = (ownReport.body.usage as UsageRow[]).map(
      (row) => row.skill_slug,
    );
    expect(ownSlugs).toContain("foreign-only-skill");
  });

  test("lists a seeded skill with no invocation in the window as never used", async () => {
    await callTool("record_skill_usage", NAMESPACE, {
      skill_slug: "long-idle-skill",
      agent: "claude-opus-5",
      runtime: "claude-code",
    });
    // Age that one invocation out of the reporting window. The entity stays;
    // only the log row moves, which is exactly the never-used condition.
    await pool!.query(
      `UPDATE skill_usage_log
          SET invoked_at = NOW() - INTERVAL '90 days'
        WHERE skill_slug = 'long-idle-skill'`,
    );
    const report = await callTool("skill_usage_report", NAMESPACE, { days: 7 });
    const slugs = (report.body.usage as UsageRow[]).map((row) => row.skill_slug);
    expect(slugs).not.toContain("long-idle-skill");
    expect(report.body.never_used as string[]).toContain("skill.long-idle-skill");
  });

  test("reports the prior window's count so the trend is two facts, not a verdict", async () => {
    await callTool("record_skill_usage", NAMESPACE, {
      skill_slug: "trend-skill",
      agent: "claude-opus-5",
      runtime: "claude-code",
    });
    await callTool("record_skill_usage", NAMESPACE, {
      skill_slug: "trend-skill",
      agent: "claude-opus-5",
      runtime: "claude-code",
    });
    // Push one of the two back into the prior window.
    await pool!.query(
      `UPDATE skill_usage_log
          SET invoked_at = NOW() - INTERVAL '10 days'
        WHERE id = (SELECT MIN(id) FROM skill_usage_log
                     WHERE skill_slug = 'trend-skill')`,
    );
    const report = await callTool("skill_usage_report", NAMESPACE, { days: 7 });
    const rows = rowsFor(report.body, "trend-skill");
    expect(rows.length).toBe(1);
    expect(rows[0]!.invocations).toBe(1);
    expect(rows[0]!.prior_window_invocations).toBe(1);
    // Facts only: the report must not hand back a judgement word alongside them.
    expect(Object.keys(rows[0]!)).not.toContain("recommendation");
    expect(Object.keys(rows[0]!)).not.toContain("category");
  });

  test("denies recording to a namespace the caller cannot write", async () => {
    const denied = await callTool("record_skill_usage", NAMESPACE, {
      skill_slug: "cross-tenant-write",
      namespace: OTHER_NAMESPACE,
    });
    expect(denied.isError).toBe(true);
    expect(String(denied.body.text)).toContain("Permission denied");
  });

  test("denies recording without write permission", async () => {
    const denied = await callTool(
      "record_skill_usage",
      NAMESPACE,
      { skill_slug: "readonly-write-attempt" },
      "readonly",
    );
    expect(denied.isError).toBe(true);
    expect(String(denied.body.text)).toContain("Permission denied");
  });
});
