import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * The trace body itself: masking, identity, duration, release, and the real
 * default sink's export order.
 */
import { describe, expect, test, vi } from "vitest";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildToolTraceBody,
  createTracingRuntime,
  errorOutput,
  readRuntimeDeployStamp,
  repoRelease,
  resolveRepoRelease,
} from "./langfuse-tracing.ts";
import { readDeployedRevision } from "../transport/server-identity.ts";
import { logger as legacyLogger } from "../logging/legacy-logger.ts";
import {
  consoleTracingLoggerFrom,
  ENABLED_CONFIG,
} from "./langfuse-tracing-fixtures.ts";

const consoleTracingLogger = consoleTracingLoggerFrom(legacyLogger);

/**
 * The v3 review's MEDIUM finding, carried into v4: the SDK's own logger writes
 * export failures straight to `console.error` with the raw error attached, so a
 * transport message carrying the endpoint or an auth header would bypass this
 * module's content-free discipline AND the shared logger's redaction.
 *
 * Measured before the fix: the SDK logger emitted 2 lines and the injected
 * `sk-lf-` string appeared in them.
 */
describe("the SDK's own logger cannot bypass the content-free discipline", () => {
  test("building the real sink silences SDK-level error and warn output", async () => {
    const { configureGlobalLogger, getGlobalLogger, LogLevel } =
      await import("@langfuse/core");

    // Asserted through the SDK's OWN level gate rather than by capturing
    // `console.error`: Bun's runner installs its own console, so a swapped
    // `console.error` does not reliably observe a library's writes from inside
    // a test. `shouldLog` is the exact predicate that decides whether the SDK
    // reaches the console at all, so checking it tests the real mechanism
    // instead of a proxy for it.
    type Gated = { shouldLog(level: number): boolean };

    // Baseline asserted FIRST and explicitly, because the SDK logger is
    // process-global: an earlier test that built a real sink has already
    // installed the suppression, so "silent" would otherwise pass for the
    // wrong reason.
    configureGlobalLogger({ level: LogLevel.DEBUG });
    expect((getGlobalLogger() as unknown as Gated).shouldLog(LogLevel.ERROR)).toBe(
      true,
    );

    // Building the real sink installs the suppression. `createSink` is NOT
    // injected here on purpose: the point is that the DEFAULT factory does it.
    createTracingRuntime({
      config: ENABLED_CONFIG,
      logger: consoleTracingLogger,
    });

    const gated = getGlobalLogger() as unknown as Gated;
    expect(gated.shouldLog(LogLevel.ERROR)).toBe(false);
    expect(gated.shouldLog(LogLevel.WARN)).toBe(false);
  });

  // #825 (L2b-2): this module reads no environment. A caller that omits
  // `config` used to get a second, module-private parse of the ambient
  // environment that could disagree with the one the composition root made;
  // now it gets a wiring error at the call site instead of a silently
  // different runtime.
  test("throws when constructed without config from the composition root", () => {
    expect(() => createTracingRuntime()).toThrow(
      /requires config from the composition root/,
    );
    expect(() => createTracingRuntime({})).toThrow(
      /requires config from the composition root/,
    );
  });
});

describe("the real default sink", () => {
  test("emits retrieval spans and background observations before ending the parent", async () => {
    const names: string[] = [];
    let parentEnded = 0;
    const child = { end: () => undefined };
    const parent = {
      otelSpan: {
        spanContext: () => ({
          traceId: "00000000000000000000000000000001",
          spanId: "0000000000000001",
          traceFlags: 1,
        }),
      },
      updateTrace: () => undefined,
      startObservation: (name: string) => {
        names.push(name);
        return child;
      },
      end: () => {
        parentEnded += 1;
      },
    };

    vi.resetModules();
    vi.doMock("@langfuse/tracing", () => ({
      setLangfuseTracerProvider: () => undefined,
      startObservation: (name: string) => {
        names.push(name);
        return name === "search_brain" ? parent : child;
      },
    }));

    try {
      const { createTracingRuntime: createFreshTracingRuntime } =
        await import("./langfuse-tracing.ts");
      const runtime = createFreshTracingRuntime({
        logger: { info: () => undefined, warn: () => undefined },
        config: ENABLED_CONFIG,
      });
      const sink = runtime.sink;
      expect(sink).toBeDefined();
      if (!sink) throw new Error("enabled tracing runtime did not create a sink");
      sink.emit({
        name: "search_brain",
        input: {},
        output: {},
        tags: ["open-brain-server"],
        metadata: {},
        spans: [
          {
            name: "retrieval.evidence",
            input: {},
            output: {},
            metadata: {},
          },
        ],
        observations: [
          {
            name: "background.observation",
            type: "span",
            input: {},
            output: {},
            metadata: {},
            startedAt: 10,
            endedAt: 20,
          },
        ],
        startedAt: 1,
        endedAt: 30,
      });
      await runtime.shutdown();
    } finally {
      vi.doUnmock("@langfuse/tracing");
      vi.resetModules();
    }

    expect(names).toEqual([
      "search_brain",
      "retrieval.evidence",
      "background.observation",
    ]);
    expect(parentEnded).toBe(1);
  });
});

