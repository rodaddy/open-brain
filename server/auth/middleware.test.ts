/**
 * Serving-path auth middleware: who may stamp an agent id (issue 684, S2).
 *
 * Only `admin` and `ob-admin` have X-Agent-Id honoured as-is. Every other role
 * keeps working but its claim is recorded as `unverified:<claim>`, so a token
 * cannot write an arbitrary agent id onto audit and trace records.
 */
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";
import type { AuthTokenConfig } from "../config.ts";
import { createAuthMiddleware, requestAuth } from "./middleware.ts";

const AGENT_TOKEN = randomUUID();
const ADMIN_TOKEN = randomUUID();
const OB_ADMIN_TOKEN = randomUUID();
const TOKENS: Record<string, string> = {
  agent: AGENT_TOKEN,
  admin: ADMIN_TOKEN,
  "ob-admin": OB_ADMIN_TOKEN,
};

const CONFIGURED: AuthTokenConfig[] = [
  { token: AGENT_TOKEN, role: "agent", clientId: "bilby" },
  { token: ADMIN_TOKEN, role: "admin", clientId: "admin" },
  { token: OB_ADMIN_TOKEN, role: "ob-admin", clientId: "ob-admin" },
];

interface Outcome {
  readonly status: number;
  readonly nextCalled: boolean;
  readonly request: Request;
}

function run(role: string, headers: Record<string, string> = {}): Outcome {
  const request = {
    headers: { authorization: `Bearer ${TOKENS[role]}`, ...headers },
  } as unknown as Request;
  let status = 200;
  const response = {
    status(code: number) {
      status = code;
      return response;
    },
    json() {
      return response;
    },
  } as unknown as Response;
  let nextCalled = false;
  createAuthMiddleware(CONFIGURED)(request, response, () => {
    nextCalled = true;
  });
  return { status, nextCalled, request };
}

describe("createAuthMiddleware X-Agent-Id role gate (issue 684)", () => {
  it("records a non-admin claim in the unverified form", () => {
    const outcome = run("agent", { "x-agent-id": "victim" });
    expect(outcome.nextCalled).toBe(true);
    expect(requestAuth(outcome.request)?.agentId).toBe("unverified:victim");
  });

  it("honours X-Agent-Id for admin", () => {
    const outcome = run("admin", { "x-agent-id": "victim" });
    expect(requestAuth(outcome.request)?.agentId).toBe("victim");
  });

  it("honours X-Agent-Id for ob-admin", () => {
    const outcome = run("ob-admin", { "x-agent-id": "victim" });
    expect(requestAuth(outcome.request)?.agentId).toBe("victim");
  });

  it("refuses a bad-shape agent id with 400 for a non-admin role", () => {
    const outcome = run("agent", { "x-agent-id": "bad id:with/punct" });
    expect(outcome.status).toBe(400);
    expect(outcome.nextCalled).toBe(false);
  });

  it("sets no agent id when the header is absent", () => {
    const outcome = run("agent");
    expect(outcome.nextCalled).toBe(true);
    expect(requestAuth(outcome.request)?.agentId).toBeUndefined();
  });
});
