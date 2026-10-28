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
 * This guard parses the JUnit XML emitted by Vitest's JUnit reporter and
 * FAILS the job unless every required live-Postgres suite actually executed:
 *   - each required suite is present,
 *   - it ran at least its expected number of testcases,
 *   - none of its testcases were skipped,
 *   - none of its testcases failed or errored.
 *
 * Usage:
 *   npm test -- --reporter=junit --outputFile=junit.xml
 *   node scripts/assert-db-tests-ran.ts junit.xml
 */

import { readFileSync } from "node:fs";

// Required live-Postgres suites and the minimum executed testcase count each
// must contribute. Counts are lower bounds: adding tests must not require
// touching this guard, but deleting/skipping them will trip it.
export const REQUIRED_SUITES: ReadonlyArray<{
  name: string;
  minTests: number;
}> = [
  { name: "runSharedPromoter cursor-stall fix (live Postgres)", minTests: 1 },
  {
    name: "runSharedPromoter clustering and cursor loops (live Postgres)",
    minTests: 8,
  },
  { name: "local clone real PostgreSQL boundary (live Postgres)", minTests: 1 },
  {
    name: "retire-collab-migration scratch Postgres real migrations (live Postgres)",
    minTests: 6,
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
    minTests: 10,
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
  // The #346 graph-derivation regressions, proven against the real partial-unique
  // indexes rather than the in-memory FakeGraph. Registered by #878 when the file
  // stopped skipping itself without a database.
  {
    name: "deriveGraphFromMetadata anchor rename (live Postgres)",
    minTests: 1,
  },
  {
    name: "deriveGraphFromMetadata duplicate source titles (live Postgres)",
    minTests: 2,
  },
  {
    name: "deriveGraphFromMetadata stale-edge prune (live Postgres)",
    minTests: 1,
  },
  // The live backup/restore drill was split into a full-run half and a
  // snapshot/refusals/upgrade half (#878, #938) as that file stopped skipping
  // itself, so both halves are named here; registering one would let the other
  // vanish unnoticed.
  {
    name: "backup restore drill full run (live Postgres)",
    minTests: 3,
  },
  {
    name: "backup restore drill snapshot, refusals, and upgrade (live Postgres)",
    minTests: 5,
  },
  {
    name: "session_wrap exact-scope checkpoint validation (live Postgres)",
    minTests: 4,
  },
  // The first suite of issue #1054's rebuilt server/ program (issue 831):
  // session_save's write path proven against the stored row rather than the
  // response envelope. Registered here for the usual reason — it is env-gated
  // on OPENBRAIN_TEST_DATABASE_URL, and its namespace-isolation test is the
  // kind that fails silently when skipped.
  {
    name: "session_save writes the row it claims (live Postgres)",
    minTests: 4,
  },
  // The restored `entry_access_log` writers (issue 1486). The log went quiet
  // for six weeks with nothing failing, because the only thing that notices a
  // missing write is a test that reads the log back. Skipped, these two report
  // nothing and the tiering promotion scan goes blind again unnoticed.
  {
    name: "entry_access_log writer (live Postgres)",
    minTests: 2,
  },
  // The server/db transaction owner (issue 1209). Registered here because its
  // third test is the one only a real connection can produce: a backend killed
  // mid-transaction, so the ROLLBACK itself fails. Skipped, that path reports
  // nothing, and the rollback-failure hook the four maintenance sites depend on
  // would go unproven while the job stayed green.
  {
    name: "server/db withTransaction against real Postgres (live Postgres)",
    minTests: 3,
  },
  // The three OPTIONAL shapes withTransaction grew for the tools-tier ports
  // (issue 1209), in a sibling file because four more cases in the suite above
  // exceed oxlint's max-lines-per-function. Registered for the same reason as
  // its sibling and then some: every assertion here is the SERVER's behavior --
  // a refused write in a READ ONLY transaction, a statement cancelled by
  // statement_timeout, and whether set_config was transaction-local. Skipped,
  // all three report nothing and the two tools ports would build on unproven
  // ground.
  {
    name: "server/db withTransaction options against real Postgres (live Postgres)",
    minTests: 4,
  },
  // `update_entry`'s early-return guards after the port onto withTransaction
  // (issue 1209). Registered because these three are the ONLY assertions on
  // those refusal strings: the guards used to hand-roll a mid-transaction
  // ROLLBACK-and-return and now call `control.abort`, and skipped, a guard that
  // silently stopped answering would leave the job green.
  {
    name: "update_entry early-return guards (live Postgres)",
    minTests: 3,
  },
  // `citation_recall`'s neighbor split after the port onto
  // selectCitationNeighbors (issue 1209). Registered because these two are the
  // ONLY assertions on which side each neighbor lands: the two statements used
  // to differ by a hand-written comparison operator and ORDER BY, and the port
  // collapsed them into one method parameterized by side. Skipped, a swapped
  // operator reports nothing and the job stays green.
  {
    name: "citation_recall neighbor split (live Postgres)",
    minTests: 2,
  },
  // The recall fixture set's live-row half (issue 1412), split out of
  // `fixtures.test.ts` so the structural checks can run in CI while these two
  // stay pointed at the dogfood corpus. Registered for this guard's exact
  // reason: they are the ONLY assertions that the 32 uuids in
  // `eval/recall/fixtures.json` name rows that still exist. Skipped, a fixture
  // file full of archived-away ids reports nothing and every recall eval built
  // on it measures a retrieval stack against rows that are not there.
  {
    name: "recall fixture ids resolve in the dogfood corpus (live Postgres)",
    minTests: 2,
  },
  // The two reporting tools' live halves (issue 1421). The parity fixture
  // freezes their shapes on an EMPTY namespace, where a wrong aggregate, a
  // wrong trend band, and an unscoped access-log read all return zeros and
  // pass. These are the ONLY assertions that exercise the arithmetic on real
  // rows -- and, because `entry_access_log` has no namespace column of its
  // own, the only ones proving the log is scoped by joining back to the
  // owning row. Skipped, a boundary regression reports nothing.
  {
    name: "access_report (live Postgres)",
    minTests: 5,
  },
  {
    name: "get_stats (live Postgres)",
    minTests: 4,
  },
  // The `authority_tier` fill (issue 1469 State 4). Registered for this
  // guard's exact reason: it is the ONLY place the SQL form of the R3 rule is
  // exercised against real rows. `authority.test.ts` proves the TypeScript
  // form and runs without Postgres, so a skip here leaves the SQL predicate
  // -- the one that actually writes 287,471 rows -- asserted nowhere, and a
  // mis-tiered backfill is a silent authority downgrade.
  {
    name: "fillAuthorityTiers (live Postgres)",
    minTests: 3,
  },
  // The apply-step run-schema mirrors (issue 1469). Registered for this
  // guard's exact reason: `CREATE TABLE ... (LIKE public.<t>)` is DDL whose
  // survival depends on the live column types, and the suite's fourth case is
  // the only assertion that a mirror write path leaves `public` alone. Skipped,
  // a mirror that had started writing to the real tables would report nothing.
  {
    name: "dream route apply mirrors (live Postgres)",
    minTests: 5,
  },
  // The apply step itself (issue 1469). Registered for this guard's exact
  // reason: these are the only assertions that a routing run writes into the
  // run-schema mirrors and nowhere else, and that a second call writes
  // nothing. Skipped, an apply step that had started writing to `public` or
  // double-applying a run would report nothing and the job would stay green.
  {
    name: "dream route apply step (live Postgres)",
    minTests: 7,
  },
  // The labelled matrix case store (issue 1469). Registered because its
  // refusals -- a candidate outside the cohort, a dest that disagrees with its
  // own yes/no answers -- are enforced against the real table's constraints,
  // and its keying by candidate and matrix fingerprint only means anything
  // against a live unique index. Skipped, a store that silently accepted
  // either would report nothing.
  {
    name: "dream route matrix case store (live Postgres)",
    minTests: 5,
  },
  // The route signals step (issue 1469). Registered for this guard's exact
  // reason: these are the only assertions that a contradicts_canon candidate
  // is never applied, and that a reverses_rule signal writes a relegate
  // lifecycle event and a tier_moves row only when the candidate is
  // operator-anchored. Skipped, a signals step that had started applying a
  // contradicted candidate -- or relegating on an observed one -- would report
  // nothing and the job would stay green.
  {
    name: "dream route apply signals (live Postgres)",
    minTests: 5,
  },
  // Graduation to always-known and its undo (issue 1469). Registered because
  // the distinct-session count is read across the frozen snapshot's source
  // turn ids through `ob_raw_turns.session_ref`, a join only real rows
  // exercise, and because the undo path's proof is that nothing is deleted.
  // Skipped, a threshold that had started counting repeats rather than
  // sessions would promote on a single session and report nothing.
  {
    name: "dream route graduation and undo (live Postgres)",
    minTests: 8,
  },
  // Candidate dedupe runs in every REM pass (issue 1488). Its only proof that
  // the nearest-survivor lookup is index-served is an EXPLAIN against the real
  // schema; skipped, a plan that fell back to scanning every unreviewed
  // candidate would load the database and report nothing.
  {
    name: "candidate dedupe pairing uses the HNSW index (live Postgres)",
    minTests: 1,
  },
  // Public routing history tables (issue 1525). Registered because the foreign
  // key, the per-run candidate uniqueness, and the reader indexes exist only
  // in a migrated database; skipped, a migration that had lost one would
  // report nothing.
  {
    name: "public routing history tables (live Postgres)",
    minTests: 4,
  },
  // Tier-move insert helper and insertThought source/tier (issue 1525).
  // Registered because both write real rows; skipped, a helper that had lost
  // a column or a default would report nothing.
  {
    name: "tier move insert and thought source (live Postgres)",
    minTests: 4,
  },
  // Public DREAM apply repository (issue 1525). Registered because the
  // thought/event dedupe and the tier move exist only in a migrated database;
  // skipped, an apply that wrote twice would report nothing.
  {
    name: "public DREAM apply repository (live Postgres)",
    minTests: 8,
  },
  // Public DREAM routing repository (issue 1525): the unrouted-slice read and
  // the run-history write. Skipped, a broken skip-already-routed predicate
  // would re-route every candidate on every run and report nothing.
  {
    name: "public DREAM routing repository (live Postgres)",
    minTests: 5,
  },
  // The scheduled dream.route handler (issue 1525): slice read, one run's
  // history, the apply step, and the spend refusal in one transaction.
  {
    name: "dream.route handler (live Postgres)",
    minTests: 6,
  },
  // The dream.route producer facts (issue 1525): a dead letter counts as the
  // last terminal time, and "unrouted" flips once every candidate is routed.
  {
    name: "route signal facts (live Postgres)",
    minTests: 3,
  },
  // Embedding repair survives a content_hash unique violation (issue 1462).
  // Only a real unique index raises 23505, so a skipped run proves nothing.
  {
    name: "embedding repair content_hash collision (live Postgres)",
    minTests: 1,
  },
  { name: "sessions collision evidence (live Postgres)", minTests: 4 },
  // The missing-embedding drain advances past colliding rows (issue 1612).
  {
    name: "repair-embeddings drain advances past content_hash collisions (live Postgres)",
    minTests: 2,
  },
  // createPool finishes pgvector registration before a new client runs the
  // caller's first query (issue 1502).
  {
    name: "createPool pgvector registration ordering (live Postgres)",
    minTests: 3,
  },
  // The capture observer's namespace check (issue 682). A misspelled
  // capture-health namespace read as a quiet night and kept /health green;
  // skipped, this suite reports nothing and the typo goes silent again.
  {
    name: "capture liveness namespace check (live Postgres)",
    minTests: 2,
  },
  // The scenario teardown archives memory-kind records through the served
  // archive_entry tool (issue 672). Skipped, a teardown that leaves thoughts,
  // decisions, or sessions behind would go unnoticed.
  {
    name: "scenario teardown archives memory-kind records (live Postgres)",
    minTests: 1,
  },
  // Live Postgres suites that were never named here (issue 683): skipped,
  // each would report nothing and CI would stay green.
  {
    name: "nats worker composes a LIVE embed watermark observer by default (#724 item 3)",
    minTests: 4,
  },
  { name: "parent + chunk entry storage (live Postgres)", minTests: 3 },
  { name: "chunk write duplicate and fallback handling (live Postgres)", minTests: 3 },
  { name: "rewrite entrypoint embedding provenance (live Postgres)", minTests: 1 },
  { name: "automatic REM serving composition (live Postgres)", minTests: 1 },
  { name: "raw turn to reviewed durable memory (live Postgres)", minTests: 3 },
  { name: "decompose_entry planning (live Postgres)", minTests: 4 },
  { name: "decompose_entry applying (live Postgres)", minTests: 3 },
  { name: "entity and link tools (live Postgres)", minTests: 6 },
  { name: "people tools (live Postgres)", minTests: 3 },
  { name: "get_entity namespace isolation (live Postgres)", minTests: 3 },
  { name: "list_stale staleness predicate (live Postgres)", minTests: 4 },
  {
    name: "list_stale envelope, paging and namespace boundary (live Postgres)",
    minTests: 4,
  },
  { name: "promote_shared promotion rules (live Postgres)", minTests: 5 },
  { name: "promotion identity rules and list_namespaces (live Postgres)", minTests: 3 },
  { name: "hybrid lexical distinct-query-term coverage (live Postgres)", minTests: 5 },
  { name: "hybrid lexical compound normalization (live Postgres)", minTests: 3 },
  { name: "hybrid lexical numeric aliases (live Postgres)", minTests: 2 },
  { name: "hybrid lexical document-length normalization (live Postgres)", minTests: 2 },
  { name: "keyword lexical matching (live Postgres)", minTests: 2 },
  { name: "promote_reviewed_candidate (live Postgres)", minTests: 6 },
  { name: "session lifecycle event bounds (#515)", minTests: 4 },
  { name: "session_start exact-scope establishment (#646)", minTests: 2 },
  { name: "tier_recommendations (live Postgres)", minTests: 3 },
  { name: "loadCanonEntriesForNamespace (live Postgres)", minTests: 3 },
];

// Absolute floor on total executed (non-skipped) live-Postgres testcases,
// independent of the per-suite breakdown above. It tracks the sum of the
// `minTests` values above, so the global floor cannot silently fall behind
// the per-suite one; the sum-invariant test in assert-db-tests-ran.test.ts
// enforces the equality.
//
// Recomputed 332 -> 150 for issue 1054 (operator ruling 2026-08-30): all 175
// *.test.ts files under src/ were retired, which took 61 of the 84 entries
// above with them. The 23 that remain are the suites still emitted by test
// files outside src/. The long addition-by-addition history that used to sit
// here narrated entries that no longer exist; the git history keeps it.
//
// Recomputed 150 -> 75 for issue 864: the server parity fixture suite (75) was
// retired along with the fixtures it replayed, so its entry left this list and
// the sum moved with it.
//
// Recomputed 75 -> 79 for issue 864: the restored session_wrap exact-scope
// suite emits 4 testcases, so its entry raised the sum by that count.
//
// Recomputed 79 -> 83 for issue 831: the new session_save write-path suite
// emits 4 testcases, so its entry raised the sum by that count.
// Recomputed 83 -> 86 for issue 1209: the new server/db withTransaction suite
// emits 3 testcases, so its entry raised the sum by that count.
// Recomputed 86 -> 90 for issue 1209: the withTransaction options suite emits
// 4 testcases, so its entry raised the sum by that count.
// Recomputed 90 -> 93 for issue 1209: the new update_entry early-return guard
// suite emits 3 testcases, so its entry raised the sum by that count.
// Recomputed 93 -> 95 for issue 1209: the new citation_recall neighbor-split
// suite emits 2 testcases, so its entry raised the sum by that count.
// Recomputed 95 -> 97 for issue 1412: the recall fixture corpus suite emits 2
// testcases, so its entry raised the sum by that count.
// Recomputed 97 -> 106 for issue 1421: the reporting suite's two describes
// were never registered here at all. `access_report` emits 5 testcases and
// `get_stats` emits 4, so the two entries raised the sum by 9.
// Recomputed 106 -> 109 for issue 1469: the authority_tier fill suite emits 3
// testcases, so its entry raised the sum by that count.
// Recomputed 109 -> 114 for issue 1469: the apply-mirror suite emits 5
// testcases, so its entry raised the sum by that count.
// Recomputed 114 -> 126 for issue 1469: the apply-step suite emits 7 testcases
// and the matrix case store suite emits 5, so the two entries raised the sum
// by 12.
// Recomputed 126 -> 139 for issue 1469: the route-signals suite emits 5
// testcases and the graduation-and-undo suite emits 8, so the two entries
// raised the sum by 13.
// Recomputed 139 -> 140 for issue 1488: the candidate dedupe HNSW plan suite
// emits 1 testcase, so its entry raised the sum by that count.
// Recomputed 140 -> 144 for issue 1525: the public routing history tables
// suite emits 4 testcases, so its entry raised the sum by that count.
// Recomputed 144 -> 148 for issue 1525: the tier move insert suite emits 4
// testcases, so its entry raised the sum by that count.
// Recomputed 148 -> 154 for issue 1525: the public DREAM apply repository
// suite emits 6 testcases, so its entry raised the sum by that count.
// Recomputed 154 -> 159 for issue 1525: the public DREAM routing repository
// suite emits 5 testcases, so its entry raised the sum by that count.
// Recomputed 159 -> 163 for issue 1525: the dream.route handler suite emits 4
// testcases, so its entry raised the sum by that count.
// Recomputed 163 -> 165 for issue 1525: the dream.route handler suite gained
// the claimUnrouted and overlapping-run tests, so its entry rose by 2.
// Recomputed 165 -> 168 for issue 1525: the route signal facts suite emits 3
// testcases, so its entry raised the sum by that count.
// Recomputed 168 -> 170 for issue 1525: the public DREAM apply repository
// suite gained 2 embedding-copy testcases (6 -> 8).
// Recomputed 170 -> 173 for issue 1502: the createPool registration ordering
// suite emits 3 testcases, so its entry raised the sum by that count.
// Recomputed 176 -> 178 for issue 682: the capture liveness namespace check
// suite emits 2 testcases, so its entry raised the sum by that count.
// Recomputed 178 -> 179 for issue 672: the scenario teardown archive suite
// emits 1 testcase, so its entry raised the sum by that count.
// Recomputed 179 -> 257 for issue 683: 24 live Postgres suites that had no entry were named, at their JUnit counts.
// Recomputed 257 -> 261 for issue 1612: the sessions collision evidence suite
// emits 4 testcases, so its entry raised the sum by that count.
// Recomputed 261 -> 263 for issue 1612: the repair-embeddings drain collision
// suite emits 2 testcases, so its entry raised the sum by that count.
// Recomputed 263 -> 264 for issue 1618: the promote_shared promotion rules
// suite gained the Jev share-screen testcase (4 -> 5).
// Recomputed 264 -> 267 for issue 1618 B4 L1: the canon read suite emits 3
// testcases, so its entry raised the sum by that count.
// Recomputed 267 -> 265 for issue 1678 (purge P3 part b): the sdk-protocol
// suite lost its two two-worker front proofs with the front (12 -> 10).
export const MIN_TOTAL_LIVE_TESTCASES = 265;

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

// A suite is live when its name carries the marker OR the manifest names it
// (issue 683): a manifest entry is the stronger statement of the two.
function isLiveSuiteName(name: string): boolean {
  return (
    name.includes("(live Postgres)") ||
    REQUIRED_SUITES.some((suite) => suite.name === name)
  );
}

function emptySuiteStats(): SuiteStats {
  return { tests: 0, failures: 0, errors: 0, skipped: 0 };
}

function addSuiteTagStats(
  suiteStats: Map<string, SuiteStats>,
  name: string,
  tag: string,
): void {
  const previous = suiteStats.get(name) ?? emptySuiteStats();
  suiteStats.set(name, {
    tests: previous.tests + Number(attr(tag, "tests") ?? "0"),
    failures: previous.failures + Number(attr(tag, "failures") ?? "0"),
    errors: previous.errors + Number(attr(tag, "errors") ?? "0"),
    skipped: previous.skipped + Number(attr(tag, "skipped") ?? "0"),
  });
}

function vitestSuiteName(open: string): string | undefined {
  const classname = attr(open, "classname") ?? "";
  if (isLiveSuiteName(classname)) return undefined;
  const name = attr(open, "name") ?? "";
  return REQUIRED_SUITES.find(
    (suite) => name === suite.name || name.startsWith(`${suite.name} &gt; `),
  )?.name;
}

function addVitestTestcaseStats(
  suiteStats: Map<string, SuiteStats>,
  block: string,
): void {
  const open = block.match(/<testcase\b[^>]*>/)?.[0] ?? block;
  const name = vitestSuiteName(open);
  if (!name) return;
  const previous = suiteStats.get(name) ?? emptySuiteStats();
  suiteStats.set(name, {
    tests: previous.tests + 1,
    failures: previous.failures + (/<failure\b/.test(block) ? 1 : 0),
    errors: previous.errors + (/<error\b/.test(block) ? 1 : 0),
    skipped:
      previous.skipped +
      (/<skipped\b/.test(block) || attr(open, "skipped") === "true" ? 1 : 0),
  });
}

// Collect per-suite stats from <testsuite ...> opening tags.
function collectSuiteStats(xml: string): Map<string, SuiteStats> {
  const suiteStats = new Map<string, SuiteStats>();
  for (const tag of xml.match(/<testsuite\b[^>]*>/g) ?? []) {
    const name = attr(tag, "name");
    if (!name || !isLiveSuiteName(name)) continue;
    addSuiteTagStats(suiteStats, name, tag);
  }
  const testcaseRe = /<testcase\b[^>]*?(\/>|>[\s\S]*?<\/testcase>)/g;
  for (const block of xml.match(testcaseRe) ?? []) {
    addVitestTestcaseStats(suiteStats, block);
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
  const name = attr(open, "name") ?? "";
  const suiteName = isLiveSuiteName(classname)
    ? classname
    : REQUIRED_SUITES.find(
        (suite) => name === suite.name || name.startsWith(`${suite.name} &gt; `),
      )?.name;
  if (!suiteName) return undefined;
  const isSkipped = /<skipped\b/.test(block) || attr(open, "skipped") === "true";
  return isSkipped ? undefined : suiteName;
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
        `"${req.name}" ran ${s.tests} tests, expected at least ` + `${req.minTests}.`,
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
  const { executedLiveTestcases, erroredLiveTestcases, executedLiveTestcasesBySuite } =
    tallyTestcases(xml);

  const errors: string[] = [];

  for (const req of REQUIRED_SUITES) {
    errors.push(...checkRequiredSuite(req, suiteStats, executedLiveTestcasesBySuite));
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
