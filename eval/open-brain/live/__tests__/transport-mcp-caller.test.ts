import { describe, expect, it } from "vitest";
import { createMcpCaller, LiveTransportError } from "../transport.ts";
import { fakeMcpClient } from "./transport-test-support.ts";

// The concrete MCP caller boundary: a thrown SDK error, a server isError body,
// and a success body must each be reduced to a content-free label or the raw
// response body, never a leaked remote message.

const baseOpts = {
  baseUrl: "http://127.0.0.1:3100",
  token: "tok",
  namespace: "ns-x",
  timeoutMs: 1000,
};

describe("createMcpCaller (concrete boundary sanitization)", () => {
  it("sanitizes a thrown connect error (no raw remote body)", async () => {
    const promise = createMcpCaller({
      ...baseOpts,
      clientFactory: () => ({
        client: fakeMcpClient({
          connect: async () => {
            throw new Error("HTTP 401 Unauthorized: token leaked-secret-xyz");
          },
        }),
        transport: {},
      }),
    });
    await expect(promise).rejects.toThrow(LiveTransportError);
    await expect(promise).rejects.toThrow("connect:unauthorized");
    await promise.catch((e) => {
      expect((e as Error).message).not.toContain("leaked-secret-xyz");
    });
  });

  it("sanitizes a thrown callTool error to a content-free label", async () => {
    const caller = await createMcpCaller({
      ...baseOpts,
      clientFactory: () => ({
        client: fakeMcpClient({
          callTool: async () => {
            throw new Error("stream broke: row body 'private grommet note' 500");
          },
        }),
        transport: {},
      }),
    });
    const call = caller.callTool("search_brain", { query: "q" });
    await expect(call).rejects.toThrow(LiveTransportError);
    await call.catch((e) => {
      expect((e as LiveTransportError).label).toBe("search_brain:http-500");
      expect((e as Error).message).not.toContain("grommet");
    });
  });
});

describe("createMcpCaller response body handling", () => {
  it("redacts a server isError body to a content-free label (not thrown)", async () => {
    const caller = await createMcpCaller({
      ...baseOpts,
      clientFactory: () => ({
        client: fakeMcpClient({
          callTool: async () => ({
            content: [{ type: "text", text: "Permission denied: secret body abc" }],
            isError: true,
          }),
        }),
        transport: {},
      }),
    });
    const res = await caller.callTool("search_brain", { query: "q" });
    expect(res.isError).toBe(true);
    expect(res.denied).toBe(true);
    expect(res.errorLabel).toBe("search_brain:permission-denied");
    expect(res.data).toBe("");
  });

  it("returns the response body only on success, for structured parsing", async () => {
    const body = JSON.stringify({ id: "srv-1", namespace: "ns-x" });
    const caller = await createMcpCaller({
      ...baseOpts,
      clientFactory: () => ({
        client: fakeMcpClient({
          callTool: async () => ({
            content: [{ type: "text", text: body }],
            isError: false,
          }),
        }),
        transport: {},
      }),
    });
    const res = await caller.callTool("log_thought", { content: "c" });
    expect(res.isError).toBe(false);
    expect(res.data).toBe(body);
    expect(res.errorLabel).toBe("");
  });

  it("sanitizes a thrown close error to a content-free label", async () => {
    const caller = await createMcpCaller({
      ...baseOpts,
      clientFactory: () => ({
        client: fakeMcpClient({
          close: async () => {
            throw new Error("close failed 503: leftover private body text");
          },
        }),
        transport: {},
      }),
    });
    const close = caller.close();
    await expect(close).rejects.toThrow(LiveTransportError);
    await close.catch((e) => {
      expect((e as LiveTransportError).label).toBe("close:http-503");
      expect((e as Error).message).not.toContain("private body");
    });
  });
});
