/**
 * Unit tests for the crash-visibility seam. No database: the registrar's whole
 * contract is process listeners, one fatal line, and one terminate call.
 */
import { describe, expect, it } from "vitest";
import type { Logger } from "pino";
import { projectCrashReason, registerCrashHandlers } from "./crash-handlers.ts";

describe("projectCrashReason", () => {
  it("carries an Error's name, message and stack", () => {
    const projected = projectCrashReason(new TypeError("boom"));
    expect(projected.name).toBe("TypeError");
    expect(projected.message).toBe("boom");
    expect(typeof projected.stack).toBe("string");
    expect(projected.stack).toContain("boom");
  });

  it("names a non-Error rejection rather than guessing its type", () => {
    const projected = projectCrashReason({ code: 7 });
    expect(projected.name).toBe("non_error_rejection");
    expect(projected.message).toBe("[object Object]");
    expect(projected.stack).toBeNull();
  });
});

describe("registerCrashHandlers", () => {
  it("logs one fatal crash line, terminates, and unregisters cleanly", () => {
    const before = process.listenerCount("uncaughtException");
    const fatalCalls: Array<{ payload: unknown; event: unknown }> = [];
    let flushed = 0;
    const logger = {
      fatal: (payload: unknown, event: unknown) => {
        fatalCalls.push({ payload, event });
      },
      flush: () => {
        flushed += 1;
      },
    } as unknown as Logger;

    // A sentinel instead of process.exit: the registrar's terminate is typed
    // `never`, and a test that actually exited would take the runner with it.
    const sentinel = new Error("terminate-sentinel");
    const codes: number[] = [];
    const terminate = (code: number): never => {
      codes.push(code);
      throw sentinel;
    };

    const registration = registerCrashHandlers(logger, terminate);
    try {
      expect(() => process.emit("uncaughtException", new Error("x"))).toThrow(sentinel);

      expect(fatalCalls).toHaveLength(1);
      const first = fatalCalls[0];
      if (!first) throw new Error("no fatal line was recorded");
      const { crash } = first.payload as {
        crash: { name: string; message: string; stack: string | null };
      };
      expect(crash.name).toBe("Error");
      expect(crash.message).toBe("x");
      expect(typeof crash.stack).toBe("string");
      expect(first.event).toBe("process_uncaught_exception");
      expect(flushed).toBe(1);
      expect(codes).toEqual([1]);
    } finally {
      registration.unregister();
    }

    expect(process.listenerCount("uncaughtException")).toBe(before);
  });
});
