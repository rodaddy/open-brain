/**
 * The composition root's seam, and the #530 outage-alert contract.
 *
 * The operator's rule is that an outage must be visible but not noisy — "if you
 * do that every time, you're going to spend most of your time saying hey hey
 * this isn't working." So the assertions here are about COUNTS of log lines,
 * not just their presence: "exactly one" is the whole requirement, and a test
 * that only checked `toBeDefined()` would pass against a per-call warn.
 */
import { describe, expect, test } from "vitest";
import { expectDefined } from "../testing/expect-defined.ts";
import {
  createTracingRuntime,
  emitTraceBodyWithObservations,
  installMcpTracing,
  SinkHealthTracker,
  type TracingSink,
} from "./langfuse-tracing.ts";
import { logger as legacyLogger } from "../logging/legacy-logger.ts";
import {
  AUTH,
  consoleTracingLoggerFrom,
  ENABLED_CONFIG,
  fakeServer,
  flakySink,
  hangingSink,
  recordingSink,
  throwingSink,
} from "./langfuse-tracing-fixtures.ts";
import {
  captureLogLines,
  captureWarnLinesAsync,
} from "../../scripts/test-support/console-capture.ts";

const consoleTracingLogger = consoleTracingLoggerFrom(legacyLogger);

/**
 * Wire tracing EXACTLY as `server/main.ts` does, and return the call handle.
 *
 * This helper is the point of the outage suite. A previous version installed
 * with `createSink`, which made `installMcpTracing` build and own the sink — a
 * branch production never takes, because `createServerFactory` always passes
 * `sink:` from the process-wide runtime. Every alert assertion therefore passed
 * against a code path no server ran, while the shared path silently discarded
 * every failure (measured: zero lines across a 500-call outage). Driving
 * `createTracingRuntime` -> `installMcpTracing({ sink })` means a regression in
 * the production wiring fails these tests.
 */
function wireLikeProduction(
  sink: TracingSink,
  healthOptions?: { cooldownMs?: number; now?: () => number },
): () => Promise<void> {
  const runtime = createTracingRuntime({
    logger: consoleTracingLogger,
    config: ENABLED_CONFIG,
    createSink: () => sink,
    ...(healthOptions === undefined ? {} : { healthOptions }),
  });
  return callThroughSharedSink(runtime.sink);
}

interface SessionHandle {
  shutdown: () => Promise<void>;
  call: () => Promise<void>;
}

/**
 * One per-session install over a shared sink, with its own shutdown and call.
 *
 * Hoisted to module scope so the suite that drives two of them does not nest a
 * callback inside a callback inside the  body.
 */
function sessionOverSharedSink(shared: TracingSink): SessionHandle {
  const { server, handlers } = fakeServer();
  const handle = installMcpTracing(server, {
    logger: consoleTracingLogger,
    config: ENABLED_CONFIG,
    sink: shared,
  });
  expect(handle.active).toBe(true);
  server.registerTool(
    "log_thought",
    { inputSchema: {} } as never,
    (() => ({ ok: true })) as never,
  );
  return {
    // A per-session handle must not drain a sink it does not own, or the first
    // session to close would flush and shut down tracing for the rest.
    shutdown: () => handle.shutdown(),
    call: async () => {
      await handlers.get("log_thought")?.({}, AUTH);
    },
  };
}

