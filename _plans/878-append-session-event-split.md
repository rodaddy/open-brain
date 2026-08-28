# #878 — split and convert `src/tools/__tests__/append-session-event.test.ts`

Status: PROPOSED (plan only; nothing written, merged, or running).
Subject on origin/main `751c7268`: 2779 lines, one unit `describe` at line 86
(61 `it` registrations, one of them a loop at 1248 over 8 event types) and one
`dbDescribe` live suite at 2381 (8 its). All line numbers below are origin/main
line numbers and are ANCHORS: each session-12 lane prints the real block start
and end with `awk 'NR>=A && NR<=B'` before every `sed -n 'A,Bp'` copy and never
takes a boundary from this plan (round 40 tightening).

## Census (verified this lane)

- `wc -l` → 2779
- unit describe: line 86 `describe("append_session_event", ...)`, closes 2379
- live describe: line 2381 `dbDescribe("append_session_event create_if_missing (live Postgres)", ...)`, closes 2779
- `it` registrations: 61 unit + 8 live = 69
- oxlint on the whole file, per rule:
  - `typescript(no-explicit-any)` — 89
  - `typescript(no-non-null-assertion)` — 43
  - `eslint(max-lines-per-function)` — 2
  - `eslint(max-lines)` — 1
  - total 135
- manifest entry name for the live suite (`scripts/assert-db-tests-ran.ts:40`):
  `append_session_event create_if_missing (live Postgres)`;
  `MIN_TOTAL_LIVE_TESTCASES = 328` at line 518.

## Helper module

New sibling module `src/tools/__tests__/append-session-event-test-helpers.ts`
holds every helper shared by two or more split files. It holds no test and
creates no pool; every function that touches the database takes `pool: Pool`
as its first parameter (R3). Contents:

- `createMockEmbed` (origin/main 11-13) — note `src/tools/__tests__/test-helpers.ts:15`
  already exports a `createMockEmbed`; check its signature first and import the
  existing one rather than duplicating it if the shapes match.
- `createThrowingEmbed` (15-19)
- `setupToolClient` (21-53)
- `createLaneFoundPool` (56-71)
- `createLaneNotFoundPool` (74-83)
- `expectDefined(value, label)` — new generic guard that throws on null or
  undefined, replacing all 43 `x!` occurrences across the split (R7).

`parseToolResult` / `getErrorText` already exist in
`src/tools/__tests__/test-helpers.ts` (lines 72 and 77) — reuse, do not re-add.
Helpers used by exactly one split file stay in that file.

## Planned files (7)

Each file stays under 500 lines including helpers and imports (R6), and each
`it` body is hoisted to a module-scope `async function` called as
`it("<same name>", fn)` so no describe callback exceeds 100 code lines (R7, R9).

### File 1 — `append-session-event-auth.test.ts` (7 its)
Describe: `append_session_event auth and lookup`
- 89 denies write when auth is missing entirely
- 121 denies write for discord role
- 142 denies write for readonly role
- 165 admin can append event — full output fields
- 201 allows agent role
- 221 allows ob-admin role
- 243 returns error when lane not found
Helpers: `setupToolClient`, `createLaneFoundPool`, `createLaneNotFoundPool` from the lane helper module.

### File 2 — `append-session-event-lane-creation.test.ts` (10 its)
Describe: `append_session_event lane creation and scope`
- 265 creates a scoped lane on first append when create_if_missing is true
- 365 reuses an existing scoped lane when create_if_missing is true
- 422 handles first-write lane creation races by returning the existing lane
- 481 denies append when supplied exact scope conflicts with the existing lane
- 545 denies unthreaded realtime append against an existing threaded lane
- 593 appends to a session_start-created lane with null scope without false conflict
- 677 fails closed when a concurrent writer asserts a conflicting scope during attachment
- 734 still denies a non-null scope mismatch against an existing lane
- 788 treats null thread as asserted unthreaded scope once the lane is otherwise exact
Helpers: `setupToolClient`, `createMockEmbed`, plus the file-local transactional mock pools that live inside these bodies (keep them in this file).

### File 3 — `append-session-event-failure-paths.test.ts` (5 its)
Describe: `append_session_event failure and rollback paths`
- 841 returns retryable_outage when the database fails before append
- 871 rolls back a first-write lane when event insert fails after lane creation
- 955 preserves the original append error when rollback also fails
- 1023 fails loud when create_if_missing cannot get a transactional pool
Helpers: `setupToolClient`, `createThrowingEmbed` from the lane helper module.

