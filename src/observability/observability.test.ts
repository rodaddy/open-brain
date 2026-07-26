/**
 * Behavioral tests for the observability surface.
 *
 * These assert what a log consumer actually receives — the parsed JSON lines a
 * Loki query would match — for varied inputs. They do not assert internal call
 * shapes.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { logger, addLogSink, setLogLevel, getLogLevel } from "../logger.ts";
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
    // `host` is the second of the two Loki labels; a line missing it leaves a
    // hole in the per-host query surface.
    expect(typeof line!.host).toBe("string");
    expect(String(line!.host).length).toBeGreaterThan(0);
    expect(typeof line!.timestamp).toBe("string");
    // caller fields survive alongside the envelope
    expect(line!.count).toBe(3);
  });

  it("does not let a caller field shadow host", () => {
    logger.info("evt", { host: "impostor" });
    expect(captured[0]!.host).not.toBe("impostor");
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

describe("describeError redaction", () => {
  // Caught in adversarial review of the logging sweep, from a real failing run:
  // an error thrown during a NATS-bridge context-pack build arrived with `name`
  // set to `NatsError nats://user:pass@host`. `withLogging` logs at the THROW
  // SITE, before src/nats-bridge.ts can apply its safeErrorType() allowlist, so
  // a redactor at the boundary cannot help. Every emitted field is redacted.
  it("redacts credentials from error_name, error_message, and error_stack", () => {
    const secret = ["user", ":", "pass"].join("");
    const url = `nats://${secret}@broker.internal:4222`;
    const err = new Error(`working set exploded for ${url}`);
    // `name` is writable, which is exactly why it cannot be trusted.
    err.name = `NatsError ${url}`;

    const fields = describeError(err);

    expect(fields.error_name).not.toContain(secret);
    expect(fields.error_message).not.toContain(secret);
    expect(fields.error_stack ?? "").not.toContain(secret);
    // Redacted, not dropped: the diagnostic shape must survive.
    expect(fields.error_name).toContain("[REDACTED]");
    expect(fields.error_message).toContain("working set exploded");
  });

  it("redacts a thrown string", () => {
    const secret = ["user", ":", "pass"].join("");
    const fields = describeError(`boom postgres://${secret}@db/x`);
    expect(fields.error_name).toBe("ThrownString");
    expect(fields.error_message).not.toContain(secret);
  });

  it("keeps ordinary errors fully readable", () => {
    const fields = describeError(new TypeError("x is not a function"));
    expect(fields.error_name).toBe("TypeError");
    expect(fields.error_message).toBe("x is not a function");
  });
});

describe("envelope ownership", () => {
  it("does not let async context override service, host, or level", () => {
    // `service` and `host` are the only two envelope fields that become Loki
    // labels. A context reader that returns either -- by accident or by
    // spreading a request object wholesale -- would silently split the query
    // surface, and nothing in the emitted line would say so.
    //
    // The spread order is the whole fix: context used to land AFTER the
    // envelope block that claims to own these names.
    setLogLevel("info");
    captured.length = 0;

    // withContext merges arbitrary fields, so this is reachable without a
    // hand-written reader: any caller that spreads a request object into the
    // scope can carry a `service` key in without meaning to.
    withContext(
      {
        correlation_id: "cid-1",
        service: "not-open-brain",
        host: "not-this-host",
        level: "debug",
      },
      () => {
        logger.info("owned_envelope");
      },
    );

    const line = captured.find((l) => l.message === "owned_envelope");
    expect(line).toBeDefined();
    expect(line!.service).not.toBe("not-open-brain");
    expect(line!.host).not.toBe("not-this-host");
    expect(line!.level).toBe("info");
    // Context still supplies what it is actually for.
    expect(line!.correlation_id).toBe("cid-1");
  });
});

describe("runtime log level", () => {
  // Restore whatever the process started at, so raising the level here cannot
  // leak into another suite in this shared process.
  const original = getLogLevel();
  afterEach(() => {
    setLogLevel(original);
  });

  it("drops debug lines at the default info level", () => {
    setLogLevel("info");
    captured.length = 0;
    logger.debug("quiet_line");
    expect(captured.some((l) => l.message === "quiet_line")).toBe(false);
  });

  it("emits debug lines once raised, without a restart", () => {
    // The point of the setter: an incident is the worst moment to restart the
    // process being investigated.
    setLogLevel("debug");
    captured.length = 0;
    logger.debug("loud_line", { detail: 1 });

    const line = captured.find((l) => l.message === "loud_line");
    expect(line).toBeDefined();
    expect(line!.level).toBe("debug");
    expect(line!.detail).toBe(1);
  });

  it("reaches the target level even when the announce line throws", () => {
    // The announce widens the gate temporarily so the transition cannot filter
    // its own notice. `log` can throw for real -- FILE_SINK.write fails on a
    // full or unwritable disk -- and without a `finally` the widened value is
    // where minLevel stays.
    //
    // That inverts the intent on the one path this setter exists for: an
    // operator raising verbosity mid-incident, on the box whose disk just
    // filled, gets debug-volume logging from a call that reported failure.
    // Go DOWN in verbosity (debug -> error). The widened gate is then "debug"
    // and the target is "error", so the two differ and the assertion can tell
    // a restored level from a stuck one. Raising instead would leave both at
    // "debug" and pass either way.
    setLogLevel("debug");

    const realLog = console.log;
    let armed = true;
    console.log = ((...args: unknown[]) => {
      if (armed) {
        armed = false;
        throw new Error("sink failure (full disk)");
      }
      return realLog(...(args as []));
    }) as typeof console.log;

    let threw = false;
    try {
      setLogLevel("error");
    } catch {
      threw = true;
    } finally {
      console.log = realLog;
    }

    expect(threw).toBe(true);
    // Pre-fix: "debug" -- stuck at the widened gate, so the process keeps
    // emitting debug volume after a call that reported failure.
    expect(getLogLevel()).toBe("error");
  });

  it("announces the change so the transition is visible in the stream", () => {
    setLogLevel("info");
    captured.length = 0;
    setLogLevel("warn");

    const line = captured.find((l) => l.message === "log_level_changed");
    expect(line).toBeDefined();
    expect(line!.from).toBe("info");
    expect(line!.to).toBe("warn");
  });

  it("announces the change in both directions, including up from error", () => {
    // Both directions can swallow their own notice: emitting after the swap
    // loses it when lowering verbosity, emitting before loses it when raising
    // from a level that already suppressed info.
    setLogLevel("error");
    captured.length = 0;
    setLogLevel("debug");

    const line = captured.find((l) => l.message === "log_level_changed");
    expect(line).toBeDefined();
    expect(line!.from).toBe("error");
    expect(line!.to).toBe("debug");
  });

  it("rejects an unknown level instead of silently keeping the old one", () => {
    setLogLevel("warn");
    // Silently ignoring a typo looks identical to the setting having worked,
    // which is the failure mode this whole sweep exists to remove.
    expect(() => setLogLevel("verbose")).toThrow(/unknown log level/);
    expect(getLogLevel()).toBe("warn");
  });

  it("normalises case and surrounding whitespace", () => {
    expect(setLogLevel("  DEBUG ")).toBe("debug");
    expect(getLogLevel()).toBe("debug");
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
