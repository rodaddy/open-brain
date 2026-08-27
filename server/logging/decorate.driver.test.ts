/**
 * Driver test for the L3 logging decoration seam (`server/logging/decorate.ts`).
 *
 * Design authority: `_DOCS/STANDARDS-observability.md` for the envelope,
 * `_plans/server-hardening-ladder.md` rung L3 ("one logger, threaded") for the
 * seam itself, gated by `scripts/done-means/750-l3-logger-threaded.sh`.
 *
 * WRITTEN RED, ON PURPOSE. `./decorate.ts` does not exist yet; this file is
 * the specification States 5-6 of the L3 handover code against, so it must be
 * committed BEFORE the module it imports. Until then the import fails and
 * `bun test server/logging/decorate.driver.test.ts` exits non-zero, which is
 * precisely what clause 4 of the done-means check reports.
 *
 * What it pins down, and why each part is not negotiable:
 *
 *   - The seam takes a logger it is GIVEN. There is no `createLogger` call in
 *     this file and there must be none in `decorate.ts`: the whole rung exists
 *     so that exactly one logger is constructed, in `server/main.ts`.
 *   - A thrown error must still throw. A wrapper that swallows the failure to
 *     log it has replaced a loud defect with a quiet one.
 *   - The emitted line must carry `stack`. An error logged as `{}` — which is
 *     what `JSON.stringify` does to an `Error` — is the failure mode that makes
 *     the log useless in exactly the case it exists for.
 *   - The line must carry the ambient `correlation_id` from `./context.ts`, not
 *     one the caller passes in. That is what ties the failure to the request
 *     that caused it across the await boundary.
 *   - Both spellings are covered: `withLogging` for plain functions and
 *     closures, `logged` for class methods. The server has both shapes.
 */
import { describe, expect, it } from "bun:test";
import { Writable } from "node:stream";
import type { DestinationStream } from "pino";
import { withCorrelation } from "./context.ts";
import { withLogging, logged } from "./decorate.ts";
import { createLogger } from "./logger.ts";

const CONFIG = {
  level: "debug" as const,
  file: "logs/open-brain.log",
  service: "open-brain-server",
  workerName: "worker-1",
};

/**
 * One in-memory destination and the parsed lines written to it.
 *
 * Deliberately the same shape as `captureLogger` in
 * `server/logging/logging.test.ts` rather than an import of it: that helper is
 * module-private there, and a test that reaches across into another test file
 * couples two suites that should be able to move independently.
 */
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

/** The first entry whose level is `error`, as a flat record. */
function firstFailure(
  entries: Record<string, unknown>[],
): Record<string, unknown> {
  const found = entries.find((entry) => entry.level === "error");
  expect(found).toBeDefined();
  return found as Record<string, unknown>;
}

describe("logging decoration seam", () => {
  it("logs a thrown error with its stack and the ambient correlation id", async () => {
    const capture = captureLogger();
    const explode = withLogging(
      { logger: capture.logger, name: "explode" },
      async (): Promise<never> => {
        await Promise.resolve();
        throw new Error("driver_boom");
      },
    );

    await expect(
      withCorrelation(async () => explode(), "driver-correlation"),
    ).rejects.toThrow("driver_boom");

    const failure = firstFailure(capture.entries());
    expect(failure.correlation_id).toBe("driver-correlation");
    const error = failure.error as Record<string, unknown>;
    expect(typeof error.stack).toBe("string");
    expect(String(error.stack)).toContain("driver_boom");
  });

  it("passes arguments and the return value through on the success path", async () => {
    const capture = captureLogger();
    const add = withLogging(
      { logger: capture.logger, name: "add" },
      async (left: number, right: number) => {
        await Promise.resolve();
        return left + right;
      },
    );

    await expect(
      withCorrelation(async () => add(2, 3), "driver-ok"),
    ).resolves.toBe(5);
    expect(capture.entries().some((entry) => entry.level === "error")).toBe(
      false,
    );
  });

  it("logs a thrown error from a decorated method the same way", async () => {
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
      withCorrelation(async () => new Subject().fail(), "driver-method"),
    ).rejects.toThrow("method_boom");

    const failure = firstFailure(capture.entries());
    expect(failure.correlation_id).toBe("driver-method");
    expect(String((failure.error as Record<string, unknown>).stack)).toContain(
      "method_boom",
    );
  });
});
