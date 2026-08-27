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
export const REQUIRED_SUITES: ReadonlyArray<{
  name: string;
  minTests: number;
}> = [
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
    minTests: 2,
  },
  {
    name: "search_brain language-aware FTS ranking (live Postgres)",
    minTests: 4,
  },
  {
    name: "language-aware FTS covers every migration-007 source field (live Postgres)",
    minTests: 1,
  },
  {
    name: "declared source language selects the real search config via explicit request (live Postgres)",
    minTests: 3,
  },
  { name: "local clone real PostgreSQL boundary (live Postgres)", minTests: 1 },
  // Migration 025 in-place normalization (#878). Env-gated like every suite
  // above and never registered here, so a Postgres misconfiguration silently
  // skipped both proofs: that the migration converges the accepted shapes, and
  // that it leaves every rejected one byte-for-byte unchanged. Split by subject
  // in #878, so both halves are named here -- registering one would let the
  // other vanish unnoticed.
  {
    name: "025 normalize legacy Development lanes (live Postgres)",
    minTests: 1,
  },
  {
    name: "025 leaves unrecognized lane shapes unchanged (live Postgres)",
    minTests: 1,
  },
  {
    name: "server ID queries enforce namespace isolation (live Postgres)",
    minTests: 4,
  },
  // The charter Phase 5 real-SDK protocol proof. Registered here for the same
  // reason as every suite above: it is env-gated on OPENBRAIN_TEST_DATABASE_URL,
  // so without this entry a CI Postgres misconfiguration would silently skip the
  // ONE suite that proves the rewrite answers the real MCP protocol over real
  // HTTP -- and the job would stay green while proving nothing.
  {
    name: "rewrite candidate over the real MCP SDK and real HTTP transport (live Postgres)",
    minTests: 12,
  },
  // Skill/canon usage telemetry (#469). Registered for the same reason as every
  // suite above: it is env-gated on OPENBRAIN_TEST_DATABASE_URL, so without this
  // entry a CI Postgres misconfiguration would silently skip the ONE suite that
  // proves usage rows are saved, queryable, and -- most importantly -- invisible
  // across the namespace boundary. `skill_usage_log` has no namespace column, so
  // that boundary lives entirely in a join this suite is what checks.
  // Split by subject in #878 out of one "skill usage telemetry" suite; the two
  // halves together cover exactly what that one entry did, so both are named
  // here. Registering only one would let the other vanish unnoticed.
  { name: "skill usage recording and reporting (live Postgres)", minTests: 4 },
  {
    name: "skill usage isolation and permissions (live Postgres)",
    minTests: 5,
  },
  // The source registry's revision, approval, isolation, and retirement paths,
  // split by subject in #878 out of one "source registry lifecycle" suite.
  // Env-gated like every suite above, and never registered here before, so a
  // Postgres misconfiguration silently skipped all eight of these.
  {
    name: "source registry revision and approval (live Postgres)",
    minTests: 5,
  },
  {
    name: "source registry isolation and retirement (live Postgres)",
    minTests: 3,
  },
  // The maintenance queue runner's lease boundary, proven through the composed
  // `server/` runtime. This entry matters more than most: both invariants it
  // covers fail SILENTLY -- a row sits `running` under a live lease with no
  // handler, nothing throws, and nothing is logged -- so a skipped run and a
  // passing run look identical from the outside. That is precisely the shape
  // this guard exists for.
  { name: "maintenance runtime lease boundary (live Postgres)", minTests: 5 },
  // The rewrite's real process entrypoint (`server/main.ts`), charter Phase 5.
  // Registered for the strongest version of this guard's reason: these are the
  // ONLY suites that start the entrypoint as a process -- real config parse,
  // real pool, real migrations, real token map, real audit installation, real
  // listener -- so a silently skipped run reports a green build for a startup
  // path nothing ever executed. Every other `server/` suite hand-assembles the
  // application and would stay green with a completely broken `startServer`.
  // #878 split the start-equivalence suite by subject: the audit and runtime
  // composition tests moved into their own suite, so start-equivalence itself
  // now runs 3 rather than 8. Both halves are named here for the reason above.
  { name: "rewrite entrypoint start-equivalence (live Postgres)", minTests: 3 },
  {
    name: "rewrite entrypoint audit and runtime composition (live Postgres)",
    minTests: 2,
  },
  {
    name: "rewrite entrypoint startup and shutdown ordering (live Postgres)",
    minTests: 3,
  },
  // Migration 028's upgrade-path repair (#878). The defect it covers exists
  // ONLY on a database upgraded across an earlier revision of 026, so a fresh
  // schema proves nothing and a skipped run proves less: the queue's
  // dead-letter category would be rejected in production while CI stayed
  // green. Registered here so the run is proven, not assumed.
  {
    name: "028 maintenance_jobs lease_expired compat (live Postgres)",
    minTests: 3,
  },
];

