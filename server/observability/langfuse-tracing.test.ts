/**
 * Functional tests for the #530 content-ful tracing lane.
 *
 * The contract under test is the one the module states: every tool call emits
 * one trace carrying VERBATIM input and output plus caller identity, and a
 * tracing failure never fails, slows, or ALTERS a tool call. The second half is
 * the one that matters operationally, so the sink that throws on every method
 * is a first-class case here, not an afterthought.
 *
 * No SDK, no server, no socket: the client factory is injected, exactly the
 * seam `McpAuditDeps.now` provides for the audit lane.
 */
import { describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildToolTraceBody,
  createTracingRuntime,
  errorOutput,
  installMcpTracing,
  readMcpTracingConfig,
  resolveSessionId,
  type McpTracingConfig,
  type TracingSink,
} from "./langfuse-tracing.ts";

const ENABLED_CONFIG: McpTracingConfig = {
  enabled: true,
  endpoint: "http://10.71.20.50:3000",
  publicKey: "pk-lf-test",
  secretKey: "sk-lf-test",
};

/** A minimal stand-in for the SDK client that records what it was handed. */
function recordingSink(): TracingSink & { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  return {
    bodies,
    trace(body) {
      bodies.push(body);
      return {};
    },
    flushAsync: () => Promise.resolve(),
    shutdownAsync: () => Promise.resolve(),
  };
}

/** A sink that fails on every method — the best-effort contract's adversary. */
function throwingSink(): TracingSink {
  return {
    trace() {
      throw new Error("langfuse exploded with secret sk-lf-leak in the message");
    },
    flushAsync: () => Promise.reject(new Error("flush exploded")),
    shutdownAsync: () => Promise.reject(new Error("shutdown exploded")),
  };
}

/**
 * A fake `McpServer` exposing only `registerTool`, plus the handler capture the
 * assertions need. Structural, because the real class needs a transport.
 */
function fakeServer(): {
  server: McpServer;
  handlers: Map<string, (args: unknown, extra: unknown) => unknown>;
  originalRegisterTool: unknown;
} {
  const handlers = new Map<string, (args: unknown, extra: unknown) => unknown>();
  const registerTool = (name: string, _config: unknown, cb: unknown): void => {
    handlers.set(name, cb as (args: unknown, extra: unknown) => unknown);
  };
  const server = { registerTool } as unknown as McpServer;
  return { server, handlers, originalRegisterTool: registerTool };
}

const AUTH = {
  authInfo: {
    role: "admin" as const,
    clientId: "rico",
    tokenClientId: "rico",
    agentId: "worker-530",
    namespaceSource: "header" as const,
  },
};

