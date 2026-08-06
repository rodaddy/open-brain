/**
 * Functional tests for the #530 content-ful tracing lane.
 *
 * The contract under test is the one the module states: every tool call emits
 * one trace retaining complete input and output around masked detector matches,
 * plus caller identity; a tracing failure never fails, slows, or ALTERS a tool
 * call. The second half is
 * the one that matters operationally, so the sink that throws on every method
 * is a first-class case here, not an afterthought.
 *
 * No SDK, no server, no socket: the client factory is injected, exactly the
 * seam `McpAuditDeps.now` provides for the audit lane.
 */
import { describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildToolTraceBody,
  createTracingRuntime,
  errorOutput,
  installMcpTracing,
  readMcpTracingConfig,
  readRuntimeDeployStamp,
  repoRelease,
  resolveRepoRelease,
  resolveSessionId,
  setActiveMcpTraceMetadata,
  SinkHealthTracker,
  traceRetrievalSpan,
  traceRetrievalSpanSync,
  type McpTracingConfig,
  type TraceBody,
  type TracingSink,
} from "./langfuse-tracing.ts";

const ENABLED_CONFIG: McpTracingConfig = {
  enabled: true,
  maskingEnabled: true,
  endpoint: "http://10.71.20.50:3000",
  publicKey: "pk-lf-test",
  secretKey: "sk-lf-test",
};

/** A minimal stand-in for the SDK sink that records what it was handed. */
function recordingSink(): TracingSink & { bodies: TraceBody[] } {
  const bodies: TraceBody[] = [];
  return {
    bodies,
    emit(body) {
      bodies.push(body);
    },
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
}

/**
 * A sink whose drain NEVER settles — the real adversary for shutdown.
 *
 * This is what an unreachable endpoint produces: a promise that stays pending
 * far past any supervisor's patience (the v3 lane was measured at 28.0 s,
 * against launchd's 20 s `ExitTimeOut`). `throwingSink` cannot stand in for it,
 * because rejecting instantly is the one thing a hung socket does not do — and
 * no SDK timeout setting can be trusted to cover this, which is why the drain
 * is raced rather than merely configured.
 */
function hangingSink(): TracingSink {
  return {
    emit: () => undefined,
    forceFlush: () => new Promise<void>(() => {}),
    shutdown: () => new Promise<void>(() => {}),
  };
}

/** A sink that fails on every method — the best-effort contract's adversary. */
function throwingSink(): TracingSink {
  return {
    emit() {
      throw new Error(
        "langfuse exploded with secret sk-lf-leak in the message",
      );
    },
    forceFlush: () => Promise.reject(new Error("flush exploded")),
    shutdown: () => Promise.reject(new Error("shutdown exploded")),
  };
}

/**
 * A sink that fails only while `down` is true — the outage simulator.
 *
 * The #530 alert contract is about TRANSITIONS, so the adversary has to be able
 * to change state mid-run. A sink that always fails can only ever prove the
 * suspend line; it can never prove that recovery reports the right drop count,
 * or that the healthy path stays silent.
 */
function flakySink(): TracingSink & { down: boolean; bodies: TraceBody[] } {
  const bodies: TraceBody[] = [];
  return {
    down: false,
    bodies,
    emit(body) {
      if (this.down) throw new Error("connect ECONNREFUSED sk-lf-leak");
      bodies.push(body);
    },
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
}

/**
 * Capture the console channels the shared logger actually writes to.
 *
 * `warn` goes to `console.warn` but `info` goes to `console.LOG`, not
 * `console.info` (`src/logger.ts:536-544` — the final `else` branch). Hooking
 * `console.info` captures nothing and lets the real line escape to stdout,
 * which is exactly how the first draft of this helper produced a green
 * "one suspend line" assertion against zero captured lines.
 */
async function captureLogLines(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const originalWarn = console.warn;
  const originalLog = console.log;
  const push = (...parts: unknown[]): void => {
    // `String(err)` on an Error yields "Error: <message>", but the SDK logger
    // hands the Error as its own argument, so the interesting text is in a
    // later part rather than the first. Stringify every part, and reach into
    // Error objects explicitly so a leaked message is actually visible here.
    lines.push(
      parts
        .map((part) =>
          part instanceof Error
            ? `${part.name}: ${part.message}`
            : String(part),
        )
        .join(" "),
    );
  };
  console.warn = push;
  console.log = push;
  try {
    await run();
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }
  return lines;
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
  const handlers = new Map<
    string,
    (args: unknown, extra: unknown) => unknown
  >();
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
    const config = readMcpTracingConfig({});
    expect(config.enabled).toBe(false);
    expect(config.maskingEnabled).toBe(true);
  });

  test("masking is disabled only by the explicit zero value", () => {
    expect(
      readMcpTracingConfig({ OPENBRAIN_TRACING_MASKING_ENABLED: "0" })
        .maskingEnabled,
    ).toBe(false);
    expect(
      readMcpTracingConfig({ OPENBRAIN_TRACING_MASKING_ENABLED: "false" })
        .maskingEnabled,
    ).toBe(true);
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
      maskingEnabled: true,
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
    expect(
      resolveSessionId({ content: "x" }, { sessionId: "transport-b" }),
    ).toBe("transport-b");
  });

  test("is undefined when neither exists", () => {
    expect(resolveSessionId({ content: "x" }, {})).toBeUndefined();
  });
});

