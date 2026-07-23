// Tests for the issue #165 anti-skip guard (scripts/assert-db-tests-ran.ts).
// Synthetic JUnit fixtures cover the four regressions the guard must catch:
// silent skip, missing suite, failures, and — per the cross-model review —
// suites/testcases reporting errors="1" / <error> children, which the original
// guard false-passed.
import { describe, it, expect } from "bun:test";
import { evaluateJunit, REQUIRED_SUITES } from "./assert-db-tests-ran.ts";

function suiteXml(
  name: string,
  opts: {
    tests: number;
    failures?: number;
    errors?: number;
    skipped?: number;
    testcases?: string;
  },
): string {
  const { tests, failures = 0, errors = 0, skipped = 0 } = opts;
  const cases =
    opts.testcases ??
    Array.from(
      { length: tests },
      (_, i) => `<testcase name="case ${i}" classname="${name}" time="0.01" />`,
    ).join("\n");
  return (
    `<testsuite name="${name}" tests="${tests}" failures="${failures}" ` +
    `errors="${errors}" skipped="${skipped}" time="0.1">\n${cases}\n</testsuite>`
  );
}

function allSuitesGreen(): string {
  return REQUIRED_SUITES.map((s) =>
    suiteXml(s.name, { tests: s.minTests }),
  ).join("\n");
}

