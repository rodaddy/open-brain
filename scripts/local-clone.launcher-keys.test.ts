import { describe, expect, it } from "vitest";
import { describeDroppedChildEnvironment } from "./local-clone.ts";

// Issue 755: OPENBRAIN_LOCAL_CLONE_LOG_DIR configures the launcher's own log
// sink and is consumed before the child exists, so the drop report must not
// name it. Any other unlisted OPENBRAIN_* key must still be reported.
describe("local clone launcher-own env keys (issue 755)", () => {
  it("does not report launcher-own keys but still reports unlisted server keys", () => {
    expect(
      describeDroppedChildEnvironment({
        OPENBRAIN_LOCAL_CLONE_LOG_DIR: "/x",
        OPENBRAIN_SOME_UNLISTED_KEY: "y",
      }),
    ).toEqual([{ key: "OPENBRAIN_SOME_UNLISTED_KEY" }]);
  });
});