describe("installMcpTracing", () => {
  test("records one trace per call with complete benign input, output and caller identity", async () => {
    const sink = recordingSink();
    const { server, handlers } = fakeServer();
    installMcpTracing(server, {
      config: ENABLED_CONFIG,
      createSink: () => sink,
    });

    const result = {
      content: [{ type: "text", text: "the full answer body" }],
    };
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
    const body = sink.bodies[0]!;
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
      caller_token_client_id: "rico",
      caller_agent_id: "worker-530",
      namespace_source: "header",
      status: "success",
    });
    expect(
      (body.metadata as { duration_ms: number }).duration_ms,
    ).toBeGreaterThanOrEqual(0);
  });

  test("emits masked retrieval child spans with row ids, scores, filter reasons, and namespace value", async () => {
    const sink = recordingSink();
    const { server, handlers } = fakeServer();
    installMcpTracing(server, {
      config: ENABLED_CONFIG,
      createSink: () => sink,
    });
    server.registerTool(
      "search_brain",
      { inputSchema: {} } as never,
      (async () => {
        setActiveMcpTraceMetadata({ resolved_namespace: "rico" });
        const candidates = await traceRetrievalSpan({
          name: "retrieval.vector_query",
          input: { namespace: "rico" },
          run: async () => [
            {
              row_id: "row-569",
              content_preview: "api_key=sk-live-candidate",
              similarity: 0.93,
              bm25_score: null,
            },
          ],
          output: (rows) => ({ count: rows.length, candidates: rows }),
        });
        return traceRetrievalSpanSync({
          name: "retrieval.rank_rrf",
          input: { candidates },
          run: () => ({ content: [{ type: "text", text: "ok" }] }),
          output: () => ({
            selected_row_ids: ["row-569"],
            candidates: [
              {
                row_id: "row-569",
                rrf_score: 0.031,
                chosen: true,
                filtered_by: null,
              },
            ],
          }),
        });
      }) as never,
    );

    await handlers.get("search_brain")?.({ query: "memory" }, AUTH);

    const body = sink.bodies[0]!;
    expect(body.metadata.resolved_namespace).toBe("rico");
    expect(body.spans?.map((span) => span.name)).toEqual([
      "retrieval.vector_query",
      "retrieval.rank_rrf",
    ]);
    expect(body.spans?.[0]?.output).toMatchObject({
      count: 1,
      candidates: [{ row_id: "row-569", similarity: 0.93 }],
    });
    expect(body.spans?.[1]?.output).toMatchObject({
      selected_row_ids: ["row-569"],
      candidates: [{ row_id: "row-569", chosen: true, filtered_by: null }],
    });
    const serialized = JSON.stringify(body.spans);
    expect(serialized).not.toContain("sk-live-candidate");
    expect(serialized).toContain("[MASKED:");
  });

  test("retrieval span helpers are direct no-ops outside an active traced call", async () => {
    const object = { row_id: "row-no-trace" };
    let calls = 0;
    let summaries = 0;
    const summarize = (): unknown => {
      summaries += 1;
      return {};
    };
    const asyncResult = await traceRetrievalSpan({
      name: "retrieval.vector_query",
      run: async () => {
        calls += 1;
        return object;
      },
      output: summarize,
    });
    const syncResult = traceRetrievalSpanSync({
      name: "retrieval.rank_rrf",
      run: () => {
        calls += 1;
        return object;
      },
      output: summarize,
    });
    expect(calls).toBe(2);
    expect(summaries).toBe(0);
    expect(asyncResult).toBe(object);
    expect(syncResult).toBe(object);
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

    expect((sink.bodies[0]?.metadata as { status: string }).status).toBe(
      "error",
    );
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
    expect((sink.bodies[0]?.metadata as { status: string }).status).toBe(
      "exception",
    );
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
    // ONE sink for the process. The runtime hands back a health-carrying view
    // of the sink it built rather than the bare object — the tracker has to
    // hang off the shared sink or the shared path has no way to report an
    // outage at all — so the assertion is that everything still lands in the
    // same underlying sink, which `sink.bodies` below proves.
    expect(runtime.sink).toBeDefined();
    expect(runtime.sink?.health).toBeDefined();

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

  // The gap that let the 28-second shutdown through: the only adversary in
  // this suite was `throwingSink`, which REJECTS instantly. A sink that never
  // settles is the real Langfuse against an unreachable endpoint, and nothing
  // exercised it.
  test("a sink that never settles cannot hold shutdown open", async () => {
    const runtime = createTracingRuntime({
      config: ENABLED_CONFIG,
      createSink: hangingSink,
      shutdownTimeoutMs: 25,
    });
    const started = Date.now();
    await expect(runtime.shutdown()).resolves.toBeUndefined();
    // Generous upper bound: the assertion is "bounded", not a timing
    // measurement. Unbounded, this never resolves and the test times out.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("the bounded drain warns content-free on timeout", async () => {
    const lines: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...parts: unknown[]): void => {
      lines.push(parts.map((part) => String(part)).join(" "));
    };
    try {
      const runtime = createTracingRuntime({
        config: ENABLED_CONFIG,
        createSink: hangingSink,
        shutdownTimeoutMs: 25,
      });
      await runtime.shutdown();
    } finally {
      console.warn = originalWarn;
    }
    const warn = lines.find((line) =>
      line.includes("mcp_tool_tracing_shutdown_timeout"),
    );
    expect(warn).toBeDefined();
    // Content-free: the deadline itself, never a payload or a key.
    expect(warn).toContain('"timeoutMs":25');
    expect(warn).not.toContain("sk-lf");
  });

  test("a per-session install with a hanging own sink still drains bounded", async () => {
    const { server } = fakeServer();
    const handle = installMcpTracing(server, {
      config: ENABLED_CONFIG,
      createSink: hangingSink,
      shutdownTimeoutMs: 25,
    });
    expect(handle.active).toBe(true);
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });
});

