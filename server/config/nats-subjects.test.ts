import { describe, expect, it } from "bun:test";
import { obContextPackSubject, slugSubjectToken } from "./nats-subjects.ts";

describe("slugSubjectToken", () => {
  it("lowercases and collapses spaces and dots to hyphens (fleet _slug parity)", () => {
    expect(slugSubjectToken("Staging Lab.1")).toBe("staging-lab-1");
    expect(slugSubjectToken("PROD")).toBe("prod");
  });

  it("throws on a token that normalises to empty", () => {
    expect(() => slugSubjectToken("   ")).toThrow(/normalises to empty/);
    expect(() => slugSubjectToken("")).toThrow(/normalises to empty/);
  });
});

describe("obContextPackSubject", () => {
  it("builds the env-prefixed fleet subject", () => {
    expect(obContextPackSubject("dev")).toBe("dev.ob.memory.context_pack");
    expect(obContextPackSubject("prod")).toBe("prod.ob.memory.context_pack");
  });

  it("slugs the env token before use", () => {
    expect(obContextPackSubject("Staging Lab")).toBe(
      "staging-lab.ob.memory.context_pack",
    );
  });

  it("throws when the env token is empty", () => {
    expect(() => obContextPackSubject("  ")).toThrow(/normalises to empty/);
  });
});
