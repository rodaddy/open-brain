import { describe, expect, it } from "bun:test";

import {
  OpenBrainClient,
  OpenBrainHTTPError,
  OpenBrainProtocolError,
  OpenBrainToolError,
  FetchTransport,
  type Json,
  type Transport,
  type TransportResponse,
} from "../src/client.ts";
import { CURRENT_CONTRACT_HEADER } from "../src/contract.ts";
import { LaneAwareTransport, TEST_TOKEN, toolResult } from "./fakes.ts";

function makeClient(
  transport: Transport,
  overrides: Partial<ConstructorParameters<typeof OpenBrainClient>[1]> = {},
): OpenBrainClient {
  return new OpenBrainClient("https://brain.example", {
    token: TEST_TOKEN,
    namespace: "bilby",
    transport,
    ...overrides,
  });
}

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
    await Bun.sleep(0);
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

describe("FetchTransport bounded streaming", () => {
  async function withFetchResponse(
    response: Response,
    assertion: () => Promise<void>,
  ): Promise<void> {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => response) as unknown as typeof fetch;
    try {
      await assertion();
    } finally {
      globalThis.fetch = original;
    }
  }

  it("cancels oversized JSON before buffering the full body", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("1234"));
        controller.enqueue(new TextEncoder().encode("5678"));
      },
      cancel() {
        cancelled = true;
      },
    });
    await withFetchResponse(
      new Response(stream, { headers: { "content-type": "application/json" } }),
      async () => {
        const transport = new FetchTransport({ maxResponseBytes: 5 });
        await expect(
          transport.post("https://brain.example/mcp", {
            headers: {},
            json: {},
            timeout: 1,
          }),
        ).rejects.toBeInstanceOf(OpenBrainHTTPError);
      },
    );
    expect(cancelled).toBe(true);
  });

  it("cancels oversized SSE before buffering the full event stream", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"id":1}\n\n'));
        controller.enqueue(new TextEncoder().encode("x".repeat(64)));
      },
      cancel() {
        cancelled = true;
      },
    });
    await withFetchResponse(
      new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      }),
      async () => {
        const transport = new FetchTransport({ maxResponseBytes: 32 });
        await expect(
          transport.post("https://brain.example/mcp", {
            headers: {},
            json: {},
            timeout: 1,
            expectedId: 99,
          }),
        ).rejects.toBeInstanceOf(OpenBrainHTTPError);
      },
    );
    expect(cancelled).toBe(true);
  });

  it("returns once a matching complete SSE event arrives on an open stream", async () => {
    let cancelled = false;
    const matched = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"id":6}\n\n'));
        controller.enqueue(new TextEncoder().encode(`data: ${matched}\n\n`));
        // Deliberately never close: EOF is not part of a successful response.
      },
      cancel() {
        cancelled = true;
      },
    });
    await withFetchResponse(
      new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      }),
      async () => {
        const response = await new FetchTransport().post(
          "https://brain.example/mcp",
          {
            headers: {},
            json: {},
            timeout: 1,
            expectedId: 7,
          },
        );
        expect(response.text).toBe(`data: ${matched}\n\n`);
      },
    );
    expect(cancelled).toBe(true);
  });

  it("decodes a matching SSE event through the full client on an open stream", async () => {
    const original = globalThis.fetch;
    let request = 0;
    let toolStreamCancelled = false;
    globalThis.fetch = (async () => {
      request += 1;
      if (request === 1) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: "2025-03-26" },
          }),
          {
            headers: {
              "content-type": "application/json",
              "mcp-session-id": "stream-session",
            },
          },
        );
      }
      if (request === 2) {
        return new Response(null, { status: 202 });
      }
      const message = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
        },
      });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(`data: ${message}\n\n`),
            );
            // Deliberately remain open after the complete matching event.
          },
          cancel() {
            toolStreamCancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;
    try {
      const client = new OpenBrainClient("https://brain.example", {
        token: TEST_TOKEN,
        namespace: "bilby",
        transport: new FetchTransport(),
      });
      await expect(client.get_contract()).resolves.toEqual({ ok: true });
      expect(toolStreamCancelled).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("OpenBrainClient base-url policy", () => {
  it("rejects plain http to non-local hosts", () => {
    expect(
      () =>
        new OpenBrainClient("http://brain.example", {
          token: TEST_TOKEN,
          namespace: "bilby",
        }),
    ).toThrow();
  });

  it("allows localhost http and explicit insecure opt-in", () => {
    expect(
      () =>
        new OpenBrainClient("http://127.0.0.1:3100", {
          token: TEST_TOKEN,
          namespace: "bilby",
        }),
    ).not.toThrow();
    expect(
      () =>
        new OpenBrainClient("http://10.71.1.21:3100", {
          token: TEST_TOKEN,
          namespace: "bilby",
          allowInsecureHttp: true,
        }),
    ).not.toThrow();
  });
});

class ScriptedTransport implements Transport {
  readonly requests: Json[] = [];
  private toolResponses: TransportResponse[];
  private sessionCounter = 0;

  constructor(toolResponses: TransportResponse[]) {
    this.toolResponses = toolResponses;
  }

  async delete(): Promise<TransportResponse> {
    return { status: 200, headers: {}, text: "" };
  }

  async post(
    _url: string,
    options: { headers: Record<string, string>; json: Json; timeout: number },
  ): Promise<TransportResponse> {
    this.requests.push(structuredClone(options.json));
    const method = options.json["method"];
    if (method === "initialize") {
      this.sessionCounter += 1;
      return {
        status: 200,
        headers: {
          "content-type": "application/json",
          "mcp-session-id": `session-${this.sessionCounter}`,
        },
        text: JSON.stringify({
          jsonrpc: "2.0",
          id: options.json["id"],
          result: { protocolVersion: "2025-03-26" },
        }),
      };
    }
    if (method === "notifications/initialized") {
      return { status: 202, headers: {}, text: "" };
    }
    const next = this.toolResponses.shift();
    if (next === undefined) {
      throw new Error("no scripted response left");
    }
    // Rewrite the jsonrpc id to match the live request when the body is JSON.
    try {
      const parsed = JSON.parse(next.text) as Json;
      if ("id" in parsed) {
        parsed["id"] = options.json["id"];
        return { ...next, text: JSON.stringify(parsed) };
      }
    } catch {
      // non-JSON bodies pass through unchanged
    }
    return next;
  }
}

describe("OpenBrainClient protocol handling", () => {
  it("redacts secret-shaped material from tool error bodies", async () => {
    const secretText = ["token", "super-secret-material"].join("=");
    const transport = new ScriptedTransport([
      {
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          result: {
            isError: true,
            content: [{ type: "text", text: `denied: ${secretText}` }],
          },
        }),
      },
    ]);
    const client = makeClient(transport);
    let thrown: unknown = null;
    try {
      await client.log_thought({ content: "hello" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OpenBrainToolError);
    const message = (thrown as Error).message;
    expect(message).not.toContain("super-secret-material");
    expect(message).toContain("[REDACTED]");
  });

  it("re-initializes transparently when the MCP session expired", async () => {
    const transport = new ScriptedTransport([
      { status: 404, headers: {}, text: "session not found" },
      toolResult(0, { ok: true }),
    ]);
    const client = makeClient(transport);
    const result = await client.log_thought({ content: "retry me" });
    expect(result["ok"]).toBe(true);
    const initializeCalls = transport.requests.filter(
      (request) => request["method"] === "initialize",
    );
    expect(initializeCalls.length).toBe(2);
  });

  it("raises a typed HTTP error with the status code attached", async () => {
    const transport = new ScriptedTransport([
      { status: 503, headers: {}, text: "downstream unavailable" },
    ]);
    const client = makeClient(transport);
    let thrown: unknown = null;
    try {
      await client.log_thought({ content: "x" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OpenBrainHTTPError);
    expect((thrown as OpenBrainHTTPError).statusCode).toBe(503);
  });

  it("decodes SSE tool responses by matching the request id", async () => {
    const sseTransport: Transport = {
      async delete() {
        return { status: 200, headers: {}, text: "" };
      },
      async post(_url, options): Promise<TransportResponse> {
        const method = options.json["method"];
        if (method === "initialize") {
          return {
            status: 200,
            headers: {
              "content-type": "application/json",
              "mcp-session-id": "sse-session",
            },
            text: JSON.stringify({
              jsonrpc: "2.0",
              id: options.json["id"],
              result: { protocolVersion: "2025-03-26" },
            }),
          };
        }
        if (method === "notifications/initialized") {
          return { status: 202, headers: {}, text: "" };
        }
        const decoy = JSON.stringify({ jsonrpc: "2.0", id: "decoy" });
        const real = JSON.stringify({
          jsonrpc: "2.0",
          id: options.json["id"],
          result: {
            content: [{ type: "text", text: JSON.stringify({ via: "sse" }) }],
          },
        });
        return {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          text: [
            "event: message",
            `data: ${decoy}`,
            "",
            "event: message",
            `data: ${real}`,
            "",
          ].join("\n"),
        };
      },
    };
    const client = makeClient(sseTransport);
    const result = await client.log_thought({ content: "sse" });
    expect(result["via"]).toBe("sse");
  });
});
