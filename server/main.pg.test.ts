/**
 * Start-equivalence proof for the rewrite's real process entrypoint (#463).
 *
 * WHAT THIS COVERS THAT NOTHING ELSE DID. `server/application/sdk-protocol.pg.test.ts`
 * composes `createShadowApplication` BY HAND: it builds its own `bearerAuth()`
 * middleware, its own `serverFactory`, a `fakeHealthDatabase()`, and never
 * touches config, migrations, the token map, the REST routers, MCP audit, the
 * NATS lifecycle, or a listener it did not open itself. Every one of those steps
 * lived only in `src/index.ts:255-437`, so the rewrite had a composed
 * APPLICATION and no composed PROCESS. This file drives `startServer()` — the
 * real entrypoint, the real config parse, the real pool, the real migration
 * runner, the real token map, the real audit installation — against an isolated
 * database on an ephemeral port, and then shuts it down.
 *
 * THE FOUR SURFACES ARE ASSERTED TOGETHER ON PURPOSE. Health, one REST route,
 * one MCP tool call, and an audit row are not four independent features; they
 * are four things that only work if the SAME composition is right. The REST
 * router needs `req.auth`, which needs the middleware built from the config's
 * token list. The MCP call needs the audit wrapper to have been installed
 * BEFORE tool registration. The audit row needs the pool the migrations ran
 * against. Asserting them one at a time against separate hand-built fixtures is
 * exactly how the gap this file closes stayed invisible.
 *
 * DATABASE. REQUIRES the test-database variable and fails hard without it
 * (operator ruling 2026-08-27, issue #878). It must point at an isolated test database — NEVER the dogfood one. The
 * anti-skip guard (`scripts/assert-db-tests-ran.ts`) fails the job if this suite
 * does not actually execute, because a silent skip here would report a green
 * build for an entrypoint nothing had started.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pino from "pino";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../scripts/test-support/require-test-database.ts";
import { parseServerConfig, type ServerConfig } from "./config.ts";
import { startServer, type StartedServer } from "./main.ts";
import type { SingleWorkerHealth } from "./transport/index.ts";

const DB_URL = requireTestDatabaseUrl();

const TOKEN = `entrypoint-proof-${process.pid}`;
const _NAMESPACE = `entrypoint-proof-${process.pid}-${Date.now()}`;
const JEV_URL = "https://jev-entrypoint.test/v1/systemone";
const EMBEDDING_URL = "https://embedding-entrypoint.test/v1";
const EMBEDDING_MODEL = "entrypoint-proof-model";
const SEARCH_TOKEN = `zqxjevboundary${process.pid}`;
const SEARCH_NAMESPACE = "agent";
const SEARCH_IDS = {
  first: "a1111111-1111-4111-8111-111111111111",
  second: "b2222222-2222-4222-8222-222222222222",
  promoted: "c3333333-3333-4333-8333-333333333333",
  foreign: "d4444444-4444-4444-8444-444444444444",
} as const;
const SEARCH_VECTOR = Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0));
const SEARCH_VECTOR_LITERAL = `[${SEARCH_VECTOR.join(",")}]`;

type JevMode = "rerank" | "malformed";
let jevMode: JevMode = "rerank";
const jevRequests: Array<Record<string, unknown>> = [];
const originalFetch = globalThis.fetch;

function silentLogger() {
  return pino({ level: "silent" });
}

/**
 * Build the config the entrypoint would have parsed from the environment.
 *
 * `parseServerConfig` rather than a hand-written object: the point is that the
 * REAL validator produced this, so a schema change that would break startup
 * breaks this test too. The database fields are decomposed from the test URL so
 * the pool the entrypoint opens is the isolated one, not whatever `.env` names.
 *
 * `runMigrations` is left ON. The entrypoint's migration step is part of what
 * start-equivalence means, and the runner is append-only and idempotent — on an
 * already-migrated test database it applies nothing and returns an empty list,
 * which is itself the assertion that it did not try to rewrite history.
 */
