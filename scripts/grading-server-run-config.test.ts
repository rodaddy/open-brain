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
    expect(parse([])).toEqual({ namespace: "rico", gradedBy: "rico", port: 3417 });
  });

  it("requires an explicit namespace before frozen startup", () => {
    expect(() =>
      parse(["--frozen-schema", "dream_run_001", "--graded-by", "human-rico"], {
        OB_GRADING_NAMESPACE: "environment-is-not-explicit",
      }),
    ).toThrow(/--namespace is required with --frozen-schema/);
  });

  it("requires and trusts a human grader before frozen startup", () => {
    expect(() =>
      parse(["--frozen-schema", "dream_run_001", "--namespace", "rico"]),
    ).toThrow(/--graded-by or GRADED_BY is required/);
    expect(() =>
      parse([
        "--frozen-schema",
        "dream_run_001",
        "--namespace",
        "rico",
        "--graded-by",
        "gpt-6",
      ]),
    ).toThrow(/machine identity/);
  });

  it("rejects a missing or malformed frozen schema value", () => {
    expect(() => parse(["--frozen-schema", "--namespace", "rico"])).toThrow(
      /--frozen-schema requires a value/,
    );
    expect(() =>
      parse([
        "--frozen-schema",
        "public",
        "--namespace",
        "rico",
        "--graded-by",
        "human-rico",
      ]),
    ).toThrow(/dream run schema/);
  });

  it("returns the frozen callback inputs with an env-supplied trusted grader", () => {
    expect(
      parse(["--frozen-schema", "dream_run_042", "--namespace", "rico"], {
        GRADED_BY: "human-rico",
      }),
    ).toEqual({
      namespace: "rico",
      gradedBy: "human-rico",
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
