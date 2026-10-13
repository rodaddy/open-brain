import { describe, expect, test } from "vitest";
import {
  parseEgressArgs,
  runEgressCli,
  serializeCliOutcome,
} from "./eval-langfuse-egress.ts";
import {
  OPTED_IN_ENV,
  fakeTransport,
  generation,
} from "./test-support/eval-langfuse-egress-test-support.ts";

describe("Langfuse egress verification", () => {
  test("settle timeout CLI flag accepts non-negative seconds and rejects invalid values", () => {
    expect(parseEgressArgs(["--verify", "--tag", "run-tag"]).settleTimeoutSeconds).toBe(
      60,
    );
    expect(
      parseEgressArgs(["--verify", "--tag", "run-tag", "--settle-timeout", "2.5"])
        .settleTimeoutSeconds,
    ).toBe(2.5);
    expect(() =>
      parseEgressArgs(["--verify", "--tag", "run-tag", "--settle-timeout", "-1"]),
    ).toThrow("--settle-timeout must be a non-negative number");
    expect(() =>
      parseEgressArgs(["--verify", "--tag", "run-tag", "--settle-timeout", "later"]),
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
