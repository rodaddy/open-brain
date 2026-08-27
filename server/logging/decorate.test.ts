/**
 * Unit tests for the logging decoration seam.
 *
 * These cover the seam's own contract; `decorate.driver.test.ts` is the
 * specification the rung is gated on. Both use an in-memory destination so the
 * assertions read the real emitted envelope rather than a mock's record of it.
 */
import { describe, expect, it } from "bun:test";
import { Writable } from "node:stream";
import type { DestinationStream } from "pino";
import { withCorrelation } from "./context.ts";
import { logged, withLogging } from "./decorate.ts";
import { createLogger } from "./logger.ts";

const CONFIG = {
  level: "debug" as const,
  file: "logs/open-brain.log",
  service: "open-brain-server",
  workerName: "worker-1",
};

function captureLogger(): {
  logger: ReturnType<typeof createLogger>;
  entries(): Record<string, unknown>[];
} {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  return {
    logger: createLogger(CONFIG, stream as DestinationStream),
    entries: () =>
      lines.flatMap((line) =>
        line
          .split("\n")
          .filter(Boolean)
          .map((item) => JSON.parse(item) as Record<string, unknown>),
      ),
  };
}

function levels(entries: Record<string, unknown>[]): string[] {
  return entries.map((entry) => String(entry.level));
}

function messages(entries: Record<string, unknown>[]): string[] {
  return entries.map((entry) => String(entry.message));
}

describe("withLogging", () => {
  it("emits entry and exit lines around a synchronous call", () => {
    const capture = captureLogger();
    const double = withLogging(
      { logger: capture.logger, name: "double" },
      (value: number) => value * 2,
    );

    expect(double(21)).toBe(42);

    const entries = capture.entries();
    expect(messages(entries)).toEqual(["operation_entry", "operation_result"]);
    expect(levels(entries)).toEqual(["debug", "info"]);
    expect(entries[0]?.operation).toBe("double");
    expect(typeof entries[1]?.duration_ms).toBe("number");
  });

  it("keeps a synchronous function synchronous", () => {
    const capture = captureLogger();
    const identity = withLogging(
      { logger: capture.logger, name: "identity" },
      (value: string) => value,
    );

    const returned: unknown = identity("plain");
    expect(returned).toBe("plain");
    expect(returned instanceof Promise).toBe(false);
  });

  it("rethrows a synchronous failure after logging stack and correlation id", () => {
    const capture = captureLogger();
    const explode = withLogging(
      { logger: capture.logger, name: "explode_sync" },
      (): never => {
        throw new Error("sync_boom");
      },
    );

    const run = (): void => withCorrelation(explode, "corr-sync");
    expect(run).toThrow("sync_boom");

    const failure = capture
      .entries()
      .find((entry) => entry.level === "error") as Record<string, unknown>;
    expect(failure).toBeDefined();
    expect(failure.correlation_id).toBe("corr-sync");
    expect(failure.operation).toBe("explode_sync");
    const error = failure.error as Record<string, unknown>;
    expect(String(error.stack)).toContain("sync_boom");
  });

  it("awaits an asynchronous result and logs the exit after it settles", async () => {
    const capture = captureLogger();
    const add = withLogging(
      { logger: capture.logger, name: "add" },
      async (left: number, right: number) => {
        await Promise.resolve();
        return left + right;
      },
    );

    await expect(
      withCorrelation(async () => add(2, 3), "corr-ok"),
    ).resolves.toBe(5);
    const entries = capture.entries();
    expect(messages(entries)).toEqual(["operation_entry", "operation_result"]);
    expect(entries.some((entry) => entry.level === "error")).toBe(false);
  });

  it("rethrows an asynchronous failure with the ambient correlation id", async () => {
    const capture = captureLogger();
    const explode = withLogging(
      { logger: capture.logger, name: "explode_async" },
      async (): Promise<never> => {
        await Promise.resolve();
        throw new Error("async_boom");
      },
    );

    await expect(
      withCorrelation(async () => explode(), "corr-async"),
    ).rejects.toThrow("async_boom");

    const failure = capture
      .entries()
      .find((entry) => entry.level === "error") as Record<string, unknown>;
    expect(failure.correlation_id).toBe("corr-async");
    const error = failure.error as Record<string, unknown>;
    expect(typeof error.stack).toBe("string");
    expect(String(error.stack)).toContain("async_boom");
  });

  it("merges caller-supplied fields into the entry line", () => {
    const capture = captureLogger();
    const noop = withLogging(
      { logger: capture.logger, name: "noop", fields: { tenant: "rico" } },
      () => undefined,
    );

    noop();
    expect(capture.entries()[0]?.tenant).toBe("rico");
  });
});

describe("logged", () => {
  it("logs entry and exit for a decorated method and preserves `this`", async () => {
    const capture = captureLogger();
    const capturedLogger = capture.logger;

    class Counter {
      private readonly step = 5;

      @logged({ logger: () => capturedLogger, name: "Counter.bump" })
      async bump(value: number): Promise<number> {
        await Promise.resolve();
        return value + this.step;
      }
    }

    await expect(new Counter().bump(1)).resolves.toBe(6);
    const entries = capture.entries();
    expect(messages(entries)).toEqual(["operation_entry", "operation_result"]);
    expect(entries[0]?.operation).toBe("Counter.bump");
  });

  it("rethrows from a decorated method with stack and correlation id", async () => {
    const capture = captureLogger();
    const capturedLogger = capture.logger;

    class Subject {
      @logged({ logger: () => capturedLogger, name: "Subject.fail" })
      async fail(): Promise<never> {
        await Promise.resolve();
        throw new Error("method_boom");
      }
    }

    await expect(
      withCorrelation(async () => new Subject().fail(), "corr-method"),
    ).rejects.toThrow("method_boom");

    const failure = capture
      .entries()
      .find((entry) => entry.level === "error") as Record<string, unknown>;
    expect(failure.correlation_id).toBe("corr-method");
    expect(failure.operation).toBe("Subject.fail");
    expect(String((failure.error as Record<string, unknown>).stack)).toContain(
      "method_boom",
    );
  });

  it("resolves the logger at call time, not at class-definition time", () => {
    const capture = captureLogger();
    const holder: { value?: ReturnType<typeof createLogger> } = {};

    class Late {
      @logged({
        logger: () => {
          if (holder.value === undefined) {
            throw new Error("logger_not_ready");
          }
          return holder.value;
        },
        name: "Late.run",
      })
      run(): string {
        return "ran";
      }
    }

    const subject = new Late();
    holder.value = capture.logger;
    expect(subject.run()).toBe("ran");
    expect(messages(capture.entries())).toEqual([
      "operation_entry",
      "operation_result",
    ]);
  });

  it("rethrows a synchronous failure from a decorated method", () => {
    const capture = captureLogger();
    const capturedLogger = capture.logger;

    class SyncSubject {
      @logged({ logger: () => capturedLogger, name: "SyncSubject.fail" })
      fail(): never {
        throw new Error("sync_method_boom");
      }
    }

    expect(() => new SyncSubject().fail()).toThrow("sync_method_boom");
    const failure = capture
      .entries()
      .find((entry) => entry.level === "error") as Record<string, unknown>;
    expect(String((failure.error as Record<string, unknown>).stack)).toContain(
      "sync_method_boom",
    );
  });
});
