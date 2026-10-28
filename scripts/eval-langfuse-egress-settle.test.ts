import { describe, expect, test } from "vitest";
import type { HttpTransport } from "./eval-langfuse-egress.ts";
import {
  generation,
  transportUrl,
  verify,
} from "./test-support/eval-langfuse-egress-test-support.ts";

describe("Langfuse egress verification", () => {
  test("settle polling records a late successful arrival", async () => {
    let listCalls = 0;
    let now = 0;
    const transport: HttpTransport = async (input) => {
      const url = transportUrl(input);
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

    expect(receipt.passed).toBe(true);
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
      const url = transportUrl(input);
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

    expect(receipt.passed).toBe(false);
    expect(receipt.observed.observations).toBe(1);
    expect(receipt.settle).toEqual({
      waited_ms: 2_000,
      timed_out: true,
      polls: 2,
    });
  });
});
