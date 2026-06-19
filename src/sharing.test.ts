import { describe, expect, it } from "bun:test";
import {
  classifyShareCandidate,
  containsSecret,
  DEFAULT_MIN_SHARE_LENGTH,
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
