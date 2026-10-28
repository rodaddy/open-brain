/**
 * The #530 tracing lane's configuration and session-resolution contract.
 *
 * Split out of the single `langfuse-tracing.test.ts` so each suite is a
 * readable unit; the doubles are shared from `./langfuse-tracing-fixtures.ts`.
 */
import { describe, expect, test } from "vitest";
import { expectDefined } from "../testing/expect-defined.ts";
import {
  readAmbientEnv,
  withAmbientEnv,
} from "../../scripts/test-support/ambient-env.ts";
import { tracingLoggerFrom } from "./trace-logger-adapter.ts";
import { logger as legacyLogger } from "../logging/legacy-logger.ts";
import { tracingGroup } from "../config/env-groups.ts";
import {
  createTracingRuntime,
  readMcpTracingConfig,
  resolveSessionId,
} from "./langfuse-tracing.ts";
import {
  consoleTracingLoggerFrom,
  recordingLogger,
} from "./langfuse-tracing-fixtures.ts";
import { captureWarnLines } from "../../scripts/test-support/console-capture.ts";

const consoleTracingLogger = consoleTracingLoggerFrom(legacyLogger);

describe("readMcpTracingConfig", () => {
  test("is disabled with no environment at all", () => {
    const config = readMcpTracingConfig({}, recordingLogger());
    expect(config.enabled).toBe(false);
    expect(config.maskingEnabled).toBe(true);
  });

  test("masking is disabled only by the explicit zero value", () => {
    expect(
      readMcpTracingConfig(
        { OPENBRAIN_TRACING_MASKING_ENABLED: "0" },
        recordingLogger(),
      ).maskingEnabled,
    ).toBe(false);
    expect(
      readMcpTracingConfig(
        { OPENBRAIN_TRACING_MASKING_ENABLED: "false" },
        recordingLogger(),
      ).maskingEnabled,
    ).toBe(true);
  });

  test("is disabled when the coordinates are present but the flag is not set", () => {
    const config = readMcpTracingConfig(
      {
        OPENBRAIN_TRACING_ENDPOINT: "http://host:3000",
        OPENBRAIN_TRACING_PUBLIC_KEY: "pk",
        OPENBRAIN_TRACING_SECRET_KEY: "sk",
      },
      recordingLogger(),
    );
    expect(config.enabled).toBe(false);
  });

  test("is disabled when the flag is set but a coordinate is missing", () => {
    const config = readMcpTracingConfig(
      {
        OPENBRAIN_TRACING_ENABLED: "1",
        OPENBRAIN_TRACING_ENDPOINT: "http://host:3000",
        OPENBRAIN_TRACING_PUBLIC_KEY: "pk",
      },
      recordingLogger(),
    );
    expect(config.enabled).toBe(false);
    expect(config.secretKey).toBe("");
  });

  test("a whitespace-only coordinate counts as missing, not present", () => {
    expect(
      readMcpTracingConfig(
        {
          OPENBRAIN_TRACING_ENABLED: "1",
          OPENBRAIN_TRACING_ENDPOINT: "  ",
          OPENBRAIN_TRACING_PUBLIC_KEY: "pk",
          OPENBRAIN_TRACING_SECRET_KEY: "sk",
        },
        recordingLogger(),
      ).enabled,
    ).toBe(false);
  });

  test("the incomplete-flag warn is emitted, readable, and carries no key value", () => {
    // The shared logger emits warn lines through `console.warn`. Captured, not
    // mocked away, so the assertion sees the output of the REAL redaction pass
    // — which is the whole point of the test.
    const lines = captureWarnLines(() => {
      readMcpTracingConfig(
        {
          OPENBRAIN_TRACING_ENABLED: "1",
          OPENBRAIN_TRACING_ENDPOINT: "http://host:3000",
          OPENBRAIN_TRACING_PUBLIC_KEY: "pk-lf-visible",
          OPENBRAIN_TRACING_SECRET_KEY: "",
        },
        tracingLoggerFrom(legacyLogger),
      );
    });

    const warn = lines.find((line) =>
      line.includes("mcp_tool_tracing_config_incomplete"),
    );
    expect(warn).toBeDefined();
    // The whole point of the line: it names which coordinate is missing. A
    // field the logger redacts would report "[REDACTED]" and say nothing.
    expect(warn).toContain('"privateIdSet":false');
    expect(warn).toContain('"publicIdSet":true');
    expect(warn).not.toContain("REDACTED");
    expect(warn).not.toContain("pk-lf-visible");
  });
});