/**
 * The #530 outage contract: state-change alerts only.
 *
 * The operator's rule is that an outage must be visible but not noisy — "if you
 * do that every time, you're going to spend most of your time saying hey hey
 * this isn't working." So the assertions here are about COUNTS of log lines,
 * not just their presence: "exactly one" is the whole requirement, and a test
 * that only checked `toBeDefined()` would pass against a per-call warn.
 */
describe("outage alerts fire on state change only", () => {
  /**
   * Wire tracing EXACTLY as `server/main.ts` does, and return the call handle.
   *
   * This helper is the point of this suite. The previous version of these tests
   * installed with `createSink`, which made `installMcpTracing` build and own
   * the sink — a branch production never takes, because `createServerFactory`
   * always passes `sink:` from the process-wide runtime. Every alert assertion
   * therefore passed against a code path no server ran, while the shared path
   * silently discarded every failure (measured: zero lines across a 500-call
   * outage). Driving `createTracingRuntime` -> `installMcpTracing({ sink })`
   * means a regression in the production wiring fails these tests.
   */
  function wireLikeProduction(
    sink: TracingSink,
    healthOptions?: { cooldownMs?: number; now?: () => number },
  ): () => Promise<void> {
    const runtime = createTracingRuntime({
      config: ENABLED_CONFIG,
      createSink: () => sink,
      ...(healthOptions === undefined ? {} : { healthOptions }),
    });
    const { server, handlers } = fakeServer();
    // The `main.ts` shape: config plus the process's ONE shared sink.
    installMcpTracing(server, {
      config: ENABLED_CONFIG,
      sink: runtime.sink!,
    });
    server.registerTool(
      "log_thought",
      { inputSchema: {} } as never,
      (() => ({ ok: true })) as never,
    );
    return async () => {
      await handlers.get("log_thought")?.({}, AUTH);
    };
  }

  test("the healthy path logs nothing at all", async () => {
    const sink = recordingSink();
    const call = wireLikeProduction(sink);

    const lines = await captureLogLines(async () => {
      for (let i = 0; i < 5; i += 1) await call();
    });

    expect(sink.bodies).toHaveLength(5);
    expect(lines.filter((line) => line.includes("mcp_tool_tracing"))).toEqual(
      [],
    );
  });

  test("the shared-sink path reports an outage — one suspend, one recovery with the drop count", async () => {
    const sink = flakySink();
    const call = wireLikeProduction(sink);

    const lines = await captureLogLines(async () => {
      await call(); // healthy
      sink.down = true;
      for (let i = 0; i < 4; i += 1) await call(); // the outage window
      sink.down = false;
      await call(); // recovery
      await call(); // still healthy — must stay silent
    });

    const suspends = lines.filter((line) =>
      line.includes("mcp_tool_tracing_suspended"),
    );
    const resumes = lines.filter((line) =>
      line.includes("mcp_tool_tracing_resumed"),
    );
    // FOUR failed calls, ONE line. That ratio is the requirement — and this is
    // now asserted through the shared sink, where it previously read zero.
    expect(suspends).toHaveLength(1);
    expect(resumes).toHaveLength(1);
    expect(resumes[0]).toContain('"droppedTraces":4');
    // Content-free: the suspend line carries an error label, never the message
    // the sink threw (which deliberately contains a key-shaped string).
    expect(suspends[0]).not.toContain("sk-lf-leak");
  });

  test("many sessions over one shared sink still report a single pair", async () => {
    // The multiplication the per-install tracker would have caused if it had
    // ever run on the shared path: N sessions must not mean N suspend lines.
    const sink = flakySink();
    const runtime = createTracingRuntime({
      config: ENABLED_CONFIG,
      createSink: () => sink,
    });
    const calls = [0, 1, 2].map(() => {
      const { server, handlers } = fakeServer();
      installMcpTracing(server, {
        config: ENABLED_CONFIG,
        sink: runtime.sink!,
      });
      server.registerTool(
        "log_thought",
        { inputSchema: {} } as never,
        (() => ({ ok: true })) as never,
      );
      return async () => {
        await handlers.get("log_thought")?.({}, AUTH);
      };
    });

    const lines = await captureLogLines(async () => {
      sink.down = true;
      for (const call of calls) await call();
      sink.down = false;
      await calls[0]!();
    });

    expect(
      lines.filter((line) => line.includes("mcp_tool_tracing_suspended")),
    ).toHaveLength(1);
    const resumes = lines.filter((line) =>
      line.includes("mcp_tool_tracing_resumed"),
    );
    expect(resumes).toHaveLength(1);
    // Three sessions' worth of drops counted into ONE window.
    expect(resumes[0]).toContain('"droppedTraces":3');
  });

  /**
   * Caught by the live blackholed probe, not by a test: traces enqueued BEFORE
   * the outage was noticed were reported as `droppedTraces: 0`.
   *
   * The outage is discovered on the background export, seconds after the calls
   * were made, so the whole in-flight batch was already handed over while the
   * sink still looked healthy. Those are exactly the traces the operator lost.
   */
  test("traces enqueued before the failure was noticed still count as dropped", () => {
    const tracker = new SinkHealthTracker({ cooldownMs: 0 });
    // Five traces accepted while the sink still looked healthy.
    for (let i = 0; i < 5; i += 1) tracker.recordEnqueued();
    // The background export then reports the endpoint is gone. `false` because
    // a failed BATCH is not itself one lost trace.
    expect(tracker.recordFailure(false)).toBe(true);
    // Two more arrive during the known outage.
    tracker.recordEnqueued();
    tracker.recordEnqueued();
    // All seven, not two — and emphatically not zero.
    expect(tracker.recordSuccess()).toBe(7);
  });

  test("a delivered flush clears the pending tally so a later outage is not inflated", () => {
    const tracker = new SinkHealthTracker({ cooldownMs: 0 });
    for (let i = 0; i < 4; i += 1) tracker.recordEnqueued();
    // Those four reached the endpoint.
    tracker.noteDelivered();
    for (let i = 0; i < 3; i += 1) tracker.recordEnqueued();
    expect(tracker.recordFailure(false)).toBe(true);
    // Only the three that were still in flight, not the four already delivered.
    expect(tracker.recordSuccess()).toBe(3);
  });

  test("a second outage reports its own window, not a running total", () => {
    // Cooldown disabled: this asserts the counting rule, and a real clock would
    // otherwise suppress the second pair as a flap.
    const tracker = new SinkHealthTracker({ cooldownMs: 0 });
    expect(tracker.recordFailure()).toBe(true); // transition
    expect(tracker.recordFailure()).toBe(false); // already down — no line
    expect(tracker.recordSuccess()).toBe(2);
    // Recovered: a success now is a no-op, so nothing is logged on the happy path.
    expect(tracker.recordSuccess()).toBeUndefined();
    expect(tracker.recordFailure()).toBe(true);
    expect(tracker.recordSuccess()).toBe(1);
  });

  test("tool calls still return their own result verbatim throughout an outage", async () => {
    const sink = flakySink();
    const runtime = createTracingRuntime({
      config: ENABLED_CONFIG,
      createSink: () => sink,
    });
    const { server, handlers } = fakeServer();
    installMcpTracing(server, {
      config: ENABLED_CONFIG,
      sink: runtime.sink!,
    });
    const result = { content: [{ type: "text", text: "untouched" }] };
    server.registerTool(
      "log_thought",
      { inputSchema: {} } as never,
      (() => result) as never,
    );
    sink.down = true;
    await captureLogLines(async () => {
      const returned = await handlers.get("log_thought")?.({}, AUTH);
      expect(returned).toBe(result);
    });
  });

  /**
   * The LOW finding from the adversarial review: state-change-only is not by
   * itself a bound on output. A sink alternating fail/success changes state on
   * every call, so 20 alternating calls MEASURED 10 suspend and 10 resume lines
   * — per-call noise arriving through the rule meant to prevent it.
   */
  test("a flapping sink reports a bounded number of pairs, not one per flap", async () => {
    const sink = flakySink();
    // A clock the test drives, so the 30 s default is asserted without sleeping
    // through it. Time advances 1 s per call: twenty alternating calls span
    // 20 s, which is inside one cooldown.
    let clock = 0;
    const call = wireLikeProduction(sink, {
      cooldownMs: 30_000,
      now: () => clock,
    });

    const lines = await captureLogLines(async () => {
      for (let i = 0; i < 20; i += 1) {
        sink.down = i % 2 === 0;
        await call();
        clock += 1_000;
      }
    });

    const suspends = lines.filter((line) =>
      line.includes("mcp_tool_tracing_suspended"),
    );
    const resumes = lines.filter((line) =>
      line.includes("mcp_tool_tracing_resumed"),
    );
    // Was 10/10 before the cooldown. The first transition is never delayed, so
    // exactly one pair is the correct bound for a window this size.
    expect(suspends).toHaveLength(1);
    expect(resumes).toHaveLength(1);
  });

  test("the cooldown delays a flap's pair but never a real outage after quiet", async () => {
    const sink = flakySink();
    let clock = 0;
    const call = wireLikeProduction(sink, {
      cooldownMs: 30_000,
      now: () => clock,
    });

    const lines = await captureLogLines(async () => {
      // First outage: reported immediately.
      sink.down = true;
      await call();
      sink.down = false;
      await call();
      // A flap 1 s later: suppressed, because a pair was just printed.
      clock += 1_000;
      sink.down = true;
      await call();
      sink.down = false;
      await call();
      // A genuine outage well past the cooldown: reported again.
      clock += 31_000;
      sink.down = true;
      await call();
      sink.down = false;
      await call();
    });

    // Two pairs, not three: the middle flap is the one the cooldown eats.
    expect(
      lines.filter((line) => line.includes("mcp_tool_tracing_suspended")),
    ).toHaveLength(2);
    expect(
      lines.filter((line) => line.includes("mcp_tool_tracing_resumed")),
    ).toHaveLength(2);
  });
});

