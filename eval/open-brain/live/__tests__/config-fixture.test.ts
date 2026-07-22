import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLiveFixture } from "../fixtures.ts";
import { parseThresholds } from "../metrics.ts";
import {
  liveEvalEnabled,
  loadLiveConfig,
  makeRunId,
  runNamespaces,
} from "../config.ts";

const SHIPPED_FIXTURE = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../fixtures/live-recall-v1.json"),
    "utf8",
  ),
);
const SHIPPED_THRESHOLDS = JSON.parse(
  readFileSync(join(import.meta.dir, "../../thresholds.json"), "utf8"),
);

const BASE_ENV = {
  OPEN_BRAIN_LIVE_EVAL: "1",
  OPEN_BRAIN_LIVE_EVAL_BASE_URL: "http://127.0.0.1:3100",
  OPEN_BRAIN_LIVE_EVAL_TOKEN: "primary-token",
} as unknown as NodeJS.ProcessEnv;

describe("live fixture validation", () => {
  it("parses the shipped fixture and its probes", () => {
    const fixture = parseLiveFixture(SHIPPED_FIXTURE);
    expect(fixture.fixture_id).toBe("open-brain-live-recall-v1");
    expect(fixture.probes.length).toBeGreaterThan(0);
    expect(fixture.corpus.some((e) => e.namespace_role === "negative")).toBe(
      true,
    );
  });

  it("shipped thresholds apply to the shipped fixture", () => {
    const fixture = parseLiveFixture(SHIPPED_FIXTURE);
    const thresholds = parseThresholds(SHIPPED_THRESHOLDS);
    expect(thresholds.applies_to_fixture_id).toBe(fixture.fixture_id);
  });

  it("shipped precision threshold is achievable given the fixture's relevant density", () => {
    const fixture = parseLiveFixture(SHIPPED_FIXTURE);
    const thresholds = parseThresholds(SHIPPED_THRESHOLDS);
    // Best-case mean Precision@K = mean(relevant_count/top_k) must clear the bar,
    // otherwise the gate can never pass no matter how good retrieval is.
    const bestMeanPrecision =
      fixture.probes
        .map(
          (p) =>
            Math.min(
              p.relevant.filter((r) => r.grade > 0).length,
              thresholds.top_k,
            ) / thresholds.top_k,
        )
        .reduce((a, b) => a + b, 0) / fixture.probes.length;
    expect(bestMeanPrecision).toBeGreaterThanOrEqual(
      thresholds.thresholds.min_precision_at_k,
    );
  });

  it("rejects a probe that references an unknown relevant id", () => {
    expect(() =>
      parseLiveFixture({
        schema_version: 1,
        fixture_id: "bad",
        description: "",
        corpus: [
          {
            id: "a",
            table: "thoughts",
            namespace_role: "primary",
            content: "a",
            tags: [],
          },
        ],
        probes: [
          {
            id: "p",
            query: "q",
            relevant: [{ id: "missing", grade: 1 }],
            forbidden_ids: [],
          },
        ],
      }),
    ).toThrow(/unknown relevant id/);
  });

  it("rejects a forbidden id that is not a negative-role entry", () => {
    expect(() =>
      parseLiveFixture({
        schema_version: 1,
        fixture_id: "bad",
        description: "",
        corpus: [
          {
            id: "a",
            table: "thoughts",
            namespace_role: "primary",
            content: "a",
            tags: [],
          },
        ],
        probes: [{ id: "p", query: "q", relevant: [], forbidden_ids: ["a"] }],
      }),
    ).toThrow(/must be a negative-role entry/);
  });

  it("rejects duplicate corpus ids", () => {
    expect(() =>
      parseLiveFixture({
        schema_version: 1,
        fixture_id: "dup",
        description: "",
        corpus: [
          {
            id: "a",
            table: "thoughts",
            namespace_role: "primary",
            content: "a",
            tags: [],
          },
          {
            id: "a",
            table: "thoughts",
            namespace_role: "primary",
            content: "a2",
            tags: [],
          },
        ],
        probes: [
          {
            id: "p",
            query: "q",
            relevant: [{ id: "a", grade: 1 }],
            forbidden_ids: [],
          },
        ],
      }),
    ).toThrow(/duplicate corpus id/);
  });
});

