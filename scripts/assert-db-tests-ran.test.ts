// Tests for the issue #165 anti-skip guard (scripts/assert-db-tests-ran.ts).
// Synthetic JUnit fixtures cover the four regressions the guard must catch:
// silent skip, missing suite, failures, and — per the cross-model review —
// suites/testcases reporting errors="1" / <error> children, which the original
// guard false-passed.
import { describe, it, expect } from "vitest";
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
  return REQUIRED_SUITES.map((s) => suiteXml(s.name, { tests: s.minTests })).join("\n");
}

function wrap(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${inner}\n</testsuites>`;
}

function allSuitesGreenVitest(): string {
  const cases = REQUIRED_SUITES.flatMap((suite) =>
    Array.from(
      { length: suite.minTests },
      (_, index) =>
        `<testcase classname="server/example.pg.test.ts" ` +
        `name="${suite.name} &gt; case ${index}" />`,
    ),
  ).join("\n");
  return wrap(
    `<testsuite name="server/example.pg.test.ts" tests="${ALL_GREEN_TOTAL}" ` +
      `failures="0" errors="0" skipped="0">${cases}</testsuite>`,
  );
}

/** `<testcase>` elements for `count` cases, each carrying `<skipped />`. */
function skippedCases(name: string, count: number): string {
  return Array.from(
    { length: count },
    (_, i) => `<testcase name="case ${i}" classname="${name}"><skipped /></testcase>`,
  ).join("\n");
}

/**
 * An all-green report with one suite swapped for `replacement`.
 *
 * Every fixture below is "all suites green except this one, which misbehaves",
 * so building it here keeps each test to its own subject and keeps the
 * `REQUIRED_SUITES.map` callback out of the test bodies.
 */
function greenExcept(
  name: string,
  replacement: (suite: (typeof REQUIRED_SUITES)[number]) => string,
): string {
  return REQUIRED_SUITES.map((s) =>
    s.name === name ? replacement(s) : suiteXml(s.name, { tests: s.minTests }),
  ).join("\n");
}

/** An all-green report with one suite omitted entirely. */
function greenWithout(name: string): string {
  return REQUIRED_SUITES.filter((s) => s.name !== name)
    .map((s) => suiteXml(s.name, { tests: s.minTests }))
    .join("\n");
}

/**
 * An all-green report where one suite carries an `<error>` child on its first
 * testcase and clean cases for the rest.
 */
function greenWithErrorElement(name: string): string {
  return greenExcept(name, (s) =>
    suiteXml(s.name, {
      tests: s.minTests,
      testcases:
        `<testcase name="boom" classname="${name}"><error message="thrown" /></testcase>\n` +
        cleanCases(name, s.minTests - 1),
    }),
  );
}

/** `<testcase>` elements for `count` cases, each reporting no problem. */
function cleanCases(name: string, count: number): string {
  return Array.from(
    { length: count },
    (_, i) => `<testcase name="case ${i}" classname="${name}" />`,
  ).join("\n");
}

/**
 * An all-green report where `skippedName` executes nothing and `paddedName`
 * absorbs exactly what it withheld.
 *
 * The padding is derived from the table rather than written as a literal, so it
 * silently stops being the right amount if either suite's `minTests` changes.
 * The point is that the global total is untouched, which is what lets a test
 * prove the per-suite check trips even when the floor alone is satisfied.
 */
function greenWithSkipPaddedElsewhere(skippedName: string, paddedName: string): string {
  const withheld = REQUIRED_SUITES.find((s) => s.name === skippedName)?.minTests ?? 0;
  return REQUIRED_SUITES.map((s) => {
    if (s.name === skippedName) {
      return suiteXml(s.name, {
        tests: s.minTests,
        testcases: skippedCases(s.name, s.minTests),
      });
    }
    if (s.name === paddedName) {
      return suiteXml(s.name, { tests: s.minTests + withheld });
    }
    return suiteXml(s.name, { tests: s.minTests });
  }).join("\n");
}

/** An all-green report with one suite present but reporting only skips. */
function greenWithSkipped(name: string, alsoZeroSkippedAttr = false): string {
  return greenExcept(name, (s) =>
    suiteXml(s.name, {
      tests: s.minTests,
      skipped: alsoZeroSkippedAttr ? 0 : s.minTests,
      testcases: skippedCases(s.name, s.minTests),
    }),
  );
}

/**
 * The total an all-green run contributes, derived rather than hardcoded.
 *
 * This was the literal `32`, which meant every addition to `REQUIRED_SUITES`
 * failed this file for a reason that had nothing to do with the guard's
 * behavior -- the number was a restatement of the table, so the two could only
 * ever drift apart. Deriving it keeps the assertion meaningful (the guard really
 * does count every executed live testcase) while letting the table grow.
 */
const ALL_GREEN_TOTAL = REQUIRED_SUITES.reduce(
  (total, suite) => total + suite.minTests,
  0,
);

describe("assert-db-tests-ran anti-skip guard: presence and skips", () => {
  it("passes Vitest JUnit with file classnames and describe names on testcases", () => {
    const result = evaluateJunit(allSuitesGreenVitest());
    expect(result.errors).toEqual([]);
    expect(result.executedLiveTestcases).toBe(ALL_GREEN_TOTAL);
  });
  it("passes when every required live-Postgres suite executed cleanly", () => {
    const result = evaluateJunit(wrap(allSuitesGreen()));
    expect(result.errors).toEqual([]);
    expect(result.executedLiveTestcases).toBe(ALL_GREEN_TOTAL);
    expect(
      result.executedLiveTestcasesBySuite.get(
        "skill usage recording and reporting (live Postgres)",
      ),
    ).toBe(4);
    expect(
      result.executedLiveTestcasesBySuite.get(
        "local clone real PostgreSQL boundary (live Postgres)",
      ),
    ).toBe(1);
    expect(
      result.executedLiveTestcasesBySuite.get(
        "rewrite entrypoint start-equivalence (live Postgres)",
      ),
    ).toBe(3);
  });

  it("fails when the skill-usage recording suite is omitted", () => {
    const missingName = "skill usage recording and reporting (live Postgres)";
    const xml = wrap(greenWithout(missingName));
    const result = evaluateJunit(xml);
    expect(
      result.errors.some((e) => e.includes(`MISSING suite "${missingName}"`)),
    ).toBe(true);
  });

  it("fails when the local-clone boundary suite is omitted", () => {
    const missingName = "local clone real PostgreSQL boundary (live Postgres)";
    const xml = wrap(greenWithout(missingName));
    const result = evaluateJunit(xml);
    expect(
      result.errors.some((e) => e.includes(`MISSING suite "${missingName}"`)),
    ).toBe(true);
  });

  it("fails when the local-clone boundary suite is skipped", () => {
    const skippedName = "local clone real PostgreSQL boundary (live Postgres)";
    const suites = greenWithSkipped(skippedName);
    const result = evaluateJunit(wrap(suites));
    expect(
      result.errors.some((e) => e.includes(`SKIPPED tests in "${skippedName}"`)),
    ).toBe(true);
  });

  it("fails when the entrypoint start-equivalence suite is skipped", () => {
    const skippedName = "rewrite entrypoint start-equivalence (live Postgres)";
    const suites = greenWithSkipped(skippedName);
    const result = evaluateJunit(wrap(suites));
    expect(
      result.errors.some((e) => e.includes(`SKIPPED tests in "${skippedName}"`)),
    ).toBe(true);
  });

  it("fails when a required suite is missing entirely", () => {
    const xml = wrap(
      greenWithout("maintenance runtime shutdown drain (live Postgres)"),
    );
    const result = evaluateJunit(xml);
    expect(
      result.errors.some((e) =>
        e.includes(
          'MISSING suite "maintenance runtime shutdown drain (live Postgres)"',
        ),
      ),
    ).toBe(true);
  });

  it("fails when a required suite reports skipped tests", () => {
    const suites = greenWithSkipped(
      "deriveGraphFromMetadata duplicate source titles (live Postgres)",
    );
    const result = evaluateJunit(wrap(suites));
    expect(
      result.errors.some((e) =>
        e.includes(
          'SKIPPED tests in "deriveGraphFromMetadata duplicate source titles (live Postgres)"',
        ),
      ),
    ).toBe(true);
  });
});

describe("assert-db-tests-ran anti-skip guard: reported failures and counts", () => {
  it("fails when a required suite reports failures", () => {
    const suites = greenExcept(
      "maintenance runtime lease expiry (live Postgres)",
      (s) => suiteXml(s.name, { tests: s.minTests, failures: 1 }),
    );
    const result = evaluateJunit(wrap(suites));
    expect(
      result.errors.some((e) =>
        e.includes('FAILURES in "maintenance runtime lease expiry (live Postgres)"'),
      ),
    ).toBe(true);
  });

  it('fails when a required suite reports errors="1" (cross-model P3)', () => {
    const suites = greenExcept(
      "maintenance runtime shutdown drain (live Postgres)",
      (s) => suiteXml(s.name, { tests: s.minTests, errors: 1 }),
    );
    const result = evaluateJunit(wrap(suites));
    expect(
      result.errors.some((e) =>
        e.includes(
          'ERRORS in "maintenance runtime shutdown drain (live Postgres)": errors=1',
        ),
      ),
    ).toBe(true);
  });

  it("fails when a live-Postgres testcase carries an <error> element", () => {
    const name = "skill usage isolation and permissions (live Postgres)";
    const suites = greenWithErrorElement(name);
    const result = evaluateJunit(wrap(suites));
    expect(result.errors.some((e) => e.includes("carry an <error> element"))).toBe(
      true,
    );
  });

  it("fails when total executed live testcases fall below the floor", () => {
    // All suites present, but the shutdown-drain testcases are all skipped
    // while its suite attrs lie (tests counted, skipped attr zeroed) — the independent
    // testcase-level count still catches the shortfall.
    const name = "maintenance runtime shutdown drain (live Postgres)";
    const suites = greenWithSkipped(name, true);
    const result = evaluateJunit(wrap(suites));
    expect(
      result.errors.some((e) =>
        e.includes("live-Postgres testcases executed; expected at least"),
      ),
    ).toBe(true);
  });

  it("fails when one required suite has no executed testcases but the global floor is met", () => {
    const skippedName = "maintenance runtime shutdown drain (live Postgres)";
    const extraName = "runSharedPromoter cursor-stall fix (live Postgres)";
    const suites = greenWithSkipPaddedElsewhere(skippedName, extraName);

    const result = evaluateJunit(wrap(suites));
    // The padding adds back exactly what skipping the shutdown-drain suite
    // removed, so the global total is untouched -- which is the premise of this
    // test: the per-suite check must still trip even when the floor alone is
    // satisfied.
    expect(result.executedLiveTestcases).toBe(ALL_GREEN_TOTAL);
    expect(
      result.errors.some((e) =>
        e.includes(`"${skippedName}" executed 0 non-skipped live-Postgres testcases`),
      ),
    ).toBe(true);
  });
});

describe("assert-db-tests-ran anti-skip guard: required boundary suites", () => {
  it("fails when the required local-clone boundary suite is missing", () => {
    const name = "local clone real PostgreSQL boundary (live Postgres)";
    const xml = wrap(greenWithout(name));
    const result = evaluateJunit(xml);
    expect(result.errors).toContain(
      `MISSING suite "${name}" — it did not run at all (SKIPPED or never registered). The CI Postgres / OPENBRAIN_TEST_DATABASE_URL is not wired correctly.`,
    );
  });

  it("fails when the required local-clone boundary suite is skipped", () => {
    const name = "local clone real PostgreSQL boundary (live Postgres)";
    const suites = greenExcept(name, (suite) =>
      suiteXml(name, {
        tests: suite.minTests,
        skipped: suite.minTests,
        testcases: `<testcase name="boundary" classname="${name}"><skipped /></testcase>`,
      }),
    );
    const result = evaluateJunit(wrap(suites));
    expect(
      result.errors.some((error) => error.includes(`SKIPPED tests in "${name}"`)),
    ).toBe(true);
  });

  it("fails when the server foundation boundary suite is missing", () => {
    const name = "server ID queries enforce namespace isolation (live Postgres)";
    const xml = wrap(greenWithout(name));
    const result = evaluateJunit(xml);
    expect(
      result.errors.some((error) => error.includes(`MISSING suite "${name}"`)),
    ).toBe(true);
  });

  it("fails when the server foundation boundary suite is skipped", () => {
    const name = "server ID queries enforce namespace isolation (live Postgres)";
    const suites = greenWithSkipped(name);
    const result = evaluateJunit(wrap(suites));
    expect(
      result.errors.some((error) => error.includes(`SKIPPED tests in "${name}"`)),
    ).toBe(true);
  });
});
