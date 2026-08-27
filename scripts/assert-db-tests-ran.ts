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
  {
    name: "029 maintenance_jobs terminal category compat (live Postgres)",
    minTests: 3,
  },
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
  // The cross-provider parity fixtures (#878). Every recorded tool response for
  // both providers is replayed here, so this is the single suite that proves the
  // two implementations still answer identically. It was env-gated and never
  // registered, which meant a Postgres misconfiguration skipped all 75 of those
  // comparisons and the job stayed green having compared nothing.
  {
    name: "server parity fixtures by implemented provider capability (live Postgres)",
    minTests: 75,
  },
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
  // The #297 negative matrix against real Postgres (#878). Converted from an
  // env-gated self-skip, so it is registered here for the same reason as every
  // suite above: it is the only proof that the namespace predicate is evaluated
  // by Postgres itself, and its allow half is what keeps the deny half from
  // being vacuous.
  {
    name: "#297 namespace isolation negative matrix (live Postgres)",
    minTests: 2,
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
  // decompose_entry against a real database (#878). One suite split by subject
  // into three: planning that must not write, apply that must, and the
  // duplicate classification only a real transaction can distinguish. It read
  // the environment itself and skipped when it was unset, so it was never
  // registered here and a Postgres misconfiguration silently skipped all five.
  {
    name: "decompose_entry planning writes nothing (live Postgres)",
    minTests: 2,
  },
  {
    name: "decompose_entry apply writes replacements (live Postgres)",
    minTests: 1,
  },
  {
    name: "decompose_entry duplicate classification (live Postgres)",
    minTests: 2,
  },
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
  // The issue #337 tag-clobber regression, which shares migration 027's file
  // and its database. It was never registered here, so a Postgres
  // misconfiguration skipped it silently -- and a lost tag is exactly the kind
  // of defect that leaves no trace at the exit code.
  {
    name: "backgroundExtract tag merge against live row (live Postgres)",
    minTests: 2,
  },
  // The maintenance queue runner's lease boundary, proven through the composed
  // `server/` runtime. These entries matter more than most: the invariants they
  // cover fail SILENTLY -- a row sits `running` under a live lease with no
  // handler, nothing throws, and nothing is logged -- so a skipped run and a
  // passing run look identical from the outside. That is precisely the shape
  // this guard exists for.
  //
  // #889 split the single lease-boundary suite by subject, so the one entry
  // that stood here became the four below. Each is named separately on purpose:
  // a single entry covering all six tests would stay satisfied if an entire
  // subject stopped running, as long as the others made up the count.
  {
    name: "maintenance runtime shutdown drain (live Postgres)",
    minTests: 2,
  },
  {
    name: "maintenance runtime lease expiry (live Postgres)",
    minTests: 1,
  },
  {
    name: "maintenance runtime failure classification (live Postgres)",
    minTests: 1,
  },
  {
    name: "maintenance runtime composition (live Postgres)",
    minTests: 2,
  },
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
  // from a permanent all-status UNIQUE constraint to a running-only partial
  // index. Registered because the upgrade path it repairs exists only in
  // Postgres: the suite rewinds a real schema to the legacy shape and proves
  // the converged one, which no text assertion over the SQL can do.
  {
    name: "031 ob_source_sync_runs running-only uniqueness compat (live Postgres)",
    minTests: 6,
  },
  // Migration 032's raw-turn structural guarantees, split by subject over one
  // shared fixture. Registered by #878 when the suite stopped skipping itself
  // without a database, so a vanished raw-turn constraint fails the run rather
  // than reporting a silent zero.
  { name: "032 raw turns role contract (live Postgres)", minTests: 2 },
  { name: "032 raw turns identity (live Postgres)", minTests: 4 },
  { name: "032 raw turns conversation thread (live Postgres)", minTests: 4 },
  {
    name: "032 raw turns retention and provenance (live Postgres)",
    minTests: 7,
  },
  // Migrations 038/039. The CHECK constraints, the dedupe unique index, and the
  // ON DELETE CASCADE are database guarantees a fake cannot enforce, so an
  // unnoticed non-run here means nothing is proving them. The file's suites are
  // FLAT for this guard's sake: its testcase-level cross-check keys on the JUnit
  // `classname`, which for a nested suite carries the inner name only, so a
  // wrapping describe would register here as a suite that executed nothing and
  // fail even on a fully green run. All four are named; registering a subset
  // would let the rest vanish unnoticed.
  {
    name:
      "the operator queue is enforced by the database, not by convention " +
      "(live Postgres)",
    minTests: 6,
  },
  { name: "039 said-at timestamps (live Postgres)", minTests: 4 },
  { name: "038 candidate_reinforcement writes (live Postgres)", minTests: 5 },
  {
    name: "038 candidate_reinforcement lifecycle (live Postgres)",
    minTests: 4,
  },
  // The 001_init schema proof (#878). It reads the catalog back after the
  // migration runs, so it is the only place a halfvec column that came back as
  // a plain vector, or an HNSW index built with `vector_cosine_ops`, is caught
  // at all -- and a schema defect is exactly the kind that stays invisible
  // until data has already been written against it. Registered as six suites
  // because the file is six independent subjects over one shared schema; naming
  // only some of them would let the rest vanish unnoticed.
  { name: "001_init table existence (live Postgres)", minTests: 2 },
  { name: "001_init embedding columns (live Postgres)", minTests: 5 },
  { name: "001_init indexes (live Postgres)", minTests: 2 },
  { name: "001_init projects table schema (live Postgres)", minTests: 2 },
  { name: "001_init entity graph schema (live Postgres)", minTests: 4 },
  { name: "001_init vector round-trip (live Postgres)", minTests: 1 },
  // The bulk_set_tier live-Postgres proofs (#878). Previously env-gated and
  // never registered here, so a Postgres misconfiguration silently skipped the
  // ONE suite that proves the per-row write predicate actually excludes foreign
  // and archived rows -- the fake-pool suite cannot show that. Split by subject
  // in #878, so all three halves are named here; registering one would let the
  // others vanish unnoticed.
  {
    name: "bulk_set_tier write predicate reach (live Postgres)",
    minTests: 3,
  },
  { name: "bulk_set_tier reported counts (live Postgres)", minTests: 1 },
  {
    name: "bulk_set_tier transaction atomicity (live Postgres)",
    minTests: 3,
  },
  // list_stale, the dream planner's candidate query (#878). A fake pool hands
  // back a pre-sorted array, so the staleness cutoff, the COALESCE fallback,
  // and the ordering are all supplied by the fixture rather than computed --
  // only these live suites exercise the query itself. Registered as three
  // subject-split entries: threshold, ordering, scoping.
  {
    name: "list_stale staleness threshold (live Postgres)",
    minTests: 2,
  },
  { name: "list_stale result ordering (live Postgres)", minTests: 1 },
  { name: "list_stale scoping predicates (live Postgres)", minTests: 3 },
  // The exact-scope checkpoint lifecycle (#878). The lane row, its metadata,
  // and the predicate that rejects a hostile scope claim on an owned session
  // key exist only in Postgres, so a skipped run leaves the isolation half of
  // `session_start`/`session_wrap` entirely unexercised while CI reports green.
  // Registered here as that suite stopped skipping itself.
  {
    name: "exact-scope checkpoint lifecycle (live Postgres)",
    minTests: 2,
  },
  // The maintenance sweep idempotency suite, registered by #878 when it stopped
  // skipping itself without a database. Its one testcase drives the
  // UNIQUE(job_kind, idempotency_key) conflict path, which exists only in
  // Postgres and reported a silent zero before.
  { name: "maintenance sweep idempotency (live Postgres)", minTests: 1 },
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
// 77 -> 79 when #878 registered the two migration-025 suites at 1 each, then
// 79 -> 80 when #889 split the maintenance lease-boundary suite by subject and
// its single entry of 5 became four entries summing to 6, then 80 -> 83 when
// #878 registered the migration 029 terminal-category compat suite's 3 as that
// suite stopped skipping itself, then 83 -> 85 when #878 also registered the
// backgroundExtract tag-merge suite that shares migration 027's file and had
// never been named here, then 85 -> 91 when #878 registered the migration 031
// upgrade-path suite and its 6, then 91 -> 108 when #878 registered the four
// migration 032 raw-turns suites' 2 + 4 + 4 + 7, then 108 -> 127 when #878
// registered the migrations 038/039 reinforcement + said-at file's four
// flattened suites at 6 + 4 + 5 + 4, then 127 -> 143 when #878 converted the
// 001_init schema proof and registered its six suites' 16, then 143 -> 218 when
// #878 registered the cross-provider parity suite's 75, then 218 -> 223 when
// #878 registered the three decompose_entry suites (2 + 1 + 2) as that file
// stopped skipping itself, then 223 -> 230 when #878 registered the three
// bulk_set_tier suites (3 + 1 + 3) as that file stopped skipping itself, then
// 230 -> 236 when #878 registered the three subject-split list_stale suites
// (2 + 1 + 3) as that file stopped skipping itself, then 236 -> 238 when
// #878 registered the exact-scope checkpoint lifecycle suite's 2 as it too
// stopped skipping itself, then 238 -> 240 when #878 registered the #297
// namespace isolation negative matrix suite's 2 as that suite stopped skipping
// itself, then 240 -> 241 when #878 registered the maintenance sweep
// idempotency suite's 1), so the global floor cannot silently fall behind
// the per-suite one.
export const MIN_TOTAL_LIVE_TESTCASES = 241;

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
