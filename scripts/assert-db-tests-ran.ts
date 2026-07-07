/**
 * Anti-skip guard for DB-backed integration tests (issue #165).
 *
 * The `dbDescribe`/`describe.skipIf` blocks that exercise the real Postgres SQL
 * write paths (lane_upsert, promote_shared, tier_lane, append_session_event,
 * runSharedPromoter) are env-gated on OPENBRAIN_TEST_DATABASE_URL. If the CI
 * Postgres is ever missing or misconfigured, those suites SILENTLY SKIP and the
 * job still goes green with ZERO coverage of the exact SQL paths that shipped
 * the #162 lane_upsert bugs.
 *
 * This guard parses the JUnit XML emitted by `bun test --reporter=junit` and
 * FAILS the job unless every required live-Postgres suite actually executed:
 *   - each required suite is present,
 *   - it ran at least its expected number of testcases,
 *   - none of its testcases were skipped,
 *   - none of its testcases failed or errored.
 *
 * Usage:
 *   bun test --reporter=junit --reporter-outfile=junit.xml
 *   bun run scripts/assert-db-tests-ran.ts junit.xml
 */

import { readFileSync } from "node:fs";

// Required live-Postgres suites and the minimum executed testcase count each
// must contribute. Counts are lower bounds: adding tests must not require
// touching this guard, but deleting/skipping them will trip it.
export const REQUIRED_SUITES: ReadonlyArray<{ name: string; minTests: number }> =
  [
    { name: "lane_upsert (live Postgres)", minTests: 2 },
    { name: "promote_shared (live Postgres)", minTests: 1 },
    { name: "tier_lane (live Postgres)", minTests: 2 },
    {
      name: "append_session_event create_if_missing (live Postgres)",
      minTests: 4,
    },
    { name: "runSharedPromoter cursor-stall fix (live Postgres)", minTests: 8 },
    {
      name: "search_brain relational retrieval eval fixture (live Postgres)",
      minTests: 1,
    },
  ];

// Absolute floor on total executed (non-skipped) live-Postgres testcases,
// independent of the per-suite breakdown above.
export const MIN_TOTAL_LIVE_TESTCASES = 18;

export interface SuiteStats {
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
}

export interface GuardResult {
  errors: string[];
  executedLiveTestcases: number;
  executedLiveTestcasesBySuite: Map<string, number>;
  suiteStats: Map<string, SuiteStats>;
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : undefined;
}

export function evaluateJunit(xml: string): GuardResult {
  // Collect per-suite stats from <testsuite ...> opening tags.
  const suiteStats = new Map<string, SuiteStats>();
  for (const tag of xml.match(/<testsuite\b[^>]*>/g) ?? []) {
    const name = attr(tag, "name");
    if (!name || !name.includes("(live Postgres)")) continue;
    const prev = suiteStats.get(name) ?? {
      tests: 0,
      failures: 0,
      errors: 0,
      skipped: 0,
    };
    suiteStats.set(name, {
      tests: prev.tests + Number(attr(tag, "tests") ?? "0"),
      failures: prev.failures + Number(attr(tag, "failures") ?? "0"),
      errors: prev.errors + Number(attr(tag, "errors") ?? "0"),
      skipped: prev.skipped + Number(attr(tag, "skipped") ?? "0"),
    });
  }

  // Inspect individual live-Postgres <testcase> blocks as an independent
  // cross-check on the suite-level attributes. A skipped testcase carries a
  // <skipped .../> child or skipped="true"; an errored one carries an
  // <error .../> child.
  let executedLiveTestcases = 0;
  let erroredLiveTestcases = 0;
  const executedLiveTestcasesBySuite = new Map<string, number>();
  const testcaseRe = /<testcase\b[^>]*?(\/>|>[\s\S]*?<\/testcase>)/g;
  for (const block of xml.match(testcaseRe) ?? []) {
    const open = block.match(/<testcase\b[^>]*>/)?.[0] ?? block;
    const classname = attr(open, "classname") ?? "";
    if (!classname.includes("(live Postgres)")) continue;
    const isSkipped =
      /<skipped\b/.test(block) || attr(open, "skipped") === "true";
    if (isSkipped) continue;
    executedLiveTestcases += 1;
    executedLiveTestcasesBySuite.set(
      classname,
      (executedLiveTestcasesBySuite.get(classname) ?? 0) + 1,
    );
    if (/<error\b/.test(block)) erroredLiveTestcases += 1;
  }

  const errors: string[] = [];

  for (const req of REQUIRED_SUITES) {
    const s = suiteStats.get(req.name);
    if (!s) {
      errors.push(
        `MISSING suite "${req.name}" — it did not run at all (SKIPPED or ` +
          `never registered). The CI Postgres / OPENBRAIN_TEST_DATABASE_URL ` +
          `is not wired correctly.`,
      );
      continue;
    }
    if (s.skipped > 0) {
      errors.push(
        `SKIPPED tests in "${req.name}": skipped=${s.skipped}. DB-backed ` +
          `coverage was silently disabled.`,
      );
    }
    if (s.failures > 0) {
      errors.push(`FAILURES in "${req.name}": failures=${s.failures}.`);
    }
    if (s.errors > 0) {
      errors.push(`ERRORS in "${req.name}": errors=${s.errors}.`);
    }
    if (s.tests < req.minTests) {
      errors.push(
        `"${req.name}" ran ${s.tests} tests, expected at least ` +
          `${req.minTests}.`,
      );
    }
    const executed = executedLiveTestcasesBySuite.get(req.name) ?? 0;
    if (executed < req.minTests) {
      errors.push(
        `"${req.name}" executed ${executed} non-skipped live-Postgres ` +
          `testcases, expected at least ${req.minTests}.`,
      );
    }
  }

  if (erroredLiveTestcases > 0) {
    errors.push(
      `${erroredLiveTestcases} live-Postgres testcase(s) carry an <error> ` +
        `element — errored tests are failures, not coverage.`,
    );
  }

  if (executedLiveTestcases < MIN_TOTAL_LIVE_TESTCASES) {
    errors.push(
      `Only ${executedLiveTestcases} live-Postgres testcases executed; ` +
        `expected at least ${MIN_TOTAL_LIVE_TESTCASES}. DB-backed suites are ` +
        `being skipped.`,
    );
  }

  return {
    errors,
    executedLiveTestcases,
    executedLiveTestcasesBySuite,
    suiteStats,
  };
}

function main(): void {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: assert-db-tests-ran.ts <junit.xml>");
    process.exit(2);
  }

  let xml: string;
  try {
    xml = readFileSync(path, "utf8");
  } catch (err) {
    console.error(
      `anti-skip guard: could not read JUnit report at ${path}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    process.exit(2);
  }

  const result = evaluateJunit(xml);

  if (result.errors.length > 0) {
    console.error("anti-skip guard FAILED (issue #165):");
    for (const e of result.errors) console.error(`  - ${e}`);
    console.error(
      "\nThe DB-backed integration tests must RUN against a real pgvector " +
        "Postgres in CI. A silent skip is a coverage regression, not a pass.",
    );
    process.exit(1);
  }

  console.log(
    `anti-skip guard PASSED: ${result.executedLiveTestcases} live-Postgres ` +
      `testcases executed across ${REQUIRED_SUITES.length} required suites ` +
      `(0 skipped, 0 failed, 0 errored).`,
  );
  for (const req of REQUIRED_SUITES) {
    const s = result.suiteStats.get(req.name)!;
    console.log(`  - ${req.name}: ${s.tests} tests`);
  }
}

if (import.meta.main) {
  main();
}
