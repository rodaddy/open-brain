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

describe("the emit path never throws at the call site", () => {
  // Review lane finding, both lanes independently, HIGH. `JSON.stringify(entry)`
  // was the one unguarded step in `log()` -- every neighbour is deliberately
  // fail-open. A cycle, a BigInt, or a throwing toJSON in ANY caller field or
  // context field lost the line on all four destinations and threw into
  // arbitrary application code.
  const cyclic = () => {
    const o: Record<string, unknown> = { name: "ctx" };
    o.self = o;
    return o;
  };

  it("emits a line for a cyclic field instead of throwing", () => {
    captured.length = 0;

    expect(() => logger.info("cyclic_field", { ctx: cyclic() })).not.toThrow();

    const line = captured.find((l) => l.message === "cyclic_field");
    expect(line).toBeDefined();
  });

  it("emits a line for a BigInt field instead of throwing", () => {
    captured.length = 0;

    expect(() => logger.info("bigint_field", { row_id: 7n })).not.toThrow();

    const line = captured.find((l) => l.message === "bigint_field");
    expect(line).toBeDefined();
    expect(line!.row_id).toBe("7");
  });

  it("emits a line when a field's toJSON throws", () => {
    captured.length = 0;
    const hostile = {
      toJSON() {
        throw new Error("toJSON boom");
      },
    };

    expect(() => logger.info("hostile_field", { hostile })).not.toThrow();

    // The envelope-only fallback still lands, and says why it is thin.
    const line = captured.find(
      (l) => l.message === "hostile_field" || l.log_serialize_failed === true,
    );
    expect(line).toBeDefined();
  });

  it("still runs the wrapped operation at debug with an unserializable field", async () => {
    // The worst consequence: `withLogging` emits its entry line at debug BEFORE
    // calling fn. At info that line is gated out and fn runs; at debug the same
    // call threw and fn was NEVER invoked. Raising the log level to investigate
    // an incident silently stopped work from running -- the exact scenario
    // setLogLevel exists for.
    const original = getLogLevel();
    setLogLevel("debug");
    let ran = false;
    try {
      await withLogging(
        "critical_op",
        async () => {
          ran = true;
          return "ok";
        },
        { ctx: cyclic() },
      );
    } finally {
      setLogLevel(original);
    }

    expect(ran).toBe(true);
  });

  it("re-throws the caller's original error by identity", async () => {
    // `withLogging` documents "re-throws whatever fn throws, unchanged". A
    // serializer throw from the logging wrapper replaced the real root cause.
    const real = new Error("real root cause");
    let caught: unknown;
    try {
      await withLogging(
        "op",
        async () => {
          throw real;
        },
        { ctx: cyclic() },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(real);
  });

  it("withFallback returns the fallback rather than throwing", async () => {
    const result = await withFallback(
      "cache_read",
      async () => {
        throw new Error("miss");
      },
      "FALLBACK",
      { key: 1n },
    );

    expect(result).toBe("FALLBACK");
  });
});

describe("redaction covers the whole entry", () => {
  it("redacts caller-supplied fields, not just error_* fields", () => {
    // Review lane finding, HIGH. `redactForLog` was applied only to
    // error_name/error_message/error_stack, so the IDENTICAL credential went
    // out redacted in error_message and in clear in a caller field on the same
    // line. Redaction belongs at the envelope.
    captured.length = 0;

    logger.error("nats_connect_failed", {
      dsn: "nats://user:hunter2@10.71.1.21:4222",
    });

    const line = captured.find((l) => l.message === "nats_connect_failed");
    expect(line).toBeDefined();
    expect(JSON.stringify(line)).not.toContain("hunter2");
  });

  it("redacts context fields too", () => {
    captured.length = 0;

    withContext(
      { correlation_id: "cid-x", token: "Bearer AAAAAAAAAAAAAAAAAAAA" },
      () => {
        logger.info("ctx_secret");
      },
    );

    const line = captured.find((l) => l.message === "ctx_secret");
    expect(line).toBeDefined();
    expect(JSON.stringify(line)).not.toContain("AAAAAAAAAAAAAAAAAAAA");
  });

  it("bounds the redaction input so a pathological string cannot stall the loop", () => {
    // PRIVATE_KEY_BLOCK_RE is quadratic on repeated BEGIN markers with no END:
    // measured 625 KB -> 3.9 s of blocked event loop. An unbounded string in a
    // log line is its own problem regardless of the pattern.
    captured.length = 0;
    const pathological = "-----BEGIN PRIVATE KEY-----".repeat(20_000);

    const started = Date.now();
    logger.info("pathological", { blob: pathological });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(1_000);
    const line = captured.find((l) => l.message === "pathological");
    expect(line).toBeDefined();
  });

  it("redacts a credential that straddles the truncation boundary", () => {
    // Sol final-gate finding, HIGH. The bound was applied BEFORE the patterns
    // ran, so a DSN crossing the 16 KB cut was split mid-credential, no pattern
    // matched the surviving head, and the tail went out in clear. Truncating
    // cannot create a secret but it can destroy the evidence of one, so
    // redaction now runs first and the bound is applied to the result.
    captured.length = 0;
    const secret = "postgres://user:hunter2straddle@10.71.1.21:5432/openbrain";
    const blob = `${"x".repeat(16_384 - 20)}${secret}`;

    logger.info("straddling_secret", { blob });

    const line = captured.find((l) => l.message === "straddling_secret");
    expect(line).toBeDefined();
    // Pre-fix: "postgres://user:hunter2s" survived the cut unredacted.
    expect(JSON.stringify(line)).not.toContain("hunter2straddle");
    expect(JSON.stringify(line)).not.toContain("postgres://user:");
  });

  it("redacts a value by its field name when the value has no secret shape", () => {
    // Sol final-gate finding, HIGH. Every detector is value-shaped -- it
    // recognizes `sk-…`, `ghp_…`, or the text `password=…`. But a JSON logger
    // hands the replacer each value in ISOLATION, so an arbitrary passphrase
    // under a field called `password` has nothing to match on and went out in
    // clear. `json_labeled_secret` already describes this exact pair; it was
    // simply never shown the key.
    captured.length = 0;

    logger.info("structured_secret", {
      password: "hunter2driveway",
      api_key: "plainvalue123",
      db_dsn: "opaque-rotated-value",
      // Control: a non-sensitive field must stay readable.
      namespace: "shared-kb",
    });

    const line = captured.find((l) => l.message === "structured_secret");
    expect(line).toBeDefined();
    const serialized = JSON.stringify(line);
    // Pre-fix: all three values appeared verbatim.
    expect(serialized).not.toContain("hunter2driveway");
    expect(serialized).not.toContain("plainvalue123");
    expect(serialized).not.toContain("opaque-rotated-value");
    expect(line?.namespace).toBe("shared-kb");
  });
});

describe("serialization preserves data it is not required to drop", () => {
  it("keeps a repeated non-circular object on both fields", () => {
    // Sol final-gate finding, HIGH. Cycle detection used a WeakSet that only
    // ever grew, so it flagged any object seen a SECOND time -- including one
    // referenced from two sibling fields, which is not a cycle at all. Sharing
    // a single config/job/namespace object across fields is ordinary, so the
    // false positive was the common case and it silently dropped real data.
    captured.length = 0;
    const shared = { id: "abc" };

    logger.info("repeated_object", { a: shared, b: shared });

    const line = captured.find((l) => l.message === "repeated_object");
    expect(line).toBeDefined();
    // Pre-fix: b was the string "[Circular]".
    expect(line?.a).toEqual({ id: "abc" });
    expect(line?.b).toEqual({ id: "abc" });
  });

  it("still marks a genuine cycle rather than throwing", () => {
    // The guard against over-correcting the finding above: a real self
    // reference must still be caught, or the fix trades a data-loss bug for a
    // RangeError that loses the whole line.
    captured.length = 0;
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic.self = cyclic;

    logger.info("true_cycle", { cyclic });

    const line = captured.find((l) => l.message === "true_cycle");
    expect(line).toBeDefined();
    expect((line?.cyclic as Record<string, unknown>).self).toBe("[Circular]");
  });
});

describe("an unwritable file sink degrades to console", () => {
  it("still emits the line when LOG_FILE cannot be written", async () => {
    // Review lane finding, HIGH — against the TEST, not the code. A self-review
    // "fix" had wrapped `FILE_SINK?.write` in try/catch, and the lane proved no
    // test failed when that guard was reverted.
    //
    // Chasing that down showed the guard was defending against an impossible
    // case: `createRotatingFileSink` documents "Never throws on write" and
    // already wraps `appendFileSync` in its own try/catch. The guard is now
    // gone; what remains worth pinning is the BEHAVIOUR both were aiming at,
    // which nothing covered either way — an unwritable LOG_FILE must still
    // produce the line on console.
    //
    // A subprocess is the only honest way in: FILE_SINK is resolved once at
    // module load, so the suite (which runs with LOG_FILE unset) can never
    // exercise it in-process.
    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        `const { logger } = await import("${import.meta.dir}/../logger.ts");
         logger.error("disk_full_still_logs", { probe: 1 });`,
      ],
      {
        env: {
          ...process.env,
          // A directory that cannot exist as a file's parent -> every write throws.
          LOG_FILE: "/proc/nonexistent/open-brain.log",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    // The process must survive AND the line must reach console.error.
    expect(exitCode).toBe(0);
    expect(`${stdout}${stderr}`).toContain("disk_full_still_logs");
  });
});

describe("sink registration", () => {
  it("does not re-deliver a line to a sink that re-subscribes mid-emit", () => {
    // `Set` iteration observes mutation, so a sink that disposes and re-adds
    // itself landed back at the tail and was reached again by the same loop --
    // one log line drove a sink 50,001 times before a circuit breaker stopped
    // it. Inside the per-sink catch, so it presented as a silent hang.
    let calls = 0;
    let dispose: (() => void) | undefined;
    const sink = () => {
      calls += 1;
      if (calls > 100) return; // circuit breaker, so a regression fails loudly
      dispose?.();
      dispose = addLogSink(sink);
    };
    dispose = addLogSink(sink);

    logger.info("one_line");

    dispose?.();
    expect(calls).toBe(1);
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

  it("lets a nested setLogLevel from a sink win, and reports what took effect", () => {
    // Review lane finding. The `finally` restore was unconditional, but the
    // widened window runs sinks synchronously and one can reenter -- an
    // auto-escalate-on-error sink is the documented extension point. The nested
    // call set the level, returned its own target as though it stuck, and the
    // outer `finally` then silently reverted it.
    setLogLevel("info");
    let nestedReturn = "";
    const off = addLogSink((entry) => {
      if (entry.message === "log_level_changed" && entry.to === "debug") {
        nestedReturn = setLogLevel("error");
      }
    });

    const outerReturn = setLogLevel("debug");
    off();

    expect(nestedReturn).toBe("error");
    expect(getLogLevel()).toBe("error");
    // The outer call must report what is actually in effect, not what it asked
    // for -- otherwise a reentrant change is reported as the caller's own.
    expect(outerReturn).toBe("error");
  });

  it("lets a nested setLogLevel win even when it picks the widened level", () => {
    // Sol final-gate finding. The restore guard was `minLevel === widened`,
    // which cannot distinguish "my temporary widened value is still installed"
    // from "a nested call deliberately chose that same value".
    //
    // Lowering debug -> error makes `widened` the PREVIOUS level, "debug". An
    // auto-escalate sink that wants to stay at debug therefore sets exactly the
    // widened value, the equality guard reads it as untouched, and the outer
    // finally overwrites the nested decision. The test above passes with the
    // old code because its nested call picks "error", which differs from the
    // widened "debug"; only the colliding value exposes it.
    setLogLevel("debug");
    let nestedReturn = "";
    const off = addLogSink((entry) => {
      if (entry.message === "log_level_changed" && entry.to === "error") {
        nestedReturn = setLogLevel("debug");
      }
    });

    const outerReturn = setLogLevel("error");
    off();

    expect(nestedReturn).toBe("debug");
    // Pre-fix: "error" -- the nested decision was silently reverted while the
    // nested call had already reported "debug" as taking effect.
    expect(getLogLevel()).toBe("debug");
    expect(outerReturn).toBe("debug");
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