### File 4 — `append-session-event-lane-state.test.ts` (11 its)
Describe: `append_session_event lane state, defaults, and event types`
- 1061 rejects append to archived lane
- 1088 allows append to wrapped lane
- 1115 returns duplicate response when content_hash conflicts
- 1153 defaults namespace to auth.clientId when not provided
- 1180 defaults importance to 'warm' when not provided
- 1205 embedding failure is non-fatal — event still inserted
- 1248 `accepts event_type="${eventType}"` — a `for` loop over 8 event types; move the loop and its array verbatim
- 1274 succeeds with only required fields (source, artifact_path omitted)
Helpers: `setupToolClient`, `createLaneFoundPool`, `createThrowingEmbed`.

### File 5 — `append-session-event-provenance.test.ts` (5 its)
Describe: `append_session_event writer provenance`
- 1359 records distinct writer and token provenance for cross-namespace writes
- 1403 does not treat X-Agent-Id as delegated provenance without X-Namespace
- 1445 records delegated namespace writer separately from token provenance
- 1490 preserves caller _openbrain metadata while stamping trusted writer provenance
Helpers: `setupToolClient`, `createLaneFoundPool`.

### File 6 — `append-session-event-share-gate.test.ts` (23 its)
Describe: `append_session_event share-nomination gate`
- 1528 strips share_candidate and reports reject-secret when content carries a secret
- 1580 treats string "true" nomination like boolean true (matches async SQL truthiness)
- 1625 strips share_candidate and reports reject-private when metadata.private is true
- 1671 marks repeated rejected sanitized resubmits non-resubmittable at the bound
- 1710 does not trust a reset sanitized_resubmit_attempt when prior rejected resubmits exist
- 1749 keeps the original rejection root when a contract-following resubmit fails again
- 1790 does not let a rotated resubmit root reset the retry bound
- 1832 bounds repeated rejected nominations even when clients omit resubmit lineage
- 1867 keeps clean share_candidate metadata without making candidate presence a write
- 1903 preserves an explicit shared nomination lifecycle action for the promoter
- 1945 strips lifecycle candidate metadata from rejected shared nominations
- 1994 rejects malformed lifecycle metadata before persistence
- 2023 rejects lifecycle evidence refs that contain secrets
- 2054 rejects share_candidate on non-nomination lifecycle actions
- 2085 accepts a clean sanitized resubmit without emitting rejection detail
- 2124 passes metadata through unchanged when no share_candidate is present
Helpers: `setupToolClient`, `createLaneFoundPool`, plus the share-gate mock pool
factories declared inside 1299-2154; those stay in this file unless File 7 also
uses one, in which case they move to the lane helper module with `pool` first.
Sizing risk: this is the largest group. If the hoisted bodies push it past 500
lines, cut it at 1903 into `-share-gate.test.ts` (1528-1867) and
`-share-lifecycle.test.ts` (1903-2154) and add a matching lane; both halves keep
their own helper imports.

### File 7 — `append-session-event-citation.test.ts` (6 its)
Describe: `append_session_event database errors and transcript citation`
- 2157 returns isError=true with message when DB query throws
- 2184 persists a host-neutral transcript citation with the event
- 2229 rejects host-specific transcript references before any database write
- 2261 requires transcript_ref for an empty transcript and rejects noncanonical segments
- 2306 rejects credential-like transcript material before any database write
- 2340 reports when a duplicate cannot retain newly supplied citation fields
Helpers: `setupToolClient`, `createLaneFoundPool`.

### File 8 (live) — `src/tools/__tests__/append-session-event.pg.test.ts` (8 its)
Describe: `append_session_event create_if_missing (live Postgres)` — the name is
unchanged, so the existing `scripts/assert-db-tests-ran.ts:40` entry keeps its
line; its `minTests` is re-measured from JUnit anyway (R5).
- 2439 creates the lane on first write and reuses it idempotently on the second
- 2481 creates exactly one lane under a genuine concurrent first-write race
- 2514 embeds first-write lane topic/project metadata on the real lane row
- 2555 allows identical first-write lane hashes in separate namespaces
- 2608 allows case-distinct session keys with the same normalized lane hash
- 2659 persists previously unasserted exact scope on an existing lane and then fails closed
- 2717 denies a scoped append that conflicts with the real stored lane scope
- 2749 denies cross-namespace create_if_missing for a non-global token

