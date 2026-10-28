import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseGradingServerRunConfig,
  startWithPoolCleanup,
} from "./grading-server-run-config.ts";

const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
});

function parse(args: string[], env: NodeJS.ProcessEnv = {}) {
  process.argv = ["node", "scripts/grading-server-run.ts", ...args];
  return parseGradingServerRunConfig(env);
}

describe("parseGradingServerRunConfig", () => {
  it("preserves normal-mode defaults", () => {
    expect(parse([])).toEqual({ namespace: "dana", gradedBy: "dana", port: 3417 });
  });

  it("requires an explicit namespace before frozen startup", () => {
    expect(() =>
      parse(["--frozen-schema", "dream_run_001", "--graded-by", "human-dana"], {
        OB_GRADING_NAMESPACE: "environment-is-not-explicit",
      }),
    ).toThrow(/--namespace is required with --frozen-schema/);
  });

  it("requires and trusts a human grader before frozen startup", () => {
    expect(() =>
      parse(["--frozen-schema", "dream_run_001", "--namespace", "dana"]),
    ).toThrow(/--graded-by or GRADED_BY is required/);
    expect(() =>
      parse([
        "--frozen-schema",
        "dream_run_001",
        "--namespace",
        "dana",
        "--graded-by",
        "gpt-6",
      ]),
    ).toThrow(/machine identity/);
  });

  it("rejects a missing or malformed frozen schema value", () => {
    expect(() => parse(["--frozen-schema", "--namespace", "dana"])).toThrow(
      /--frozen-schema requires a value/,
    );
    expect(() =>
      parse([
        "--frozen-schema",
        "public",
        "--namespace",
        "dana",
        "--graded-by",
        "human-dana",
      ]),
    ).toThrow(/dream run schema/);
  });

  it("returns the frozen callback inputs with an env-supplied trusted grader", () => {
    expect(
      parse(["--frozen-schema", "dream_run_042", "--namespace", "dana"], {
        GRADED_BY: "human-dana",
      }),
    ).toEqual({
      namespace: "dana",
      gradedBy: "human-dana",
      port: 3417,
      frozenSchema: "dream_run_042",
    });
  });

  it.each(["-1", "0", "1.5", "65536", "not-a-port"])(
    "rejects invalid port %s before startup",
    (port) => {
      expect(() => parse(["--port", port])).toThrow(/integer from 1 through 65535/);
    },
  );
});

describe("startWithPoolCleanup", () => {
  it("closes the pool and preserves every startup rejection", async () => {
    const failure = Object.assign(new Error("invalid port"), {
      code: "ERR_SOCKET_BAD_PORT",
    });
    const closePool = vi.fn(async () => undefined);

    await expect(
      startWithPoolCleanup(async () => Promise.reject(failure), closePool),
    ).rejects.toBe(failure);
    expect(closePool).toHaveBeenCalledOnce();
  });

  it("leaves the pool open after successful startup", async () => {
    const closePool = vi.fn(async () => undefined);

    await expect(startWithPoolCleanup(async () => "server", closePool)).resolves.toBe(
      "server",
    );
    expect(closePool).not.toHaveBeenCalled();
  });
});