describe("readMcpTracingConfig — the enable flag itself", () => {
  test("only the exact flag value enables it", () => {
    expect(
      readMcpTracingConfig(
        {
          OPENBRAIN_TRACING_ENABLED: "true",
          OPENBRAIN_TRACING_ENDPOINT: "http://host:3000",
          OPENBRAIN_TRACING_PUBLIC_KEY: "pk",
          OPENBRAIN_TRACING_SECRET_KEY: "sk",
        },
        recordingLogger(),
      ).enabled,
    ).toBe(false);
  });

  test("enables with the flag and all three coordinates", () => {
    expect(
      readMcpTracingConfig(
        {
          OPENBRAIN_TRACING_ENABLED: "1",
          OPENBRAIN_TRACING_ENDPOINT: "http://host:3000",
          OPENBRAIN_TRACING_PUBLIC_KEY: "pk-lf-1",
          OPENBRAIN_TRACING_SECRET_KEY: "sk-lf-1",
        },
        recordingLogger(),
      ),
    ).toEqual({
      enabled: true,
      maskingEnabled: true,
      endpoint: "http://host:3000",
      publicKey: "pk-lf-1",
      secretKey: "sk-lf-1",
    });
  });
});

describe("resolveSessionId", () => {
  test("prefers a top-level session_key", () => {
    expect(
      resolveSessionId({ session_key: "sess-a" }, { sessionId: "transport-b" }),
    ).toBe("sess-a");
  });

  test("falls back to scope.session_key", () => {
    expect(
      resolveSessionId(
        { scope: { session_key: "sess-scoped" } },
        { sessionId: "transport-b" },
      ),
    ).toBe("sess-scoped");
  });

  test("falls back to the transport sessionId", () => {
    expect(resolveSessionId({ content: "x" }, { sessionId: "transport-b" })).toBe(
      "transport-b",
    );
  });

  test("is undefined when neither exists", () => {
    expect(resolveSessionId({ content: "x" }, {})).toBeUndefined();
  });
});

describe("tracing configuration arrives from the composition root (#825)", () => {
  test("createTracingRuntime observes the validated group, not the ambient environment", () => {
    // The exact shape `server/main.ts:505` passes: `config.tracing`, produced
    // by `tracingGroup` from the one validated parse. Disabled, so nothing is
    // constructed and no socket opens.
    const fromValidatedConfig = tracingGroup({
      OPENBRAIN_TRACING_ENDPOINT: "http://from-config:3000",
      OPENBRAIN_TRACING_PUBLIC_KEY: "pk-from-config",
      OPENBRAIN_TRACING_SECRET_KEY: "sk-from-config",
      OPENBRAIN_TRACING_ENABLED: false,
      OPENBRAIN_TRACING_MASKING_ENABLED: false,
    } as never);

    // The ambient environment says something DIFFERENT. Before #825 the reader
    // defaulted its parameter to the ambient environment, so a caller that
    // forgot to pass the value silently answered from there instead. The
    // ambient write goes through the shared test-support accessor because
    // `server/**` may not touch it directly (`.oxlintrc.json`, the L2b rung).
    withAmbientEnv("OPENBRAIN_TRACING_ENDPOINT", "http://from-ambient-env:9999", () => {
      const runtime = createTracingRuntime({
        config: fromValidatedConfig,
        logger: consoleTracingLogger,
      });
      expect(runtime.config.endpoint).toBe("http://from-config:3000");
      expect(runtime.config.publicKey).toBe("pk-from-config");
      expect(runtime.config.maskingEnabled).toBe(false);
      expect(runtime.sink).toBeUndefined();
    });

    // And the ambient value is put back exactly as it was found, so a later
    // file in the same Bun process is not contaminated by this one.
    expect(readAmbientEnv("OPENBRAIN_TRACING_ENDPOINT")).not.toBe(
      "http://from-ambient-env:9999",
    );
    expect(
      expectDefined(fromValidatedConfig, "the validated tracing group").endpoint,
    ).toBe("http://from-config:3000");
  });
});
