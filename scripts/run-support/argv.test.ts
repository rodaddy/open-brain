import { afterEach, describe, expect, test } from "vitest";
import { arg, createConsoleLogger, has } from "./argv.ts";

const realArgv = process.argv;

afterEach(() => {
  process.argv = realArgv;
});

function withArgv(tokens: string[]): void {
  process.argv = ["bun", "script.ts", ...tokens];
}

describe("arg", () => {
  test("returns the token after the flag", () => {
    withArgv(["--batch", "100"]);
    expect(arg("--batch")).toBe("100");
  });

  test("returns undefined when the flag is absent", () => {
    withArgv(["--all"]);
    expect(arg("--batch")).toBeUndefined();
  });

  test("returns undefined when the flag is the last token", () => {
    withArgv(["--batch"]);
    expect(arg("--batch")).toBeUndefined();
  });

  test("reads argv at call time, not at import", () => {
    withArgv(["--batch", "5"]);
    expect(arg("--batch")).toBe("5");
    withArgv(["--batch", "9"]);
    expect(arg("--batch")).toBe("9");
  });
});

describe("has", () => {
  test("true when present, false when not", () => {
    withArgv(["--stats"]);
    expect(has("--stats")).toBe(true);
    expect(has("--drain")).toBe(false);
  });
});

/** Capture one console method for the duration of `run`. */
function capture(method: "log" | "warn" | "error", run: () => void): Array<unknown[]> {
  const lines: Array<unknown[]> = [];
  const original = console[method];
  console[method] = (...args: unknown[]) => {
    lines.push(args);
  };
  try {
    run();
  } finally {
    console[method] = original;
  }
  return lines;
}

describe("createConsoleLogger", () => {
  test("prints the message and the fields as JSON", () => {
    const logger = createConsoleLogger();
    const lines = capture("log", () => logger.info("swept", { scanned: 3 }));
    expect(lines).toEqual([["swept", '{"scanned":3}']]);
  });

  test("prints nothing after the message when fields are absent or empty", () => {
    const logger = createConsoleLogger();
    expect(capture("log", () => logger.info("done"))).toEqual([["done", ""]]);
    expect(capture("log", () => logger.info("done", {}))).toEqual([["done", ""]]);
  });

  test("warn goes to console.warn and error to console.error", () => {
    const logger = createConsoleLogger();
    expect(capture("warn", () => logger.warn("slow", { ms: 1 }))).toEqual([
      ["slow", '{"ms":1}'],
    ]);
    expect(capture("error", () => logger.error("boom", { code: "x" }))).toEqual([
      ["boom", '{"code":"x"}'],
    ]);
  });

  test("per-level prefixes are prepended to the message only", () => {
    const logger = createConsoleLogger({
      prefix: { info: "  · ", warn: "  ! ", error: "  x " },
    });
    expect(capture("log", () => logger.info("a", { n: 1 }))).toEqual([
      ["  · a", '{"n":1}'],
    ]);
    expect(capture("warn", () => logger.warn("b"))).toEqual([["  ! b", ""]]);
    expect(capture("error", () => logger.error("c"))).toEqual([["  x c", ""]]);
  });

  test("infoToStderr routes info to console.error", () => {
    const logger = createConsoleLogger({ infoToStderr: true });
    expect(capture("error", () => logger.info("quiet"))).toEqual([["quiet", ""]]);
    expect(capture("log", () => logger.info("quiet"))).toEqual([]);
  });
});