describe("live config validation", () => {
  it("is disabled unless OPEN_BRAIN_LIVE_EVAL=1", () => {
    expect(liveEvalEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(
      liveEvalEnabled({ OPEN_BRAIN_LIVE_EVAL: "0" } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(liveEvalEnabled(BASE_ENV)).toBe(true);
  });

  it("throws when disabled", () => {
    expect(() => loadLiveConfig("run1", {} as NodeJS.ProcessEnv)).toThrow(
      /disabled/,
    );
  });

  it("requires base URL and token", () => {
    expect(() =>
      loadLiveConfig("run1", {
        OPEN_BRAIN_LIVE_EVAL: "1",
      } as NodeJS.ProcessEnv),
    ).toThrow(/BASE_URL/);
    expect(() =>
      loadLiveConfig("run1", {
        OPEN_BRAIN_LIVE_EVAL: "1",
        OPEN_BRAIN_LIVE_EVAL_BASE_URL: "http://127.0.0.1:3100",
      } as NodeJS.ProcessEnv),
    ).toThrow(/TOKEN/);
  });

  it("rejects a malformed base URL", () => {
    expect(() =>
      loadLiveConfig("run1", {
        ...BASE_ENV,
        OPEN_BRAIN_LIVE_EVAL_BASE_URL: "not a url",
      } as NodeJS.ProcessEnv),
    ).toThrow(/valid URL/);
  });

  it("rejects a negative token equal to the primary token when explicitly set", () => {
    expect(() =>
      loadLiveConfig("run1", {
        ...BASE_ENV,
        OPEN_BRAIN_LIVE_EVAL_NEGATIVE_TOKEN: "primary-token",
      } as NodeJS.ProcessEnv),
    ).toThrow(/must differ/);
  });

  it("defaults the negative token to the primary token (namespace binding is the isolation proof)", () => {
    const config = loadLiveConfig("run-n", BASE_ENV);
    // A real negative control is always available: same token, distinct
    // negative namespace. Token inequality is NOT required for isolation.
    expect(config.negativeToken).toBe("primary-token");
    expect(config.negativeTokenIsDistinct).toBe(false);
    expect(config.negativeNamespace).not.toBe(config.primaryNamespace);
  });

  it("accepts a distinct negative token and flags cross-token coverage", () => {
    const config = loadLiveConfig("run-n2", {
      ...BASE_ENV,
      OPEN_BRAIN_LIVE_EVAL_NEGATIVE_TOKEN: "other-token",
    } as NodeJS.ProcessEnv);
    expect(config.negativeToken).toBe("other-token");
    expect(config.negativeTokenIsDistinct).toBe(true);
  });

  it("rejects an invalid search mode and timeout", () => {
    expect(() =>
      loadLiveConfig("run1", {
        ...BASE_ENV,
        OPEN_BRAIN_LIVE_EVAL_SEARCH_MODE: "fuzzy",
      } as NodeJS.ProcessEnv),
    ).toThrow(/SEARCH_MODE/);
    expect(() =>
      loadLiveConfig("run1", {
        ...BASE_ENV,
        OPEN_BRAIN_LIVE_EVAL_TIMEOUT_MS: "-4",
      } as NodeJS.ProcessEnv),
    ).toThrow(/TIMEOUT_MS/);
  });

  it("derives a unique, isolated namespace pair per run id", () => {
    const a = runNamespaces("commit-abc-123");
    const b = runNamespaces("commit-xyz-999");
    expect(a.primary).not.toBe(b.primary);
    expect(a.negative).toBe(`${a.primary}-negative`);
    expect(a.primary).not.toBe(a.negative);
  });

  it("sanitizes unsafe characters in the run id", () => {
    const ns = runNamespaces("weird/../id name!");
    expect(ns.primary).toMatch(/^eval-live-recall-[a-zA-Z0-9_-]+$/);
  });

  it("builds a valid config with defaults", () => {
    const config = loadLiveConfig("run-7", BASE_ENV);
    expect(config.baseUrl).toBe("http://127.0.0.1:3100");
    expect(config.searchMode).toBe("hybrid");
    expect(config.timeoutMs).toBeGreaterThan(0);
    expect(config.negativeToken).toBe("primary-token");
    expect(config.negativeTokenIsDistinct).toBe(false);
    expect(config.primaryNamespace).toBe("eval-live-recall-run-7");
  });
});

describe("run id uniqueness (crypto/operator, deterministic namespaces)", () => {
  it("prefers an explicit operator run id for reproducibility", () => {
    const id = makeRunId({
      prefix: "commitpref",
      randomHex: "deadbeef",
      env: {
        OPEN_BRAIN_LIVE_EVAL_RUN_ID: "operator-run-42",
      } as NodeJS.ProcessEnv,
    });
    expect(id).toBe("operator-run-42");
  });

  it("combines prefix + random suffix so repeated same-commit runs never collide", () => {
    const a = makeRunId({
      prefix: "abc123",
      randomHex: "aaaa1111",
      env: {} as NodeJS.ProcessEnv,
    });
    const b = makeRunId({
      prefix: "abc123",
      randomHex: "bbbb2222",
      env: {} as NodeJS.ProcessEnv,
    });
    expect(a).toBe("abc123-aaaa1111");
    expect(b).toBe("abc123-bbbb2222");
    expect(a).not.toBe(b);
    // And the derived namespaces differ, so teardown never crosses runs.
    expect(runNamespaces(a).primary).not.toBe(runNamespaces(b).primary);
  });

  it("throws when neither an operator id nor a random suffix is available", () => {
    expect(() =>
      makeRunId({
        prefix: "abc",
        randomHex: "   ",
        env: {} as NodeJS.ProcessEnv,
      }),
    ).toThrow(/unique across runs/);
  });

  it("runNamespaces stays deterministic for a fixed run id", () => {
    // No Date.now/random inside the helper: same input -> same output.
    expect(runNamespaces("fixed-run")).toEqual(runNamespaces("fixed-run"));
  });
});
