import { describe, expect, it } from "vitest";
import { authorityTierOf } from "./authority.ts";
import type { RouteCandidate } from "./types.ts";

const candidate = (over: Partial<RouteCandidate>): RouteCandidate => ({
  id: "c1",
  namespace: "shared-kb",
  candidateType: "fact",
  content: "content",
  operatorText: null,
  unitKind: "exchange",
  anchorKind: "typed",
  ...over,
});

describe("authorityTierOf", () => {
  it("is decided for a typed exchange", () => {
    expect(authorityTierOf(candidate({}))).toBe("decided");
  });

  it("is decided for an askuserquestion exchange", () => {
    expect(authorityTierOf(candidate({ anchorKind: "askuserquestion" }))).toBe(
      "decided",
    );
  });

  it("is observed for a fragment even when typed", () => {
    expect(authorityTierOf(candidate({ unitKind: "fragment" }))).toBe("observed");
  });

  it("is observed for an orphan anchor", () => {
    expect(authorityTierOf(candidate({ anchorKind: "orphan" }))).toBe("observed");
  });

  it("is observed for a null anchor", () => {
    expect(authorityTierOf(candidate({ anchorKind: null }))).toBe("observed");
  });
});
