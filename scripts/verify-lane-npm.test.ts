// Tests for verify-lane's npm resolution and visible bootstrap failure
// (issues 1510, 1503). Pure resolver plus one real spawn of a failing binary;
// nothing here installs dependencies or talks to Forgejo.
import { afterEach, describe, expect, it, vi } from "vitest";
import { KEG_NPM, resolveNpm, runNpmCi } from "./verify-lane.ts";

describe("resolveNpm", () => {
  it("uses the npm beside the running node when it exists", () => {
    const seen: string[] = [];
    const npm = resolveNpm("/opt/x/node24/bin/node", (path) => {
      seen.push(path);
      return true;
    });
    expect(npm).toBe("/opt/x/node24/bin/npm");
    expect(seen).toEqual(["/opt/x/node24/bin/npm"]);
  });

  it("falls back to the node@24 keg npm when the sibling is missing", () => {
    expect(resolveNpm("/usr/local/bin/node", () => false)).toBe(KEG_NPM);
    expect(KEG_NPM).toBe("/opt/homebrew/opt/node@24/bin/npm");
  });
});

describe("runNpmCi failure line", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the exit code and rethrows when npm exits non-zero", () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    expect(() => runNpmCi("deps-at-head", process.cwd(), "/usr/bin/false")).toThrow(
      /exited 1/,
    );
    expect(writes).toContain("VERIFY-LANE BOOTSTRAP FAILED: deps-at-head exit 1\n");
  });

  it("names a spawn error when the npm binary does not exist", () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    expect(() =>
      runNpmCi("deps-at-head", process.cwd(), "/nonexistent/node24/bin/npm"),
    ).toThrow(/could not execute/);
    expect(writes).toContain(
      "VERIFY-LANE BOOTSTRAP FAILED: deps-at-head exit spawn-error\n",
    );
  });
});
