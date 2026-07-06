import { describe, expect, it } from "bun:test";
import {
  classifyShareCandidate,
  containsSecret,
  DEFAULT_MIN_SHARE_LENGTH,
  redactText,
  shareRejectionDetail,
  SECRET_PATTERNS,
} from "./sharing.ts";

// Clearly-fake / documentation example values, split where needed so the repo's
// own secret scanner (ggshield) does not flag the test fixtures themselves.
const FAKE_AWS_ACCESS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";
const FAKE_JWT =
  "eyJhbGciOiJIUzI1NiJ9." + "eyJzdWIiOiJ0ZXN0In0." + "abcdefghijklmnop";
const FAKE_GH_PAT = "github" + "_pat_" + "11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuVwXyZ";
const FAKE_SK = "sk" + "-" + "abcdefghijklmnopqrstuvwxyz0123456789";
const FAKE_SLACK = "xoxb-" + "1234567890-abcdefghij";
const LONG_FACT =
  "The open-brain promotion runner graduates lane facts into shared-kb after classification.";

describe("containsSecret", () => {
  it("detects a fake AWS access key", () => {
    expect(containsSecret(`key is ${FAKE_AWS_ACCESS_KEY} here`)).toBe(true);
  });

  it("detects a fake JWT", () => {
    expect(containsSecret(`token ${FAKE_JWT}`)).toBe(true);
  });

  it("detects a GitHub PAT", () => {
    expect(containsSecret(`use ${FAKE_GH_PAT} to auth`)).toBe(true);
  });

  it("detects an sk-style API key", () => {
    expect(containsSecret(`OPENAI ${FAKE_SK}`)).toBe(true);
  });

  it("detects a Slack token", () => {
    expect(containsSecret(`slack ${FAKE_SLACK}`)).toBe(true);
  });

  it("detects an AWS secret in context", () => {
    expect(
      containsSecret(
        "aws_secret_access_key=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY1234",
      ),
    ).toBe(true);
  });

  it("detects a bearer authorization header", () => {
    expect(containsSecret("Authorization: Bearer abcdef123456")).toBe(true);
  });

  it("detects a key=value secret assignment", () => {
    expect(containsSecret("api_key=supersecretvalue")).toBe(true);
  });

  it("detects a private key block", () => {
    expect(
      containsSecret(
        "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----",
      ),
    ).toBe(true);
  });

  // ── #174: unlabeled credential shapes ──
  it("detects a Stripe-style live key (underscore form)", () => {
    expect(containsSecret("stripe " + "sk_live_" + "a".repeat(24))).toBe(true);
    expect(containsSecret("pub " + "pk_test_" + "b".repeat(24))).toBe(true);
  });

  it("detects credentials embedded in a URL", () => {
    expect(
      containsSecret("db at postgres://admin:hunter2pw@10.0.0.1:5432/app"),
    ).toBe(true);
  });

  it("detects URL credentials regardless of scheme case", () => {
    // URI schemes are case-insensitive; an uppercase scheme must not leak.
    expect(containsSecret("HTTPS://admin:hunter2pw@host/x")).toBe(true);
  });

  it("scans large input in linear time (ReDoS regression)", () => {
    // The URL credential pattern once had an unanchored `[a-z][a-z0-9+.-]*://`
    // prefix that backtracked O(n^2) on long input with no `://`. A fixed scheme
    // alternation fixed it. Guard: 80k chars must scan well under a second.
    const t = performance.now();
    containsSecret("a".repeat(80_000));
    containsSecret("http" + ":x".repeat(40_000));
    expect(performance.now() - t).toBeLessThan(500);
  });

  it("detects a labeled long secret value", () => {
    expect(
      containsSecret("client_secret=" + "Ab9".repeat(8) + "xyz"),
    ).toBe(true);
  });

  it("does NOT flag a bare hex content-hash / git SHA (no over-rejection)", () => {
    // 64-char hex content_hash and a 40-char git SHA are pervasive + legitimate.
    expect(containsSecret("content_hash " + "a1b2c3d4".repeat(8))).toBe(false);
    expect(containsSecret("commit 4ba6c76e1f2a3b4c5d6e7f8091a2b3c4d5e6f708")).toBe(
      false,
    );
  });

  it("does NOT flag a plain URL without credentials (no over-rejection)", () => {
    expect(containsSecret("see https://github.com/rodaddy/open-brain")).toBe(
      false,
    );
  });

  it("does not flag ordinary prose", () => {
    expect(
      containsSecret(
        "We decided to route lane facts through the promoter identity for shared-kb.",
      ),
    ).toBe(false);
  });

  it("does not flag empty content", () => {
    expect(containsSecret("")).toBe(false);
  });

  it("ships a non-trivial set of patterns", () => {
    expect(SECRET_PATTERNS.length).toBeGreaterThanOrEqual(10);
  });
});