const fakeLabeledSecret = ["pass", "word=obviously-fake-561-fixture-value"].join("");

describe("trace body helpers", () => {
  test("masks detector matches in tool arguments and results while retaining every field", () => {
    const body = buildToolTraceBody({
      toolName: "fixture_tool",
      status: "success",
      durationMs: 7,
      args: {
        query: `args-before ${fakeLabeledSecret} args-after`,
        untouched: "plain argument",
      },
      output: {
        content: [
          {
            type: "text",
            text: `result-before ${fakeLabeledSecret} result-after`,
          },
        ],
        isError: false,
      },
    });

    expect(body.input).toEqual({
      query: "args-before password=[MASKED:labeled_secret] args-after",
      untouched: "plain argument",
    });
    expect(body.output).toEqual({
      content: [
        {
          type: "text",
          text: "result-before password=[MASKED:labeled_secret] result-after",
        },
      ],
      isError: false,
    });
  });

  test("masks opaque values carried by sensitive argument and result keys", () => {
    const opaqueValue = ["obviously-fake-561-fixture-value-", "aaaaaaaaaaaa"].join("");
    const body = buildToolTraceBody({
      toolName: "fixture_tool",
      status: "success",
      durationMs: 1,
      args: {
        password: opaqueValue,
        nested: { api_key: opaqueValue },
      },
      output: {
        password: opaqueValue,
        nested: { api_key: opaqueValue, totp_secret: opaqueValue },
      },
    });

    expect(body.input).toEqual({
      password: "[MASKED:sensitive_key]",
      nested: { api_key: "[MASKED:sensitive_key]" },
    });
    expect(body.output).toEqual({
      password: "[MASKED:sensitive_key]",
      nested: {
        api_key: "[MASKED:sensitive_key]",
        totp_secret: "[MASKED:sensitive_key]",
      },
    });
  });

  test("keeps serialized JSON parseable and retains a masked field label", () => {
    const body = buildToolTraceBody({
      toolName: "fixture_tool",
      status: "success",
      durationMs: 1,
      args: {},
      output: {
        // The value is deliberately an obvious placeholder: key-based masking
        // triggers on the KEY alone, and a realistic-looking value here is
        // itself a secret-scanner hit (the scanner flagged the previous one).
        text: JSON.stringify({
          a: 1,
          password: "fake-placeholder-not-a-secret",
          b: 2,
        }),
      },
    });
    const text = (body.output as { text: string }).text;

    expect(JSON.parse(text)).toEqual({
      a: 1,
      password: "[MASKED:json_labeled_secret]",
      b: 2,
    });
  });
});

describe("trace body masking of non-plain carriers", () => {
  test("normalizes non-plain carriers before masking their observable content", () => {
    const opaqueValue = ["obviously-fake-561-fixture-value-", "bbbbbbbbbbbb"].join("");
    const bytes = Buffer.from(`password=${opaqueValue}`);
    const typedBytes = new Uint8Array(bytes);
    const body = buildToolTraceBody({
      toolName: "fixture_tool",
      status: "success",
      durationMs: 1,
      args: {
        map: new Map([
          ["password", opaqueValue],
          ["visible", "plain map value"],
        ]),
        set: new Set([`password=${opaqueValue}`, "plain set value"]),
      },
      output: {
        error: new Error(`password=${opaqueValue}`),
        buffer: bytes,
        typedBytes,
      },
    });

    expect(body.input).toEqual({
      map: {
        password: "[MASKED:sensitive_key]",
        visible: "plain map value",
      },
      set: ["password=[MASKED:labeled_secret]", "plain set value"],
    });
    expect(body.output).toEqual({
      error: {
        name: "Error",
        message: "password=[MASKED:labeled_secret]",
      },
      buffer: { type: "Buffer", byteLength: bytes.byteLength },
      typedBytes: { type: "Uint8Array", byteLength: typedBytes.byteLength },
    });
    expect(JSON.stringify(body)).not.toContain(opaqueValue);
  });

  test("the explicit masking opt-out retains the original trace body", () => {
    const body = buildToolTraceBody({
      toolName: "fixture_tool",
      status: "success",
      durationMs: 7,
      args: { query: fakeLabeledSecret },
      output: { result: fakeLabeledSecret },
      maskingEnabled: false,
    });

    expect(body.input).toEqual({ query: fakeLabeledSecret });
    expect(body.output).toEqual({ result: fakeLabeledSecret });
  });
});