// Absolute floor on total executed (non-skipped) live-Postgres testcases,
// independent of the per-suite breakdown above. Tracks the sum of the
// `minTests` values above (32 before the Phase 5 real-SDK protocol suite added
// its 8, then 12 once that suite also covered the realtime append tools and the
// two-worker front, then 44 -> 53 when the #469 skill-usage telemetry suite
// added its 9, then 53 -> 58 when the maintenance lease-boundary suite added
// its 5, then 58 -> 65 when the two entrypoint suites added their 5 and 2, then
// 65 -> 74 when #878 registered the two source-registry suites (8) and the
// entrypoint split redistributed its own tests to 3 + 2 + 3, then 74 -> 77 when
// #878 registered the migration 028 lease_expired compat suite's 3, then
// 77 -> 79 when #878 registered the two migration-025 suites at 1 each), so the
// global floor cannot silently fall behind the per-suite one.
export const MIN_TOTAL_LIVE_TESTCASES = 79;

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

// Collect per-suite stats from <testsuite ...> opening tags.
function collectSuiteStats(xml: string): Map<string, SuiteStats> {
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
  return suiteStats;
}

interface TestcaseTally {
  executedLiveTestcases: number;
  erroredLiveTestcases: number;
  executedLiveTestcasesBySuite: Map<string, number>;
}

// Inspect individual live-Postgres <testcase> blocks as an independent
// cross-check on the suite-level attributes. A skipped testcase carries a
// <skipped .../> child or skipped="true"; an errored one carries an
// <error .../> child.
// The suite name of one <testcase> block when it is a live-Postgres case that
// actually executed, and undefined for every other block.
function executedLiveSuiteName(block: string): string | undefined {
  const open = block.match(/<testcase\b[^>]*>/)?.[0] ?? block;
  const classname = attr(open, "classname") ?? "";
  if (!classname.includes("(live Postgres)")) return undefined;
  const isSkipped =
    /<skipped\b/.test(block) || attr(open, "skipped") === "true";
  return isSkipped ? undefined : classname;
}

function tallyTestcases(xml: string): TestcaseTally {
  let executedLiveTestcases = 0;
  let erroredLiveTestcases = 0;
  const executedLiveTestcasesBySuite = new Map<string, number>();
  const testcaseRe = /<testcase\b[^>]*?(\/>|>[\s\S]*?<\/testcase>)/g;
  for (const block of xml.match(testcaseRe) ?? []) {
    const classname = executedLiveSuiteName(block);
    if (classname === undefined) continue;
    executedLiveTestcases += 1;
    executedLiveTestcasesBySuite.set(
      classname,
      (executedLiveTestcasesBySuite.get(classname) ?? 0) + 1,
    );
    if (/<error\b/.test(block)) erroredLiveTestcases += 1;
  }
  return {
    executedLiveTestcases,
    erroredLiveTestcases,
    executedLiveTestcasesBySuite,
  };
}

// Every way one required suite can fail the guard, as error strings.
function checkRequiredSuite(
  req: { name: string; minTests: number },
  suiteStats: Map<string, SuiteStats>,
  executedLiveTestcasesBySuite: Map<string, number>,
): string[] {
  const errors: string[] = [];
  {
    const s = suiteStats.get(req.name);
    if (!s) {
      errors.push(
        `MISSING suite "${req.name}" — it did not run at all (SKIPPED or ` +
          `never registered). The CI Postgres / OPENBRAIN_TEST_DATABASE_URL ` +
          `is not wired correctly.`,
      );
      return errors;
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
  return errors;
}

export function evaluateJunit(xml: string): GuardResult {
  const suiteStats = collectSuiteStats(xml);
  const {
    executedLiveTestcases,
    erroredLiveTestcases,
    executedLiveTestcasesBySuite,
  } = tallyTestcases(xml);

  const errors: string[] = [];

  for (const req of REQUIRED_SUITES) {
    errors.push(
      ...checkRequiredSuite(req, suiteStats, executedLiveTestcasesBySuite),
    );
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
    const s = result.suiteStats.get(req.name);
    console.log(`  - ${req.name}: ${s?.tests ?? 0} tests`);
  }
}

if (import.meta.main) {
  main();
}
