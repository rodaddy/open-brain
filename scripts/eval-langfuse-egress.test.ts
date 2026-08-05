import { describe, expect, test } from "bun:test";
import {
  langfuseHost,
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

interface FakeObservationOptions {
  usage?: boolean;
  cost?: number | null;
}

function generation(
  options: FakeObservationOptions = {},
): Record<string, unknown> {
  return {
    id: "observation-1",
    type: "GENERATION",
    providedModelName: "claude-fable-5",
    usageDetails: options.usage === false ? undefined : { input: 2, output: 3 },
    totalCost: options.cost === undefined ? 0.001 : options.cost,
    output: "SAFE_BODY_MARKER",
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
    requireCost?: boolean;
    body?: Record<string, unknown>;
  } = {},
) {
  return verifyLangfuseEgress({
    tag: "run-tag",
    expectedObservations: options.expected ?? 1,
    requireCost: options.requireCost,
    config: CONFIG,
    transport: fakeTransport(observations, options.body),
  });
}

function check(receipt: Awaited<ReturnType<typeof verify>>, label: string) {
  const found = receipt.checks.find((item) => item.label === label);
  if (!found) throw new Error(`missing check ${label}`);
  return found;
}

describe("Langfuse egress verification", () => {
  test("normalizes bare hosts and ingestion URLs identically", () => {
    expect(langfuseHost("https://langfuse.example")).toBe(
      "https://langfuse.example",
    );
    expect(langfuseHost("https://langfuse.example/api/public/ingestion/")).toBe(
      "https://langfuse.example",
    );
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