function wrap(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${inner}\n</testsuites>`;
}

describe("assert-db-tests-ran anti-skip guard", () => {
  it("passes when every required live-Postgres suite executed cleanly", () => {
    const result = evaluateJunit(wrap(allSuitesGreen()));
    expect(result.errors).toEqual([]);
    expect(result.executedLiveTestcases).toBe(27);
    expect(
      result.executedLiveTestcasesBySuite.get(
        "search_brain language-aware FTS ranking (live Postgres)",
      ),
    ).toBe(4);
    expect(
      result.executedLiveTestcasesBySuite.get(
        "language-aware FTS covers every migration-007 source field (live Postgres)",
      ),
    ).toBe(1);
    expect(
      result.executedLiveTestcasesBySuite.get(
        "declared source language selects the real search config via explicit request (live Postgres)",
      ),
    ).toBe(3);
  });

  it("fails when the language-aware FTS ranking suite is omitted", () => {
    const missingName =
      "search_brain language-aware FTS ranking (live Postgres)";
    const xml = wrap(
      REQUIRED_SUITES.filter((s) => s.name !== missingName)
        .map((s) => suiteXml(s.name, { tests: s.minTests }))
        .join("\n"),
    );
    const result = evaluateJunit(xml);
    expect(
      result.errors.some((e) => e.includes(`MISSING suite "${missingName}"`)),
    ).toBe(true);
  });

  it("fails when the all-table language parity suite is omitted", () => {
    const missingName =
      "language-aware FTS covers every migration-007 source field (live Postgres)";
    const xml = wrap(
      REQUIRED_SUITES.filter((s) => s.name !== missingName)
        .map((s) => suiteXml(s.name, { tests: s.minTests }))
        .join("\n"),
    );
    const result = evaluateJunit(xml);
    expect(
      result.errors.some((e) => e.includes(`MISSING suite "${missingName}"`)),
    ).toBe(true);
  });

  it("fails when the all-table language parity suite is skipped", () => {
    const skippedName =
      "language-aware FTS covers every migration-007 source field (live Postgres)";
    const suites = REQUIRED_SUITES.map((s) =>
      s.name === skippedName
        ? suiteXml(s.name, {
            tests: s.minTests,
            skipped: s.minTests,
            testcases: Array.from(
              { length: s.minTests },
              (_, i) =>
                `<testcase name="case ${i}" classname="${s.name}"><skipped /></testcase>`,
            ).join("\n"),
          })
        : suiteXml(s.name, { tests: s.minTests }),
    ).join("\n");
    const result = evaluateJunit(wrap(suites));
    expect(
      result.errors.some((e) =>
        e.includes(`SKIPPED tests in "${skippedName}"`),
      ),
    ).toBe(true);
  });

  it("fails when the declared-source language suite is skipped", () => {
    const skippedName =
      "declared source language selects the real search config via explicit request (live Postgres)";
    const suites = REQUIRED_SUITES.map((s) =>
      s.name === skippedName
        ? suiteXml(s.name, {
            tests: s.minTests,
            skipped: s.minTests,
            testcases: Array.from(
              { length: s.minTests },
              (_, i) =>
                `<testcase name="case ${i}" classname="${s.name}"><skipped /></testcase>`,
            ).join("\n"),
          })
        : suiteXml(s.name, { tests: s.minTests }),
    ).join("\n");
    const result = evaluateJunit(wrap(suites));
    expect(
      result.errors.some((e) =>
        e.includes(`SKIPPED tests in "${skippedName}"`),
      ),
    ).toBe(true);
  });

  it("fails when a required suite is missing entirely", () => {
    const xml = wrap(
      REQUIRED_SUITES.filter((s) => s.name !== "lane_upsert (live Postgres)")
        .map((s) => suiteXml(s.name, { tests: s.minTests }))
        .join("\n"),
    );
    const result = evaluateJunit(xml);
    expect(
      result.errors.some((e) =>
        e.includes('MISSING suite "lane_upsert (live Postgres)"'),
      ),
    ).toBe(true);
  });

  it("fails when a required suite reports skipped tests", () => {
    const suites = REQUIRED_SUITES.map((s) =>
      s.name === "tier_lane (live Postgres)"
        ? suiteXml(s.name, {
            tests: s.minTests,
            skipped: s.minTests,
            testcases: Array.from(
              { length: s.minTests },
              (_, i) =>
                `<testcase name="case ${i}" classname="${s.name}"><skipped /></testcase>`,
            ).join("\n"),
          })
        : suiteXml(s.name, { tests: s.minTests }),
    ).join("\n");
    const result = evaluateJunit(wrap(suites));
    expect(
      result.errors.some((e) =>
        e.includes('SKIPPED tests in "tier_lane (live Postgres)"'),
      ),
    ).toBe(true);
  });

  it("fails when a required suite reports failures", () => {
    const suites = REQUIRED_SUITES.map((s) =>
      s.name === "promote_shared (live Postgres)"
        ? suiteXml(s.name, { tests: s.minTests, failures: 1 })
        : suiteXml(s.name, { tests: s.minTests }),
    ).join("\n");
    const result = evaluateJunit(wrap(suites));
    expect(
      result.errors.some((e) =>
        e.includes('FAILURES in "promote_shared (live Postgres)"'),
      ),
    ).toBe(true);
  });

  it('fails when a required suite reports errors="1" (cross-model P3)', () => {
    const suites = REQUIRED_SUITES.map((s) =>
      s.name === "lane_upsert (live Postgres)"
        ? suiteXml(s.name, { tests: s.minTests, errors: 1 })
        : suiteXml(s.name, { tests: s.minTests }),
    ).join("\n");
    const result = evaluateJunit(wrap(suites));
    expect(
      result.errors.some((e) =>
        e.includes('ERRORS in "lane_upsert (live Postgres)": errors=1'),
      ),
    ).toBe(true);
  });

  it("fails when a live-Postgres testcase carries an <error> element", () => {
    const name = "append_session_event create_if_missing (live Postgres)";
    const suites = REQUIRED_SUITES.map((s) =>
      s.name === name
        ? suiteXml(s.name, {
            tests: s.minTests,
            testcases:
              `<testcase name="boom" classname="${name}"><error message="thrown" /></testcase>\n` +
              Array.from(
                { length: s.minTests - 1 },
                (_, i) => `<testcase name="case ${i}" classname="${name}" />`,
              ).join("\n"),
          })
        : suiteXml(s.name, { tests: s.minTests }),
    ).join("\n");
    const result = evaluateJunit(wrap(suites));
    expect(
      result.errors.some((e) => e.includes("carry an <error> element")),
    ).toBe(true);
  });

  it("fails when total executed live testcases fall below the floor", () => {
    // All suites present, but lane_upsert testcases are all skipped while its
    // suite attrs lie (tests counted, skipped attr zeroed) — the independent
    // testcase-level count still catches the shortfall.
    const name = "lane_upsert (live Postgres)";
    const suites = REQUIRED_SUITES.map((s) =>
      s.name === name
        ? suiteXml(s.name, {
            tests: s.minTests,
            testcases: Array.from(
              { length: s.minTests },
              (_, i) =>
                `<testcase name="case ${i}" classname="${name}"><skipped /></testcase>`,
            ).join("\n"),
          })
        : suiteXml(s.name, { tests: s.minTests }),
    ).join("\n");
    const result = evaluateJunit(wrap(suites));
    expect(
      result.errors.some((e) =>
        e.includes("live-Postgres testcases executed; expected at least"),
      ),
    ).toBe(true);
  });

  it("fails when one required suite has no executed testcases but the global floor is met", () => {
    const skippedName = "lane_upsert (live Postgres)";
    const extraName = "runSharedPromoter cursor-stall fix (live Postgres)";
    const suites = REQUIRED_SUITES.map((s) => {
      if (s.name === skippedName) {
        return suiteXml(s.name, {
          tests: s.minTests,
          testcases: Array.from(
            { length: s.minTests },
            (_, i) =>
              `<testcase name="case ${i}" classname="${s.name}"><skipped /></testcase>`,
          ).join("\n"),
        });
      }
      if (s.name === extraName) {
        return suiteXml(s.name, { tests: s.minTests + 2 });
      }
      return suiteXml(s.name, { tests: s.minTests });
    }).join("\n");

    const result = evaluateJunit(wrap(suites));
    expect(result.executedLiveTestcases).toBe(27);
    expect(
      result.errors.some((e) =>
        e.includes(
          `"${skippedName}" executed 0 non-skipped live-Postgres testcases`,
        ),
      ),
    ).toBe(true);
  });
});
