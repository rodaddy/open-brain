import { describe, expect, test } from "bun:test";
import { summarizeChildStderr } from "../child-stderr.ts";

describe("summarizeChildStderr", () => {
  test("returns nothing for empty or whitespace-only stderr", () => {
    expect(summarizeChildStderr("")).toEqual({});
    expect(summarizeChildStderr("  \n\n \t ")).toEqual({});
  });

  test("names the error class from a Python traceback tail", () => {
    const stderr = [
      "Traceback (most recent call last):",
      '  File "provider.py", line 12, in main',
      "    raise PermissionError(msg)",
      "PermissionError: scope key 'project' was rejected",
    ].join("\n");
    expect(summarizeChildStderr(stderr)).toEqual({
      error_class: "PermissionError",
      stderr_first_line: "PermissionError: scope key 'project' was rejected",
    });
  });

  test("falls back to the first line when no class is recognizable", () => {
    const summary = summarizeChildStderr("uv: command not found\nsecond line");
    expect(summary.error_class).toBeUndefined();
    expect(summary.stderr_first_line).toBe("uv: command not found");
  });

  test("redacts labeled secret material out of the surfaced line", () => {
    // Detection is label-gated by design (src/secret-patterns.ts): a bare
    // high-entropy string is intentionally left alone, so the credential here
    // carries the label the detectors key on.
    const summary = summarizeChildStderr(
      "ValueError: rejected token=abcd1234efgh5678ijkl",
    );
    expect(summary.error_class).toBe("ValueError");
    expect(summary.stderr_first_line).not.toContain("abcd1234efgh5678ijkl");
    expect(summary.stderr_first_line).toContain("[REDACTED]");
  });
});