describe("readMcpTracingConfig", () => {
  test("is disabled with no environment at all", () => {
    expect(readMcpTracingConfig({}).enabled).toBe(false);
  });

  test("is disabled when the coordinates are present but the flag is not set", () => {
    const config = readMcpTracingConfig({
      OPENBRAIN_TRACING_ENDPOINT: "http://host:3000",
      OPENBRAIN_TRACING_PUBLIC_KEY: "pk",
      OPENBRAIN_TRACING_SECRET_KEY: "sk",
    });
    expect(config.enabled).toBe(false);
  });

  test("is disabled when the flag is set but a coordinate is missing", () => {
    const config = readMcpTracingConfig({
      OPENBRAIN_TRACING_ENABLED: "1",
      OPENBRAIN_TRACING_ENDPOINT: "http://host:3000",
      OPENBRAIN_TRACING_PUBLIC_KEY: "pk",
    });
    expect(config.enabled).toBe(false);
    expect(config.secretKey).toBe("");
  });

  test("a whitespace-only coordinate counts as missing, not present", () => {
    expect(
      readMcpTracingConfig({
        OPENBRAIN_TRACING_ENABLED: "1",
        OPENBRAIN_TRACING_ENDPOINT: "  ",
        OPENBRAIN_TRACING_PUBLIC_KEY: "pk",
        OPENBRAIN_TRACING_SECRET_KEY: "sk",
      }).enabled,
    ).toBe(false);
  });

  test("the incomplete-flag warn is emitted, readable, and carries no key value", () => {
    const lines: string[] = [];
    // The shared logger emits warn lines through `console.warn` (src/logger.ts
    // :539). Captured, not mocked away, so the assertion sees the output of the
    // REAL redaction pass — which is the whole point of the test. Restored in a
    // `finally` because Bun runs every test file in one process.
    const originalWarn = console.warn;
    console.warn = (...parts: unknown[]): void => {
      lines.push(parts.map((part) => String(part)).join(" "));
    };
    try {
      readMcpTracingConfig({
        OPENBRAIN_TRACING_ENABLED: "1",
        OPENBRAIN_TRACING_ENDPOINT: "http://host:3000",
        OPENBRAIN_TRACING_PUBLIC_KEY: "pk-lf-visible",
        OPENBRAIN_TRACING_SECRET_KEY: "",
      });
    } finally {
      console.warn = originalWarn;
    }

    const warn = lines.find((line) =>
      line.includes("mcp_tool_tracing_config_incomplete"),
    );
    expect(warn).toBeDefined();
    // The whole point of the line: it names which coordinate is missing. A
    // field the logger redacts would report "[REDACTED]" and say nothing.
    expect(warn).toContain('"privateIdSet":false');
    expect(warn).toContain('"publicIdSet":true');
    expect(warn).not.toContain("REDACTED");
    expect(warn).not.toContain("pk-lf-visible");
  });

  test("only the exact flag value enables it", () => {
    expect(
      readMcpTracingConfig({
        OPENBRAIN_TRACING_ENABLED: "true",
        OPENBRAIN_TRACING_ENDPOINT: "http://host:3000",
        OPENBRAIN_TRACING_PUBLIC_KEY: "pk",
        OPENBRAIN_TRACING_SECRET_KEY: "sk",
      }).enabled,
    ).toBe(false);
  });

  test("enables with the flag and all three coordinates", () => {
    expect(
      readMcpTracingConfig({
        OPENBRAIN_TRACING_ENABLED: "1",
        OPENBRAIN_TRACING_ENDPOINT: "http://host:3000",
        OPENBRAIN_TRACING_PUBLIC_KEY: "pk-lf-1",
        OPENBRAIN_TRACING_SECRET_KEY: "sk-lf-1",
      }),
    ).toEqual({
      enabled: true,
      endpoint: "http://host:3000",
      publicKey: "pk-lf-1",
      secretKey: "sk-lf-1",
    });
  });
});

describe("resolveSessionId", () => {
  test("prefers a top-level session_key", () => {
    expect(
      resolveSessionId({ session_key: "sess-a" }, { sessionId: "transport-b" }),
    ).toBe("sess-a");
  });

  test("falls back to scope.session_key", () => {
    expect(
      resolveSessionId(
        { scope: { session_key: "sess-scoped" } },
        { sessionId: "transport-b" },
      ),
    ).toBe("sess-scoped");
  });

  test("falls back to the transport sessionId", () => {
    expect(resolveSessionId({ content: "x" }, { sessionId: "transport-b" })).toBe(
      "transport-b",
    );
  });

  test("is undefined when neither exists", () => {
    expect(resolveSessionId({ content: "x" }, {})).toBeUndefined();
  });
});

