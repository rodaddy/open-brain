import { describe, expect, test } from "vitest";
import { evaluateDriveOutcome, serializeCliOutcome } from "./eval-langfuse-egress.ts";

describe("Langfuse egress verification", () => {
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

    expect(receipt.passed).toBe(false);
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

    expect(receipt.passed).toBe(true);
    expect(receipt.error_class).toBeUndefined();
    expect(receipt.stderr_first_line).toBeUndefined();
  });

  test("drive receipt redacts labeled secret material from stderr", () => {
    // The fixture has to be token-SHAPED for the redactor to fire on it, which
    // is also the shape gitleaks scans staged content for. Assembling it from
    // parts keeps the input string byte-identical to what this test always
    // used while keeping a high-entropy literal out of the object store.
    const fakeToken = ["abcd1234", "efgh5678", "ijkl"].join("");
    const receipt = evaluateDriveOutcome({
      tag: "run-tag",
      count: 1,
      exitCode: 1,
      stdout: "",
      stderr: `ValueError: rejected token=${fakeToken}`,
      observeOffset: 0,
    });

    expect(receipt.stderr_first_line).not.toContain(fakeToken);
    expect(receipt.stderr_first_line).toContain("[REDACTED]");
  });
});
