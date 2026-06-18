import { describe, expect, it } from "bun:test";
import { validatePrBody } from "./validate-pr-body.ts";

const validBody = `## Summary

- test

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
- [x] Live Open Brain checks are linked below when an issue acceptance criterion requires live proof
`;

describe("validatePrBody", () => {
  it("accepts a complete critical self-review and checked review gate", () => {
    expect(validatePrBody(validBody)).toEqual({ bypassed: false, errors: [] });
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

  it("allows Rico-approved bypass marker", () => {
    expect(validatePrBody("review-gate-bypass: rico-approved")).toEqual({
      bypassed: true,
      errors: [],
    });
  });
});
