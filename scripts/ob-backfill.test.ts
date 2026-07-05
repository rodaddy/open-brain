import { describe, expect, it } from "bun:test";

import { containsSecret, SECRET_PATTERNS } from "../src/sharing.ts";
import { buildDecisionLogParams, sanitize } from "./ob-backfill.ts";

const FAKE_SK = "sk" + "-" + "abcdefghijklmnopqrstuvwxyz0123456789";
const FAKE_GITHUB_PAT =
  "github" + "_pat_" + "11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuVwXyZ";
const FAKE_GH_PAT = "ghp_" + "11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuVwXyZ";
const FAKE_AWS_ACCESS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";
const FAKE_AWS_SECRET = "Aa0/".repeat(10);
const FAKE_GOOGLE_API_KEY = "AIza" + "A".repeat(35);
const FAKE_JWT =
  "eyJhbGciOiJIUzI1NiJ9." + "eyJzdWIiOiJ0ZXN0In0." + "abcdefghijklmnop";
const FAKE_PRIVATE_KEY =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----";
const FAKE_URL = "postgres://admin:hunter2pw@10.0.0.1:5432/app";
const FAKE_SLACK = "xoxb-" + "1234567890-abcdefghij";
const FAKE_STRIPE = "sk" + "_live_" + "a".repeat(24);
const FAKE_LONG_LABELED_SECRET = "Abcdefghij1234567890";

const SECRET_CASES = [
  "Authorization: Bearer abcdef123456",
  "bearer abcdef123456",
  "mcp-session-id: session_123:abc",
  FAKE_SK,
  FAKE_GITHUB_PAT,
  FAKE_GH_PAT,
  FAKE_AWS_ACCESS_KEY,
  `aws_secret_access_key=${FAKE_AWS_SECRET}`,
  FAKE_AWS_SECRET,
  FAKE_SLACK,
  FAKE_GOOGLE_API_KEY,
  FAKE_JWT,
  "api_key=supersecretvalue",
  '"token": "supersecretvalue"',
  FAKE_PRIVATE_KEY,
  FAKE_STRIPE,
  FAKE_URL,
  `access_token=${FAKE_LONG_LABELED_SECRET}`,
] as const;

