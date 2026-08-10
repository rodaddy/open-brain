import { describe, expect, it } from "bun:test";
import { validatePrBody } from "./validate-pr-body.ts";

const validBody = `## Summary

- test

## Verification

- Done-means: scripts/done-means/done-means-field-required.sh

## Critical Self-Review

- Highest-risk behavior: delegated auth provenance can drift
- Assumptions that could be wrong: workflow event body parsing
- Missing/weak tests: live canary remains separate
- Security/permission risk: PR body bypass requires Rico approval
- Migration/deploy risk: none
- Downstream client/runtime risk: none
- Rollback/cleanup concern: remove workflow
- Fixes made before PR: validator added
- Known residual risk: live proof still must be run when required
- SME review-memory update: [x] \`docs/sme/\` updated or [ ] not applicable because:

## Review Gate

- [x] Critical self-review fields above are filled with specific, non-placeholder content
- [x] MEDIUM+ review findings were captured in \`docs/sme/\` or explicitly marked not applicable
- Live Open Brain checks: [ ] linked below or [x] not applicable because: this fixture does not require live proof

## Contract Parity

- Contract parity: [x] fixtures updated
- Contract parity: [ ] runtime-specific because:
`;

describe("validatePrBody", () => {
  it("accepts a complete critical self-review and checked review gate", () => {
    expect(validatePrBody(validBody).errors).toEqual([]);
  });

  it("rejects the blank PR template", () => {
    const template = Bun.file(".github/pull_request_template.md").text();
    return template.then((body) => {
      expect(validatePrBody(body).errors.length).toBeGreaterThan(0);
    });
  });

  it("rejects unchecked review gate confirmations", () => {
    const body = validBody.replaceAll("- [x]", "- [ ]");
    expect(validatePrBody(body).errors).toContain(
      "Review Gate checkbox must be checked: Critical self-review fields above are filled",
    );
  });

  it("rejects empty critical self-review fields without stealing the next bullet", () => {
    const body = validBody.replace(
      "- Highest-risk behavior: delegated auth provenance can drift",
      "- Highest-risk behavior:",
    );
    expect(validatePrBody(body).errors).toContain(
      "Critical Self-Review field 'Highest-risk behavior' needs specific content.",
    );
  });

  it("rejects ambiguous SME disposition", () => {
    const body = validBody.replace(
      "- SME review-memory update: [x] `docs/sme/` updated or [ ] not applicable because:",
      "- SME review-memory update: [x] `docs/sme/` updated or [x] not applicable because: duplicate",
    );
    expect(validatePrBody(body).errors).toContain(
      "SME review-memory update must check exactly one disposition.",
    );
  });

  it("rejects ambiguous live-check disposition", () => {
    const body = validBody.replace(
      "- Live Open Brain checks: [ ] linked below or [x] not applicable because: this fixture does not require live proof",
      "- Live Open Brain checks: [x] linked below or [x] not applicable because: duplicate",
    );
    expect(validatePrBody(body).errors).toContain(
      "Live Open Brain checks must check exactly one disposition.",
    );
  });

  it("rejects self-attested bypass text", () => {
    expect(
      validatePrBody("review-gate-bypass: rico-approved").errors.length,
    ).toBeGreaterThan(0);
  });

  it("requires the contract-parity section for client and contract changes", () => {
    const body = validBody.replace(/\n## Contract Parity[\s\S]*$/, "");
    expect(
      validatePrBody(body, { contractParityRequired: true }).errors,
    ).toContain("Missing '## Contract Parity' section.");
  });

  it("accepts either exact contract-parity disposition", () => {
    expect(
      validatePrBody(validBody, { contractParityRequired: true }).errors,
    ).toEqual([]);
    const runtimeSpecific = validBody
      .replace("[x] fixtures updated", "[ ] fixtures updated")
      .replace(
        "[ ] runtime-specific because:",
        "[x] runtime-specific because: TS adapter owns the category taxonomy",
      );
    expect(
      validatePrBody(runtimeSpecific, { contractParityRequired: true }).errors,
    ).toEqual([]);
  });

  it("rejects ambiguous or unexplained contract-parity dispositions", () => {
    const ambiguous = validBody.replace(
      "[ ] runtime-specific because:",
      "[x] runtime-specific because: duplicate",
    );
    expect(
      validatePrBody(ambiguous, { contractParityRequired: true }).errors,
    ).toContain("Contract parity must check exactly one disposition.");

    const unexplained = validBody
      .replace("[x] fixtures updated", "[ ] fixtures updated")
      .replace(
        "[ ] runtime-specific because:",
        "[x] runtime-specific because: -",
      );
    expect(
      validatePrBody(unexplained, { contractParityRequired: true }).errors,
    ).toContain("Contract parity runtime-specific disposition needs a reason.");
  });

  it("rejects placeholder runtime-specific reasons", () => {
    const placeholder = validBody
      .replace("[x] fixtures updated", "[ ] fixtures updated")
      .replace(
        "[ ] runtime-specific because:",
        "[x] runtime-specific because: TBD",
      );
    expect(
      validatePrBody(placeholder, { contractParityRequired: true }).errors,
    ).toContain("Contract parity runtime-specific disposition needs a reason.");
  });

  it("rejects non-literal fixtures-updated declarations", () => {
    const body = validBody.replace(
      "[x] fixtures updated",
      "[x] fixtures updated or runtime-specific",
    );
    expect(
      validatePrBody(body, { contractParityRequired: true }).errors,
    ).toContain("Contract parity must check exactly one disposition.");
  });

  // --- issue #706: which tree answers the Done-means path -------------------
  //
  // The end-to-end proof is scripts/done-means/706-done-means-resolves-pr-head.sh,
  // which drives the real validator across two real trees. These are the
  // function-boundary cases: cheap, and they pin the resolution ORDER and the
  // containment guard, which a cross-tree shell check reads less precisely.
  const withDoneMeans = (value: string) =>
    validBody.replace(
      "- Done-means: scripts/done-means/done-means-field-required.sh",
      `- Done-means: ${value}`,
    );

  const notFound = (result: { errors: string[] }) =>
    result.errors.some((error) => error.includes("Done-means"));

  it("resolves Done-means against the tree under review, not its own tree", () => {
    // `scripts/validate-pr-body.ts` exists in the repo root. Pointing reviewRoot
    // at `scripts/` makes `validate-pr-body.ts` (no directory prefix) resolvable
    // ONLY through the review root, so a pass can only come from that tree.
    const result = validatePrBody(withDoneMeans("validate-pr-body.ts"), {
      reviewRoot: import.meta.dir,
    });
    expect(result.errors).toEqual([]);
    expect(result.notes.join("\n")).toContain("the tree under review");
  });

  it("still refuses a path that exists in no tree and on no ref", () => {
    const result = validatePrBody(
      withDoneMeans("scripts/done-means/definitely-not-here-706.sh"),
      { reviewRoot: import.meta.dir },
    );
    expect(notFound(result)).toBe(true);
    // The refusal names where it looked, so it is actionable rather than a dead
    // end (lane-contract round 15).
    expect(result.errors.join("\n")).toContain("looked in:");
  });

  it("refuses an absolute path even when that path exists", () => {
    // Widening WHERE the path may live must not widen WHAT may be named: an
    // absolute path escapes the repo-relative contract, and it resolves outside
    // any tree the reviewer can see.
    const result = validatePrBody(withDoneMeans("/etc/hosts"), {
      reviewRoot: import.meta.dir,
    });
    expect(notFound(result)).toBe(true);
  });

  it("refuses a traversal escape out of the tree under review", () => {
    const result = validatePrBody(withDoneMeans("../../../../etc/hosts"), {
      reviewRoot: import.meta.dir,
    });
    expect(notFound(result)).toBe(true);
  });

  it("falls back to the validator's own tree when the review root misses", () => {
    // The ordinary case: the validator invoked from somewhere unrelated still
    // resolves a path that lives beside it. This is what stops the fix from
    // swapping one hardcoded tree for another.
    const result = validatePrBody(
      withDoneMeans("scripts/done-means/done-means-field-required.sh"),
      { reviewRoot: "/" },
    );
    expect(result.errors).toEqual([]);
    expect(result.notes.join("\n")).toContain("the validator's own tree");
  });

  it("does not consult a ref when none is named", () => {
    // The branch fallback is opt-in. Without headRef there is no git call and no
    // extra resolution, so an absent path is still absent.
    const result = validatePrBody(withDoneMeans("no/such/path-706.sh"), {
      reviewRoot: import.meta.dir,
    });
    expect(notFound(result)).toBe(true);
    expect(result.errors.join("\n")).not.toContain("and in ref");
  });
});
