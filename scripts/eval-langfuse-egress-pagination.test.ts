import { describe, expect, test } from "vitest";
import type { HttpTransport } from "./eval-langfuse-egress.ts";
import {
  generation,
  transportUrl,
  verify,
} from "./test-support/eval-langfuse-egress-test-support.ts";

describe("Langfuse egress verification", () => {
  test("pagination falls back to full pages when totalPages is absent", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `trace-${index + 1}`,
    }));
    const transport: HttpTransport = async (input) => {
      const url = transportUrl(input);
      if (url.pathname === "/api/public/traces") {
        return Response.json({
          data:
            url.searchParams.get("page") === "1" ? firstPage : [{ id: "trace-101" }],
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

    expect(receipt.passed).toBe(true);
    expect(receipt.observed).toEqual({
      traces: 101,
      observations: 101,
      generations: 101,
    });
  });
});
