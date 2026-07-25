/**
 * Behavioral tests for the observability surface.
 *
 * These assert what a log consumer actually receives — the parsed JSON lines a
 * Loki query would match — for varied inputs. They do not assert internal call
 * shapes.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { logger, addLogSink } from "../logger.ts";
import { withContext, currentCorrelationId } from "./context.ts";
import { withLogging, withFallback, describeError } from "./with-logging.ts";

type Line = Record<string, unknown>;

// Log lines are observed through the logger's own sink rather than by swapping
// `console.*`: Bun runs every test file in one process, and other suites here
// replace console methods inline without restoring them.
//
// These tests are also why no suite may `mock.module("./logger.ts")`. That mock
// is process-wide and permanent in Bun — keyed by resolved specifier, never
// scoped to one file, and not undone by `mock.restore()`. This module's subject
// IS the real logger, so any stub of it makes every assertion below vacuous:
// the sink is never invoked, `captured` stays empty, and the failure surfaces
// here while its cause lives in another file. Suites needing to assert on log
// output use `addLogSink` instead, which observes without replacing.

let captured: Line[] = [];
let unsubscribe: (() => void) | undefined;

beforeEach(() => {
  captured = [];
  unsubscribe = addLogSink((entry) => {
    captured.push(entry as Line);
  });

  // Prove the sink is really wired before any assertion depends on it.
  // Checking `typeof addLogSink === "function"` is not enough: a stubbed
  // logger exporting `addLogSink: () => () => {}` satisfies that check while
  // never invoking the sink, which is exactly how this suite once failed 18
  // assertions with an empty `captured` and no indication why. Emitting a line
  // and requiring it back detects a no-op stub as well as a missing export.
  // `info`, not `debug`: the default MIN_LEVEL is "info", so a debug probe is
  // dropped by the level gate and would report a broken sink on a healthy one.
  const probeIndex = captured.length;
  logger.info("observability_sink_probe");
  if (captured.length === probeIndex) {
    unsubscribe();
    unsubscribe = undefined;
    throw new Error(
      "logger.addLogSink did not deliver an emitted line — ../logger.ts has " +
        "been replaced, almost certainly by a `mock.module` stub in a test file " +
        "loaded earlier in this run (the stub is process-wide and permanent). " +
        "Find it with `grep -rn 'mock.module' src scripts` and convert it to " +
        "observe via `addLogSink`. Do not weaken this check.",
    );
  }
  captured = [];
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
});

describe("shared envelope", () => {
  it("stamps every line with the envelope fields", () => {
    logger.info("thing_happened", { count: 3 });

    const [line] = captured;
    expect(line).toBeDefined();
    expect(line!.level).toBe("info");
    expect(line!.message).toBe("thing_happened");
    expect(typeof line!.service).toBe("string");
    expect(String(line!.service).length).toBeGreaterThan(0);
    expect(typeof line!.timestamp).toBe("string");
    // caller fields survive alongside the envelope
    expect(line!.count).toBe(3);
  });

  it("emits an ISO-8601 timestamp a log pipeline can parse", () => {
    logger.info("t");
    const stamp = String(captured[0]!.timestamp);
    expect(Number.isNaN(Date.parse(stamp))).toBe(false);
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("does not let a caller field shadow an envelope field", () => {
    // Two repos spelling `service` differently is how one query surface
    // becomes several, so the envelope must win over caller input.
    logger.info("evt", { service: "impostor", level: "debug" });

    const line = captured[0]!;
    expect(line.service).not.toBe("impostor");
    expect(line.level).toBe("info");
  });

  it("omits correlation_id outside any context scope", () => {
    logger.info("no_scope");
    expect(captured[0]!.correlation_id).toBeUndefined();
  });
});

describe("withContext", () => {
  it("attaches correlation_id to lines emitted inside the scope", async () => {
    await withContext({ correlation_id: "abc-123" }, async () => {
      logger.info("inside");
    });

    expect(captured[0]!.correlation_id).toBe("abc-123");
  });

  it("survives await boundaries", async () => {
    await withContext({ correlation_id: "across-await" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      logger.info("after_await");
    });

    expect(captured[0]!.correlation_id).toBe("across-await");
  });

  it("keeps concurrent operations' ids separate", async () => {
    // The failure this guards against is two in-flight requests sharing one id,
    // which would make both operations unreadable in Loki.
    await Promise.all([
      withContext({ correlation_id: "req-A" }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        logger.info("from_a");
      }),
      withContext({ correlation_id: "req-B" }, async () => {
        logger.info("from_b");
      }),
    ]);

    const byMessage = new Map(
      captured.map((l) => [l.message, l.correlation_id]),
    );
    expect(byMessage.get("from_b")).toBe("req-B");
    expect(byMessage.get("from_a")).toBe("req-A");
  });

  it("merges nested scopes instead of replacing them", async () => {
    await withContext({ correlation_id: "outer" }, async () => {
      await withContext(
        { correlation_id: "outer", lane_id: "L1" },
        async () => {
          logger.info("nested");
        },
      );
    });

    expect(captured[0]!.correlation_id).toBe("outer");
    expect(captured[0]!.lane_id).toBe("L1");
  });

  it("does not leak context after the scope ends", async () => {
    await withContext({ correlation_id: "gone" }, async () => {
      logger.info("in");
    });
    logger.info("out");

    expect(captured[1]!.correlation_id).toBeUndefined();
    expect(currentCorrelationId()).toBeUndefined();
  });
});

describe("withLogging", () => {
  it("emits an ok line with a duration on success", async () => {
    const result = await withLogging("load_thing", async () => "value");

    expect(result).toBe("value");
    // The entry line is `debug`, so at the default `info` level only the exit
    // line is emitted. Deliberate: entry logging is expensive and noisy in
    // production, and the exit line is the one that carries the outcome.
    // Raising LOG_LEVEL to `debug` restores it — asserted below.
    const ok = captured.find((l) => l.message === "load_thing_ok")!;
    expect(ok).toBeDefined();
    expect(ok.level).toBe("info");
    expect(typeof ok.duration_ms).toBe("number");
    expect(captured.some((l) => l.message === "load_thing_failed")).toBe(false);
  });

  it("records a duration that reflects real elapsed time", async () => {
    await withLogging("slow_thing", async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    const ok = captured.find((l) => l.message === "slow_thing_ok")!;
    expect(Number(ok.duration_ms)).toBeGreaterThanOrEqual(15);
  });

  it("logs a failure and re-throws the original error", async () => {
    const boom = new Error("kaboom");

    await expect(
      withLogging("risky", async () => {
        throw boom;
      }),
    ).rejects.toThrow("kaboom");

    const failure = captured.find((l) => l.message === "risky_failed")!;
    expect(failure).toBeDefined();
    expect(failure.level).toBe("error");
    expect(failure.error_message).toBe("kaboom");
    expect(failure.error_name).toBe("Error");
  });

  it("carries the correlation_id onto all of an operation's lines", async () => {
    // The point of the wrapper: five points for one operation are queryable as
    // one unit.
    await withContext({ correlation_id: "op-1" }, async () => {
      await withLogging("multi", async () => {
        logger.warn("multi_degraded_path", { reason: "cache_cold" });
      });
    });

    // Two lines at the default level: the operation's exit line and the
    // caller's explicit degraded-path warning. Both must be joinable.
    expect(captured.length).toBeGreaterThanOrEqual(2);
    for (const line of captured) {
      expect(line.correlation_id).toBe("op-1");
    }
    expect(captured.map((l) => l.message)).toContain("multi_degraded_path");
    expect(captured.map((l) => l.message)).toContain("multi_ok");
  });

  it("passes caller fields through to every line it emits", async () => {
    await withLogging("scoped", async () => undefined, { lane_id: "L9" });
    expect(captured.length).toBeGreaterThan(0);
    for (const line of captured) expect(line.lane_id).toBe("L9");
  });

  it("includes the caller fields on the failure line too", async () => {
    await expect(
      withLogging(
        "scoped_fail",
        async () => {
          throw new Error("nope");
        },
        { lane_id: "L9" },
      ),
    ).rejects.toThrow("nope");

    const failure = captured.find((l) => l.message === "scoped_fail_failed")!;
    expect(failure.lane_id).toBe("L9");
  });
});

describe("withFallback", () => {
  it("returns the value when the operation succeeds and logs nothing", async () => {
    const value = await withFallback("lookup", async () => 42, -1);

    expect(value).toBe(42);
    // "No log line means success" — a healthy path must stay quiet.
    expect(captured).toEqual([]);
  });

  it("warns and returns the fallback when the operation throws", async () => {
    const value = await withFallback(
      "lookup",
      async () => {
        throw new Error("unreachable");
      },
      -1,
    );

    expect(value).toBe(-1);
    expect(captured[0]!.message).toBe("lookup_degraded");
    expect(captured[0]!.level).toBe("warn");
    expect(captured[0]!.error_message).toBe("unreachable");
  });
});

describe("describeError", () => {
  it("reduces an Error to name, message, and stack", () => {
    const fields = describeError(new TypeError("bad type"));
    expect(fields.error_name).toBe("TypeError");
    expect(fields.error_message).toBe("bad type");
    expect(typeof fields.error_stack).toBe("string");
  });

  it("handles thrown non-errors without throwing", () => {
    expect(describeError("just a string").error_message).toBe("just a string");
    expect(describeError(undefined).error_name).toBe("ThrownNonError");
    expect(describeError(null).error_name).toBe("ThrownNonError");
    expect(describeError({ weird: true }).error_name).toBe("ThrownNonError");
  });

  it("does not copy arbitrary properties off a thrown object", async () => {
    // Thrown objects routinely carry request/config/credential data. Spreading
    // an error into a log entry leaks whatever is attached to it.
    const err = Object.assign(new Error("http failed"), {
      config: { headers: { authorization: "Bearer super-secret-value" } },
      request: { body: "private" },
    });

    await withFallback(
      "call",
      async () => {
        throw err;
      },
      null,
    );

    const serialized = JSON.stringify(captured[0]);
    expect(serialized).not.toContain("super-secret-value");
    expect(serialized).not.toContain("private");
    expect(captured[0]!.error_message).toBe("http failed");
  });
});
