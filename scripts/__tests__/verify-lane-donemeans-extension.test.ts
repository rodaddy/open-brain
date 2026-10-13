/**
 * verify-lane refuses a done-means path that is not a shell script (issue 733).
 *
 * THE DEFECT. `runCheck` hands the resolved done-means path straight to
 * `spawnSync("bash", [checkPath])`. When a PR's `- Done-means:` line names a
 * `.ts` or `.test.ts` file — an easy mistake, because a lane's real evidence
 * usually IS a test file — bash parses TypeScript line by line and dies with a
 * syntax error at exit 2. verify-lane then reports that as `<path> exited 2 at
 * PR head <sha>`, which reads exactly like a failing check. It is not: nothing
 * was verified, and the lane gets told its work is red for a reason that has
 * nothing to do with its work.
 *
 * So the refusal happens BEFORE the spawn, and it names the wrapper recipe
 * rather than leaving the author to guess at it.
 */
import { describe, expect, test } from "vitest";
import { VerifyLaneError, requireShellCheckPath } from "../verify-lane-io.ts";

describe("verify-lane done-means extension guard", () => {
  test("accepts a .sh path and returns nothing", () => {
    expect(
      requireShellCheckPath(
        "scripts/done-means/733-verify-lane-donemeans-extension.sh",
      ),
    ).toBeUndefined();
  });

  test("refuses a .ts path before bash ever sees it", () => {
    expect(() => requireShellCheckPath("scripts/verify-lane.ts")).toThrow(
      VerifyLaneError,
    );
  });

  test("refuses a .test.ts path", () => {
    expect(() =>
      requireShellCheckPath(
        "scripts/__tests__/verify-lane-donemeans-extension.test.ts",
      ),
    ).toThrow(VerifyLaneError);
  });

  test("the refusal is a harness error, not a check verdict", () => {
    let caught: VerifyLaneError | null = null;
    try {
      requireShellCheckPath("src/thing.test.ts");
    } catch (err) {
      caught = err as VerifyLaneError;
    }
    expect(caught).not.toBeNull();
    expect(caught?.step).toBe("done-means");
    // (a) it says the path is not a shell script
    expect(caught?.message).toContain("not a shell script");
    expect(caught?.message).toContain("src/thing.test.ts");
    // (b) it names the wrapper recipe verbatim, including the npm command
    expect(caught?.detail).toContain("scripts/done-means/<issue>-<slug>.sh");
    expect(caught?.detail).toContain("npm run test:isolated -- src/thing.test.ts");
  });

  test("a path with no extension is refused too — bash would still be guessing", () => {
    expect(() => requireShellCheckPath("scripts/done-means/whatever")).toThrow(
      VerifyLaneError,
    );
  });

  test("the extension check is case-insensitive", () => {
    expect(requireShellCheckPath("scripts/done-means/Thing.SH")).toBeUndefined();
  });
});
