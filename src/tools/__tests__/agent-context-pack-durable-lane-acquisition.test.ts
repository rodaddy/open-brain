import { describe, expect, it } from "bun:test";
import type { AuthInfo } from "../../types.ts";
import {
  AGENT_CONTEXT_PACK_SCOPE as SCOPE,
  setupAgentContextPackToolClient as setupToolClient,
} from "./agent-context-pack-test-helpers.ts";

const AUTH: AuthInfo = { role: "admin", clientId: "rico" };

async function callBudgetedPack(
  pool: Parameters<typeof setupToolClient>[1],
  maxLatencyMs: number,
) {
  const { client, cleanup } = await setupToolClient(AUTH, pool);
  try {
    const startedAt = performance.now();
    const pack = await client.callTool({
      name: "agent_context_pack",
      arguments: {
        ...SCOPE,
        requested_sections: ["durable_lane_context"],
        budget: { max_latency_ms: maxLatencyMs },
      },
    });
    return { pack, elapsedMs: performance.now() - startedAt };
  } finally {
    await cleanup();
  }
}

function expectDatabaseUnavailable(
  pack: Awaited<ReturnType<typeof callBudgetedPack>>["pack"],
) {
  expect(pack.isError).toBeFalsy();
  const payload = JSON.parse((pack.content as any)[0].text);
  expect(payload.sections.durable_lane_context).toBeUndefined();
  expect(payload.warnings.degraded_sources).toEqual([
    {
      source: "durable_lane_context",
      reason: "database_unavailable",
    },
  ]);
  return payload;
}

describe("agent_context_pack durable lane pool acquisition", () => {
  it("fails open promptly when pool acquisition never resolves", async () => {
    const { pack, elapsedMs } = await callBudgetedPack(
      {
        query: async () => ({ rows: [] }),
        connect: () => new Promise(() => undefined),
      },
      25,
    );

    expectDatabaseUnavailable(pack);
    expect(elapsedMs).toBeLessThan(250);
  });

  it("releases a client that arrives after the acquisition deadline without using it", async () => {
    let queryCount = 0;
    let releaseCount = 0;
    const lateClient = {
      query: async () => {
        queryCount += 1;
        return { rows: [] };
      },
      release: () => {
        releaseCount += 1;
      },
    };
    const { pack, elapsedMs } = await callBudgetedPack(
      {
        query: async () => ({ rows: [] }),
        connect: async () => {
          await Bun.sleep(75);
          return lateClient;
        },
      },
      25,
    );

    expectDatabaseUnavailable(pack);
    expect(elapsedMs).toBeLessThan(250);
    await Bun.sleep(75);
    expect(queryCount).toBe(0);
    expect(releaseCount).toBe(1);
  });

  it("redacts pool acquisition rejection details", async () => {
    const { pack } = await callBudgetedPack(
      {
        query: async () => ({ rows: [] }),
        connect: async () => {
          throw new Error("postgres://secret-host/private-connect-detail");
        },
      },
      100,
    );

    const payload = expectDatabaseUnavailable(pack);
    expect(JSON.stringify(payload)).not.toContain("secret-host");
    expect(JSON.stringify(payload)).not.toContain("private-connect-detail");
  });

  it("uses and releases a normally acquired client within the shared deadline", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    let releaseCount = 0;
    const dbClient = {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        return { rows: [] };
      },
      release: () => {
        releaseCount += 1;
      },
    };
    const { pack } = await callBudgetedPack(
      {
        query: async () => {
          throw new Error("budgeted reads must use the acquired client");
        },
        connect: async () => dbClient,
      },
      250,
    );

    expect(pack.isError).toBeFalsy();
    const payload = JSON.parse((pack.content as any)[0].text);
    expect(payload.warnings.scope_denials).toContainEqual({
      source: "durable_lane_context",
      reasons: ["exact_scope"],
    });
    expect(queries.map(({ sql }) => sql)).toEqual([
      "BEGIN READ ONLY",
      "SELECT set_config('statement_timeout', $1, true)",
      expect.stringContaining("FROM ob_session_lanes"),
      "COMMIT",
    ]);
    const statementTimeoutMs = Number.parseInt(
      String(queries[1]?.params?.[0]),
      10,
    );
    expect(statementTimeoutMs).toBeGreaterThan(0);
    expect(statementTimeoutMs).toBeLessThanOrEqual(250);
    expect(releaseCount).toBe(1);
  });
});