describe("trace body identity and duration", () => {
  // The case the audit lane already records both ids for: a delegated call
  // whose acting identity is not its token identity. With only
  // `caller_client_id`, the content-ful lane an operator reads to answer "who
  // actually did this" loses the distinction.
  test("a delegated call records both the acting and the token identity", () => {
    const body = buildToolTraceBody({
      toolName: "log_thought",
      status: "success",
      durationMs: 1,
      args: {},
      output: {},
      auth: {
        role: "admin",
        clientId: "acting-agent",
        tokenClientId: "issuing-operator",
        namespaceSource: "header",
      } as never,
    });
    expect(body.metadata).toMatchObject({
      caller_client_id: "acting-agent",
      caller_token_client_id: "issuing-operator",
    });
    // `userId` stays the acting identity: it is the Langfuse grouping key, and
    // the token identity travels alongside it rather than replacing it.
    expect(body.userId).toBe("acting-agent");
  });

  test("a call with no auth records both identities as null, never undefined", () => {
    const body = buildToolTraceBody({
      toolName: "t",
      status: "success",
      durationMs: 1,
      args: {},
      output: {},
    });
    expect(body.metadata).toMatchObject({
      caller_client_id: null,
      caller_token_client_id: null,
    });
  });

  test("omits sessionId and userId rather than sending nulls", () => {
    const body = buildToolTraceBody({
      toolName: "t",
      status: "success",
      durationMs: 4.6,
      args: {},
      output: {},
    });
    expect("sessionId" in body).toBe(false);
    expect("userId" in body).toBe(false);
    expect((body.metadata as { duration_ms: number }).duration_ms).toBe(5);
  });

  test("a non-finite duration records as zero, never NaN", () => {
    const body = buildToolTraceBody({
      toolName: "t",
      status: "success",
      durationMs: Number.NaN,
      args: {},
      output: {},
    });
    expect((body.metadata as { duration_ms: number }).duration_ms).toBe(0);
  });

  test("errorOutput names the class for non-Error throws too", () => {
    expect(errorOutput("plain string")).toEqual({
      error_class: "string",
      error_message: "plain string",
    });
  });
});

/**
 * #560: `release` is what lets an operator ask "which COMMIT got expensive".
 *
 * It was empty on 100% of traces because nothing ever resolved it. The resolver
 * is asserted rather than the processor option, because constructing a real
 * `LangfuseSpanProcessor` would build an exporter and this suite dials nothing.
 */
describe("the release stamped on every trace", () => {
  test("reads the runtime stamp from the deployed tree root", () => {
    const stampPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      ".deployed-revision",
    );
    const previousStamp = existsSync(stampPath)
      ? readFileSync(stampPath, "utf8")
      : undefined;

    try {
      writeFileSync(stampPath, "sha=0123456789abcdef\nshort_sha=0123456\n");
      expect(readRuntimeDeployStamp()).toContain("short_sha=0123456");
      expect(
        resolveRepoRelease({
          parseStamp: readDeployedRevision,
          resolveGit: () => {
            throw new Error("git checkout unavailable");
          },
        }),
      ).toBe("0123456");
    } finally {
      if (previousStamp === undefined) unlinkSync(stampPath);
      else writeFileSync(stampPath, previousStamp);
    }
  });

  test("contains stamp parser failures inside the tracing boundary", () => {
    expect(
      resolveRepoRelease({
        parseStamp: () => {
          throw new Error("stamp parser unavailable");
        },
      }),
    ).toBeUndefined();
  });

  test("uses an injected deploy stamp when the runtime has no git checkout", () => {
    expect(
      resolveRepoRelease({
        parseStamp: readDeployedRevision,
        readStamp: () => "sha=0123456789abcdef\nshort_sha=0123456\n",
        resolveGit: () => {
          throw new Error("git checkout unavailable");
        },
      }),
    ).toBe("0123456");
  });

  test("resolves to the short SHA of the checkout under test", () => {
    const release = repoRelease({ parseStamp: readDeployedRevision });

    // This suite runs from a git checkout, so a SHA is expected here — but the
    // shape is what is asserted, since the value changes with every commit.
    expect(release).toMatch(/^[0-9a-f]{7,40}$/);
  });

  test("is never a placeholder standing in for an unknown commit", () => {
    // A placeholder would group every unversioned trace as one release, which
    // is worse than an absent field: it reads as a real, shared commit.
    expect(repoRelease({ parseStamp: readDeployedRevision })).not.toBe("unknown");
  });

  test("is resolved once and cached, never forked per trace", () => {
    // A subprocess per emit would put a fork on the request path, which is the
    // one thing this lane is built not to do.
    expect(repoRelease({ parseStamp: readDeployedRevision })).toBe(
      repoRelease({ parseStamp: readDeployedRevision }),
    );
  });
});
