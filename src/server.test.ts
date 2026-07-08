import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "bun:test";
import { createApp } from "./index.ts";
import { getSessionCount } from "./transport.ts";
import { createNatsBridgeHealth } from "./nats-bridge.ts";
import { resetOperatorDoctorCache } from "./operator-doctor.ts";
import { readNatsRuntimeBoundary } from "./nats-runtime.ts";
import type { AuthInfo, HealthStatus } from "./types.ts";
import type { Server } from "node:http";

// -- Mock pool ----------------------------------------------------------------
const defaultMockQuery = async (sql: string) => {
  if (sql.trim() === "SELECT 1") {
    return { rows: [{ "?column?": 1 }] };
  }
  return { rows: [] };
};

const mockPool = {
  query: defaultMockQuery,
  totalCount: 1,
  idleCount: 1,
  waitingCount: 0,
} as any; // eslint-disable-line @typescript-eslint/no-explicit-any

// -- Token map ----------------------------------------------------------------
const testTokenMap = new Map<string, AuthInfo>([
  ["test-token-123", { role: "admin" as const, clientId: "test" }],
  ["agent-token-123", { role: "agent" as const, clientId: "agent" }],
]);

// -- Server lifecycle ---------------------------------------------------------
let server: Server;
let baseUrl: string;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  const app = createApp(mockPool, testTokenMap);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  // Restore original fetch
  (globalThis as Record<string, unknown>).fetch = originalFetch;

  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

// -- Isolated mock management -------------------------------------------------
beforeEach(() => {
  // Reset pool query to default before each test
  mockPool.query = defaultMockQuery;
  // Restore original fetch before each test
  (globalThis as Record<string, unknown>).fetch = originalFetch;
});

afterEach(() => {
  // Restore pool query and fetch after each test
  mockPool.query = defaultMockQuery;
  (globalThis as Record<string, unknown>).fetch = originalFetch;
});

// -- Helpers ------------------------------------------------------------------
// The mock intercepts only provider health checks (non-localhost URLs with /health).
// Test-side fetches to 127.0.0.1 pass through to Express normally.
function mockFetchOk() {
  (globalThis as Record<string, unknown>).fetch = (
    input: string | URL | globalThis.Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/health") && !url.includes("127.0.0.1")) {
      return Promise.resolve(new Response("{}", { status: 200 }));
    }
    return originalFetch(input, init);
  };
}

