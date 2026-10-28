import { describe, expect, it } from "vitest";

import { OpenBrainClient, OpenBrainHTTPError, FetchTransport } from "../src/client.ts";
import { TEST_TOKEN } from "./fakes.ts";

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

describe("FetchTransport bounded streaming", () => {
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
});

describe("FetchTransport bounded streaming", () => {
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
        const response = await new FetchTransport().post("https://brain.example/mcp", {
          headers: {},
          json: {},
          timeout: 1,
          expectedId: 7,
        });
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
            controller.enqueue(new TextEncoder().encode(`data: ${message}\n\n`));
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