describe("ob-backfill sanitize", () => {
  it("redacts each shared secret pattern before OB writes", () => {
    SECRET_PATTERNS.forEach((pattern) => {
      expect(SECRET_CASES.some((secretCase) => pattern.test(secretCase))).toBe(true);
    });
    SECRET_CASES.forEach((secretCase) => {
      expect(SECRET_PATTERNS.some((pattern) => pattern.test(secretCase))).toBe(true);
    });

    for (const secretCase of SECRET_CASES) {
      const sanitized = sanitize(
        [`transcript detail ${secretCase}`, "regular file path src/tools/session-save.ts"].join(
          "\n",
        ),
      );

      expect(sanitized).not.toContain(secretCase);
      expect(sanitized).toContain("[REDACTED]");
      if (sanitized !== "[REDACTED]") {
        expect(sanitized).toContain("regular file path src/tools/session-save.ts");
      }
      expect(sanitized).not.toContain("\n");
      expect(containsSecret(sanitized.replace(/\s+/g, ""))).toBe(false);
    }
  });

  it("redacts repeated same-shape secrets before OB writes", () => {
    const secondFakeSk = "sk" + "-" + "zyxwvutsrqponmlkjihgfedcba9876543210";
    const sanitized = sanitize(`first ${FAKE_SK}\nsecond ${secondFakeSk}`);

    expect(sanitized).not.toContain(FAKE_SK);
    expect(sanitized).not.toContain(secondFakeSk);
    expect(sanitized).toContain("[REDACTED]");
    expect(sanitized).not.toContain("\n");
    expect(containsSecret(sanitized.replace(/\s+/g, ""))).toBe(false);
  });

  it("redacts secrets reformed after control-character stripping", () => {
    const splitSecret = `${FAKE_SK.slice(0, 12)}\x1b${FAKE_SK.slice(12)}`;
    const sanitized = sanitize(`token ${splitSecret}`);

    expect(sanitized).not.toContain(FAKE_SK);
    expect(sanitized).toContain("[REDACTED]");
  });

  it("redacts secrets that only become detectable after whitespace compaction", () => {
    const splitJwt = FAKE_JWT.replace(".abcdefghijklmnop", ".\nabcdefghijklmnop");
    const sanitized = sanitize(`jwt ${splitJwt} rotated`);

    expect(sanitized).toBe("[REDACTED]");
  });

  it("redacts secrets split between alphanumeric token characters", () => {
    const splitSecret = `${FAKE_SK.slice(0, 13)}\n${FAKE_SK.slice(13)}`;
    const sanitized = sanitize(`wrapped ${splitSecret} rotated`);

    expect(sanitized).toBe("[REDACTED]");
    expect(containsSecret(sanitized.replace(/\s+/g, ""))).toBe(false);
  });

  it("redacts secrets split across many wrapped fragments", () => {
    const fragments = FAKE_SK.match(/.{1,7}/g);
    if (!fragments) throw new Error("Expected fake secret fragments");

    const sanitized = sanitize(`apikey ${fragments.join("\n")} rotated`);

    expect(sanitized).toBe("[REDACTED]");
    expect(containsSecret(sanitized.replace(/\s+/g, ""))).toBe(false);
  });

  it("redacts secrets split into short wrapped fragments", () => {
    const fragments = FAKE_SK.match(/.{1,3}/g);
    if (!fragments) throw new Error("Expected fake secret fragments");

    const sanitized = sanitize(`apikey ${fragments.join("\n")} rotated`);

    expect(sanitized).toBe("[REDACTED]");
    expect(containsSecret(sanitized.replace(/\s+/g, ""))).toBe(false);
  });

  it("redacts secrets split beyond the prefix-join fragment cap", () => {
    const fragments = FAKE_SK.match(/.{1,2}/g);
    if (!fragments) throw new Error("Expected fake secret fragments");

    const sanitized = sanitize(`key ${fragments.join(" ")} end`);

    expect(fragments.length).toBeGreaterThan(16);
    expect(sanitized).toBe("[REDACTED]");
    expect(containsSecret(sanitized.replace(/\s+/g, ""))).toBe(false);
  });

  it("redacts wrapped bearer and mcp-session-id tails", () => {
    const wrappedBearer = [
      "Authorization",
      ": Bearer ",
      "aB3xY9zK7m",
      "\n",
      "N2pQ5rT8wV1cD4",
    ].join("");
    const wrappedSessionId = [
      "mcp-session-id",
      ": ",
      "7f3a9b2c",
      "\n",
      "1d4e5f6a780099",
    ].join("");

    for (const wrappedSecret of [wrappedBearer, wrappedSessionId]) {
      const sanitized = sanitize(`wrapped ${wrappedSecret} tail`);

      expect(sanitized).toBe("[REDACTED]");
      expect(containsSecret(sanitized.replace(/\s+/g, ""))).toBe(false);
    }
  });

  it("redacts prefixless, URL, and labeled secrets split by wrapping", () => {
    const splitAwsSecret = `${FAKE_AWS_SECRET.slice(0, 20)}\n${FAKE_AWS_SECRET.slice(20)}`;
    const lateSymbolAwsSecret = "Abcdefghij1234567890AbcdefghijKLMNOP/xyz";
    const splitLateSymbolAwsSecret = lateSymbolAwsSecret.replace("/xyz", "\n/xyz");
    const splitUrl = FAKE_URL.replace("hunter2pw@", "hunter2\npw@");
    const splitLabeled = `access_token=${FAKE_LONG_LABELED_SECRET.slice(
      0,
      10,
    )}\n${FAKE_LONG_LABELED_SECRET.slice(10)}`;

    for (const wrappedSecret of [
      splitAwsSecret,
      splitLateSymbolAwsSecret,
      splitUrl,
      splitLabeled,
    ]) {
      const sanitized = sanitize(`wrapped ${wrappedSecret} rotated`);

      expect(sanitized).toBe("[REDACTED]");
      expect(containsSecret(sanitized.replace(/\s+/g, ""))).toBe(false);
    }
  });

  it("redacts prefixless AWS-like secrets split by punctuation", () => {
    for (const separator of [",", '"', "<", "`", "*", "{", "}", "^", "$", "\\"]) {
      const splitSecret = `${FAKE_AWS_SECRET.slice(0, 20)}${separator}${FAKE_AWS_SECRET.slice(20)}`;
      const sanitized = sanitize(`wrapped ${splitSecret} rotated`);
      const rejoined = sanitized.replace(/[\s,;"'()[\]<>?!&%#|`*{}^$\\]/g, "");

      expect(sanitized).toBe("[REDACTED]");
      expect(rejoined).not.toContain(FAKE_AWS_SECRET);
      expect(containsSecret(sanitized)).toBe(false);
    }
  });

  it("does not leave prefixed secret tails after punctuation splits", () => {
    for (const separator of [",", '"', "[", "<"]) {
      const splitSecret = `${FAKE_SK.slice(0, 18)}${separator}${FAKE_SK.slice(18)}`;
      const sanitized = sanitize(`token ${splitSecret} end`);

      expect(sanitized).toBe("[REDACTED]");
      for (const index of Array.from({ length: FAKE_SK.length - 5 }, (_, i) => i)) {
        expect(sanitized).not.toContain(FAKE_SK.slice(index, index + 6));
      }
    }
  });

  it("redacts wrapped ssh credential URLs", () => {
    const wrappedSshUrl = [
      "ssh://admin:hunter2",
      "\n",
      "pw@example.test",
      "/repo",
    ].join("");
    const sanitized = sanitize(`wrapped ${wrappedSshUrl} tail`);

    expect(sanitized).toBe("[REDACTED]");
    expect(containsSecret(sanitized.replace(/\s+/g, ""))).toBe(false);
  });

  it("does not leave labeled wrapped-secret tails in cleartext", () => {
    const fragments = FAKE_SK.match(/.{1,2}/g);
    if (!fragments) throw new Error("Expected fake secret fragments");

    const sanitized = sanitize(`apikey=${fragments.join(" ")}`);

    expect(sanitized).toBe("[REDACTED]");
    for (const index of Array.from({ length: FAKE_SK.length - 5 }, (_, i) => i)) {
      expect(sanitized).not.toContain(FAKE_SK.slice(index, index + 6));
    }
  });

  it("redacts credential URLs without joining across benign URL prose", () => {
    const sanitized = sanitize(
      "see https://good.example/path and postgres://user:pass123@host/db done",
    );

    expect(sanitized).not.toBe("[REDACTED]");
    expect(sanitized).toContain("https://good.example/path");
    expect(sanitized).toContain("[REDACTED]");
    expect(sanitized).toContain("done");
    expect(containsSecret(sanitized)).toBe(false);
  });

  it("preserves benign label prose instead of redacting the whole field", () => {
    const text = "token: the meeting is at 3pm and everyone should attend the sync";
    const sanitized = sanitize(text);

    expect(sanitized).not.toBe("[REDACTED]");
    expect(sanitized).toContain("meeting is at 3pm");
    expect(containsSecret(sanitized.replace(/\s+/g, ""))).toBe(false);
  });

  it("scans token-dense transcripts without quadratic blowup", () => {
    const dense = Array.from({ length: 12_000 }, (_, index) => `Ab${index % 10}cd`).join(
      " ",
    );
    const startedAt = performance.now();
    const sanitized = sanitize(dense);

    expect(sanitized).toContain("Ab0cd");
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("scans URL-dense transcripts without quadratic prefix-join work", () => {
    const dense = Array.from(
      { length: 4_000 },
      (_, index) => `https://example.com/${index}`,
    ).join(" ");
    const startedAt = performance.now();
    const sanitized = sanitize(dense);

    expect(sanitized).toContain("https://example.com/0");
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });
});

describe("ob-backfill decision params", () => {
  it("sanitizes decisions before splitting title and rationale", () => {
    const splitCredentialUrl = [
      "postgres://admin:hunter2",
      " because ",
      "pw@example.test:5432/app",
    ].join("");
    const params = buildDecisionLogParams(
      splitCredentialUrl,
      "open-brain",
    );

    expect(params.title).toBe("[REDACTED]");
    expect(params.rationale).toBe("");
    expect(containsSecret(`${params.title} ${params.rationale}`)).toBe(false);
  });

  it("does not duplicate single-clause decisions into rationale", () => {
    const params = buildDecisionLogParams("Adopted pgvector for speed", "open-brain");

    expect(params.title).toBe("Adopted pgvector for speed");
    expect(params.rationale).toBe("");
  });

  it("preserves multi-clause rationale after the first because", () => {
    const params = buildDecisionLogParams(
      "Adopt pgvector because retrieval is faster because vectors stay local",
      "open-brain",
    );

    expect(params.title).toBe("Adopt pgvector");
    expect(params.rationale).toBe("retrieval is faster because vectors stay local");
  });

  it("sanitizes structural project tags", () => {
    const params = buildDecisionLogParams("Adopted pgvector for speed", FAKE_SK);

    expect(params.tags).toEqual(["backfill", "[REDACTED]"]);
    expect(containsSecret(params.tags.join(" "))).toBe(false);
  });
});