// -- Tests --------------------------------------------------------------------
describe("GET /health", () => {
  it("includes server IP identity", async () => {
    const originalServerIp = process.env.OPEN_BRAIN_SERVER_IP;
    process.env.OPEN_BRAIN_SERVER_IP = "10.71.1.21";

    try {
      const res = await fetch(`${baseUrl}/health`);
      const body = (await res.json()) as HealthStatus;

      expect(body.server_ip).toBe("10.71.1.21");
      expect(body.server_ips).toEqual(["10.71.1.21"]);
    } finally {
      if (originalServerIp === undefined) {
        delete process.env.OPEN_BRAIN_SERVER_IP;
      } else {
        process.env.OPEN_BRAIN_SERVER_IP = originalServerIp;
      }
    }
  });

  it("does not auto-disclose host interface IPs when identity is not configured", async () => {
    const originalServerIp = process.env.OPEN_BRAIN_SERVER_IP;
    delete process.env.OPEN_BRAIN_SERVER_IP;

    try {
      const res = await fetch(`${baseUrl}/health`);
      const body = (await res.json()) as HealthStatus;

      expect(body.server_ip).toBe("unknown");
      expect(body.server_ips).toEqual(["unknown"]);
    } finally {
      if (originalServerIp !== undefined) {
        process.env.OPEN_BRAIN_SERVER_IP = originalServerIp;
      }
    }
  });

  it("does not degrade when the embedding provider is unreachable", async () => {
    const originalEmbeddingBaseUrl = process.env.EMBEDDING_BASE_URL;
    process.env.EMBEDDING_BASE_URL = "http://embedding-provider:8791/v1";

    (globalThis as Record<string, unknown>).fetch = (
      input: string | URL | globalThis.Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/models") && !url.includes("127.0.0.1")) {
        return Promise.reject(new Error("connection refused"));
      }
      return originalFetch(input, init);
    };

    try {
      const res = await fetch(`${baseUrl}/health`);
      const body = (await res.json()) as HealthStatus;
      expect(body.status).toBe("healthy");
      expect(body.embedding.connected).toBe(false);
      expect(body.database.connected).toBe(true);
      expect(body.nats.requested_transport).toBe("http");
      expect(typeof body.timestamp).toBe("string");
    } finally {
      if (originalEmbeddingBaseUrl === undefined) {
        delete process.env.EMBEDDING_BASE_URL;
      } else {
        process.env.EMBEDDING_BASE_URL = originalEmbeddingBaseUrl;
      }
    }
  });

  it("returns 503 when pool query throws", async () => {
    mockFetchOk();

    // Make pool.query throw for this test
    mockPool.query = async () => {
      throw new Error("connection refused");
    };

    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(503);

    const body = (await res.json()) as HealthStatus;
    expect(body.status).toBe("degraded");
    expect(body.database.connected).toBe(false);
  });

  it("returns 503 when requested NATS bridge health degrades after startup", async () => {
    const natsBoundary = readNatsRuntimeBoundary({
      OPENBRAIN_TRANSPORT: "nats",
      OPENBRAIN_NATS_ENABLE_BRIDGE: "true",
      OPENBRAIN_NATS_URL: "nats://127.0.0.1:4222",
    });
    const natsBridgeHealth = createNatsBridgeHealth("available");
    const app = createApp(mockPool, testTokenMap, {
      pool: mockPool,
      embedFn: async () => null,
      natsRuntimeBoundary: natsBoundary,
      natsBridgeHealth,
    });
    let isolatedServer: Server | null = null;

    try {
      const isolatedBaseUrl = await new Promise<string>((resolve) => {
        isolatedServer = app.listen(0, () => {
          const addr = isolatedServer?.address();
          const port = typeof addr === "object" && addr ? addr.port : 0;
          resolve(`http://127.0.0.1:${port}`);
        });
      });

      natsBridgeHealth.availability = "not_runtime_available";
      natsBridgeHealth.consecutiveFailures = 2;
      const sensitiveToken = ["sec", "ret"].join("");
      const brokerHost = ["broker", "internal"].join(".");
      natsBridgeHealth.lastError = [
        "iterator failed against nats://user:",
        sensitiveToken,
        "@",
        brokerHost,
        ":4222",
      ].join("");

      const res = await fetch(`${isolatedBaseUrl}/health`);
      expect(res.status).toBe(503);

      const body = (await res.json()) as HealthStatus;
      expect(body.status).toBe("degraded");
      expect(body.database.connected).toBe(true);
      expect(body.nats).toMatchObject({
        requested_transport: "nats",
        availability: "not_runtime_available",
        consecutive_failures: 2,
        last_error: "redacted",
      });
      expect(JSON.stringify(body)).not.toContain(sensitiveToken);
      expect(JSON.stringify(body)).not.toContain(brokerHost);
    } finally {
      if (isolatedServer) {
        await new Promise<void>((resolve, reject) => {
          isolatedServer?.close((err) => (err ? reject(err) : resolve()));
        });
      }
    }
  });

  it("is accessible without Authorization header", async () => {
    const res = await fetch(`${baseUrl}/health`);
    // Should NOT be 401 -- health is public
    expect(res.status).not.toBe(401);
  });
});