describe("redactText", () => {
  it("scrubs known secret shapes while preserving surrounding diagnostics", () => {
    const input = [
      `aws ${FAKE_AWS_ACCESS_KEY}`,
      `jwt ${FAKE_JWT}`,
      `pat ${FAKE_GH_PAT}`,
      `openai ${FAKE_SK}`,
      `slack ${FAKE_SLACK}`,
      "plain diagnostic text stays visible",
    ].join("\n");

    const redacted = redactText(input);

    expect(redacted).toContain("plain diagnostic text stays visible");
    for (const secret of [
      FAKE_AWS_ACCESS_KEY,
      FAKE_JWT,
      FAKE_GH_PAT,
      FAKE_SK,
      FAKE_SLACK,
    ]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain("[REDACTED]");
  });

  it("scrubs repeated secrets that match the same pattern", () => {
    const secondFakeSk = "sk" + "-" + "zyxwvutsrqponmlkjihgfedcba9876543210";
    const redacted = redactText(`first ${FAKE_SK} second ${secondFakeSk}`);

    expect(redacted).not.toContain(FAKE_SK);
    expect(redacted).not.toContain(secondFakeSk);
    expect(redacted.match(/\[REDACTED\]/g)).toHaveLength(2);
  });
});

describe("classifyShareCandidate — reject-secret", () => {
  it("rejects a fact carrying an AWS key (secret beats everything)", () => {
    expect(
      classifyShareCandidate({
        event_type: "fact",
        importance: "hot",
        content: `${LONG_FACT} ${FAKE_AWS_ACCESS_KEY}`,
      }),
    ).toBe("reject-secret");
  });

  it("rejects even a long, share-eligible decision with an embedded JWT", () => {
    expect(
      classifyShareCandidate({
        importance: "hot",
        content: `${LONG_FACT} session ${FAKE_JWT}`,
      }),
    ).toBe("reject-secret");
  });
});

describe("shareRejectionDetail", () => {
  it("returns a non-leaking secret classifier label and span count", () => {
    const detail = shareRejectionDetail({
      event_type: "fact",
      importance: "hot",
      content: `${LONG_FACT} ${FAKE_AWS_ACCESS_KEY} then ${FAKE_AWS_ACCESS_KEY}`,
      metadata: { share_candidate: true },
    });

    expect(detail).toMatchObject({
      category: "reject-secret",
      matched_kind: "aws_access_key_id",
      span_count: 2,
      resubmittable: true,
      resubmit_attempt: 0,
      max_resubmit_attempts: 2,
    });
    expect(JSON.stringify(detail)).not.toContain(FAKE_AWS_ACCESS_KEY);
    expect(detail?.redaction_hint).toContain("Remove the credential");
  });

  it("counts spans across all matching secret detectors", () => {
    const detail = shareRejectionDetail({
      event_type: "fact",
      importance: "hot",
      content: `${LONG_FACT} ${FAKE_SK} plus ${FAKE_AWS_ACCESS_KEY}`,
      metadata: { share_candidate: true },
    });

    expect(detail).toMatchObject({
      category: "reject-secret",
      matched_kind: "openai_api_key",
      span_count: 2,
    });
    expect(JSON.stringify(detail)).not.toContain(FAKE_SK);
    expect(JSON.stringify(detail)).not.toContain(FAKE_AWS_ACCESS_KEY);
  });

  it("returns private marker detail without echoing private content", () => {
    const detail = shareRejectionDetail({
      content: LONG_FACT,
      tags: ["work", "confidential", "secret"],
      metadata: { share_candidate: true },
    });

    expect(detail).toMatchObject({
      category: "reject-private",
      matched_kind: "private-tag",
      span_count: 2,
      resubmittable: true,
    });
    expect(JSON.stringify(detail)).not.toContain("confidential");
    expect(JSON.stringify(detail)).not.toContain("secret");
  });

  it("bounds repeated sanitized resubmission attempts", () => {
    const detail = shareRejectionDetail({
      content: `${LONG_FACT} ${FAKE_SK}`,
      metadata: {
        share_candidate: true,
        sanitized_resubmit_of: "evt-1",
        sanitized_resubmit_attempt: 2,
      },
    });

    expect(detail).toMatchObject({
      category: "reject-secret",
      matched_kind: "openai_api_key",
      resubmit_attempt: 2,
      max_resubmit_attempts: 2,
      resubmittable: false,
    });
    expect(JSON.stringify(detail)).not.toContain(FAKE_SK);
  });
});

describe("classifyShareCandidate — reject-private", () => {
  it("rejects when metadata.private === true", () => {
    expect(
      classifyShareCandidate({
        content: LONG_FACT,
        metadata: { private: true },
      }),
    ).toBe("reject-private");
  });

  it("rejects when a private tag is present", () => {
    expect(
      classifyShareCandidate({
        content: LONG_FACT,
        tags: ["work", "Personal"],
      }),
    ).toBe("reject-private");
  });

  it("rejects when metadata.visibility is private", () => {
    expect(
      classifyShareCandidate({
        content: LONG_FACT,
        metadata: { visibility: "private" },
      }),
    ).toBe("reject-private");
  });

  it("private check ranks below secret check", () => {
    expect(
      classifyShareCandidate({
        content: `${LONG_FACT} ${FAKE_AWS_ACCESS_KEY}`,
        metadata: { private: true },
      }),
    ).toBe("reject-secret");
  });
});

describe("classifyShareCandidate — reject-noise", () => {
  it("rejects a question event type", () => {
    expect(
      classifyShareCandidate({ event_type: "question", content: LONG_FACT }),
    ).toBe("reject-noise");
  });

  it("rejects an action event type", () => {
    expect(
      classifyShareCandidate({ event_type: "action", content: LONG_FACT }),
    ).toBe("reject-noise");
  });

  it("rejects cold importance", () => {
    expect(
      classifyShareCandidate({
        event_type: "fact",
        importance: "cold",
        content: LONG_FACT,
      }),
    ).toBe("reject-noise");
  });

  it("rejects content shorter than minLen", () => {
    expect(classifyShareCandidate({ content: "too short" })).toBe(
      "reject-noise",
    );
  });

  it("rejects a non-shareable lane event type (blocker)", () => {
    expect(
      classifyShareCandidate({ event_type: "blocker", content: LONG_FACT }),
    ).toBe("reject-noise");
  });
});

describe("classifyShareCandidate — share / manual-review", () => {
  it("shares a long, hot fact event", () => {
    expect(
      classifyShareCandidate({
        event_type: "fact",
        importance: "hot",
        content: LONG_FACT,
      }),
    ).toBe("share");
  });

  it("shares a thought (no event_type) that is long and warm", () => {
    expect(
      classifyShareCandidate({ importance: "warm", content: LONG_FACT }),
    ).toBe("share");
  });

  it("shares a handoff event", () => {
    expect(
      classifyShareCandidate({ event_type: "handoff", content: LONG_FACT }),
    ).toBe("share");
  });

  it("routes a just-over-min-length candidate to manual-review", () => {
    const content = "x".repeat(DEFAULT_MIN_SHARE_LENGTH + 2);
    expect(classifyShareCandidate({ event_type: "fact", content })).toBe(
      "manual-review",
    );
  });

  it("honors a custom minLen", () => {
    const content = "short fact here";
    expect(
      classifyShareCandidate(
        { event_type: "fact", content },
        { minLen: 4 },
      ),
    ).toBe("share");
  });
});
