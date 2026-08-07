import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  captureEnvironment,
  evaluateDriveOutcome,
  langfuseHost,
  observationOffset,
  parseEgressArgs,
  readCaptureDriveConfig,
  runEgressCli,
  serializeCliOutcome,
  verifyLangfuseEgress,
  type HttpTransport,
  type LangfuseReadConfig,
} from "./eval-langfuse-egress.ts";

const CONFIG: LangfuseReadConfig = {
  endpoint: "https://langfuse.example",
  publicKey: "public-id",
  secretKey: "private-id",
};

const OPTED_IN_ENV = {
  OPEN_BRAIN_LANGFUSE_EGRESS: "1",
  OPENBRAIN_TRACING_ENABLED: "1",
  OPENBRAIN_TRACING_ENDPOINT: "https://langfuse.example/api/public/ingestion",
  OPENBRAIN_TRACING_PUBLIC_KEY: "public-id",
  OPENBRAIN_TRACING_SECRET_KEY: "private-id",
};

const CAPTURE_DRIVE_ENV = {
  ...OPTED_IN_ENV,
  OPENBRAIN_CAPTURE_BASE_URL: "http://127.0.0.1:3100",
  OPENBRAIN_CAPTURE_TOKEN: "capture-token",
};

interface FakeObservationOptions {
  usage?: boolean;
  cost?: number | null;
  output?: unknown;
}

function generation(
  options: FakeObservationOptions = {},
): Record<string, unknown> {
  return {
    id: "observation-1",
    type: "GENERATION",
    model: "claude-fable-5",
    usageDetails: options.usage === false ? undefined : { input: 2, output: 3 },
    totalPrice: options.cost === undefined ? 0.001 : options.cost,
    output: options.output ?? "SAFE_BODY_MARKER",
  };
}

function fakeTransport(
  observations: unknown[],
  bodyExtras: Record<string, unknown> = {},
): HttpTransport {
  return async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/public/traces") {
      return Response.json({
        data: [{ id: "trace-1" }],
        meta: { totalPages: 1 },
      });
    }
    if (url.pathname === "/api/public/traces/trace-1") {
      return Response.json({
        id: "trace-1",
        sessionId: "run-tag",
        tags: ["open-brain-capture"],
        observations,
        ...bodyExtras,
      });
    }
    return new Response(null, { status: 404 });
  };
}

async function verify(
  observations: unknown[],
  options: {
    expected?: number;
    expectedTraces?: number;
    requireCost?: boolean;
    body?: Record<string, unknown>;
    settleTimeoutSeconds?: number;
    pollIntervalMs?: number;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
    transport?: HttpTransport;
  } = {},
) {
  return verifyLangfuseEgress({
    tag: "run-tag",
    expectedObservations: options.expected ?? 1,
    expectedTraces: options.expectedTraces,
    requireCost: options.requireCost,
    settleTimeoutSeconds: options.settleTimeoutSeconds ?? 0,
    pollIntervalMs: options.pollIntervalMs,
    now: options.now,
    sleep: options.sleep,
    config: CONFIG,
    transport: options.transport ?? fakeTransport(observations, options.body),
  });
}

function check(receipt: Awaited<ReturnType<typeof verify>>, label: string) {
  const found = receipt.checks.find((item) => item.label === label);
  if (!found) throw new Error(`missing check ${label}`);
  return found;
}