/**
 * The v3 review's MEDIUM finding, carried into v4: the SDK's own logger writes
 * export failures straight to `console.error` with the raw error attached, so a
 * transport message carrying the endpoint or an auth header would bypass this
 * module's content-free discipline AND the shared logger's redaction.
 *
 * Measured before the fix: the SDK logger emitted 2 lines and the injected
 * `sk-lf-` string appeared in them.
 */
describe("the SDK's own logger cannot bypass the content-free discipline", () => {
  test("building the real sink silences SDK-level error and warn output", async () => {
    const { configureGlobalLogger, getGlobalLogger, LogLevel } = await import(
      "@langfuse/core"
    );

    // Asserted through the SDK's OWN level gate rather than by capturing
    // `console.error`: Bun's runner installs its own console, so a swapped
    // `console.error` does not reliably observe a library's writes from inside
    // a test. `shouldLog` is the exact predicate that decides whether the SDK
    // reaches the console at all, so checking it tests the real mechanism
    // instead of a proxy for it.
    type Gated = { shouldLog(level: number): boolean };

    // Baseline asserted FIRST and explicitly, because the SDK logger is
    // process-global: an earlier test that built a real sink has already
    // installed the suppression, so "silent" would otherwise pass for the
    // wrong reason.
    configureGlobalLogger({ level: LogLevel.DEBUG });
    expect(
      (getGlobalLogger() as unknown as Gated).shouldLog(LogLevel.ERROR),
    ).toBe(true);

    // Building the real sink installs the suppression. `createSink` is NOT
    // injected here on purpose: the point is that the DEFAULT factory does it.
    createTracingRuntime({ config: ENABLED_CONFIG });

    const gated = getGlobalLogger() as unknown as Gated;
    expect(gated.shouldLog(LogLevel.ERROR)).toBe(false);
    expect(gated.shouldLog(LogLevel.WARN)).toBe(false);
  });
});