describe("installMcpTracing", () => {
  test("records one trace per call with verbatim input, output and caller identity", async () => {
    const sink = recordingSink();
    const { server, handlers } = fakeServer();
    installMcpTracing(server, {
      config: ENABLED_CONFIG,
      createSink: () => sink,
    });

    const result = { content: [{ type: "text", text: "the full answer body" }] };
    server.registerTool(
      "log_thought",
      { inputSchema: {} } as never,
      (() => result) as never,
    );

    const args = {
      content: "the full prompt body, verbatim",
      session_key: "sess-530",
    };
    await handlers.get("log_thought")?.(args, AUTH);

    expect(sink.bodies).toHaveLength(1);
    const body = sink.bodies[0] as Record<string, unknown>;
    expect(body.name).toBe("log_thought");
    // CONTENT-FUL is the requirement: the same objects, not a summary of them.
    expect(body.input).toBe(args);
    expect(body.output).toBe(result);
    expect(body.sessionId).toBe("sess-530");
    expect(body.userId).toBe("rico");
    expect(body.tags).toEqual(["open-brain-server", "mcp-tool"]);
    expect(body.metadata).toMatchObject({
      caller_role: "admin",
      caller_client_id: "rico",
      caller_agent_id: "worker-530",
      namespace_source: "header",
      status: "success",
    });
    expect(
      (body.metadata as { duration_ms: number }).duration_ms,
    ).toBeGreaterThanOrEqual(0);
  });

  test("an isError result is traced as status error, not success", async () => {
    const sink = recordingSink();
    const { server, handlers } = fakeServer();
    installMcpTracing(server, {
      config: ENABLED_CONFIG,
      createSink: () => sink,
    });
    server.registerTool(
      "search_memory",
      { inputSchema: {} } as never,
      (() => ({ isError: true, content: [] })) as never,
    );

    await handlers.get("search_memory")?.({ query: "x" }, AUTH);

    expect(
      (sink.bodies[0]?.metadata as { status: string }).status,
    ).toBe("error");
  });

  test("a sink that throws on every method leaves the result byte-identical and never throws", async () => {
    const { server, handlers } = fakeServer();
    const handle = installMcpTracing(server, {
      config: ENABLED_CONFIG,
      createSink: throwingSink,
    });

    const result = { content: [{ type: "text", text: "untouched" }] };
    server.registerTool(
      "log_thought",
      { inputSchema: {} } as never,
      (() => result) as never,
    );

    const returned = await handlers.get("log_thought")?.({ a: 1 }, AUTH);
    // Identity, not deep equality: the wrapper must return the tool's own
    // object, not a copy of it.
    expect(returned).toBe(result);
    expect(JSON.stringify(returned)).toBe(JSON.stringify(result));
    // Shutdown swallows its own failures too, or a tracing fault would make a
    // clean drain read as a dirty one.
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  test("a handler exception still propagates, traced as status exception with the error class", async () => {
    const sink = recordingSink();
    const { server, handlers } = fakeServer();
    installMcpTracing(server, {
      config: ENABLED_CONFIG,
      createSink: () => sink,
    });

    class NamespaceViolationError extends Error {
      override name = "NamespaceViolationError";
    }
    server.registerTool(
      "get_entity",
      { inputSchema: {} } as never,
      (() => {
        throw new NamespaceViolationError("entity 7 is not in namespace rico");
      }) as never,
    );

    await expect(
      handlers.get("get_entity")?.({ id: "7" }, AUTH),
    ).rejects.toThrow("entity 7 is not in namespace rico");

    expect(sink.bodies).toHaveLength(1);
    expect(
      (sink.bodies[0]?.metadata as { status: string }).status,
    ).toBe("exception");
    expect(sink.bodies[0]?.output).toEqual({
      error_class: "NamespaceViolationError",
      error_message: "entity 7 is not in namespace rico",
    });
  });

  test("disabled config leaves registerTool untouched — no wrapper at all", async () => {
    const sink = recordingSink();
    const { server, originalRegisterTool } = fakeServer();
    const handle = installMcpTracing(server, {
      config: { ...ENABLED_CONFIG, enabled: false },
      createSink: () => sink,
    });

    expect(server.registerTool as unknown).toBe(originalRegisterTool);
    expect(handle.active).toBe(false);
    await expect(handle.shutdown()).resolves.toBeUndefined();
    expect(sink.bodies).toHaveLength(0);
  });

  test("installing twice wraps once", async () => {
    const sink = recordingSink();
    const { server, handlers } = fakeServer();
    installMcpTracing(server, {
      config: ENABLED_CONFIG,
      createSink: () => sink,
    });
    installMcpTracing(server, {
      config: ENABLED_CONFIG,
      createSink: () => sink,
    });
    server.registerTool(
      "log_thought",
      { inputSchema: {} } as never,
      (() => ({ ok: true })) as never,
    );
    await handlers.get("log_thought")?.({}, AUTH);
    expect(sink.bodies).toHaveLength(1);
  });

  test("a sink factory that throws degrades to no tracing instead of failing install", () => {
    const { server, originalRegisterTool } = fakeServer();
    const handle = installMcpTracing(server, {
      config: ENABLED_CONFIG,
      createSink: () => {
        throw new Error("bad base url");
      },
    });
    expect(handle.active).toBe(false);
    expect(server.registerTool as unknown).toBe(originalRegisterTool);
  });

  test("a non-function third argument passes through unwrapped", () => {
    const sink = recordingSink();
    const { server } = fakeServer();
    installMcpTracing(server, {
      config: ENABLED_CONFIG,
      createSink: () => sink,
    });
    expect(() =>
      (server.registerTool as unknown as (...a: unknown[]) => unknown)(
        "odd_tool",
        { inputSchema: {} },
        undefined,
      ),
    ).not.toThrow();
  });
});

describe("createTracingRuntime — the composition root's seam", () => {
  test("disabled config yields no sink and a no-op shutdown", async () => {
    const runtime = createTracingRuntime({
      config: { ...ENABLED_CONFIG, enabled: false },
      createSink: recordingSink,
    });
    expect(runtime.sink).toBeUndefined();
    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });

  test("one shared sink serves many per-session servers and drains once", async () => {
    const sink = recordingSink();
    const runtime = createTracingRuntime({
      config: ENABLED_CONFIG,
      createSink: () => sink,
    });
    expect(runtime.sink).toBe(sink);

    // Two sessions, as `createServerFactory` produces: each gets its own
    // McpServer but they must NOT each build a client.
    const built = [fakeServer(), fakeServer()];
    for (const { server } of built) {
      const handle = installMcpTracing(server, {
        config: ENABLED_CONFIG,
        sink: runtime.sink!,
      });
      expect(handle.active).toBe(true);
      // A per-session handle must not drain a sink it does not own, or the
      // first session to close would flush and shut down tracing for the rest.
      await handle.shutdown();
      server.registerTool(
        "log_thought",
        { inputSchema: {} } as never,
        (() => ({ ok: true })) as never,
      );
    }
    for (const { handlers } of built) {
      await handlers.get("log_thought")?.({}, AUTH);
    }
    // Still recording after both per-session shutdowns: proof the sink survived.
    expect(sink.bodies).toHaveLength(2);
    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });

  test("a sink whose flush and shutdown both reject still resolves", async () => {
    const runtime = createTracingRuntime({
      config: ENABLED_CONFIG,
      createSink: throwingSink,
    });
    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });
});

describe("trace body helpers", () => {
  test("omits sessionId and userId rather than sending nulls", () => {
    const body = buildToolTraceBody({
      toolName: "t",
      status: "success",
      durationMs: 4.6,
      args: {},
      output: {},
    });
    expect("sessionId" in body).toBe(false);
    expect("userId" in body).toBe(false);
    expect((body.metadata as { duration_ms: number }).duration_ms).toBe(5);
  });

  test("a non-finite duration records as zero, never NaN", () => {
    const body = buildToolTraceBody({
      toolName: "t",
      status: "success",
      durationMs: Number.NaN,
      args: {},
      output: {},
    });
    expect((body.metadata as { duration_ms: number }).duration_ms).toBe(0);
  });

  test("errorOutput names the class for non-Error throws too", () => {
    expect(errorOutput("plain string")).toEqual({
      error_class: "string",
      error_message: "plain string",
    });
  });
});
