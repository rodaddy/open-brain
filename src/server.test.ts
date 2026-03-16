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
// The mock intercepts only LiteLLM health checks (non-localhost URLs with /health).
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
  it("returns degraded status when LiteLLM is unreachable", async () => {
    // Mock fetch to simulate LiteLLM being unreachable
    (globalThis as Record<string, unknown>).fetch = (
      input: string | URL | globalThis.Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/health") && !url.includes("127.0.0.1")) {
        return Promise.reject(new Error("connection refused"));
      }
      return originalFetch(input, init);
    };

    const res = await fetch(`${baseUrl}/health`);
    const body = (await res.json()) as HealthStatus;
    expect(body.litellm.connected).toBe(false);
    expect(body.database.connected).toBe(true);
    expect(typeof body.timestamp).toBe("string");
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

  it("is accessible without Authorization header", async () => {
    const res = await fetch(`${baseUrl}/health`);
    // Should NOT be 401 -- health is public
    expect(res.status).not.toBe(401);
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
});