Conversion (R1, R2): drop the `DB_URL` const and the `dbDescribe` ternary
(2389-2390) entirely; the describe becomes a plain `describe`. At module scope,
on their own single lines (round 40, #945):

```
import { requireTestDatabaseUrl } from "../../../scripts/test-support/require-test-database.ts";
const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
```

matching `src/tools/__tests__/list-stale.pg.test.ts:44` and `:60`. The pool
created inside the describe at 2392 is deleted in favour of the module-scope
one; the existing `afterAll` that calls `pool.end()` moves to module scope and
stays the only one in the file. `callAppend` and `cleanupNs` are file-local and
stay here, with `cleanupNs(pool)` taking the pool as its first parameter.
The block header comment at 2381-2388 is rewritten to state the requirement
rather than the skip; comment lines are exempt from clause 1.

## Session 12 lanes

## Lane 1 — src/tools/__tests__/append-session-event.pg.test.ts
Tier: T1 — shared test file; CI manifest changes
Deliverable: The live describe at origin/main 2381 becomes a standalone `.pg.test.ts` file that demands the test database through `requireTestDatabaseUrl()` and no longer self-skips.
Scope: src/tools/__tests__/append-session-event.pg.test.ts, src/tools/__tests__/append-session-event.test.ts, src/tools/__tests__/append-session-event-test-helpers.ts, scripts/assert-db-tests-ran.ts
Must NOT: change src/tools/append-session-event.ts or any migration; retype moved bodies through Write; add oxlint disable comments; stage .qmd/index.yml; touch any other test file
Record: PR, then #878 comment on merge
Done-check: CHANGED_FILES="src/tools/__tests__/append-session-event.pg.test.ts src/tools/__tests__/append-session-event.test.ts" bash scripts/done-means/878-pg-tests-require-database.sh → exit 0

## Lane 2 — src/tools/__tests__/append-session-event-auth.test.ts
Tier: T1 — shared test file; CI manifest changes
Deliverable: The 7 auth and lane-lookup its move verbatim into their own file backed by the new lane helper module.
Scope: src/tools/__tests__/append-session-event-auth.test.ts, src/tools/__tests__/append-session-event-test-helpers.ts, src/tools/__tests__/append-session-event.test.ts
Must NOT: change assertion meaning or test names; add oxlint disable comments; create a pool in the helper module; stage .qmd/index.yml
Record: PR, then #878 comment on merge
Done-check: CHANGED_FILES="src/tools/__tests__/append-session-event-auth.test.ts src/tools/__tests__/append-session-event.test.ts" bash scripts/done-means/878-pg-tests-require-database.sh → exit 0

## Lane 3 — src/tools/__tests__/append-session-event-lane-creation.test.ts
Tier: T1 — shared test file; CI manifest changes
Deliverable: The 10 lane-creation and scope-conflict its move verbatim into their own file with their file-local transactional mock pools.
Scope: src/tools/__tests__/append-session-event-lane-creation.test.ts, src/tools/__tests__/append-session-event-test-helpers.ts, src/tools/__tests__/append-session-event.test.ts
Must NOT: change assertion meaning or test names; add oxlint disable comments; retype moved code through Write; stage .qmd/index.yml
Record: PR, then #878 comment on merge
Done-check: CHANGED_FILES="src/tools/__tests__/append-session-event-lane-creation.test.ts src/tools/__tests__/append-session-event.test.ts" bash scripts/done-means/878-pg-tests-require-database.sh → exit 0

## Lane 4 — src/tools/__tests__/append-session-event-failure-paths.test.ts
Tier: T1 — shared test file; CI manifest changes
Deliverable: The 5 outage, rollback, and non-transactional-pool its move verbatim into their own file.
Scope: src/tools/__tests__/append-session-event-failure-paths.test.ts, src/tools/__tests__/append-session-event-test-helpers.ts, src/tools/__tests__/append-session-event.test.ts
Must NOT: change assertion meaning or test names; add oxlint disable comments; alter rollback ordering; stage .qmd/index.yml
Record: PR, then #878 comment on merge
Done-check: CHANGED_FILES="src/tools/__tests__/append-session-event-failure-paths.test.ts src/tools/__tests__/append-session-event.test.ts" bash scripts/done-means/878-pg-tests-require-database.sh → exit 0

## Lane 5 — src/tools/__tests__/append-session-event-lane-state.test.ts
Tier: T1 — shared test file; CI manifest changes
Deliverable: The 11 lane-state, defaults, embedding, event-type-loop, and optional-field its move verbatim into their own file.
Scope: src/tools/__tests__/append-session-event-lane-state.test.ts, src/tools/__tests__/append-session-event-test-helpers.ts, src/tools/__tests__/append-session-event.test.ts
Must NOT: unroll the event-type loop; change test names; add oxlint disable comments; stage .qmd/index.yml
Record: PR, then #878 comment on merge
Done-check: CHANGED_FILES="src/tools/__tests__/append-session-event-lane-state.test.ts src/tools/__tests__/append-session-event.test.ts" bash scripts/done-means/878-pg-tests-require-database.sh → exit 0

## Lane 6 — src/tools/__tests__/append-session-event-provenance.test.ts
Tier: T1 — shared test file; CI manifest changes
Deliverable: The 5 writer- and delegated-provenance its move verbatim into their own file.
Scope: src/tools/__tests__/append-session-event-provenance.test.ts, src/tools/__tests__/append-session-event-test-helpers.ts, src/tools/__tests__/append-session-event.test.ts
Must NOT: change header names or assertion meaning; add oxlint disable comments; stage .qmd/index.yml
Record: PR, then #878 comment on merge
Done-check: CHANGED_FILES="src/tools/__tests__/append-session-event-provenance.test.ts src/tools/__tests__/append-session-event.test.ts" bash scripts/done-means/878-pg-tests-require-database.sh → exit 0

## Lane 7 — src/tools/__tests__/append-session-event-share-gate.test.ts
Tier: T1 — shared test file; CI manifest changes
Deliverable: The 23 share-nomination gate its move verbatim into their own file, split into two files at origin/main 1903 if the hoisted result exceeds 500 lines.
Scope: src/tools/__tests__/append-session-event-share-gate.test.ts, src/tools/__tests__/append-session-event-share-lifecycle.test.ts, src/tools/__tests__/append-session-event-test-helpers.ts, src/tools/__tests__/append-session-event.test.ts
Must NOT: relocate secret-shaped fixtures across the diff without a `git diff --cached | gitleaks detect` receipt; change test names; add oxlint disable comments; stage .qmd/index.yml
Record: PR, then #878 comment on merge
Done-check: CHANGED_FILES="src/tools/__tests__/append-session-event-share-gate.test.ts src/tools/__tests__/append-session-event.test.ts" bash scripts/done-means/878-pg-tests-require-database.sh → exit 0

## Lane 8 — src/tools/__tests__/append-session-event-citation.test.ts
Tier: T1 — shared test file; CI manifest changes
Deliverable: The 6 database-error and transcript-citation its move verbatim into their own file, retiring the original append-session-event.test.ts once empty.
Scope: src/tools/__tests__/append-session-event-citation.test.ts, src/tools/__tests__/append-session-event-test-helpers.ts, src/tools/__tests__/append-session-event.test.ts
Must NOT: leave a residual describe in the original file; change assertion meaning; add oxlint disable comments; stage .qmd/index.yml
Record: PR, then #878 comment on merge
Done-check: CHANGED_FILES="src/tools/__tests__/append-session-event-citation.test.ts src/tools/__tests__/append-session-event.test.ts" bash scripts/done-means/878-pg-tests-require-database.sh → exit 0

## Ordering and verification notes

Lane 1 runs first and alone: it is the only lane that touches
`scripts/assert-db-tests-ran.ts`, and its `minTests` is read from JUnit
(`bun run test:isolated <live file> --reporter=junit --reporter-outfile=...`),
never tallied by eye. `MIN_TOTAL_LIVE_TESTCASES` moves by the measured delta
from 328 and its comment chain gains one clause.

Lanes 2-8 each verify the previous phase by the SHAPE of the file being split
from, not by staged paths: `rg -n 'describe\(|^\s+it\('` plus `wc -l` on
`append-session-event.test.ts` must both fall after each lane (round 40).
Every lane re-takes lint, tsc, test, and done-means receipts on the COMMITTED
tree, because the pre-commit gate's prettier rewrite invalidates anything taken
before the commit.