describe("Langfuse egress verification", () => {
  test("drive configuration requires raw capture coordinates", () => {
    expect(() => readCaptureDriveConfig(OPTED_IN_ENV)).toThrow(
      "OPENBRAIN_CAPTURE_BASE_URL and OPENBRAIN_CAPTURE_TOKEN",
    );
  });

  test("empty-string capture vars still reach the shared aliases", () => {
    // Deployed hook-env wrappers pass VAR="${VAR:-}": unset arrives as "", not
    // absence (#525's shape). The alias fallback must engage on both.
    const config = readCaptureDriveConfig({
      ...OPTED_IN_ENV,
      OPENBRAIN_CAPTURE_BASE_URL: "",
      OPENBRAIN_CAPTURE_TOKEN: "",
      OPENBRAIN_BASE_URL: "http://127.0.0.1:3100",
      OPENBRAIN_TOKEN: "alias-token",
    });

    expect(config).toEqual({
      baseUrl: "http://127.0.0.1:3100",
      token: "alias-token",
    });
  });

  test("drive returns a non-zero configuration error before spawning an invalid child", async () => {
    const outcome = await runEgressCli(
      ["--drive", "--tag", "run-tag"],
      OPTED_IN_ENV,
    );

    expect(outcome).toEqual({
      exitCode: 2,
      error:
        "OPENBRAIN_CAPTURE_BASE_URL and OPENBRAIN_CAPTURE_TOKEN are required for --drive",
    });
  });

  test("drive child keeps declared hook settings and drops foreign Open Brain names", () => {
    const child = captureEnvironment(
      {
        ...CAPTURE_DRIVE_ENV,
        OPENBRAIN_LOCAL_CLONE: "1",
        OPENBRAIN_TRANSPORT: "typescript-only",
        OPENBRAIN_ALLOW_INSECURE_HTTP: "1",
        PATH: "/test/bin",
      },
      CONFIG,
      readCaptureDriveConfig(CAPTURE_DRIVE_ENV),
      "/scratch/watermarks.sqlite",
    );

    expect(child).toMatchObject({
      PATH: "/test/bin",
      OPENBRAIN_CAPTURE_BASE_URL: "http://127.0.0.1:3100",
      OPENBRAIN_CAPTURE_TOKEN: "capture-token",
      OPENBRAIN_ALLOW_INSECURE_HTTP: "1",
      OPENBRAIN_OBSERVATION_ENABLED: "1",
      OPENBRAIN_CAPTURE_WATERMARK_PATH: "/scratch/watermarks.sqlite",
    });
    expect(child.OPENBRAIN_LOCAL_CLONE).toBeUndefined();
    expect(child.OPENBRAIN_TRANSPORT).toBeUndefined();
  });

  test("observation watermark read falls back after a post-child database failure", async () => {
    let fallbackCalls = 0;

    const offset = await observationOffset("/watermarks.sqlite", "run-tag", {
      fileExists: async () => true,
      databaseFactory: () => {
        throw new Error("unable to open database file");
      },
      fallbackOffset: async (path, sessionKey) => {
        fallbackCalls += 1;
        expect(path).toBe("/watermarks.sqlite");
        expect(sessionKey).toBe("observe:run-tag");
        return 42;
      },
    });

    expect(offset).toBe(42);
    expect(fallbackCalls).toBe(1);
  });

  test("normalizes bare hosts and ingestion URLs identically", () => {
    expect(langfuseHost("https://langfuse.example")).toBe(
      "https://langfuse.example",
    );
    expect(langfuseHost("https://langfuse.example/api/public/ingestion/")).toBe(
      "https://langfuse.example",
    );
  });

  test("verification excludes server traces that share the capture session", async () => {
    const transport: HttpTransport = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/public/traces") {
        return Response.json({
          data: [{ id: "capture-trace" }, { id: "server-trace" }],
          meta: { totalPages: 1 },
        });
      }
      if (url.pathname === "/api/public/traces/capture-trace") {
        return Response.json({
          id: "capture-trace",
          tags: ["claude-code", "open-brain-capture"],
          observations: [
            { id: "span-1", type: "SPAN" },
            generation(),
            generation(),
            generation(),
          ],
        });
      }
      if (url.pathname === "/api/public/traces/server-trace") {
        return Response.json({
          id: "server-trace",
          tags: ["mcp-tool", "open-brain-server"],
          observations: [{ id: "span-2", type: "SPAN" }],
        });
      }
      return new Response(null, { status: 404 });
    };

    const receipt = await verifyLangfuseEgress({
      tag: "run-tag",
      expectedObservations: 4,
      expectedGenerations: 3,
      expectedTraces: 1,
      settleTimeoutSeconds: 0,
      config: CONFIG,
      transport,
    });

    expect(receipt.passed).toBeTrue();
    expect(receipt.observed).toEqual({
      traces: 1,
      observations: 4,
      generations: 3,
    });
  });

  test("arrival-count miss is fatal", async () => {
    const receipt = await verify([generation()], { expected: 2 });

    expect(receipt.passed).toBeFalse();
    expect(check(receipt, "arrival_count")).toMatchObject({
      passed: false,
      fatal: true,
      observed: 1,
      expected: 2,
    });
  });

  test("missing usage_details is fatal", async () => {
    const receipt = await verify([generation({ usage: false })]);

    expect(receipt.passed).toBeFalse();
    expect(check(receipt, "generation_metadata")).toMatchObject({
      passed: false,
      fatal: true,
      observed: 0,
      expected: 1,
    });
  });

  test("NULL cost is labelled but non-fatal by default", async () => {
    const receipt = await verify([generation({ cost: null })]);

    expect(receipt.passed).toBeTrue();
    expect(check(receipt, "total_cost")).toMatchObject({
      passed: false,
      fatal: false,
      observed: 0,
      expected: 1,
    });
  });

  test("NULL cost is fatal when required", async () => {
    const receipt = await verify([generation({ cost: null })], {
      requireCost: true,
    });

    expect(receipt.passed).toBeFalse();
    expect(check(receipt, "total_cost")).toMatchObject({
      passed: false,
      fatal: true,
    });
  });

  test("secret-shaped trace content is fatal and reports labels only", async () => {
    const receipt = await verify([generation()], {
      body: { metadata: "password=do-not-emit-this-value" },
    });
    const output = JSON.stringify(receipt);

    expect(receipt.passed).toBeFalse();
    expect(check(receipt, "secret_scan")).toMatchObject({
      passed: false,
      fatal: true,
    });
    expect(output).toContain("labeled_secret");
    expect(output).not.toContain("do-not-emit-this-value");
  });

  test("secret in observation output is fatal and content visibility is explicit", async () => {
    const receipt = await verify([
      generation({ output: "password=observation-only-secret" }),
    ]);
    const output = JSON.stringify(receipt);

    expect(receipt.passed).toBeFalse();
    expect(check(receipt, "secret_scan")).toMatchObject({
      passed: false,
      fatal: true,
      content_fields_present: true,
      detector_counts: { labeled_secret: 1 },
    });
    expect(output).not.toContain("observation-only-secret");
  });

  test("secret scan discloses when observation content fields are absent", async () => {
    const receipt = await verify([
      {
        id: "span-1",
        type: "SPAN",
      },
    ], { expected: 1 });

    expect(check(receipt, "secret_scan")).toMatchObject({
      passed: true,
      content_fields_present: false,
    });
  });

  test("secret scan over an empty trace set is skipped-no-data, not a pass", async () => {
    // Issue #583: at observed=0 traces the scan examined nothing, so calling it
    // a pass was a vacuous green. It must report skipped-no-data, and the
    // fatal arrival_count check must still fail the run.
    const emptyTransport: HttpTransport = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/public/traces") {
        return Response.json({ data: [], meta: { totalPages: 1 } });
      }
      throw new Error(`unexpected request ${url.pathname}`);
    };
    const receipt = await verify([], { transport: emptyTransport });

    expect(check(receipt, "secret_scan")).toMatchObject({
      status: "skipped-no-data",
      observed: 0,
      passed: false,
    });
    expect(check(receipt, "arrival_count")).toMatchObject({
      passed: false,
      fatal: true,
    });
    expect(receipt.passed).toBeFalse();
  });

  test("skipped-no-data fails the run even when the caller expects zero traces", async () => {
    // Review finding on #584: with expectedTraces: 0 the arrival_count check
    // passes (0 === 0), so if secret_scan's passed were decoupled from the
    // data, a run would be certified secret-free while the scanner examined
    // nothing. The skip itself must be a fatal failure.
    const emptyTransport: HttpTransport = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/public/traces") {
        return Response.json({ data: [], meta: { totalPages: 1 } });
      }
      throw new Error(`unexpected request ${url.pathname}`);
    };
    const receipt = await verify([], {
      transport: emptyTransport,
      expectedTraces: 0,
      expected: 0,
    });

    expect(check(receipt, "secret_scan")).toMatchObject({
      status: "skipped-no-data",
      passed: false,
      fatal: true,
    });
    expect(receipt.passed).toBeFalse();
  });

  test("secret scan over a real trace set reports an explicit pass status", async () => {
    const receipt = await verify([generation()]);

    expect(check(receipt, "secret_scan")).toMatchObject({ status: "pass" });
    expect(receipt.passed).toBeTrue();
  });

  test("settle polling records a late successful arrival", async () => {
    let listCalls = 0;
    let now = 0;
    const transport: HttpTransport = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/public/traces") {
        listCalls += 1;
        return Response.json({
          data: listCalls === 1 ? [] : [{ id: "trace-1" }],
        });
      }
      if (url.pathname === "/api/public/traces/trace-1") {
        return Response.json({
          id: "trace-1",
          tags: ["open-brain-capture"],
          observations: [generation()],
        });
      }
      return new Response(null, { status: 404 });
    };

    const receipt = await verify([], {
      settleTimeoutSeconds: 5,
      pollIntervalMs: 2_000,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      transport,
    });

    expect(receipt.passed).toBeTrue();
    expect(receipt.settle).toEqual({
      waited_ms: 2_000,
      timed_out: false,
      polls: 2,
    });
  });

  test("settle timeout reports the final observed counts", async () => {
    let listCalls = 0;
    let now = 0;
    const transport: HttpTransport = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/public/traces") {
        listCalls += 1;
        return Response.json({
          data: listCalls === 1 ? [] : [{ id: "trace-1" }],
        });
      }
      if (url.pathname === "/api/public/traces/trace-1") {
        return Response.json({
          id: "trace-1",
          tags: ["open-brain-capture"],
          observations: [generation()],
        });
      }
      return new Response(null, { status: 404 });
    };

    const receipt = await verify([], {
      expected: 2,
      settleTimeoutSeconds: 2,
      pollIntervalMs: 2_000,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      transport,
    });

    expect(receipt.passed).toBeFalse();
    expect(receipt.observed.observations).toBe(1);
    expect(receipt.settle).toEqual({
      waited_ms: 2_000,
      timed_out: true,
      polls: 2,
    });
  });

  test("pagination falls back to full pages when totalPages is absent", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `trace-${index + 1}`,
    }));
    const transport: HttpTransport = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/public/traces") {
        return Response.json({
          data: url.searchParams.get("page") === "1"
            ? firstPage
            : [{ id: "trace-101" }],
        });
      }
      const id = url.pathname.split("/").at(-1) ?? "missing";
      return Response.json({
        id,
        tags: ["open-brain-capture"],
        observations: [generation()],
      });
    };

    const receipt = await verify([], {
      expected: 101,
      expectedTraces: 101,
      settleTimeoutSeconds: 0,
      transport,
    });

    expect(receipt.passed).toBeTrue();
    expect(receipt.observed).toEqual({
      traces: 101,
      observations: 101,
      generations: 101,
    });
  });

  test("drive outcome requires a successful exit and advanced observe watermark", () => {
    const receipt = evaluateDriveOutcome({
      tag: "run-tag",
      count: 3,
      exitCode: 0,
      stdout: "",
      stderr: "",
      observeOffset: 42,
    });

    expect(receipt.passed).toBeTrue();
    expect(receipt.observed).toEqual({
      traces: 0,
      observations: 0,
      generations: 0,
    });
    expect(check(receipt, "capture_exit")).toMatchObject({
      passed: true,
      fatal: true,
      observed: 0,
      expected: 0,
    });
    expect(check(receipt, "emit_proven")).toMatchObject({
      passed: true,
      fatal: true,
      observed: 42,
      emit_failure_detected: false,
    });
  });

  test("failing drive child surfaces its stderr first line in the receipt", () => {
    // Issue #583: the drive path captured stdout/stderr and never surfaced
    // them, so a dead child presented as a bare exit code.
    const receipt = evaluateDriveOutcome({
      tag: "run-tag",
      count: 1,
      exitCode: 1,
      stdout: "",
      stderr: [
        "Traceback (most recent call last):",
        '  File "capture_stop.py", line 40, in main',
        "RuntimeError: langfuse client refused the scope key",
      ].join("\n"),
      observeOffset: 0,
    });

    expect(receipt.passed).toBeFalse();
    expect(receipt.error_class).toBe("RuntimeError");
    expect(receipt.stderr_first_line).toBe(
      "RuntimeError: langfuse client refused the scope key",
    );
    expect(serializeCliOutcome({ exitCode: 1, receipt }, false)).toContain(
      "error_class=RuntimeError",
    );
  });

  test("passing drive child carries no stderr diagnostics", () => {
    const receipt = evaluateDriveOutcome({
      tag: "run-tag",
      count: 1,
      exitCode: 0,
      stdout: "",
      stderr: "warming embedding cache",
      observeOffset: 5,
    });

    expect(receipt.passed).toBeTrue();
    expect(receipt.error_class).toBeUndefined();
    expect(receipt.stderr_first_line).toBeUndefined();
  });

  test("drive receipt redacts labeled secret material from stderr", () => {
    const receipt = evaluateDriveOutcome({
      tag: "run-tag",
      count: 1,
      exitCode: 1,
      stdout: "",
      stderr: "ValueError: rejected token=abcd1234efgh5678ijkl",
      observeOffset: 0,
    });

    expect(receipt.stderr_first_line).not.toContain("abcd1234efgh5678ijkl");
    expect(receipt.stderr_first_line).toContain("[REDACTED]");
  });

  test("drive outcome fails without watermark proof or on explicit emit failure", () => {
    const missingWatermark = evaluateDriveOutcome({
      tag: "run-tag",
      count: 1,
      exitCode: 0,
      stdout: "",
      stderr: "",
      observeOffset: 0,
    });
    const explicitFailure = evaluateDriveOutcome({
      tag: "run-tag",
      count: 1,
      exitCode: 0,
      stdout: "",
      stderr: "observation emit failed (network); turns left for retry",
      observeOffset: 9,
    });
    const captureFailure = evaluateDriveOutcome({
      tag: "run-tag",
      count: 1,
      exitCode: 7,
      stdout: "",
      stderr: "",
      observeOffset: 9,
    });

    expect(missingWatermark.passed).toBeFalse();
    expect(check(missingWatermark, "emit_proven")).toMatchObject({
      passed: false,
      observed: 0,
      emit_failure_detected: false,
    });
    expect(explicitFailure.passed).toBeFalse();
    expect(check(explicitFailure, "emit_proven")).toMatchObject({
      passed: false,
      observed: 9,
      emit_failure_detected: true,
    });
    expect(captureFailure.passed).toBeFalse();
    expect(check(captureFailure, "capture_exit")).toMatchObject({
      passed: false,
      observed: 7,
      expected: 0,
    });
  });

  test("settle timeout CLI flag accepts non-negative seconds and rejects invalid values", () => {
    expect(
      parseEgressArgs(["--verify", "--tag", "run-tag"])
        .settleTimeoutSeconds,
    ).toBe(60);
    expect(
      parseEgressArgs([
        "--verify",
        "--tag",
        "run-tag",
        "--settle-timeout",
        "2.5",
      ]).settleTimeoutSeconds,
    ).toBe(2.5);
    expect(() =>
      parseEgressArgs([
        "--verify",
        "--tag",
        "run-tag",
        "--settle-timeout",
        "-1",
      ]),
    ).toThrow("--settle-timeout must be a non-negative number");
    expect(() =>
      parseEgressArgs([
        "--verify",
        "--tag",
        "run-tag",
        "--settle-timeout",
        "later",
      ]),
    ).toThrow("--settle-timeout must be a non-negative number");
  });

  test("missing explicit opt-in refuses to run", async () => {
    const outcome = await runEgressCli(
      ["--verify", "--tag", "run-tag", "--count", "1"],
      { ...OPTED_IN_ENV, OPEN_BRAIN_LANGFUSE_EGRESS: undefined },
      fakeTransport([generation()]),
    );

    expect(outcome).toEqual({
      exitCode: 2,
      error: "OPEN_BRAIN_LANGFUSE_EGRESS must equal 1",
    });
  });

  test("passing serialized output never contains a returned trace body", async () => {
    const outcome = await runEgressCli(
      ["--verify", "--tag", "run-tag", "--count", "1", "--json"],
      OPTED_IN_ENV,
      fakeTransport([{ id: "root-span", type: "SPAN" }, generation()]),
    );
    const output = serializeCliOutcome(outcome, true);

    expect(outcome.exitCode).toBe(0);
    expect(output).not.toContain("SAFE_BODY_MARKER");
    expect(output).not.toContain("public-id");
    expect(output).not.toContain("private-id");
  });
});
