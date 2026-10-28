import { describe, expect, it } from "vitest";

import {
  OpenBrainProtocolError,
  OpenBrainToolError,
  type Json,
  type Transport,
  type TransportResponse,
} from "../src/client.ts";
import { setTimeout as delay } from "node:timers/promises";

import { CURRENT_CONTRACT_HEADER } from "../src/contract.ts";
import { LaneAwareTransport, TEST_TOKEN, toolResult } from "./fakes.ts";
import { makeClient } from "./client-test-support.ts";

class DelayedInitializeTransport implements Transport {
  initializeCalls = 0;
  deleteCalls = 0;
  private resolveStarted!: () => void;
  private releaseGate!: () => void;
  readonly initializeStarted = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });

  releaseInitialize(): void {
    this.releaseGate();
  }

  async post(
    _url: string,
    options: {
      headers: Record<string, string>;
      json: Json;
      timeout: number;
      expectedId?: number;
    },
  ): Promise<TransportResponse> {
    const method = options.json["method"];
    const requestId = options.json["id"];
    if (method === "initialize") {
      this.initializeCalls += 1;
      this.resolveStarted();
      await this.gate;
      return {
        status: 200,
        headers: {
          "content-type": "application/json",
          "mcp-session-id": "delayed-session",
        },
        text: JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          result: { protocolVersion: "2025-03-26" },
        }),
      };
    }
    if (method === "notifications/initialized") {
      return { status: 202, headers: {}, text: "" };
    }
    return toolResult(requestId as number, { ok: true });
  }

  async delete(): Promise<TransportResponse> {
    this.deleteCalls += 1;
    return { status: 200, headers: {}, text: "" };
  }
}

class DualExpiredTransport implements Transport {
  initializeCalls = 0;
  private expireSessionOne = false;
  private sessionOneCalls = 0;
  private resolveBothExpired!: () => void;
  private resolveDelayedExpired!: () => void;
  private resolveReplacementInitialized!: () => void;
  private readonly bothExpired = new Promise<void>((resolve) => {
    this.resolveBothExpired = resolve;
  });
  private readonly delayedExpired = new Promise<void>((resolve) => {
    this.resolveDelayedExpired = resolve;
  });
  readonly replacementInitialized = new Promise<void>((resolve) => {
    this.resolveReplacementInitialized = resolve;
  });

  startConcurrentExpiry(): void {
    this.expireSessionOne = true;
  }

  releaseDelayedResponse(): void {
    this.resolveDelayedExpired();
  }

  async post(
    _url: string,
    options: {
      headers: Record<string, string>;
      json: Json;
      timeout: number;
      expectedId?: number;
    },
  ): Promise<TransportResponse> {
    const method = options.json["method"];
    const requestId = options.json["id"] as number;
    if (method === "initialize") {
      this.initializeCalls += 1;
      const sessionId = `session-${this.initializeCalls}`;
      if (this.initializeCalls === 2) {
        this.resolveReplacementInitialized();
      }
      return {
        status: 200,
        headers: {
          "content-type": "application/json",
          "mcp-session-id": sessionId,
        },
        text: JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          result: { protocolVersion: "2025-03-26" },
        }),
      };
    }
    if (method === "notifications/initialized") {
      return { status: 202, headers: {}, text: "" };
    }
    const sessionId = options.headers["Mcp-Session-Id"];
    if (this.expireSessionOne && sessionId === "session-1") {
      this.sessionOneCalls += 1;
      const callIndex = this.sessionOneCalls;
      if (callIndex === 2) {
        this.resolveBothExpired();
      }
      await this.bothExpired;
      if (callIndex === 2) {
        await this.delayedExpired;
      }
      return {
        status: 404,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({ error: "invalid or missing session" }),
      };
    }
    return toolResult(requestId, { session_id: sessionId });
  }

  async delete(): Promise<TransportResponse> {
    return { status: 200, headers: {}, text: "" };
  }
}

