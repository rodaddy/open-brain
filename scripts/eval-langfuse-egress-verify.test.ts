import { describe, expect, test } from "vitest";
import { verifyLangfuseEgress, type HttpTransport } from "./eval-langfuse-egress.ts";
import {
  CONFIG,
  check,
  generation,
  transportUrl,
  verify,
} from "./test-support/eval-langfuse-egress-test-support.ts";

describe("Langfuse egress verification", () => {
  test("verification excludes server traces that share the capture session", async () => {
    const transport: HttpTransport = async (input) => {
      const url = transportUrl(input);
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

    expect(receipt.passed).toBe(true);
    expect(receipt.observed).toEqual({
      traces: 1,
      observations: 4,
      generations: 3,
    });
  });

  test("arrival-count miss is fatal", async () => {
    const receipt = await verify([generation()], { expected: 2 });

    expect(receipt.passed).toBe(false);
    expect(check(receipt, "arrival_count")).toMatchObject({
      passed: false,
      fatal: true,
      observed: 1,
      expected: 2,
    });
  });

  test("missing usage_details is fatal", async () => {
    const receipt = await verify([generation({ usage: false })]);

    expect(receipt.passed).toBe(false);
    expect(check(receipt, "generation_metadata")).toMatchObject({
      passed: false,
      fatal: true,
      observed: 0,
      expected: 1,
    });
  });

  test("NULL cost is labelled but non-fatal by default", async () => {
    const receipt = await verify([generation({ cost: null })]);

    expect(receipt.passed).toBe(true);
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

    expect(receipt.passed).toBe(false);
    expect(check(receipt, "total_cost")).toMatchObject({
      passed: false,
      fatal: true,
    });
  });
});
