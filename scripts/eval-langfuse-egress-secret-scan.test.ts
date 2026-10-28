import { describe, expect, test } from "vitest";
import type { HttpTransport } from "./eval-langfuse-egress.ts";
import {
  check,
  generation,
  transportUrl,
  verify,
} from "./test-support/eval-langfuse-egress-test-support.ts";

describe("Langfuse egress verification", () => {
  test("secret-shaped trace content is fatal and reports labels only", async () => {
    const receipt = await verify([generation()], {
      body: { metadata: "password=do-not-emit-this-value" },
    });
    const output = JSON.stringify(receipt);

    expect(receipt.passed).toBe(false);
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

    expect(receipt.passed).toBe(false);
    expect(check(receipt, "secret_scan")).toMatchObject({
      passed: false,
      fatal: true,
      content_fields_present: true,
      detector_counts: { labeled_secret: 1 },
    });
    expect(output).not.toContain("observation-only-secret");
  });

  test("secret scan discloses when observation content fields are absent", async () => {
    const receipt = await verify(
      [
        {
          id: "span-1",
          type: "SPAN",
        },
      ],
      { expected: 1 },
    );

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
      const url = transportUrl(input);
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
    expect(receipt.passed).toBe(false);
  });

  test("skipped-no-data fails the run even when the caller expects zero traces", async () => {
    // Review finding on #584: with expectedTraces: 0 the arrival_count check
    // passes (0 === 0), so if secret_scan's passed were decoupled from the
    // data, a run would be certified secret-free while the scanner examined
    // nothing. The skip itself must be a fatal failure.
    const emptyTransport: HttpTransport = async (input) => {
      const url = transportUrl(input);
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
    expect(receipt.passed).toBe(false);
  });

  test("secret scan over a real trace set reports an explicit pass status", async () => {
    const receipt = await verify([generation()]);

    expect(check(receipt, "secret_scan")).toMatchObject({ status: "pass" });
    expect(receipt.passed).toBe(true);
  });
});
