/**
 * Structured logging boundary tests.
 * Design authority: `_DOCS/STANDARDS-observability.md`.
 */
import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import type { DestinationStream } from "pino";
import { withCorrelation } from "./context.ts";
import { createLogger, withOperation, workerLogPath } from "./logger.ts";
import { sanitizeValue } from "./sanitize.ts";

const CONFIG = {
  level: "debug" as const,
  file: "logs/open-brain.log",
  service: "open-brain-server",
  workerName: "worker-2",
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
    entries: () => lines.flatMap((line) =>
      line.split("\n").filter(Boolean).map((item) => JSON.parse(item)),
    ),
  };
}

describe("structured logging boundary", () => {
  it("emits the required envelope and carries correlation across await", async () => {
    const capture = captureLogger();
    await withCorrelation(async () => {
      await Promise.resolve();
      capture.logger.info("foundation_ready");
    }, "correlation-test");
    expect(capture.entries()[0]).toMatchObject({
      level: "info",
      message: "foundation_ready",
      service: "open-brain-server",
      worker: "worker-2",
      correlation_id: "correlation-test",
    });
    expect(typeof capture.entries()[0]?.timestamp).toBe("string");
  });

  it("redacts declared secret fields and safely projects nested values", () => {
    const capture = captureLogger();
    const sensitiveValue = randomUUID();
    capture.logger.info({ authorization: sensitiveValue, nested: { apiKey: sensitiveValue, ok: "yes" } }, "safe_event");
    expect(capture.entries()[0]?.authorization).toBe("[REDACTED]");
    expect(capture.entries()[0]?.nested).toEqual({ apiKey: "[REDACTED]", ok: "yes" });
    expect((sanitizeValue("x".repeat(250)) as string).length).toBeLessThan(250);
    expect(sanitizeValue(new URL("https://example.invalid/path"))).toEqual({ type: "URL", key_count: 0 });
  });

  it("emits entry, result, duration, and failure through the operation wrapper", async () => {
    const capture = captureLogger();
    await withOperation({ logger: capture.logger, name: "ok", work: async () => 7 });
    await expect(withOperation({ logger: capture.logger, name: "bad", work: async () => { throw new TypeError("boom"); } })).rejects.toThrow("boom");
    expect(capture.entries().map((entry) => entry.message)).toEqual([
      "operation_entry",
      "operation_result",
      "operation_entry",
      "operation_failure",
    ]);
    expect(capture.entries()[1]?.duration_ms).toBeNumber();
    expect(capture.entries()[3]?.error).toEqual({ type: "TypeError", message: "boom" });
  });

  it("derives a separate file path for every worker", () => {
    expect(workerLogPath("logs/open-brain.log", "worker/2")).toBe("logs/open-brain.worker_2.log");
  });
});