function testConfig(): ServerConfig {
  const url = new URL(DB_URL);
  const result = parseServerConfig({
    DB_HOST: url.hostname,
    DB_PORT: url.port || "5432",
    DB_NAME: url.pathname.replace(/^\//, ""),
    DB_USER: decodeURIComponent(url.username) || "postgres",
    ...(url.password ? { DB_PASSWORD: decodeURIComponent(url.password) } : {}),
    LOG_FILE: "logs/open-brain-entrypoint-test.log",
    // A concrete LAN address, NOT loopback: `/health` exists to tell a client
    // WHICH machine it reached, so `127.0.0.1` is not a valid answer and
    // identity resolution deliberately falls through it to real detection.
    OPEN_BRAIN_SERVER_IP: "192.0.2.99",
    OPENBRAIN_MIGRATIONS_DIR: "server/db/migrations",
    // One configured token, in the role the tool assertions need. The entrypoint
    // refuses to start with none, which is a separate test below.
    AUTH_TOKEN_AGENT: TOKEN,
    EMBEDDING_BASE_URL: EMBEDDING_URL,
    EMBEDDING_MODEL,
    OPENBRAIN_JEV_SEARCH_ENABLED: "1",
    OPENBRAIN_JEV_API_KEY: "entrypoint-test-key",
    OPENBRAIN_JEV_BASE_URL: JEV_URL,
  });
  if (!result.ok) {
    throw new Error(`invalid test configuration: ${JSON.stringify(result.issues)}`);
  }
  return result.config;
}

let started: StartedServer | undefined;
let base = "";
const pool = new Pool({ connectionString: DB_URL });

beforeAll(async () => {
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${EMBEDDING_URL}/embeddings`) {
      return new Response(JSON.stringify({ data: [{ embedding: SEARCH_VECTOR }] }));
    }
    if (url === JEV_URL) {
      if (typeof init?.body !== "string") throw new Error("expected Jev JSON body");
      const request = JSON.parse(init.body) as {
        state: { records: Array<{ key: string; content: string }> };
        questions: Record<string, unknown>;
      };
      jevRequests.push(request as unknown as Record<string, unknown>);
      if (jevMode === "malformed") {
        return new Response(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: {},
            usage: { input_tokens: 12, output_tokens: 4 },
          }),
        );
      }
      const promotedKey = `thought:${SEARCH_IDS.promoted}`;
      const answers = Object.fromEntries(
        Object.keys(request.questions).map((questionId, index) => {
          const record = request.state.records[index];
          return [
            questionId,
            { type: "noul", noul: record?.key === promotedKey ? 0.99 : 0.01 },
          ];
        }),
      );
      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers,
          usage: { input_tokens: 12, output_tokens: 4 },
        }),
      );
    }
    return originalFetch(input, init);
  };
  started = await startServer({
    config: testConfig(),
    // Port 0 asks the kernel for an ephemeral port. Nothing well-known binds,
    // so this can run beside the dogfood service without contending for 3100.
    port: 0,
    bindHost: "127.0.0.1",
    logger: silentLogger(),
    allowedOrigins: [],
  });
  base = `http://127.0.0.1:${started.port}`;
  const rows = [
    [
      SEARCH_IDS.first,
      SEARCH_NAMESPACE,
      `${SEARCH_TOKEN} ${SEARCH_TOKEN} ${SEARCH_TOKEN} first`,
      8,
    ],
    [SEARCH_IDS.second, SEARCH_NAMESPACE, `${SEARCH_TOKEN} ${SEARCH_TOKEN} second`, 6],
    [SEARCH_IDS.promoted, SEARCH_NAMESPACE, `${SEARCH_TOKEN} promoted`, 4],
    [
      SEARCH_IDS.foreign,
      "someone-else",
      `${SEARCH_TOKEN} ${SEARCH_TOKEN} ${SEARCH_TOKEN} ${SEARCH_TOKEN} foreign`,
      10,
    ],
  ] as const;
  for (const [id, namespace, content, usefulness] of rows) {
    await pool.query(
      `INSERT INTO thoughts
         (id, content, tags, source, created_by, created_at, updated_at,
          namespace, tier, usefulness_score, access_count, embedding)
       VALUES ($1, $2, $3::text[], 'jev-entrypoint-fixture', 'test',
               '2026-01-02T03:04:05.000Z', '2026-01-02T03:04:05.000Z', $4,
               'warm', $5, 0, $6::halfvec)`,
      [id, content, [SEARCH_TOKEN], namespace, usefulness, SEARCH_VECTOR_LITERAL],
    );
  }
});

afterAll(async () => {
  await pool.query("DELETE FROM thoughts WHERE id = ANY($1::uuid[])", [
    Object.values(SEARCH_IDS),
  ]);
  await started?.shutdown();
  started = undefined;
  await pool.end();
  globalThis.fetch = originalFetch;
});

async function callSearchBrain(): Promise<string[]> {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
  });
  const client = new Client({ name: "jev-entrypoint-client", version: "1.0.0" });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: "search_brain",
      arguments: {
        query: SEARCH_TOKEN,
        namespace: SEARCH_NAMESPACE,
        table: "thoughts",
        mode: "hybrid",
        limit: 1,
      },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    return (JSON.parse(text ?? "[]") as Array<{ id: string }>).map(({ id }) => id);
  } finally {
    await client.close();
  }
}