describe("OpenBrainClient header binding", () => {
  it("declares contract, bearer auth, and identity headers on every request", async () => {
    const transport = new LaneAwareTransport();
    const client = makeClient(transport, { agentId: "bilby", role: "agent" });
    await client.session_start({
      session_key: "repo/session-4",
      agent: "bilby",
      platform: "discord",
      server_id: "guild-1",
      channel_id: "channel-2",
      thread_id: "thread-3",
    });
    expect(transport.requests.length).toBeGreaterThan(0);
    for (const request of transport.requests) {
      expect(request.headers["X-OB-Contract"]).toBe(CURRENT_CONTRACT_HEADER);
      expect(request.headers["Authorization"]).toBe(`Bearer ${TEST_TOKEN}`);
      expect(request.headers["X-Agent-Id"]).toBe("bilby");
      expect(request.headers["X-Role"]).toBe("agent");
      // Namespace delegation is opt-in and OFF by default.
      expect("X-Namespace" in request.headers).toBe(false);
    }
    const toolCall = transport.requests.at(-1);
    expect(toolCall?.headers["Mcp-Session-Id"]).toBe("runtime-session");
    expect(toolCall?.headers["MCP-Protocol-Version"]).toBe("2025-03-26");
  });

  it("sends X-Namespace only when delegation is enabled", async () => {
    const transport = new LaneAwareTransport();
    const client = makeClient(transport, { delegateNamespace: true });
    await client.get_contract();
    for (const request of transport.requests) {
      expect(request.headers["X-Namespace"]).toBe("bilby");
    }
  });

  it("makes the fixture transport reject server-invalid repo fact enums", async () => {
    const client = makeClient(new LaneAwareTransport());
    await expect(
      client.upsert_repo_fact({
        metadata: {
          source_system: "qmd",
          repo: "rodaddy/open-brain",
          collection: "open-brain",
          path: "clients/ts/src/runtime.ts",
          subject: "fixture validation",
          fact_type: "not-a-real-fact-type",
          fact: "The fake must enforce the real nested schema.",
          source_commit: "386fee2b15b84cc2eb1f4a0aa84d7c023db9b7d2",
          source_url:
            "https://github.com/rodaddy/open-brain/blob/386fee2b15b84cc2eb1f4a0aa84d7c023db9b7d2/clients/ts/src/runtime.ts",
          verified_at: "2026-07-22T00:00:00.000Z",
          confidence: 1,
          staleness_policy: "commit_pinned",
        },
      }),
    ).rejects.toBeInstanceOf(OpenBrainToolError);
  });
});

describe("OpenBrainClient session concurrency", () => {
  it("coalesces concurrent first-use initialization", async () => {
    const transport = new DelayedInitializeTransport();
    const client = makeClient(transport);
    const first = client.get_contract();
    await transport.initializeStarted;
    const second = client.log_thought({ content: "parallel" });
    await delay(0);
    expect(transport.initializeCalls).toBe(1);
    transport.releaseInitialize();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true },
      { ok: true },
    ]);
    expect(client.mcpSessionId).toBe("delayed-session");
    await client.close();
    expect(transport.deleteCalls).toBe(1);
  });

  it("invalidates and cleans initialization that overlaps close", async () => {
    const transport = new DelayedInitializeTransport();
    const client = makeClient(transport);
    const request = client.get_contract();
    await transport.initializeStarted;
    const requestResult = request.catch((error: unknown) => error);
    const closeResult = client.close();
    transport.releaseInitialize();
    const error = await requestResult;
    await closeResult;
    expect(error).toBeInstanceOf(OpenBrainProtocolError);
    expect(transport.initializeCalls).toBe(1);
    expect(transport.deleteCalls).toBe(1);
    expect(client.mcpSessionId).toBeNull();

    await expect(client.get_contract()).resolves.toEqual({ ok: true });
    expect(transport.initializeCalls).toBe(2);
  });

  it("does not let a delayed old-session 404 clear the replacement session", async () => {
    const transport = new DualExpiredTransport();
    const client = makeClient(transport);
    await expect(client.get_contract()).resolves.toEqual({
      session_id: "session-1",
    });
    transport.startConcurrentExpiry();

    const first = client.log_thought({ content: "first" });
    const second = client.log_decision({
      title: "second",
      rationale: "exercise delayed expiry",
    });
    await transport.replacementInitialized;
    await expect(first).resolves.toEqual({ session_id: "session-2" });
    expect(client.mcpSessionId).toBe("session-2");

    transport.releaseDelayedResponse();
    await expect(second).resolves.toEqual({ session_id: "session-2" });
    expect(transport.initializeCalls).toBe(2);
    expect(client.mcpSessionId).toBe("session-2");
  });
});
