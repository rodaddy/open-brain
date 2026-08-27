/**
 * The injected logger actually receives each line this lane can emit.
 *
 * "No module imports the logger" is satisfiable by deleting all logging, which
 * is strictly worse than the defect (#860). So one test per file that used to
 * import the `src/logger.ts` singleton drives the real code path to its log
 * statement and asserts the line arrived at the logger the caller handed in —
 * with the fields-first argument order the composition root's logger expects.
 */
import { describe, expect, test } from "bun:test";
import { readMcpTracingConfig } from "./trace-config.ts";
import { shutdownSink } from "./trace-sink.ts";
import {
  reportSinkFailure,
  reportSinkSuccess,
  SinkHealthTracker,
} from "./trace-sink-health.ts";
import { installMcpTracing } from "./langfuse-tracing.ts";
import { tracingLoggerFrom } from "./trace-logger-adapter.ts";
import type { TraceBody, TracingLogger, TracingSink } from "./trace-types.ts";

interface RecordedLine {
  level: "info" | "warn";
  fields: Record<string, unknown>;
  message: string;
}

function recordingLogger(): TracingLogger & { readonly lines: RecordedLine[] } {
  const lines: RecordedLine[] = [];
  return {
    lines,
    info: (fields, message) => {
      lines.push({ level: "info", fields, message });
    },
    warn: (fields, message) => {
      lines.push({ level: "warn", fields, message });
    },
  };
}

describe("trace-config receives its logger", () => {
  test("the incomplete-flag warn reaches the injected logger, fields first", () => {
    const logger = recordingLogger();
    readMcpTracingConfig(
      {
        OPENBRAIN_TRACING_ENABLED: "1",
        OPENBRAIN_TRACING_ENDPOINT: "http://host:3000",
        OPENBRAIN_TRACING_PUBLIC_KEY: "pk",
        OPENBRAIN_TRACING_SECRET_KEY: "",
      },
      logger,
    );
    const line = logger.lines.find(
      (candidate) => candidate.message === "mcp_tool_tracing_config_incomplete",
    );
    expect(line).toBeDefined();
    expect(line?.level).toBe("warn");
    // Fields-first: the coordinates land in the fields object, not the message.
    expect(line?.fields).toEqual({
      endpointSet: true,
      publicIdSet: true,
      privateIdSet: false,
    });
  });
});

describe("trace-sink-health receives its logger", () => {
  test("the suspend warn reaches the injected logger", () => {
    const logger = recordingLogger();
    reportSinkFailure(logger, new SinkHealthTracker(), new Error("boom"));
    const line = logger.lines.find(
      (candidate) => candidate.message === "mcp_tool_tracing_suspended",
    );
    expect(line).toBeDefined();
    expect(line?.level).toBe("warn");
    // Content-free: an error LABEL only, never the thrown message.
    expect(line?.fields.error).toBeDefined();
    expect(JSON.stringify(line?.fields)).not.toContain("boom");
  });

  test("the recovery info reaches the injected logger with the dropped count", () => {
    const logger = recordingLogger();
    const tracker = new SinkHealthTracker();
    reportSinkFailure(logger, tracker, new Error("down"));
    reportSinkSuccess(logger, tracker);
    const line = logger.lines.find(
      (candidate) => candidate.message === "mcp_tool_tracing_resumed",
    );
    expect(line).toBeDefined();
    expect(line?.level).toBe("info");
    expect(typeof line?.fields.droppedTraces).toBe("number");
  });
});

describe("trace-sink receives its logger", () => {
  test("a flush failure on the way down reaches the injected logger", async () => {
    const logger = recordingLogger();
    const sink: TracingSink = {
      emit: () => {},
      forceFlush: () => Promise.reject(new Error("flush-failed")),
      shutdown: () => Promise.resolve(),
    };
    await shutdownSink(sink, logger);
    const line = logger.lines.find(
      (candidate) => candidate.message === "mcp_tool_tracing_flush_failed",
    );
    expect(line).toBeDefined();
    expect(line?.level).toBe("warn");
    expect(JSON.stringify(line?.fields)).not.toContain("flush-failed");
  });

  test("a shutdown failure on the way down reaches the injected logger", async () => {
    const logger = recordingLogger();
    const sink: TracingSink = {
      emit: () => {},
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.reject(new Error("stop-failed")),
    };
    await shutdownSink(sink, logger);
    expect(
      logger.lines.some(
        (candidate) => candidate.message === "mcp_tool_tracing_shutdown_failed",
      ),
    ).toBe(true);
  });
});

describe("langfuse-tracing receives its logger", () => {
  const enabledConfig = {
    enabled: true,
    maskingEnabled: true,
    endpoint: "http://host:3000",
    publicKey: "pk",
    secretKey: "sk",
  };

  test("a sink that throws on emit reports the outage to the injected logger", () => {
    const logger = recordingLogger();
    const sink: TracingSink = {
      emit: (_body: TraceBody) => {
        throw new Error("emit-exploded");
      },
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
      health: new SinkHealthTracker(),
    };
    let handler: ((args: unknown, extra: unknown) => unknown) | undefined;
    const server = {
      registerTool: (
        _name: string,
        _config: unknown,
        callback: (args: unknown, extra: unknown) => unknown,
      ) => {
        handler = callback;
      },
    };
    installMcpTracing(server as never, {
      config: enabledConfig,
      sink,
      logger,
    });
    server.registerTool("probe", {}, () => ({ ok: true }));
    expect(handler).toBeDefined();
    return Promise.resolve(handler?.({}, {})).then(() => {
      const line = logger.lines.find(
        (candidate) => candidate.message === "mcp_tool_tracing_suspended",
      );
      expect(line).toBeDefined();
      expect(JSON.stringify(line?.fields)).not.toContain("emit-exploded");
    });
  });

  test("a missing logger is a wiring error, never a silent no-op", () => {
    expect(() =>
      installMcpTracing({ registerTool: () => {} } as never, {
        config: enabledConfig,
      }),
    ).toThrow(/requires a logger from the composition root/);
  });
});

describe("the legacy-root adapter", () => {
  test("flips message-first calls into the fields-first shape", () => {
    const seen: { message: string; extra?: Record<string, unknown> }[] = [];
    const adapted = tracingLoggerFrom({
      info: (message, extra) => {
        seen.push({ message, ...(extra ? { extra } : {}) });
      },
      warn: (message, extra) => {
        seen.push({ message, ...(extra ? { extra } : {}) });
      },
    });
    adapted.warn({ a: 1 }, "some_event");
    expect(seen).toEqual([{ message: "some_event", extra: { a: 1 } }]);
  });
});
