import { describe, expect, it } from "vitest";

import {
  OpenBrainClient,
  OpenBrainHTTPError,
  OpenBrainToolError,
  type Json,
  type Transport,
  type TransportResponse,
} from "../src/client.ts";
import { TEST_TOKEN, toolResult } from "./fakes.ts";
import { makeClient } from "./client-test-support.ts";

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
        new OpenBrainClient("http://192.0.2.21:3100", {
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
});

describe("OpenBrainClient protocol handling", () => {
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
