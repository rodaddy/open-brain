import { describe, expect, it } from "bun:test";
import type { AuthInfo } from "../../types.ts";
import {
  AGENT_CONTEXT_PACK_SCOPE as SCOPE,
  setupAgentContextPackToolClient as setupToolClient,
} from "./agent-context-pack-test-helpers.ts";

const AUTH: AuthInfo = { role: "admin", clientId: "rico" };

type TimedQueryConfig = {
  text: string;
  values?: unknown[];
  query_timeout?: number;
};

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

  it("fails open when the acquired client's BEGIN hits its query timeout", async () => {
    let transactionStartCount = 0;
    let laneQueryCount = 0;
    let releaseCount = 0;
    let releaseArgument: unknown;
    const dbClient = {
      query: async (config: TimedQueryConfig) => {
        if (config.text === "BEGIN READ ONLY") {
          transactionStartCount += 1;
          expect(config.query_timeout).toBeGreaterThan(0);
          if (!config.query_timeout) {
            throw new Error("BEGIN query timeout was not configured");
          }
          await Bun.sleep(config.query_timeout);
          throw new Error("Query read timeout");
        }
        if (config.text.includes("FROM ob_session_lanes")) {
          laneQueryCount += 1;
        }
        return { rows: [] };
      },
      release: (error?: unknown) => {
        releaseCount += 1;
        releaseArgument = error;
      },
    };
    const { pack, elapsedMs } = await callBudgetedPack(
      {
        query: async () => {
          throw new Error("budgeted reads must use the acquired client");
        },
        connect: async () => dbClient,
      },
      25,
    );

    const payload = expectDatabaseUnavailable(pack);
    expect(elapsedMs).toBeLessThan(250);
    expect(transactionStartCount).toBe(1);
    expect(laneQueryCount).toBe(0);
    expect(releaseCount).toBe(1);
    expect(releaseArgument).toBeInstanceOf(Error);
    expect(JSON.stringify(payload)).not.toContain("Query read timeout");
  });

  it("uses and releases a normally acquired client within the shared deadline", async () => {
    const queries: TimedQueryConfig[] = [];
    let releaseCount = 0;
    const dbClient = {
      query: async (config: TimedQueryConfig) => {
        queries.push(config);
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
    expect(queries.map(({ text }) => text)).toEqual([
      "BEGIN READ ONLY",
      "SELECT set_config('statement_timeout', $1, true)",
      expect.stringContaining("FROM ob_session_lanes"),
      "COMMIT",
    ]);
    expect(queries.every(({ query_timeout }) => query_timeout! > 0)).toBe(true);
    const statementTimeoutMs = Number.parseInt(
      String(queries[1]?.values?.[0]),
      10,
    );
    expect(statementTimeoutMs).toBeGreaterThan(0);
    expect(statementTimeoutMs).toBeLessThanOrEqual(250);
    expect(queries.map(({ text }) => text).join("\n")).not.toContain(
      "SET statement_timeout",
    );
    expect(queries.map(({ text }) => text).join("\n")).not.toContain(
      "RESET statement_timeout",
    );
    expect(releaseCount).toBe(1);
  });
});
