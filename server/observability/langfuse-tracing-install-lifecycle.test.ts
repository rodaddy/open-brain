/**
 * `installMcpTracing`: the lifecycle half — a tracing failure never fails,
 * slows, or ALTERS a tool call.
 *
 * That half is the one that matters operationally, so the sink that throws on
 * every method is a first-class case here, not an afterthought. The evidence
 * half lives in `langfuse-tracing-install.test.ts`.
 */
import { describe, expect, test } from "vitest";
import {
  installMcpTracing,
  traceRetrievalSpan,
  traceRetrievalSpanSync,
} from "./langfuse-tracing.ts";
import { logger as legacyLogger } from "../logging/legacy-logger.ts";
import {
  AUTH,
  consoleTracingLoggerFrom,
  ENABLED_CONFIG,
  fakeServer,
  onlyBody,
  recordingSink,
  throwingSink,
} from "./langfuse-tracing-fixtures.ts";

const consoleTracingLogger = consoleTracingLoggerFrom(legacyLogger);

async function spanHelpersAreNoOpsOutsideATracedCall(): Promise<void> {
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
}

async function isErrorResultTracesAsError(): Promise<void> {
  const sink = recordingSink();
  const { server, handlers } = fakeServer();
  installMcpTracing(server, {
    logger: consoleTracingLogger,
    config: ENABLED_CONFIG,
    createSink: () => sink,
  });
  server.registerTool(
    "search_memory",
    { inputSchema: {} } as never,
    (() => ({ isError: true, content: [] })) as never,
  );

  await handlers.get("search_memory")?.({ query: "x" }, AUTH);

  expect((onlyBody(sink.bodies).metadata as { status: string }).status).toBe("error");
}

async function throwingSinkLeavesResultByteIdentical(): Promise<void> {
  const { server, handlers } = fakeServer();
  const handle = installMcpTracing(server, {
    logger: consoleTracingLogger,
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
}

class NamespaceViolationError extends Error {
  override name = "NamespaceViolationError";
}

async function handlerExceptionPropagatesAndIsTraced(): Promise<void> {
  const sink = recordingSink();
  const { server, handlers } = fakeServer();
  installMcpTracing(server, {
    logger: consoleTracingLogger,
    config: ENABLED_CONFIG,
    createSink: () => sink,
  });

  server.registerTool(
    "get_entity",
    { inputSchema: {} } as never,
    (() => {
      throw new NamespaceViolationError("entity 7 is not in namespace dana");
    }) as never,
  );

  await expect(handlers.get("get_entity")?.({ id: "7" }, AUTH)).rejects.toThrow(
    "entity 7 is not in namespace dana",
  );

  expect(sink.bodies).toHaveLength(1);
  const body = onlyBody(sink.bodies);
  expect((body.metadata as { status: string }).status).toBe("exception");
  expect(body.output).toEqual({
    error_class: "NamespaceViolationError",
    error_message: "entity 7 is not in namespace dana",
  });
}

async function disabledConfigLeavesRegisterToolUntouched(): Promise<void> {
  const sink = recordingSink();
  const { server, originalRegisterTool } = fakeServer();
  const handle = installMcpTracing(server, {
    logger: consoleTracingLogger,
    config: { ...ENABLED_CONFIG, enabled: false },
    createSink: () => sink,
  });

  // The property DESCRIPTOR rather than `server.registerTool`: a bare member
  // access to a method is what `typescript(unbound-method)` forbids, and the
  // assertion only ever wanted the property's current value — reference
  // identity with the original, proving install left it untouched.
  //
  // `Reflect.get` also satisfies the lint rule but not the typechecker: it is
  // overloaded on the target's type, so it resolves to the method's own
  // signature and `.toBe` then rejects the `unknown`-typed original. The
  // descriptor's `value` is untyped, which is what this comparison wants.
  expect(Object.getOwnPropertyDescriptor(server, "registerTool")?.value).toBe(
    originalRegisterTool,
  );
  expect(handle.active).toBe(false);
  await expect(handle.shutdown()).resolves.toBeUndefined();
  expect(sink.bodies).toHaveLength(0);
}

async function installingTwiceWrapsOnce(): Promise<void> {
  const sink = recordingSink();
  const { server, handlers } = fakeServer();
  for (let i = 0; i < 2; i += 1) {
    installMcpTracing(server, {
      logger: consoleTracingLogger,
      config: ENABLED_CONFIG,
      createSink: () => sink,
    });
  }
  server.registerTool(
    "log_thought",
    { inputSchema: {} } as never,
    (() => ({ ok: true })) as never,
  );
  await handlers.get("log_thought")?.({}, AUTH);
  expect(sink.bodies).toHaveLength(1);
}

function throwingSinkFactoryDegradesToNoTracing(): void {
  const { server, originalRegisterTool } = fakeServer();
  const handle = installMcpTracing(server, {
    logger: consoleTracingLogger,
    config: ENABLED_CONFIG,
    createSink: () => {
      throw new Error("bad base url");
    },
  });
  expect(handle.active).toBe(false);
  // Same descriptor route as the disabled-config case above, for the same
  // reason: the property value, not an unbound method reference.
  expect(Object.getOwnPropertyDescriptor(server, "registerTool")?.value).toBe(
    originalRegisterTool,
  );
}

function nonFunctionThirdArgumentPassesThrough(): void {
  const sink = recordingSink();
  const { server } = fakeServer();
  installMcpTracing(server, {
    logger: consoleTracingLogger,
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
}

describe("installMcpTracing — the best-effort lifecycle", () => {
  test(
    "retrieval span helpers are direct no-ops outside an active traced call",
    spanHelpersAreNoOpsOutsideATracedCall,
  );

  test(
    "an isError result is traced as status error, not success",
    isErrorResultTracesAsError,
  );

  test(
    "a sink that throws on every method leaves the result byte-identical and never throws",
    throwingSinkLeavesResultByteIdentical,
  );

  test(
    "a handler exception still propagates, traced as status exception with the error class",
    handlerExceptionPropagatesAndIsTraced,
  );

  test(
    "disabled config leaves registerTool untouched — no wrapper at all",
    disabledConfigLeavesRegisterToolUntouched,
  );

  test("installing twice wraps once", installingTwiceWrapsOnce);

  test(
    "a sink factory that throws degrades to no tracing instead of failing install",
    throwingSinkFactoryDegradesToNoTracing,
  );

  test(
    "a non-function third argument passes through unwrapped",
    nonFunctionThirdArgumentPassesThrough,
  );
});