async function callRestSearch(): Promise<string[]> {
  const response = await originalFetch(
    `${base}/api/v1/search?q=${SEARCH_TOKEN}&namespace=${SEARCH_NAMESPACE}&table=thoughts&mode=hybrid&limit=1`,
    { headers: { authorization: `Bearer ${TOKEN}` } },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { results: Array<{ id: string }> };
  return body.results.map(({ id }) => id);
}

describe("rewrite entrypoint start-equivalence (live Postgres)", () => {
  test("binds an ephemeral port and answers the frozen /health shape", async () => {
    const response = await fetch(`${base}/health`);
    // 200 healthy or 503 degraded are both valid: the embedding provider may
    // not be running beside a test database. What must NOT vary is the SHAPE,
    // which is the charter's frozen `/health` row and what production-host's aggregate
    // front reads out of each worker.
    expect([200, 503]).toContain(response.status);
    // Typed against the frozen shape rather than `Record<string, unknown>`, so
    // a field that DISAPPEARS is a compile error here and not just a runtime
    // `undefined` that an assertion happens to notice.
    const body = (await response.json()) as SingleWorkerHealth;
    expect(["healthy", "degraded"]).toContain(body.status);
    expect(body.server_ip).toBe("192.0.2.99");
    expect(body.server_ips).toEqual(["192.0.2.99"]);
    expect(body.hostname.length).toBeGreaterThan(0);
    expect(body.database).toMatchObject({ connected: true });
    expect(body.embedding).toHaveProperty("configured");
    expect(body.embedding).toHaveProperty("connected");
    // `not_runtime_available` is the CORRECT answer for an HTTP deployment, and
    // it is the same answer `src/index.ts` gives: `readNatsRuntimeBoundary`
    // (`src/nats-runtime.ts:500-503`) requires `OPENBRAIN_TRANSPORT=nats` AND an
    // enabled bridge AND an allowed URL before it says available, so a plain
    // HTTP worker reports unavailable and is still `healthy`, because the
    // degraded rule only fires when NATS was actually REQUESTED. Asserting
    // "available" here would have pinned a shape production never emits.
    expect(body.nats).toMatchObject({
      requested_transport: "http",
      availability: "not_runtime_available",
      fallback_http: true,
      consecutive_failures: 0,
      last_error: null,
    });
    expect(typeof body.nats.context_pack_subject).toBe("string");
    expect(typeof body.timestamp).toBe("string");
  });

  test("serves the REST surface behind the composed auth middleware", async () => {
    // Unauthenticated first. A REST route reachable without a token is the
    // failure mode a composition bug produces -- the router mounts, the auth
    // middleware does not -- and it is invisible to any test that only ever
    // sends a valid token.
    const anonymous = await fetch(`${base}/api/v1/entries/recent`);
    expect(anonymous.status).toBe(401);

    const authorized = await fetch(`${base}/api/v1/entries/recent?limit=1`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    // 200 with a body, or 404 if this deployment does not expose that exact
    // path -- but never 401, which is the thing being proven.
    expect(authorized.status).not.toBe(401);
  });

  test("refuses an unknown bearer token at the REST boundary", async () => {
    const response = await fetch(`${base}/api/v1/entries/recent`, {
      headers: { authorization: "Bearer not-the-configured-token" },
    });
    expect(response.status).toBe(401);
  });
});

describe("rewrite entrypoint audit and runtime composition (live Postgres)", () => {
  test("scoped REST and MCP search rerank the full authorized pool and fall back to exact RRF", async () => {
    jevMode = "rerank";
    jevRequests.length = 0;

    const restReranked = await callRestSearch();
    expect(jevRequests).toHaveLength(1);
    expect(restReranked).toEqual([SEARCH_IDS.promoted]);
    await expect(callSearchBrain()).resolves.toEqual([SEARCH_IDS.promoted]);

    expect(jevRequests).toHaveLength(2);
    for (const request of jevRequests) {
      const state = request.state as {
        records: Array<{ key: string; content: string }>;
      };
      expect(state.records.map(({ key }) => key)).toEqual([
        `thought:${SEARCH_IDS.first}`,
        `thought:${SEARCH_IDS.second}`,
        `thought:${SEARCH_IDS.promoted}`,
      ]);
      expect(JSON.stringify(request)).not.toContain(SEARCH_IDS.foreign);
      expect(JSON.stringify(request)).not.toContain("foreign");
    }

    jevMode = "malformed";
    await expect(callRestSearch()).resolves.toEqual([SEARCH_IDS.first]);
    await expect(callSearchBrain()).resolves.toEqual([SEARCH_IDS.first]);
  });

  test("answers a real MCP tool call and writes the audit row for it", async () => {
    const before = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM mcp_tool_audit_log WHERE operation = $1",
      ["get_contract"],
    );

    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    });
    const client = new Client({ name: "entrypoint-proof", version: "1.0.0" });
    // `connect` performs the real initialize handshake over real HTTP against
    // the listener the entrypoint opened.
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.length).toBeGreaterThan(0);
      // `get_contract` is the agent's whole capability surface
      // (`docs/decisions/contract-is-the-agent-surface.md`), so it is the right
      // single call to prove the tool boundary is really mounted.
      const result = await client.callTool({
        name: "get_contract",
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
    }

    // AUDIT EVIDENCE. `installMcpAudit` writes asynchronously after the handler
    // returns, so the row can trail the response. Poll rather than sleep a fixed
    // interval: a fixed sleep either flakes or wastes the time it over-waits.
    let after = before;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      after = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM mcp_tool_audit_log WHERE operation = $1",
        ["get_contract"],
      );
      if (Number(after.rows[0]?.count) > Number(before.rows[0]?.count)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(Number(after.rows[0]?.count)).toBeGreaterThan(Number(before.rows[0]?.count));

    // The row must carry the identity the BEARER TOKEN resolved to, not
    // anything the client sent. That chain -- token -> middleware -> req.auth ->
    // SDK extra -> audit summary -- is the composition this file exists to
    // prove, and a null caller_role here means the audit wrapper was installed
    // but the auth seam was not connected to it.
    const row = await pool.query<{
      caller_role: string | null;
      caller_client_id: string | null;
      status: string;
    }>(
      `SELECT caller_role, caller_client_id, status
         FROM mcp_tool_audit_log
        WHERE operation = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      ["get_contract"],
    );
    // "success" is the literal `src/audit-log.ts:377` writes for a non-error
    // tool result; the other states are "error", "exception", and
    // "validation_error".
    expect(row.rows[0]?.status).toBe("success");
    expect(row.rows[0]?.caller_role).toBe("agent");
    expect(row.rows[0]?.caller_client_id).toBe("agent");
  });

  test("composes the maintenance runner into the ordered shutdown list", () => {
    // A runtime that is RUNNING but absent from this list is the abandoned-lease
    // bug the drain exists to prevent, and it fails silently: rows sit `running`
    // under a live lease with no handler. Asserting the composed order here is
    // what makes the entrypoint's wiring observable rather than inferred.
    expect(
      started?.application.backgroundRuntimes.map((runtime) => runtime.name),
    ).toEqual(["maintenance"]);
  });
});

describe("rewrite entrypoint embedding provenance (live Postgres)", () => {
  test("a tool write stores the embedding model name, not the provider URL (#1463)", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    });
    const client = new Client({ name: "embedding-model-proof", version: "1.0.0" });
    await client.connect(transport);
    let id: string | undefined;
    try {
      const result = await client.callTool({
        name: "log_thought",
        arguments: { content: `${SEARCH_TOKEN} embedding model provenance` },
      });
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
      id = (JSON.parse(text ?? "{}") as { id?: string }).id;
      const row = await pool.query<{ embedding_model: string | null }>(
        "SELECT embedding_model FROM thoughts WHERE id = $1",
        [id],
      );
      expect(row.rows[0]?.embedding_model).toBe(EMBEDDING_MODEL);
    } finally {
      await client.close();
      if (id) await pool.query("DELETE FROM thoughts WHERE id = $1", [id]);
    }
  });
});

describe("automatic REM serving composition (live Postgres)", () => {
  test("supplies production REM signals to the autostarted maintenance producer", async () => {
    const config = testConfig();
    const remStartedAt = new Date();
    const remServer = await startServer({
      config: {
        ...config,
        maintenance: {
          ...config.maintenance,
          pollIntervalMs: 50,
          rem: {
            enabled: true,
            backlogHighWater: 1,
            maxRequestsPerMinute: 1,
            minHeadroomBytes: 1,
            forcedSliceSize: 1,
            minGapMs: 0,
          },
        },
      },
      port: 0,
      bindHost: "127.0.0.1",
      logger: silentLogger(),
      allowedOrigins: [],
    });

    let jobIds: string[] = [];
    try {
      for (let attempt = 0; attempt < 40 && jobIds.length === 0; attempt += 1) {
        const result = await pool.query<{ id: string }>(
          `SELECT id
             FROM maintenance_jobs
            WHERE job_kind = 'dream.rem'
              AND created_at >= $1`,
          [remStartedAt],
        );
        jobIds = result.rows.map((row) => row.id);
        if (jobIds.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      expect(jobIds.length).toBeGreaterThan(0);
    } finally {
      await remServer.shutdown();
      const created = await pool.query<{ id: string }>(
        `SELECT id
           FROM maintenance_jobs
          WHERE job_kind = 'dream.rem'
            AND created_at >= $1`,
        [remStartedAt],
      );
      jobIds = created.rows.map((row) => row.id);
      if (jobIds.length > 0) {
        await pool.query(`DELETE FROM maintenance_jobs WHERE id = ANY($1::uuid[])`, [
          jobIds,
        ]);
      }
    }
  });
});

describe("rewrite entrypoint startup and shutdown ordering (live Postgres)", () => {
  test("starts on an environment whose optional secrets are present but empty", async () => {
    // The 2026-08-02 deploy failure, as a live boot rather than a unit parse.
    // `server/config.test.ts` pins the parse-boundary semantics for all eight
    // optional-secret fields; this proves the ENTRYPOINT actually comes up on
    // that environment, which is the claim start-equivalence makes and the one
    // the previous fixtures never exercised — every env they built either set
    // an optional secret to a real value or omitted the key entirely, so the
    // shape that broke production (`EMBEDDING_API_KEY=`, empty) had no test.
    const url = new URL(DB_URL);
    const result = parseServerConfig({
      DB_HOST: url.hostname,
      DB_PORT: url.port || "5432",
      DB_NAME: url.pathname.replace(/^\//, ""),
      DB_USER: decodeURIComponent(url.username) || "postgres",
      LOG_FILE: "logs/open-brain-entrypoint-empty-secret-test.log",
      // A concrete LAN address, NOT loopback: `/health` exists to tell a client
      // WHICH machine it reached, so `127.0.0.1` is not a valid answer and
      // identity resolution deliberately falls through it to real detection.
      OPEN_BRAIN_SERVER_IP: "192.0.2.99",
      OPENBRAIN_MIGRATIONS_DIR: "server/db/migrations",
      AUTH_TOKEN_AGENT: TOKEN,
      // Exactly the local clone env's shape: the MLX embedding server needs no
      // key, so the variable is exported empty rather than left unset.
      EMBEDDING_API_KEY: "",
      DB_PASSWORD: "",
      AUTH_TOKEN_ADMIN: "",
    });
    if (!result.ok) {
      throw new Error(
        `empty optional secrets must not fail config: ${JSON.stringify(result.issues)}`,
      );
    }
    const instance = await startServer({
      config: result.config,
      port: 0,
      bindHost: "127.0.0.1",
      logger: silentLogger(),
      runMigrations: false,
      allowedOrigins: [],
    });
    try {
      // A real listener answering the real health route. 503 is acceptable
      // because the embedding provider need not be up beside a test database.
      expect([200, 503]).toContain(
        (await fetch(`http://127.0.0.1:${instance.port}/health`)).status,
      );
      // The empty admin token must not have been registered as a credential:
      // a blank bearer token accepted as `admin` would be an auth hole.
      expect(result.config.authTokens.map(({ role }) => role)).toEqual(["agent"]);
      // Empty password/key were dropped rather than passed to pg / the provider.
      expect("password" in result.config.database).toBe(false);
      expect("embeddingApiKey" in result.config.transport).toBe(false);
    } finally {
      await instance.shutdown();
    }
  });

  test("refuses to start, and opens no listener, without configured tokens", async () => {
    const config = testConfig();
    const tokenless: ServerConfig = { ...config, authTokens: [] };
    await expect(
      startServer({
        config: tokenless,
        port: 0,
        bindHost: "127.0.0.1",
        logger: silentLogger(),
        runMigrations: false,
      }),
    ).rejects.toThrow("no auth tokens configured");
  });

  test("stops serving before it drains, and releases the pool last", async () => {
    const instance = await startServer({
      config: testConfig(),
      port: 0,
      bindHost: "127.0.0.1",
      logger: silentLogger(),
      runMigrations: false,
      allowedOrigins: [],
    });
    const address = `http://127.0.0.1:${instance.port}/health`;
    // Live before: the listener is real and answering.
    expect([200, 503]).toContain((await fetch(address)).status);

    const order: string[] = [];
    const runtimes = instance.application.backgroundRuntimes;
    expect(runtimes.length).toBeGreaterThan(0);
    for (const runtime of runtimes) {
      const original = runtime.stop.bind(runtime);
      (runtime as { stop: () => Promise<void> }).stop = async () => {
        // Recorded at the moment the drain begins. If the listener were still
        // open here, a late request could enqueue work the drain has already
        // passed -- which is why sessions close first.
        order.push(`stop:${runtime.name}`);
        await original();
      };
    }
    const originalEnd = instance.database.pool.end.bind(instance.database.pool);
    (instance.database.pool as { end: () => Promise<void> }).end = async () => {
      order.push("pool:end");
      await originalEnd();
    };

    await instance.shutdown();

    // The pool closes LAST. A maintenance drain that loses its pool mid-job
    // strands exactly the rows it had already leased.
    expect(order[order.length - 1]).toBe("pool:end");
    expect(order).toContain("stop:maintenance");
    expect(order.indexOf("stop:maintenance")).toBeLessThan(order.indexOf("pool:end"));

    // Dead after: the socket is closed, so the port no longer answers.
    await expect(fetch(address)).rejects.toThrow();
  });
});