describe("GET /api/v1/operator/doctor", () => {
  beforeEach(() => {
    resetOperatorDoctorCache();
  });
  afterEach(() => {
    resetOperatorDoctorCache();
  });

  it("requires auth", async () => {
    const res = await fetch(`${baseUrl}/api/v1/operator/doctor`);
    expect(res.status).toBe(401);
  });

  it("requires admin or ob-admin auth", async () => {
    const res = await fetch(`${baseUrl}/api/v1/operator/doctor`, {
      headers: { Authorization: "Bearer agent-token-123" },
    });
    expect(res.status).toBe(403);
  });

  it("returns privileged doctor JSON without secret or path disclosure", async () => {
    const originalEmbeddingBaseUrl = process.env.EMBEDDING_BASE_URL;
    const originalEmbeddingApiKey = process.env.EMBEDDING_API_KEY;
    const originalLogFile = process.env.LOG_FILE;
    const secret = "doctor-rest-secret";
    const embeddingHost = "doctor-provider.internal";
    const logPath = "/sensitive/open-brain.log";
    process.env.EMBEDDING_BASE_URL = `http://${embeddingHost}:8791/v1`;
    process.env.EMBEDDING_API_KEY = secret;
    process.env.LOG_FILE = logPath;
    mockPool.query = async (sql: string) => {
      if (sql.trim() === "SELECT 1") return { rows: [{ ok: 1 }] };
      // Unknown migration state keeps the doctor healthy so this test can
      // pin the 200 path; the degraded/unhealthy 503 paths are pinned below.
      if (sql.includes("FROM _migrations")) throw new Error("not available");
      return { rows: [] };
    };
    (globalThis as Record<string, unknown>).fetch = (
      input: string | URL | globalThis.Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/models") && !url.includes("127.0.0.1")) {
        expect(init?.headers).toMatchObject({
          Authorization: `Bearer ${secret}`,
        });
        return Promise.resolve(new Response("{}", { status: 200 }));
      }
      return originalFetch(input, init);
    };

    try {
      const res = await fetch(`${baseUrl}/api/v1/operator/doctor`, {
        headers: { Authorization: "Bearer test-token-123" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        contract_version: string;
        runtime: { contract_version: string };
        embedding_provider: { available: boolean };
      };
      const serialized = JSON.stringify(body);
      expect(body.status).toBe("healthy");
      expect(body.contract_version).toBe("2026-07-08.operator-doctor.v2");
      expect(body.runtime.contract_version).toBe("2026-07-08.memory-tools.v20");
      expect(body.embedding_provider.available).toBe(true);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(embeddingHost);
      expect(serialized).not.toContain(logPath);
    } finally {
      if (originalEmbeddingBaseUrl === undefined) delete process.env.EMBEDDING_BASE_URL;
      else process.env.EMBEDDING_BASE_URL = originalEmbeddingBaseUrl;
      if (originalEmbeddingApiKey === undefined) delete process.env.EMBEDDING_API_KEY;
      else process.env.EMBEDDING_API_KEY = originalEmbeddingApiKey;
      if (originalLogFile === undefined) delete process.env.LOG_FILE;
      else process.env.LOG_FILE = originalLogFile;
    }
  });

  it("returns 503 when the doctor reports degraded (pending migrations)", async () => {
    const originalEmbeddingBaseUrl = process.env.EMBEDDING_BASE_URL;
    delete process.env.EMBEDDING_BASE_URL;
    mockPool.query = async (sql: string) => {
      if (sql.trim() === "SELECT 1") return { rows: [{ ok: 1 }] };
      // No migrations applied: everything on disk is pending.
      if (sql.includes("FROM _migrations")) return { rows: [] };
      return { rows: [] };
    };

    try {
      const res = await fetch(`${baseUrl}/api/v1/operator/doctor`, {
        headers: { Authorization: "Bearer test-token-123" },
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("degraded");
    } finally {
      if (originalEmbeddingBaseUrl === undefined) delete process.env.EMBEDDING_BASE_URL;
      else process.env.EMBEDDING_BASE_URL = originalEmbeddingBaseUrl;
    }
  });

  it("returns 503 when the doctor reports unhealthy (database down)", async () => {
    const originalEmbeddingBaseUrl = process.env.EMBEDDING_BASE_URL;
    delete process.env.EMBEDDING_BASE_URL;
    mockPool.query = async () => {
      throw new Error("connection refused");
    };

    try {
      const res = await fetch(`${baseUrl}/api/v1/operator/doctor`, {
        headers: { Authorization: "Bearer test-token-123" },
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        status: string;
        database: { connected: boolean };
      };
      expect(body.status).toBe("unhealthy");
      expect(body.database.connected).toBe(false);
    } finally {
      if (originalEmbeddingBaseUrl === undefined) delete process.env.EMBEDDING_BASE_URL;
      else process.env.EMBEDDING_BASE_URL = originalEmbeddingBaseUrl;
    }
  });
});

describe("POST /mcp", () => {
  it("returns 401 without Authorization header", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong Bearer token", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-token",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 with valid token and MCP initialize request", async () => {
    const initRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    };

    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token-123",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(initRequest),
    });

    expect(res.status).toBe(200);
    const sessionId = res.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    expect(typeof sessionId).toBe("string");
  });

  it("returns retryable session-cap diagnostics when initialize is over cap", async () => {
    const originalMax = process.env.OPEN_BRAIN_MAX_SESSIONS;
    const originalRetryAfter = process.env.OPEN_BRAIN_SESSION_RETRY_AFTER_SECONDS;
    const seed = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token-123",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      }),
    });
    expect(seed.status).toBe(200);
    const cappedAt = getSessionCount();
    expect(cappedAt).toBeGreaterThan(0);
    process.env.OPEN_BRAIN_MAX_SESSIONS = String(cappedAt);
    process.env.OPEN_BRAIN_SESSION_RETRY_AFTER_SECONDS = "7";

    try {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token-123",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0.0" },
          },
        }),
      });

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("7");
      expect(await res.json()).toEqual({
        error: "Too many active sessions",
        code: "session_cap_exceeded",
        active_sessions: getSessionCount(),
        max_sessions: cappedAt,
        retry_after_seconds: 7,
      });
    } finally {
      if (originalMax === undefined) {
        delete process.env.OPEN_BRAIN_MAX_SESSIONS;
      } else {
        process.env.OPEN_BRAIN_MAX_SESSIONS = originalMax;
      }
      if (originalRetryAfter === undefined) {
        delete process.env.OPEN_BRAIN_SESSION_RETRY_AFTER_SECONDS;
      } else {
        process.env.OPEN_BRAIN_SESSION_RETRY_AFTER_SECONDS = originalRetryAfter;
      }
    }
  });

  it("rejects session reuse under a different delegated namespace", async () => {
    const initRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    };

    const init = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token-123",
        Accept: "application/json, text/event-stream",
        "X-Namespace": "bilby",
        "X-Agent-Id": "bilby",
        "X-Role": "agent",
      },
      body: JSON.stringify(initRequest),
    });

    expect(init.status).toBe(200);
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const mismatchedPost = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token-123",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId!,
        "X-Namespace": "skippy",
        "X-Agent-Id": "skippy",
        "X-Role": "agent",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });

    expect(mismatchedPost.status).toBe(403);
    expect(await mismatchedPost.json()).toEqual({
      error: "Request identity does not match session",
    });

    const mismatchedGet = await fetch(`${baseUrl}/mcp`, {
      method: "GET",
      headers: {
        Authorization: "Bearer test-token-123",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId!,
        "X-Namespace": "skippy",
        "X-Agent-Id": "skippy",
        "X-Role": "agent",
      },
    });

    expect(mismatchedGet.status).toBe(403);

    const mismatchedDelete = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: {
        Authorization: "Bearer test-token-123",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId!,
        "X-Namespace": "skippy",
        "X-Agent-Id": "skippy",
        "X-Role": "agent",
      },
    });

    expect(mismatchedDelete.status).toBe(403);

    const cleanup = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: {
        Authorization: "Bearer test-token-123",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId!,
        "X-Namespace": "bilby",
        "X-Agent-Id": "bilby",
        "X-Role": "agent",
      },
    });

    expect(cleanup.status).toBe(200);
  });

  it("rejects session reuse with a different agent id", async () => {
    const initRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    };

    const init = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token-123",
        Accept: "application/json, text/event-stream",
        "X-Namespace": "bilby",
        "X-Agent-Id": "bilby",
        "X-Role": "agent",
      },
      body: JSON.stringify(initRequest),
    });

    expect(init.status).toBe(200);
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const reusedByDifferentAgent = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token-123",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId!,
        "X-Namespace": "bilby",
        "X-Agent-Id": "skippy",
        "X-Role": "agent",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });

    expect(reusedByDifferentAgent.status).toBe(403);

    const cleanup = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: {
        Authorization: "Bearer test-token-123",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId!,
        "X-Namespace": "bilby",
        "X-Agent-Id": "bilby",
        "X-Role": "agent",
      },
    });

    expect(cleanup.status).toBe(200);
  });
});
