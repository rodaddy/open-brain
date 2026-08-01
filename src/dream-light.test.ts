import { describe, expect, it } from "bun:test";
import { isCountable } from "./dream-light.ts";

/**
 * Functional tests for Light's countability boundary (Issue #390).
 *
 * These exist because the boundary was wrong in production and nothing caught
 * it: an earlier version rejected anything under 16 characters, which silently
 * discarded the operator's authorizing turns -- the exact content that converts
 * a proposal into a decision.
 *
 * The standing trade is RECALL OVER PRECISION. Extra low-value rows are cheap
 * and visible to every later stage; a dropped decision is invisible and
 * unrecoverable. So the assertions below are asymmetric on purpose: they are
 * strict about what must be KEPT and permissive about what may slip through.
 */

describe("isCountable — short speech must survive", () => {
  // Real operator turns from the dogfood corpus. Each is under 16 characters
  // and each authorizes work, which is why a length floor was the wrong rule.
  const shortAuthorizations = [
    "go",
    "go for it",
    "run it",
    "try it",
    "do it",
    "switched both",
  ];

  for (const content of shortAuthorizations) {
    it(`keeps the authorization "${content}" (${content.length} chars)`, () => {
      expect(isCountable(content, "user")).toBe(true);
    });
  }

  // The same string is not always the same act -- "okay" is assent after one
  // turn and doubt after another. A rule keyed on the string alone has to
  // guess, so it must not guess: interpretation belongs to a stage that can
  // read the neighbouring turns.
  const ambiguousAcknowledgements = ["ok", "okay", "got it", "sure", "yes"];

  for (const content of ambiguousAcknowledgements) {
    it(`keeps the ambiguous "${content}" rather than guessing its meaning`, () => {
      expect(isCountable(content, "user")).toBe(true);
    });
  }

  it("keeps a single meaningful character", () => {
    expect(isCountable("y", "user")).toBe(true);
  });
});

describe("isCountable — only speech corroborates", () => {
  it("rejects tool output regardless of how substantive it looks", () => {
    expect(isCountable("=== migration applied ===\nUPDATE 3736", "tool")).toBe(
      false,
    );
  });

  it("keeps assistant prose", () => {
    expect(
      isCountable(
        "The backfill touched 3,736 rows and all sessions are contiguous.",
        "assistant",
      ),
    ).toBe(true);
  });

  // An unknown role is treated as speech: a new runtime must not be able to
  // silently drop real content. Over-counting is the tolerable failure.
  it("treats an unrecognised role as speech", () => {
    expect(
      isCountable("a genuine utterance from a new runtime", "operator"),
    ).toBe(true);
  });

  it("treats a missing role as speech", () => {
    expect(isCountable("a genuine utterance with no role given")).toBe(true);
  });
});

describe("isCountable — machine scaffolding does not corroborate", () => {
  // Measured on the live corpus: "[tool_use: Bash]" appears 1,139 times across
  // 27 sessions. Counting these makes harness plumbing look like the
  // best-corroborated content in the brain.
  const scaffolding = [
    "[tool_use: Bash]",
    "[tool_use: Write]",
    "[tool_use: AskUserQuestion]",
    "[tool_result]",
    "[image]",
    "[attachment: file.pdf]",
  ];

  for (const content of scaffolding) {
    it(`rejects the stub "${content}"`, () => {
      expect(isCountable(content, "assistant")).toBe(false);
    });
  }

  it("rejects empty content", () => {
    expect(isCountable("", "user")).toBe(false);
  });

  it("rejects whitespace-only content", () => {
    expect(isCountable("   \n\t  ", "user")).toBe(false);
  });

  // Prose that merely mentions a tool stub is speech, not scaffolding -- the
  // patterns are anchored so they cannot swallow a real sentence.
  it("keeps prose that mentions a stub without being one", () => {
    expect(
      isCountable(
        "[tool_use: Bash] showed up 1,139 times, which is the bug",
        "assistant",
      ),
    ).toBe(true);
  });
});
