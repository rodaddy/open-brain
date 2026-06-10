import { describe, expect, test, mock } from "bun:test";
import { buildTokenMap, verifyToken, authMiddleware } from "./auth.ts";
import type { AuthInfo } from "./types.ts";

// Helper: create mock Express req/res/next
function mockReq(headers: Record<string, string> = {}) {
  return {
    headers,
    auth: undefined as AuthInfo | undefined,
  } as unknown as { headers: Record<string, string>; auth?: AuthInfo };
}

function mockRes() {
  let statusCode = 200;
  let body: unknown = undefined;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: unknown) {
      body = data;
      return res;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
  return res;
}

describe("buildTokenMap", () => {
  test("builds map from env vars with correct roles", () => {
    const env: Record<string, string | undefined> = {
      AUTH_TOKEN_ADMIN: "admin-token-123",
      AUTH_TOKEN_AGENT: "agent-token-456",
      AUTH_TOKEN_DISCORD: "discord-token-789",
      AUTH_TOKEN_N8N: "n8n-token-abc",
      AUTH_TOKEN_READONLY: "readonly-token-def",
    };
    const map = buildTokenMap(env);
    expect(map.size).toBe(5);
    expect(map.get("admin-token-123")).toEqual({
      role: "admin",
      clientId: "admin",
    });
    expect(map.get("agent-token-456")).toEqual({
      role: "agent",
      clientId: "agent",
    });
    expect(map.get("discord-token-789")).toEqual({
      role: "discord",
      clientId: "discord",
    });
    expect(map.get("n8n-token-abc")).toEqual({
      role: "n8n",
      clientId: "n8n",
    });
    expect(map.get("readonly-token-def")).toEqual({
      role: "readonly",
      clientId: "readonly",
    });
  });

  test("skips undefined env vars", () => {
    const env: Record<string, string | undefined> = {
      AUTH_TOKEN_ADMIN: "admin-token",
      AUTH_TOKEN_AGENT: undefined,
    };
    const map = buildTokenMap(env);
    expect(map.size).toBe(1);
    expect(map.has("admin-token")).toBe(true);
  });

  test("skips empty string env vars", () => {
    const env: Record<string, string | undefined> = {
      AUTH_TOKEN_ADMIN: "",
      AUTH_TOKEN_READONLY: "readonly-token",
    };
    const map = buildTokenMap(env);
    expect(map.size).toBe(1);
    expect(map.has("readonly-token")).toBe(true);
  });
});

describe("verifyToken", () => {
  test("returns true for matching tokens", () => {
    expect(verifyToken("my-secret-token", "my-secret-token")).toBe(true);
  });

  test("returns false for non-matching tokens of same length", () => {
    expect(verifyToken("aaaa-bbbb-cccc", "xxxx-yyyy-zzzz")).toBe(false);
  });

  test("returns false for tokens of different lengths", () => {
    expect(verifyToken("short", "much-longer-token")).toBe(false);
  });

  test("returns false for empty provided token", () => {
    expect(verifyToken("", "expected-token")).toBe(false);
  });
});

describe("authMiddleware", () => {
  const tokenMap = new Map<string, AuthInfo>([
    ["valid-admin-token", { role: "admin", clientId: "admin" }],
    ["valid-agent-token", { role: "agent", clientId: "agent" }],
    ["valid-readonly-token", { role: "readonly", clientId: "readonly" }],
  ]);

  const middleware = authMiddleware(tokenMap);

  test("returns 401 when no Authorization header", () => {
    const req = mockReq({});
    const res = mockRes();
    const next = mock(() => {});

    middleware(req as any, res as any, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Missing Bearer token" });
    expect(next).not.toHaveBeenCalled();
  });

  test("returns 401 when Authorization is not Bearer scheme", () => {
    const req = mockReq({ authorization: "Basic dXNlcjpwYXNz" });
    const res = mockRes();
    const next = mock(() => {});

    middleware(req as any, res as any, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Missing Bearer token" });
    expect(next).not.toHaveBeenCalled();
  });

  test("returns 401 when token is invalid", () => {
    const req = mockReq({ authorization: "Bearer wrong-token" });
    const res = mockRes();
    const next = mock(() => {});

    middleware(req as any, res as any, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Invalid token" });
    expect(next).not.toHaveBeenCalled();
  });

  test("sets req.auth and calls next for valid admin token", () => {
    const req = mockReq({ authorization: "Bearer valid-admin-token" });
    const res = mockRes();
    const next = mock(() => {});

    middleware(req as any, res as any, next);

    expect((req as any).auth).toEqual({
      role: "admin",
      clientId: "admin",
      tokenClientId: "admin",
      agentId: undefined,
      namespaceSource: "token",
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("sets req.auth and calls next for valid agent token", () => {
    const req = mockReq({ authorization: "Bearer valid-agent-token" });
    const res = mockRes();
    const next = mock(() => {});

    middleware(req as any, res as any, next);

    expect((req as any).auth).toEqual({
      role: "agent",
      clientId: "agent",
      tokenClientId: "agent",
      agentId: undefined,
      namespaceSource: "token",
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("uses X-Namespace as effective clientId and keeps token identity", () => {
    const req = mockReq({
      authorization: "Bearer valid-agent-token",
      "x-namespace": "bilby",
      "x-agent-id": "bilby",
      "x-role": "agent",
    });
    const res = mockRes();
    const next = mock(() => {});

    middleware(req as any, res as any, next);

    expect((req as any).auth).toEqual({
      role: "agent",
      clientId: "bilby",
      tokenClientId: "agent",
      agentId: "bilby",
      namespaceSource: "header",
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("returns 403 when readonly token sends X-Namespace", () => {
    const req = mockReq({
      authorization: "Bearer valid-readonly-token",
      "x-namespace": "bilby",
    });
    const res = mockRes();
    const next = mock(() => {});

    middleware(req as any, res as any, next);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "Role not permitted to delegate namespace" });
    expect(next).not.toHaveBeenCalled();
  });

  test("rejects invalid delegated namespace header", () => {
    const req = mockReq({
      authorization: "Bearer valid-agent-token",
      "x-namespace": "../bilby",
    });
    const res = mockRes();
    const next = mock(() => {});

    middleware(req as any, res as any, next);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "Invalid X-Namespace header" });
    expect(next).not.toHaveBeenCalled();
  });

  test("handles empty token map gracefully", () => {
    const emptyMiddleware = authMiddleware(new Map());
    const req = mockReq({ authorization: "Bearer any-token" });
    const res = mockRes();
    const next = mock(() => {});

    emptyMiddleware(req as any, res as any, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Invalid token" });
    expect(next).not.toHaveBeenCalled();
  });
});