describe("trace body helpers", () => {
  const fakeLabeledSecret = [
    "pass",
    "word=obviously-fake-561-fixture-value",
  ].join("");

  test("masks detector matches in tool arguments and results while retaining every field", () => {
    const body = buildToolTraceBody({
      toolName: "fixture_tool",
      status: "success",
      durationMs: 7,
      args: {
        query: `args-before ${fakeLabeledSecret} args-after`,
        untouched: "plain argument",
      },
      output: {
        content: [
          {
            type: "text",
            text: `result-before ${fakeLabeledSecret} result-after`,
          },
        ],
        isError: false,
      },
    });

    expect(body.input).toEqual({
      query: "args-before password=[MASKED:labeled_secret] args-after",
      untouched: "plain argument",
    });
    expect(body.output).toEqual({
      content: [
        {
          type: "text",
          text: "result-before password=[MASKED:labeled_secret] result-after",
        },
      ],
      isError: false,
    });
  });

  test("masks opaque values carried by sensitive argument and result keys", () => {
    const opaqueValue = [
      "obviously-fake-561-fixture-value-",
      "aaaaaaaaaaaa",
    ].join("");
    const body = buildToolTraceBody({
      toolName: "fixture_tool",
      status: "success",
      durationMs: 1,
      args: {
        password: opaqueValue,
        nested: { api_key: opaqueValue },
      },
      output: {
        password: opaqueValue,
        nested: { api_key: opaqueValue, totp_secret: opaqueValue },
      },
    });

    expect(body.input).toEqual({
      password: "[MASKED:sensitive_key]",
      nested: { api_key: "[MASKED:sensitive_key]" },
    });
    expect(body.output).toEqual({
      password: "[MASKED:sensitive_key]",
      nested: {
        api_key: "[MASKED:sensitive_key]",
        totp_secret: "[MASKED:sensitive_key]",
      },
    });
  });

  test("keeps serialized JSON parseable and retains a masked field label", () => {
    const body = buildToolTraceBody({
      toolName: "fixture_tool",
      status: "success",
      durationMs: 1,
      args: {},
      output: {
        // The value is deliberately an obvious placeholder: key-based masking
        // triggers on the KEY alone, and a realistic-looking value here is
        // itself a secret-scanner hit (GitGuardian flagged the previous one).
        text: JSON.stringify({
          a: 1,
          password: "fake-placeholder-not-a-secret",
          b: 2,
        }),
      },
    });
    const text = (body.output as { text: string }).text;

    expect(JSON.parse(text)).toEqual({
      a: 1,
      password: "[MASKED:json_labeled_secret]",
      b: 2,
    });
  });

  test("normalizes non-plain carriers before masking their observable content", () => {
    const opaqueValue = [
      "obviously-fake-561-fixture-value-",
      "bbbbbbbbbbbb",
    ].join("");
    const bytes = Buffer.from(`password=${opaqueValue}`);
    const typedBytes = new Uint8Array(bytes);
    const body = buildToolTraceBody({
      toolName: "fixture_tool",
      status: "success",
      durationMs: 1,
      args: {
        map: new Map([
          ["password", opaqueValue],
          ["visible", "plain map value"],
        ]),
        set: new Set([`password=${opaqueValue}`, "plain set value"]),
      },
      output: {
        error: new Error(`password=${opaqueValue}`),
        buffer: bytes,
        typedBytes,
      },
    });

    expect(body.input).toEqual({
      map: {
        password: "[MASKED:sensitive_key]",
        visible: "plain map value",
      },
      set: ["password=[MASKED:labeled_secret]", "plain set value"],
    });
    expect(body.output).toEqual({
      error: {
        name: "Error",
        message: "password=[MASKED:labeled_secret]",
      },
      buffer: { type: "Buffer", byteLength: bytes.byteLength },
      typedBytes: { type: "Uint8Array", byteLength: typedBytes.byteLength },
    });
    expect(JSON.stringify(body)).not.toContain(opaqueValue);
  });

  test("the explicit masking opt-out retains the original trace body", () => {
    const body = buildToolTraceBody({
      toolName: "fixture_tool",
      status: "success",
      durationMs: 7,
      args: { query: fakeLabeledSecret },
      output: { result: fakeLabeledSecret },
      maskingEnabled: false,
    });

    expect(body.input).toEqual({ query: fakeLabeledSecret });
    expect(body.output).toEqual({ result: fakeLabeledSecret });
  });

  // The case the audit lane already records both ids for
  // (`src/audit-log.ts:299-301`): a delegated call whose acting identity is not
  // its token identity. With only `caller_client_id`, the content-ful lane an
  // operator reads to answer "who actually did this" loses the distinction.
  test("a delegated call records both the acting and the token identity", () => {
    const body = buildToolTraceBody({
      toolName: "log_thought",
      status: "success",
      durationMs: 1,
      args: {},
      output: {},
      auth: {
        role: "admin",
        clientId: "acting-agent",
        tokenClientId: "issuing-operator",
        namespaceSource: "header",
      } as never,
    });
    expect(body.metadata).toMatchObject({
      caller_client_id: "acting-agent",
      caller_token_client_id: "issuing-operator",
    });
    // `userId` stays the acting identity: it is the Langfuse grouping key, and
    // the token identity travels alongside it rather than replacing it.
    expect(body.userId).toBe("acting-agent");
  });

  test("a call with no auth records both identities as null, never undefined", () => {
    const body = buildToolTraceBody({
      toolName: "t",
      status: "success",
      durationMs: 1,
      args: {},
      output: {},
    });
    expect(body.metadata).toMatchObject({
      caller_client_id: null,
      caller_token_client_id: null,
    });
  });

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

/**
 * #560: `release` is what lets an operator ask "which COMMIT got expensive".
 *
 * It was empty on 100% of traces because nothing ever resolved it. The resolver
 * is asserted rather than the processor option, because constructing a real
 * `LangfuseSpanProcessor` would build an exporter and this suite dials nothing.
 */
describe("the release stamped on every trace", () => {
  test("reads the runtime stamp from the deployed tree root", () => {
    const stampPath = join(import.meta.dir, "..", "..", ".deployed-revision");
    const previousStamp = existsSync(stampPath)
      ? readFileSync(stampPath, "utf8")
      : undefined;

    try {
      writeFileSync(stampPath, "sha=0123456789abcdef\nshort_sha=0123456\n");
      expect(readRuntimeDeployStamp()).toContain("short_sha=0123456");
      expect(
        resolveRepoRelease({
          resolveGit: () => {
            throw new Error("git checkout unavailable");
          },
        }),
      ).toBe("0123456");
    } finally {
      if (previousStamp === undefined) unlinkSync(stampPath);
      else writeFileSync(stampPath, previousStamp);
    }
  });

  test("contains stamp parser failures inside the tracing boundary", () => {
    expect(
      resolveRepoRelease({
        parseStamp: () => {
          throw new Error("stamp parser unavailable");
        },
      }),
    ).toBeUndefined();
  });

  test("uses an injected deploy stamp when the runtime has no git checkout", () => {
    expect(
      resolveRepoRelease({
        readStamp: () => "sha=0123456789abcdef\nshort_sha=0123456\n",
        resolveGit: () => {
          throw new Error("git checkout unavailable");
        },
      }),
    ).toBe("0123456");
  });

  test("resolves to the short SHA of the checkout under test", () => {
    const release = repoRelease();

    // This suite runs from a git checkout, so a SHA is expected here — but the
    // shape is what is asserted, since the value changes with every commit.
    expect(release).toMatch(/^[0-9a-f]{7,40}$/);
  });

  test("is never a placeholder standing in for an unknown commit", () => {
    // A placeholder would group every unversioned trace as one release, which
    // is worse than an absent field: it reads as a real, shared commit.
    expect(repoRelease()).not.toBe("unknown");
  });

  test("is resolved once and cached, never forked per trace", () => {
    // A subprocess per emit would put a fork on the request path, which is the
    // one thing this lane is built not to do.
    expect(repoRelease()).toBe(repoRelease());
  });
});