/** Installs one per-session server over an already-built shared sink. */
function callThroughSharedSink(shared: TracingSink | undefined): () => Promise<void> {
  const { server, handlers } = fakeServer();
  // The `main.ts` shape: config plus the process's ONE shared sink.
  installMcpTracing(server, {
    logger: consoleTracingLogger,
    config: ENABLED_CONFIG,
    sink: expectDefined(shared, "the runtime's shared sink"),
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

function parentEndsWhenChildStartThrows(): void {
  let parentEnded = 0;
  let childStarts = 0;
  const child = {
    updateTrace: () => undefined,
    startObservation: () => {
      throw new Error("unused");
    },
    end: () => undefined,
  };
  const parent = {
    updateTrace: () => undefined,
    end: () => {
      parentEnded += 1;
    },
    startObservation: () => {
      childStarts += 1;
      if (childStarts === 2) throw new Error("child start failed");
      return child;
    },
  };
  const body = {
    name: "tool",
    input: {},
    output: {},
    metadata: {},
    tags: [],
    spans: [
      { name: "one", input: {}, output: {}, metadata: {} },
      { name: "two", input: {}, output: {}, metadata: {} },
    ],
  };
  expect(() => emitTraceBodyWithObservations(body, () => parent)).toThrow(
    "child start failed",
  );
  expect(parentEnded).toBe(1);
}

describe("child observation export", () => {
  test(
    "the parent observation ends when a child start throws",
    parentEndsWhenChildStartThrows,
  );
});

describe("createTracingRuntime — the composition root's seam", () => {
  test("disabled config yields no sink and a no-op shutdown", async () => {
    const runtime = createTracingRuntime({
      logger: consoleTracingLogger,
      config: { ...ENABLED_CONFIG, enabled: false },
      createSink: recordingSink,
    });
    expect(runtime.sink).toBeUndefined();
    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });

  test("one shared sink serves many per-session servers and drains once", async () => {
    const sink = recordingSink();
    const runtime = createTracingRuntime({
      logger: consoleTracingLogger,
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
    const shared = expectDefined(runtime.sink, "the runtime's shared sink");
    const calls = [0, 1].map(() => sessionOverSharedSink(shared));
    for (const entry of calls) await entry.shutdown();
    for (const entry of calls) await entry.call();
    // Still recording after both per-session shutdowns: proof the sink survived.
    expect(sink.bodies).toHaveLength(2);
    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });

  test("a sink whose flush and shutdown both reject still resolves", async () => {
    const runtime = createTracingRuntime({
      logger: consoleTracingLogger,
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
      logger: consoleTracingLogger,
      config: ENABLED_CONFIG,
      createSink: hangingSink,
      shutdownTimeoutMs: 25,
    });
    const started = Date.now();
    await expect(runtime.shutdown()).resolves.toBeUndefined();
    // Generous upper value: the assertion is "does not run away", not a timing
    // measurement. Unconstrained, this never resolves and the test times out.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("the constrained drain warns content-free on timeout", async () => {
    const lines = await captureWarnLinesAsync(async () => {
      const runtime = createTracingRuntime({
        logger: consoleTracingLogger,
        config: ENABLED_CONFIG,
        createSink: hangingSink,
        shutdownTimeoutMs: 25,
      });
      await runtime.shutdown();
    });
    const warn = lines.find((line) =>
      line.includes("mcp_tool_tracing_shutdown_timeout"),
    );
    expect(warn).toBeDefined();
    // Content-free: the deadline itself, never a payload or a key.
    expect(warn).toContain('"timeoutMs":25');
    expect(warn).not.toContain("sk-lf");
  });

  test("a per-session install with a hanging own sink still drains promptly", async () => {
    const { server } = fakeServer();
    const handle = installMcpTracing(server, {
      logger: consoleTracingLogger,
      config: ENABLED_CONFIG,
      createSink: hangingSink,
      shutdownTimeoutMs: 25,
    });
    expect(handle.active).toBe(true);
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });
});

describe("outage alerts fire on state change only", () => {
  test("the healthy path logs nothing at all", async () => {
    const sink = recordingSink();
    const call = wireLikeProduction(sink);

    const lines = await captureLogLines(async () => {
      for (let i = 0; i < 5; i += 1) await call();
    });

    expect(sink.bodies).toHaveLength(5);
    expect(lines.filter((line) => line.includes("mcp_tool_tracing"))).toEqual([]);
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
    const resumes = lines.filter((line) => line.includes("mcp_tool_tracing_resumed"));
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
      logger: consoleTracingLogger,
      config: ENABLED_CONFIG,
      createSink: () => sink,
    });
    const calls = [0, 1, 2].map(() => callThroughSharedSink(runtime.sink));

    const lines = await captureLogLines(async () => {
      sink.down = true;
      for (const call of calls) await call();
      sink.down = false;
      await expectDefined(calls[0], "the first session's call")();
    });

    expect(
      lines.filter((line) => line.includes("mcp_tool_tracing_suspended")),
    ).toHaveLength(1);
    const resumes = lines.filter((line) => line.includes("mcp_tool_tracing_resumed"));
    expect(resumes).toHaveLength(1);
    // Three sessions' worth of drops counted into ONE window.
    expect(resumes[0]).toContain('"droppedTraces":3');
  });
});

describe("the sink health tracker counts one window at a time", () => {
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
});

describe("an outage never reaches the tool result", () => {
  test("tool calls still return their own result verbatim throughout an outage", async () => {
    const sink = flakySink();
    const runtime = createTracingRuntime({
      logger: consoleTracingLogger,
      config: ENABLED_CONFIG,
      createSink: () => sink,
    });
    const { server, handlers } = fakeServer();
    installMcpTracing(server, {
      logger: consoleTracingLogger,
      config: ENABLED_CONFIG,
      sink: expectDefined(runtime.sink, "the runtime's shared sink"),
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
   * itself a constraint on output. A sink alternating fail/success changes state
   * on every call, so 20 alternating calls MEASURED 10 suspend and 10 resume
   * lines — per-call noise arriving through the rule meant to prevent it.
   */
  test("a flapping sink reports few pairs, not one per flap", async () => {
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
    const resumes = lines.filter((line) => line.includes("mcp_tool_tracing_resumed"));
    // Was 10/10 before the cooldown. The first transition is never delayed, so
    // exactly one pair is correct for a window this size.
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
    const outage = async (): Promise<void> => {
      sink.down = true;
      await call();
      sink.down = false;
      await call();
    };

    const lines = await captureLogLines(async () => {
      await outage(); // First outage: reported immediately.
      clock += 1_000;
      await outage(); // A flap 1 s later: suppressed, a pair was just printed.
      clock += 31_000;
      await outage(); // A genuine outage past the cooldown: reported again.
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

describe("background job tracing", () => {
  test("uses the shared masking boundary for root and child observations", () => {
    const sink = recordingSink();
    const runtime = createTracingRuntime({
      config: ENABLED_CONFIG,
      sink,
      logger: consoleTracingLogger,
    });
    expectDefined(runtime.background, "the background emitter").emitBackground({
      name: "memory.distill",
      input: { prompt: "password=fake-background-secret" },
      output: { status: "ok", api_key: "fake-opaque-value" },
      tags: ["background-job", "dream"],
      metadata: { status: "success" },
      observations: [
        {
          name: "distill.extract",
          type: "generation",
          model: "fixture-model",
          input: { text: "token=fake-child-secret" },
          output: { answer: "kept around password=fake-output-secret" },
          metadata: { authorization: "fake-bearer" },
          usageDetails: { input: 12, output: 4 },
          startedAt: 10,
          endedAt: 20,
        },
      ],
      startedAt: 1,
      endedAt: 30,
      sessionId: "session-569",
    });

    expect(sink.bodies[0]).toMatchObject({
      input: { prompt: "password=[MASKED:labeled_secret]" },
      output: { status: "ok", api_key: "[MASKED:sensitive_key]" },
      sessionId: "session-569",
      observations: [
        {
          type: "generation",
          model: "fixture-model",
          input: { text: "token=[MASKED:labeled_secret]" },
          output: { answer: "kept around password=[MASKED:labeled_secret]" },
          metadata: { authorization: "[MASKED:sensitive_key]" },
          usageDetails: { input: 12, output: 4 },
        },
      ],
    });
  });

  test("does not expose a background emitter when tracing is disabled", () => {
    const runtime = createTracingRuntime({
      logger: consoleTracingLogger,
      config: { ...ENABLED_CONFIG, enabled: false },
    });
    expect(runtime.background).toBeUndefined();
    expect(runtime.sink).toBeUndefined();
  });
});
