# Correctness SME Findings

Correctness reviewers check API contracts, schema compatibility, state
transitions, and runtime behavior that tests can accidentally miss.

## [2026-06-19] Mock-pool tests cannot catch SQL constraint or param-type failures

**Severity:** HIGH
**Source:** Issues #162, PRs #163 (bug) + #164 (regression fix)
**Scope:** `src/tools/*.ts` SQL writers, `src/tools/__tests__/**`
**Status:** active

### Pattern

`lane_upsert` shipped two production-breaking bugs in a row that a mock pool
(`{ query: async () => ({ rows: [...] }) }`) could not detect because the mock
never executes SQL:

1. PR #163: bound explicit `NULL` into the `NOT NULL` `status` column on INSERT
   — every new-lane create failed. Mock returned canned rows, test passed.
2. PR #163's own fix repointed `status` to `$24`, leaving `$3` used only in
   `CASE WHEN $3 IS NULL` / `$3 = 'literal'`. With no typed binding site,
   Postgres failed at plan time: `could not determine data type of parameter
   $3`. Again invisible to the mock.

### Review Questions

- Does the change touch SQL that a mock pool would not execute (INSERT/UPDATE,
  ON CONFLICT, CASE on a bind param, casts)?
- Is every bind param used in at least one typed position, or cast (`$n::type`)
  when used only in `IS NULL`/equality? Unanchored params fail type inference.
- Does an explicit `NULL` get bound into a `NOT NULL DEFAULT` column? The column
  default only applies when the column is OMITTED, not when NULL is supplied.
- Is there a DB-backed test (real pool, env-gated) for the representative
  write path, not only a mock assertion on row shape?

### Prior Fix

PR #164 added env-gated (`OPENBRAIN_TEST_DATABASE_URL`) integration tests that
run the real query through a real pool. Mock-shape assertions are insufficient
for SQL writers; require a real-pool test for new/changed write paths.

## [2026-06-11] Python wrappers must prove server schema compatibility

**Severity:** MEDIUM
**Source:** Issues #82, PR #73 review loop; PR #319 fix delta
**Scope:** `python/openbrain-memory/**`, `clients/ts/tests/fakes.ts`, `contracts/memory/**`
**Status:** active

### Pattern

Wrapper tests that only assert a method name or `probe=True` can pass while the
real MCP tool rejects the payload. PR #73 needed several fixes because facade
methods forwarded unsupported top-level fields or missed required fields.

**PR #319:** a permissive TS fixture fake drained malformed `upsert_repo_fact`
and `log_decision` records. Replay fakes must validate required nested shapes so
fixture success proves server-compatible arguments, not only operation names.

### Review Questions

- Does each wrapper send only fields accepted by the server tool schema?
- Are required fields such as `event_type` present?
- Are optional fields allowlisted instead of passed through arbitrarily?
- Is there a schema-backed, snapshot, or contract test for representative calls?

### Bad

```python
memory.checkpoint("done", status="green")  # unsupported session_wrap field
```

### Good

```python
with pytest.raises(ValueError, match="unsupported keys"):
    memory.checkpoint("done", status="green")
```

## [2026-06-11] MCP client tests must verify protocol details, not only wrappers

**Severity:** MEDIUM
**Source:** Issue #82, PR #72 review loop
**Scope:** `python/openbrain-memory/src/openbrain_memory/client.py`
**Status:** active

### Pattern

Fake transports can prove wrapper behavior but miss HTTP/MCP contract drift:
headers, JSON-RPC ids, initialized notification, session id reuse, protocol
version, and request body shape.

### Review Questions

- Is there an in-process HTTP/MCP test using real `OpenBrainClient` and
  `UrllibTransport`?
- Does the test observe `Authorization`, default omission of `X-Namespace`,
  explicit delegated `X-Namespace` when enabled, `X-Agent-Id`, `X-Role`,
  `Mcp-Session-Id`, `MCP-Protocol-Version`, JSON-RPC ids, and bodies?
- Does it cover `/health`, initialize, initialized notification, and
  `tools/call`?

## [2026-06-11] DreamEngine must handle malformed reports intentionally

**Severity:** MEDIUM
**Source:** Issues #82, PR #75 review loop
**Scope:** `python/openbrain-memory/src/openbrain_memory/dream.py`
**Status:** active

### Pattern

DreamEngine dry-run planning can be correct for happy-path reports while
behaving poorly on malformed or mixed valid/invalid server candidates.

### Review Questions

- Does malformed server output fail closed or skip invalid candidates with
  diagnostics?
- Is mixed valid/invalid candidate behavior locked by tests?
- Are namespace-scoped dreams prevented from planning global tier actions?
- Are limits bounded to the strictest downstream MCP tool schema?

### Prior Fix

PR #75 made `dream_once()` dry-run-only, bounded limits to 100, suppressed
unscoped tier actions for namespace dreams, and rejected boolean numeric config.

## [2026-06-19] Sync and async gates on the same flag must share truthiness

**Severity:** MEDIUM
**Source:** Issue #161, PR #171 (share_candidate nomination, hybrid timing)
**Scope:** any field validated both inline (TS) and in SQL (`->>'x' = 'true'`)
**Status:** active

### Pattern

`append_session_event`'s sync gate checked `metadata.share_candidate !== true`
(strict boolean), but the async promoter nominated on
`metadata->>'share_candidate' = 'true'` — which also matches the JSON string
`"true"`. A mistyped string nomination skipped the inline secret/private check
yet was still swept async, voiding the sync gate's security guarantee.
Defense-in-depth (the async re-classify) prevented an actual promotion hole, but
the sync rationale was void and the agent got no rejection feedback.

### Review Questions

- When the same flag is gated in two places (inline code + SQL `->>`), do both
  accept the same set of truthy values?
- Is the inline check at least as permissive as the SQL one, so nothing the
  async path will act on bypasses the sync guard?

### Prior Fix

PR #171 made the sync gate accept `=== true || === "true"` to match the SQL
truthiness; regression test asserts a string `"true"` nomination with secret
content is still rejected inline.

## [2026-06-19] Env-gated DB tests skip silently in CI unless the URL is set

**Severity:** HIGH
**Source:** Issue #165 / #161, PR #171
**Scope:** `.github/workflows/ci.yml`, all `dbDescribe`-gated suites
**Status:** active

### Pattern

The env-gated real-Pool tests (the only ones that catch SQL bugs per the
mock-pool finding above) gate on `OPENBRAIN_TEST_DATABASE_URL`. CI set `DB_*`
and ran migrations against a real Postgres but never set
`OPENBRAIN_TEST_DATABASE_URL`, so every `dbDescribe` suite SKIPPED in CI — the
exact write paths the discipline rule exists to protect had zero CI coverage.

### Review Questions

- Does CI export `OPENBRAIN_TEST_DATABASE_URL` so `dbDescribe` suites actually
  run, not skip?
- When a critical guarantee is only covered by an env-gated test, is that env
  wired in CI, or is it a silent gap?

### Prior Fix

PR #171 set `OPENBRAIN_TEST_DATABASE_URL` in the CI `check` job env, built from
the existing `DB_*` values, enabling all env-gated suites in CI.

## [2026-06-28] Cross-tool write/read shape coherence on shared rows

**Severity:** MEDIUM
**Source:** PR #228 full swarm (issue #227), correctness + domain lanes
**Scope:** any validator that reads fields off a row created by more than one tool
(`scopeConflicts` in `src/tools/append-session-event.ts`; lane writers
`session-start.ts`, `lane-upsert.ts`)
**Status:** fixed in PR #228

### Pattern

`append_session_event.create_if_missing` added a `scopeConflicts` check that
compared caller scope fields against an existing lane with strict `!==`. But
lanes are also created by `session_start` and `lane_upsert`, which do **not**
write the `source` column or `metadata.server_id`. So a lane created by
`session_start` (source `NULL`) hit `args.platform="discord" !== null` and the
legitimate first scoped append was **falsely rejected** with `scope_validation`
(retryable=false → a hard stall, since the contract tells Hermes to stop, not
retry). The adapter-contract doc compounded it: it mapped `source:
hermes-discord` + `metadata.platform: discord`, contradicting the code's
`platform → source` / compare-`args.platform`-vs-`lane.source` axis.

### Review Questions

- For every field a validator READS off a shared row, does EVERY tool that
  creates/updates that row write the same field in the same place (column vs
  JSONB key)?
- Does a strict-equality scope/identity check treat a NULL/absent stored value
  as a conflict? It should usually mean "unconstrained" (skip), with only a
  non-null mismatch rejected — otherwise partially-populated rows from a sibling
  tool false-deny.
- Does the contract doc's field placement match the field the comparison code
  actually reads?

### Prior Fix

PR #228 made `scopeConflicts` treat a null/absent existing value as
unconstrained (skip), so a non-null mismatch still conflicts and cross-scope
spill protection is preserved. Doc field mapping aligned with the comparison
axis. Regression tests: scoped append onto a `session_start`-shaped (null
source) lane succeeds; non-null channel mismatch still denies; live-Postgres
suite proves the real ON CONFLICT create/race + scope denial.

## [2026-07-06] Source SQL must match actual column types, not remembered shapes

**Severity:** MEDIUM
**Source:** PR #254 initial swarm for Issue #247
**Scope:** `src/tools/decompose-entry.ts`, any tool that builds readable content
from multiple source tables
**Status:** fixed in PR #254; keep as active checklist

### Pattern

`decompose_entry` initially rendered decision `alternatives` with
`array_length(alternatives, 1)` and `immutable_array_to_string(...)`, but the
real schema stores `decisions.alternatives` as `JSONB`. Mock-pool tests passed
because they never executed the SQL against Postgres, while real decision calls
would fail before planning.

### Review Questions

- Does source-content SQL use the real migration-defined column type for every
  table, especially JSONB vs `text[]`?
- Do mock-pool tests at least assert the generated SQL shape for non-default
  source tables, not just the happy-path table?
- For SQL that reads multiple table families, has someone checked the migration
  source instead of relying on memory of sibling table shapes?

## [2026-06-27] Disclosure exporters must accept server-shaped citation fields

**Severity:** MEDIUM
**Source:** PR #218 full swarm
**Scope:** `src/disclosure-bundle.ts`, `python/openbrain-memory/src/openbrain_memory/agent.py`
**Status:** fixed in PR #218

### Pattern

Adapter fixtures used camelCase citation fields (`sourceRef`, `artifactPath`),
but Open Brain server rows and docs expose snake_case fields (`source_ref`,
`artifact_path`). Exporters that only read camelCase silently drop citations
from real `session_context` / `search_all` shaped rows.

### Review Questions

- Do disclosure exporters normalize both camelCase wrapper fixtures and
  snake_case server rows at the boundary?
- Do tests include raw server-shaped rows, not only hand-authored camelCase
  fixtures?
- Does TS/Python parity test compare the full generated bundle, not fragments?

## [2026-07-06] Exact compact renders must not reuse already-clipped search previews

**Severity:** MEDIUM
**Source:** PR #246 initial swarm for Issue #192
**Scope:** `src/tools/get-entry.ts`, `src/tools/table-constants.ts`, any bounded exact-fetch projection
**Status:** fixed in PR #246

### Pattern

Search/list preview expressions can be intentionally display-clipped. In PR
#246, compact `get_entry` initially reused `CONTENT_PREVIEW[table]` for
`content_length` and `content_truncated`. For `sessions`, `CONTENT_PREVIEW`
already applied `LEFT(s.summary, 300)`, so compact exact fetch could report a
shorter length and `content_truncated=false` for a long stored session summary.

### Review Questions

- Is a compact/exact-fetch render measuring the underlying readable content, or
  a search/list preview that may already be clipped?
- Do `content_length` and `content_truncated` reflect the same unbounded text
  that `content_preview` is truncating?
- Does the test suite include a long-row regression for any source family whose
  search preview is intentionally abbreviated?
- Is novel SQL projection covered by a real Postgres-gated test when a mock pool
  cannot execute the query?

### Prior Fix

PR #246 gave compact `get_entry` its own full-readable-content expression for
`sessions`, computed normalized content once in a subquery, added a mock SQL
shape guard, and added an `OPENBRAIN_TEST_DATABASE_URL`-gated live Postgres
test for long session compact length/truncation.

## [2026-07-06] Shared-kb nominations and own-durable graduation are orthogonal

**Severity:** HIGH
**Source:** PR #251 Claude cross-review for Issue #224
**Scope:** `src/tiering.ts`, lifecycle metadata actions, any own-durable lane classifier
**Status:** fixed in PR #251

### Pattern

Lifecycle metadata can be audit/control-plane intent without changing the
memory's own-lane graduation semantics. In PR #251, `classifyLaneEvent`
initially short-circuited every `memory_lifecycle_action`, including
`nominate_shared`, into the own-durable lane. That meant an explicit shared-kb
nomination could prevent otherwise hot/fact/long content from graduating by its
normal own-durable rules.

### Review Questions

- Is the lifecycle action a durable-lane control action, or a shared-kb
  nomination/audit marker that should remain orthogonal?
- Does adding metadata to support one promotion path accidentally suppress a
  sibling promotion/classification path?
- Do tests cover the same event qualifying for shared-kb nomination and
  own-durable graduation at the same time?

### Prior Fix

PR #251 restricted own-durable lifecycle short-circuiting to explicit
`candidate`, `promote`, `relegate`, and `discard` actions. `nominate_shared`
now follows normal graduation rules while still recording shared-kb intent.

## [2026-07-06] Rejected nominations must strip all coupled lifecycle metadata

**Severity:** MEDIUM
**Source:** PR #251 Claude cross-review for Issue #224
**Scope:** `src/tools/append-session-event.ts`, synchronous shared-kb nomination rejection
**Status:** fixed in PR #251

### Pattern

Rejected shared nominations must not leave partial metadata that downstream
tools interpret as intent. In PR #251, the sync rejection path stripped
`share_candidate` for secret/private nominations but initially left
`memory_lifecycle_action=nominate_shared` and candidate detail fields behind.
That created an orphan lifecycle marker after the server had rejected the
nomination.

### Review Questions

- When the server rejects a flag or lifecycle action, are all coupled metadata
  fields stripped as one invariant-preserving group?
- Can any downstream scanner, contract consumer, or audit path still read a
  rejected event as pending nomination intent?
- Do rejection tests assert absence of the entire metadata group, not only the
  primary boolean flag?

### Prior Fix

PR #251 strips `share_candidate`, `memory_lifecycle_action`, candidate detail
fields, and `evidence_refs` from rejected nominations before stamping the
rejection marker. Regression tests cover secret/private rejected nominations.

## [2026-07-06] REST and MCP promotion scanners must share nomination predicates

**Severity:** MEDIUM
**Source:** PR #251 focused fix-verification for Issue #224
**Scope:** `src/rest-promotion.ts`, `src/tools/scan-namespace.ts`, shared promotion candidate selection
**Status:** fixed in PR #251

### Pattern

Fixing only the MCP tool can leave sibling REST endpoints exposing the old
contract. In PR #251, `scan_namespace` was tightened to explicit shared-kb
nominations, but REST `/api/v1/scan/:namespace` still selected every
non-archived row and returned ordinary memories as promotion candidates.

### Review Questions

- When a tool contract changes, do REST, MCP, Python facade fixtures, and docs
  all use the same predicate and response shape?
- Is the candidate predicate pushed into SQL before `ORDER BY` and `LIMIT` in
  every scanner, or does one path still filter after the limit?
- Does test coverage include sibling endpoints, not only the tool path that was
  directly reported?

### Prior Fix

PR #251 moved explicit shared nomination selection into a shared helper used by
both MCP and REST scanners, removed REST's stale `already_promoted` response
bucket, and updated Python DreamEngine fixtures to match the current contract.

## [2026-07-06] Deduplicating apply batches must distinguish prior rows from self-collisions

**Severity:** HIGH
**Source:** PR #254 Claude/Opus cross-review for Issue #247
**Scope:** `src/tools/decompose-entry.ts`, any batch writer using
`ON CONFLICT DO NOTHING` plus fallback duplicate lookup
**Status:** fixed in PR #254; keep as active checklist

### Pattern

When a mutating batch writes rows with a normalized uniqueness key, a later item
in the same batch can collide with an earlier item just inserted by the current
transaction. If the fallback duplicate lookup reports that new row as a
pre-existing duplicate, audit/provenance output lies about where the duplicate
came from.

### Review Questions

- Does the writer track unique keys inserted earlier in the same batch?
- Are intra-batch duplicate collapses reported separately from pre-existing
  duplicate rows?
- Do apply tests include repetitive or highly-overlapped content that can
  produce duplicate normalized hashes inside one request?

## [2026-07-08] Relational query wording must prove graph edge direction

**Severity:** MEDIUM
**Source:** PR #274 initial swarm for Issue #267
**Scope:** `src/tools/search-brain.ts`, relational graph retrieval tests
**Status:** fixed in PR #274; keep as active checklist

### Pattern

Natural-language relation prompts can encode the inverse of the storage edge.
In PR #274, "What depends on Alpha?" was initially tested as
`Alpha -> target`, but the natural answer is rows that depend on Alpha
(`target -> Alpha`). A test oracle with the same wrong direction can make the
implementation and fixtures agree while user semantics are wrong.

### Review Questions

- For each relational phrase, does the test name the expected graph direction
  explicitly?
- Does "What depends on X?" hydrate rows whose link points to X, while "What
  does X depend on?" hydrates rows pointed to by X?
- Are fixture links shaped independently from the implementation SQL, so the
  test fails when the join direction is inverted?

## [2026-07-08] Operator health surfaces need a tri-state, and REST codes must mirror body state

**Severity:** HIGH
**Source:** PR #277 pre-merge gauntlet for Issue #270
**Scope:** `src/operator-doctor.ts`, REST status endpoints, health aggregation
**Status:** fixed in PR #277

### Pattern

A binary healthy/degraded rollup hides the difference that matters to an
operator: a hard-dependency failure (DB down) must surface as unhealthy, not as
the same "degraded" used for cosmetic problems. Two related traps shipped in
the first pass: the REST status code did not mirror the body state (200 on a
degraded body), and a subsystem reporting "unknown" was allowed to pass as
healthy instead of degrading the rollup.

### Review Questions

- Does the aggregate expose at least healthy / degraded / unhealthy, with
  hard-dependency failures mapped to unhealthy?
- Does the REST status code always agree with the body state -- no
  200-on-degraded, no 5xx with a healthy body?
- Does an "unknown" subsystem status degrade the rollup rather than defaulting
  to healthy?
- Do tests cover each subsystem failing alone and assert both body state and
  HTTP code?

## [2026-07-13] Citation expansion flags require real remaining evidence

**Severity:** MEDIUM
**Source:** Issue #288 Full-tier initial review
**Scope:** citation recall bounds and response truth
**Status:** fixed in issue #288 implementation

A bounded citation response must not hardcode `expandable`. Query one extra neighbor and derive it from unseen rows or transcript truncation; tests must cover both true and false cases.

## [2026-07-17] Cross-tool lifecycle writers must round-trip exact scope

**Severity:** HIGH
**Source:** PR #294 Full-tier review
**Scope:** `session_start`, scoped `append_session_event`, `session_checkpoint`, `session_wrap`, and their Python wrappers
**Status:** fixed in PR #294

Every lifecycle writer must establish the complete exact-scope coordinate set before persisting, including asserted nullable coordinates. Exact nullable scope is presence-sensitive: an explicitly asserted `null` key is not equivalent to an omitted key, so validators must check key presence before comparing values. Checkpoint and wrap cannot silently drop those coordinates or send a sibling tool's payload shape; tests must start a scoped lane, checkpoint it, wrap it, and prove the same exact scope is recovered end to end.

## [2026-07-17] Contract compatibility must compare semantic tool versions

**Severity:** MEDIUM
**Source:** PR #294 Full-tier review
**Scope:** server contract manifests and `openbrain-memory` compatibility checks
**Status:** fixed in PR #294

Required-tool presence is insufficient when the tool contract itself evolves. Compatibility must parse and compare each required tool's semantic version against the supported range, fail closed on malformed or incompatible versions, and test older, newer, malformed, and missing version declarations.

## [2026-07-18] Exact-scope upgrades need real-Postgres conflict and history tests

**Severity:** HIGH
**Source:** Issues #295/#297, Claude first-class memory rollout
**Scope:** `src/db/migrations/025_normalize_legacy_development_lanes.sql` and its live-Postgres test
**Status:** active

Legacy lane upgrades are data migrations, not ordinary tool behavior. Mock pools cannot prove PostgreSQL JSONB handling, case normalization, conflict predicates, idempotence, or preservation of existing lane IDs and events. Every changed upgrade predicate needs an env-gated real-pool test covering recognized and partially canonical shapes, repeated application, JSON null, unknown agent/source, server/channel/thread/project conflicts, multiple namespaces, and event-history continuity.

## [2026-07-17] First-class lifecycle runtimes must gate on the live manifest

**Severity:** HIGH
**Source:** PR #294 terminal audit and focused verification
**Scope:** `python/openbrain-memory` lifecycle routers and compatibility caching
**Status:** fixed in PR #294

Before start, append, checkpoint, or wrap, a first-class runtime must validate the current live contract manifest rather than trust construction-time or stale cached compatibility. Compatibility must require exact `schema_version` and `schema_hash` agreement with the supported contract in addition to required-tool checks; a matching tool list does not make a differently hashed or versioned schema safe. Tests must mutate the advertised manifest between lifecycle calls and independently vary `schema_version` and `schema_hash`, proving an incompatible long-lived runtime is rejected before the operation.

## [2026-07-20] Saturation handling must never silently drop acknowledged data

**Severity:** HIGH
**Source:** Issue #300, PR #305 (#293-family review)
**Scope:** `python/openbrain-memory/src/openbrain_memory/spool.py`
**Status:** active

### Pattern

`append_batch` FIFO-evicted previously-spooled groups to admit a new batch and
then returned success — silently destroying records already acknowledged as
`durable=True`/`SPOOLED`. Capacity limits must surface as backpressure
(explicit rejection, e.g. `SpoolFullError`, with the store unchanged) or as an
observable loss receipt — never as evict-then-return-success.

### Review Questions

- Under saturation, does any path drop already-acknowledged data and still
  report success?
- Is rejection all-or-nothing (store byte-for-byte unchanged on failure)?
- Do tests cover both line-count and byte limits, and assert prior records
  remain intact AND replayable after a rejected append?
- Will a future replay/recovery consumer see the loss, or replay a queue that
  already lost records?

## [2026-07-21] Contract-parity gates must pin sets, ranges, and reasons

**Severity:** MEDIUM
**Source:** PR #313 / PR development#44 review swarm 2026-07-21
**Scope:** `contracts/check-parity.ts`, `contracts/memory/parity-manifest.json`, `.github/workflows/ci.yml`, `scripts/validate-pr-body.ts`
**Status:** fixed-pre-merge

- Fixture discovery without an expected-id set lets the fixture corpus silently shrink; the manifest must pin the exact fixture-id set and the validator must fail on missing OR extra fixtures.
- CI's contract-parity change detection fell back to `HEAD^` on zero/empty push `before` SHAs, checking a narrower range than the pre-push hook; derive the base from the merge-base with `origin/main` instead.
- Empty-string checks alone accept placeholder runtime-specific reasons (`n/a`, `na`, `none`, `todo`, `tbd`); reason validation must reject the placeholder set case-insensitively in both the PR-body gate and the manifest validator.

## [2026-07-21] Instance-state validation latches need reset tests, not just resets

**Severity:** MEDIUM
**Source:** PR #314 (open-brain#310 scope-aware drain) review swarm 2026-07-21
**Scope:** `python/openbrain-memory/src/openbrain_memory/runtime.py` (`_replay_scope`, `_drain_spool`)
**Status:** fixed-pre-merge

### Pattern

`_drain_spool` latches `self._replay_scope` so replayed `session_start` results
validate against the parked unit's scope. The `finally` reset was correct, but
no test failed when it was deleted — the entire suite stayed green while the
regression (stale foreign scope failing every subsequent live `session_start`,
degrading all writes to SPOOLED) went undetected. Any instance-state latch that
changes validation behavior needs a test that exercises the *next* operation
after the latch should have cleared, and the test should be mutation-verified
(delete the reset, watch the test fail) before it counts as coverage.

### Review Questions

- Does any instance attribute temporarily change validation/dispatch behavior?
  If so, is there a test asserting the behavior *after* the temporary window?
- Was the guard test proven against the mutant (reset removed → test fails with
  the predicted failure mode)?
- Is the latch also reset per iteration inside loops, so later items cannot
  inherit a stale value if new code paths skip the tail reset?

## [2026-07-21] Identity-keyed sidecar dedupe must replace, not skip

**Severity:** MEDIUM
**Source:** PR #317 review swarm, 2026-07-21
**Scope:** `python/openbrain-memory/src/openbrain_memory/spool.py` (`_append_quarantined_units`, `_remove_quarantined_entries`, `_commit_replay_pass`)
**Status:** fixed-pre-merge

### Pattern

The quarantine sidecar deduped on `unit_key` with skip semantics ("crash-window
dedupe"): if the key already had an envelope, the fresh copy was silently
dropped — while the same commit still removed the unit from the main spool. An
operator-restored (possibly edited) unit that re-failed to threshold therefore
lost its current lines from BOTH files, and the sidecar kept stale content and
stale counts. Idempotency for an identity-keyed store must be implemented as
REPLACEMENT: re-entry writes the fresh envelope + lines (one envelope per key
per pass, last write wins for in-batch duplicates), which preserves the
crash-window idempotency property AND the newest content. Pair it with
reconcile-on-success: a unit that replays successfully removes any stale
sidecar entry for its key in the same locked commit, closing the phantom-entry
window left by a crash between the sidecar append and the main-file rewrite.

### Review Questions

- Does any dedupe-by-key path skip (drop) the new copy while another step in
  the same commit removes the source copy? What happens when the key
  legitimately re-enters (restore → re-fail)?
- Is idempotency implemented as replacement (converges to one fresh entry) or
  as skip (silently discards newer content)?
- After a success, is stale sidecar state for the same identity reconciled in
  the same locked commit, covering the crash window of the original append —
  and ordered so a second crash strands a retryable unit, never a phantom?
- Do tests cover the restore → re-fail path, in-batch duplicate keys, and the
  crash-then-success sequence?

## [2026-07-22] Migration-set compatibility must be prefix-based, not subset-based

**Severity:** MEDIUM
**Source:** PR #318 review swarm, 2026-07-22
**Scope:** `scripts/backup-lib.ts` (`compareMigrationSets`), `scripts/restore.ts`
forward-migration path
**Status:** fixed-pre-merge

### Pattern

`compareMigrationSets` classified a backup as `restorable_with_migrations`
whenever its applied list was a SUBSET of the repo migration list. Subset
membership cannot see ordering: a backup with an interleaved / mid-sequence
gap (applied 001,003 against repo 001,002,003) passed as restorable, and the
forward-migration path would then apply 002 AFTER 003 had already run — an
ordering the migration authors never wrote or tested, which set-comparison
validation after the fact cannot detect either (the final sets are equal).
Compatibility for ordered, append-only sequences must require the sorted
backup list to be an exact PREFIX of the sorted repo list; any interleaved
gap is a distinct fail-closed verdict (`incompatible_interleaved`), not a
restorable one.

### Review Questions

- Is any "older but upgradable" check implemented as set/subset membership
  over an ORDERED sequence (migrations, event logs, schema revisions)? It
  must be a prefix check.
- Does the interleaved-gap case (missing middle element) have its own
  fail-closed verdict and unit test, distinct from unknown/newer elements?
- Would the post-upgrade validation catch an out-of-order application, or do
  both paths converge to identical final sets (making the ordering bug
  invisible after the fact)?

## [2026-07-22] A retry bound must terminate the expiry-reclaim path, not just the fail() path

**Severity:** P2
**Source:** PR #350 / issue #343 review swarm, 2026-07-22
**Scope:** `src/maintenance-queue.ts` `claimDueJobs` expired-lease reclaim
**Status:** fixed

### Pattern

`claimDueJobs` reclaimed *every* expired `running` row and incremented
`attempts` unconditionally, while only the explicit `fail()` path honored
`max_attempts`. A handler that keeps blowing its lease (hang/crash, never
calling complete/fail) was therefore reclaimed and re-executed forever, past
its bound — the retry cap was enforced on one exit but not the other. The fix
terminates in the same claim statement: an expired running row whose
already-consumed execution attempts (`attempts`, which counts leases) have
reached `max_attempts` is dead-lettered instead of reclaimed — lease cleared,
`terminal_at`/`dead_lettered_at` stamped, a content-free `lease_expired`
category stored — and is excluded from `RETURNING` so the runner never treats
it as claimed. `attempts` is left at the number of leases actually consumed,
never inflated past `max_attempts` by the sweep. Rows with budget remaining
still reclaim normally.

### Review Questions

- Does every path that consumes an attempt (explicit failure AND lease-expiry
  reclaim) enforce the same `max_attempts` bound, or can one path retry past
  it?
- When a bounded row terminates, is it moved to a real terminal state that
  satisfies every migration CHECK (lease cleared, terminal/dead-letter
  timestamps set, valid category) — or merely left un-selected and stuck
  `running`?
- Does the counter that gates the bound keep a stable meaning (executions
  consumed) across both paths, or does the reclaim path inflate it?
- Is there a real-database regression that fails on the pre-fix code by proving
  the exhausted row cannot be reclaimed again?

## [2026-07-22] The state-machine transition must derive from the durable row, not the caller's job object

**Severity:** P2
**Source:** PR #350 / issue #343 Terra terminal audit, 2026-07-22
**Scope:** `src/maintenance-queue.ts` `MaintenanceQueue.fail`, `MaintenanceQueueRunner.execute/fail`
**Status:** fixed

### Pattern

`fail()` decided the terminal state (`attempts >= $3`) and the retry schedule
(`nextRunAfter = now + maintenanceBackoffMs(input.job)`) from the caller-supplied
`input.job` retry fields — `maxAttempts`, `attempts`, `backoffBaseMs`,
`backoffMaxMs`. The runner hands the **same** `MaintenanceJob` object to the
registered handler (`handler(job)`), so a handler could mutate those fields
before throwing and thereby override the persisted policy: inflate
`maxAttempts` to dodge the terminal bound (dead-letter → indefinite requeue),
or shrink `backoffBaseMs`/`backoffMaxMs` to collapse the schedule. The durable
row's policy was authoritative on disk but ignored by the transition.

The fix moves the whole decision to the persisted columns inside the
lease-token-guarded UPDATE: terminal state is `attempts >= max_attempts`, and
`run_after` is computed in SQL from the row's own `attempts`, `backoff_base_ms`,
`backoff_max_ms` — `now + LEAST(backoff_base_ms * 2 ^ LEAST(GREATEST(attempts-1,
0), 30), backoff_max_ms)` — mirroring `maintenanceBackoffMs()` exactly (first
retry uses base, exponent bounded, cap preserved). No caller-supplied
retry-policy value reaches the transition; `input.job` is used only for the
id + lease-token guard, which `claimDueJobs` minted. The runner additionally
captures immutable claim identity (`id`, `kind`, `leaseToken`) before invoking
the handler and binds `complete`/`fail` to it, so handler mutation of
`job.id`/`job.leaseToken` cannot redirect the guard to another row or make the
regression vacuous. Content-free category and stale-lease no-op semantics are
unchanged. See also [2026-07-22] retry-bound-must-terminate-the-expiry-reclaim
above — both paths now honor `max_attempts` from the row, not from any object.

### Rule

A durable state-machine transition (terminal decision, next-run time, any
policy gate) must be derived from persisted row columns inside the guarded
UPDATE — never from a mutable in-memory object that untrusted or handler code
holds a reference to. The passed object may supply only opaque identity used in
the WHERE guard (here id + lease token), and even that identity should be
snapshotted before handler code runs.

### Review Questions

- Does a state transition read retry/policy values from a caller-passed object,
  or from the row's own columns? If the same object is handed to a handler that
  runs before the transition, mutation of those fields silently rewrites policy.
- Is the terminal bound and the schedule computed in SQL over persisted columns,
  or in JS over the input job? A JS computation over the input is caller-owned.
- Is the claim identity used in the lease-token guard snapshotted before handler
  code runs, so mutation of `id`/`leaseToken` cannot redirect or void the guard?
- Does a real-database regression enqueue a known policy, mutate the retry
  fields via the handler (or the returned job) before failing, and prove the
  persisted row still dead-letters/schedules per the durable policy — failing on
  the pre-fix code?
## [2026-07-22] Destructive-teardown success must fail closed on an unrecognized response shape

**Severity:** MEDIUM (P2)
**Source:** PR #348 review swarm, 2026-07-22 (issue #322 live recall gate)
**Scope:** `eval/open-brain/live/transport.ts` (`OpenBrainLiveClient.archive`),
any client wrapper mapping a destructive tool's success body to a terminal
"already gone / cleanup clean" outcome
**Status:** fixed-pre-merge

### Pattern

`archive` mapped `archived === true` to `"archived"` and treated **every other
success** as `"already_absent"`. That default is a false-pass: a shape drift, a
differently-worded body, an empty body, or a success that did not actually
tombstone the row all collapsed to "the row is gone", so teardown reported clean
cleanup while a live record was stranded and the gate could still return PASS —
the exact mutation-safety guarantee the per-record teardown exists to provide.
For a destructive operation, only the tool's REAL success shapes are safe to
accept. `archive_entry` (src/tools/archive-entry.ts) has exactly two:
`{id, table, archived: true}` for a tombstoned row, and the EXACT plain-text
body "Already archived or not found" (trimmed, case-insensitive) for the
zero-row no-op. Accept only those — a structured `archived: false` (the server
never emits it), a broad substring ("not found" / "no rows"), or the marker in
mixed text are all rejected, because they could false-pass on unrelated output.
Every other success throws a content-free `LiveTransportError`
(`archive_entry:unrecognized-success`) so an ambiguous success can never be
counted as clean teardown.

### Review Questions

- Does a wrapper over a destructive/idempotent tool have a catch-all branch that
  maps *any* non-confirmed success to "already done / nothing to do"? That
  branch fails OPEN — invert it to fail closed on unrecognized shapes.
- Are the accepted positive shapes an explicit allowlist of the tool's REAL
  success bodies (confirmed-success OR an EXACT absent marker, not a broad
  substring), with everything else — including an invented `false` field or a
  marker in mixed text — throwing?
- Is the thrown label content-free (tool + marker), never the raw body — and is
  there a test proving an unrecognized success (including an empty body and a
  non-marker plain-text body) throws rather than silently passing?
- If the operation's response can be lost after a server-side commit, is that
  residual documented (a committed row can be stranded) rather than papered over
  with a broad query-shaped sweep that would violate mutation-safety?

### Follow-up [2026-07-22, PR #348 terminal audit]: destructive success must bind returned identity/table

The initial fix accepted `archived: true` alone. `archive_entry` actually
returns `{id, table, archived: true}`, and `archived: true` does not say WHICH
row was tombstoned. An echo for a different id/table, or a response missing them,
would be credited as this record's cleanup while the real record stayed live.
The terminal fix requires the returned `id`/`table` to EXACTLY match the
requested record; anything else throws `archive_entry:identity-mismatch`
(content-free). Extend the review question: for a destructive confirmed-success
shape, is the confirmation BOUND to the requested record's identity/table, not
just a bare `archived: true`? Tests must cover archived:true with a wrong id,
wrong table, and missing id/table.

## [2026-07-22] Unknown/foreign retrieval hits must fail closed, never drop before scoring

**Severity:** MEDIUM (P1)
**Source:** PR #348 terminal audit, 2026-07-22 (issue #322 live recall gate)
**Scope:** `eval/open-brain/live/gate.ts` (`toFixtureRetrieval`), any scorer that
maps live retrieval hits back to fixture/expected ids before computing metrics
**Status:** fixed-pre-merge

### Pattern

`toFixtureRetrieval` mapped each hit's server id back to a fixture id and
**silently skipped** any hit not in the seed map, and it never checked the hit's
namespace at all. An unmapped or foreign-namespace hit therefore disappeared
before scoring: ranks compressed (recall/MRR looked better than reality), a real
cross-namespace leak left `namespace_leaks=0`, and the run could still reach
PASS. Dropping an unaccountable hit is fail-OPEN. The fix validates EVERY hit
before mapping — it must carry the EXACT bound primary namespace AND an id this
run created (present in the seed map, which holds both primary and negative
seeded ids) — and throws a content-free `LiveTransportError`
(`search_brain:foreign-namespace` / `:unknown-hit`) otherwise, which defers to
teardown and blocks PASS. A KNOWN negative-role id surfacing under the primary
namespace is NOT a validation failure: it maps and flows to the scorer, which
counts it as the namespace leak (that is how in-namespace leakage is scored).

### Follow-up [2026-07-22, PR #348 terminal fix]: the parse boundary drops entries a layer earlier than the mapper

`toFixtureRetrieval` only ever sees the hits `parseHits` (the transport parse
boundary in `transport.ts`) chose to emit. `parseHits` was itself fail-OPEN: a
non-array / invalid-JSON success body returned `[]` (conflating a malformed
result set with a real empty read), and any non-object row or row lacking a
string id was silently skipped. Those discarded raw results never reached the
gate validator, so the gate-level fix above could not see them — the same
rank-compression / hidden-leak hole, one layer up. Fix `parseHits` to fail
closed: a success body MUST be a JSON array (`search_brain:malformed-results`
otherwise) and EVERY entry MUST be an object with a non-empty string id
(`search_brain:malformed-hit` otherwise). Keep namespace OPTIONAL at the parse
boundary so a valid-but-namespace-less hit still reaches the gate and is
classified there as `foreign-namespace` — moving the namespace check into
`parseHits` would mask that distinct gate-level classification. The isolation
probe (`attemptRead`) shares `parseHits`, so a malformed negative-namespace body
throws instead of being misread as `hitCount: 0` (an empty allowed read).

### Review Questions

- Does a retrieval/scoring mapper `continue`/skip hits it cannot map? A skipped
  hit compresses ranks and can hide a leak — validate and fail closed instead.
- **Does the layer that PARSES the raw result set (before the mapper) also fail
  closed?** A parser that returns `[]` for a non-array body, or skips a
  non-object / idless row, drops the evidence before the mapper can validate it —
  fix both the parse boundary and the mapper.
- Is the retrieved row's namespace (or tenant/scope) checked to be EXACTLY the
  one the query bound, so a row returned from outside the bound scope fails the
  run rather than being scored or dropped?
- Are the expected-but-present hits still returned alongside the bad one in the
  test, proving the failure fires even when good data is also present (not just
  on an all-bad result)?
- Is the failure label content-free (no hit id, namespace value, or body)?
- Do the read path (`search`) and the isolation-probe path (`attemptRead`) share
  ONE parse boundary, so a malformed body cannot be misread as an empty allowed
  read on the probe path?

## [2026-07-22] Seed (create) proof must bind merged:false and the exact namespace

**Severity:** MEDIUM (P2)
**Source:** PR #348 terminal audit, 2026-07-22 (issue #322 live recall gate)
**Scope:** `eval/open-brain/live/transport.ts` (`OpenBrainLiveClient.logMemory`),
any client that treats a `log_*` / upsert response as a fresh this-run creation
it will later mutate
**Status:** fixed-pre-merge

### Pattern

`log_thought` / `log_decision` return `{id, namespace, merged}` where
`merged = !isNew` (src/tools/log-thought.ts, log-decision.ts): the tool upserts
`ON CONFLICT (content_hash, namespace)`. The seeder ignored `merged` and
defaulted a missing `namespace` to the requested one. In a REUSED namespace
(see the adversarial reusable/truncated-run-id entry), a second run's seed
upserts onto a prior run's stranded row and returns `merged: true` with the
prior row's id — which the gate then adopted as a current-run creation and would
archive on teardown, tombstoning a row this run did not create (and, symmetric,
counting a prior row toward this run's scoring). The fix fails closed
content-free unless the response proves a fresh create: `merged` present and
`false`, a returned namespace EXACTLY equal to `opts.namespace` (no defaulting a
missing/other namespace), and a present id. Labels: `:merged-upsert`,
`:missing-merged`, `:namespace-mismatch`, `:missing-id`.

### Review Questions

- Does the create path assert the write actually CREATED a row (an explicit
  `merged: false` / `created: true` / affected-rows signal), or does it treat any
  2xx-shaped response as a new record it now owns?
- For an upsert-backed "create", can a merged response onto a pre-existing row
  be mistaken for this caller's row and later mutated/deleted?
- Is the returned namespace/scope required to EXACTLY equal the requested one,
  with no defaulting a missing field back to the request (which masks a write
  that landed elsewhere)?
- Is every rejection content-free (tool + reason), and is there a test for each
  of merged:true, missing/non-boolean merged, wrong/absent namespace, missing id?

### Note on canonicalization

`log_thought` returns `canonicalNamespace(ns)` and `log_decision` returns raw
`ns`. For the eval-live namespace (`eval-live-recall-<run-id>`),
`canonicalNamespace` is a no-op (it only rewrites the shared namespace), so the
exact-equality check is safe. A tool that seeds into the shared namespace would
need to compare against the canonical form — check the tool's actual return
transform before pinning exact-equality.

## [2026-07-22] Whole-pack trimming must reconcile section truth, not only retained items

**Severity:** MEDIUM (P2)
**Source:** PR #353 / issue #327 Full-tier review
**Scope:** `src/tools/agent-context-pack-budget.ts`, ranked context-pack sections
**Status:** fixed-pre-merge

### Pattern

A whole-pack fitter can correctly drop low-priority items and citations while
leaving the section envelope's own state stale. In PR #353, `durable_memory`
reported `truncated: false` after ranked tail items were removed, and an empty
retained envelope lacked a stable whole-pack empty reason. Counts and citations
were correct, but the section still lied about whether the caller received the
full result. The fix reconciles every trimmed return path: any dropped item sets
`truncated: true`; an emptied-but-retained envelope reports
`empty_reason: "whole_pack_budget"`; counts, citations, warnings, and serialized
budget are rechecked after metadata changes.

### Review Questions

- When a pack-level fitter drops items, does it update the section's own
  `truncated` and `empty_reason`, not only arrays and counts?
- Are both partial-tail-drop and all-item-drop paths covered by tests that fail
  against the old metadata behavior?
- If reconciliation adds metadata, is the serialized pack measured again so the
  fix cannot exceed the hard budget?
- Do citations and warnings derive from the final retained item set?

### Recurrence (PR #357 / issue #328)

The same defect recurred in a different code location: the structured
`profile_guidance` / `process_guidance` / `repo_facts` sections re-fit through
`fitItemSection`, which — unlike `fitRankedItemSection` — does NOT self-reconcile
the section body. So the reconciliation must happen in the **caller**
(`admitStructuredSection` in `agent-context-pack.ts`): after a trim it stamps
`truncated: true`, and `empty_reason: "whole_pack_budget"` when the trim empties
an admitted envelope. Stamp before the serving/overflow checks so the added keys
are counted against the surviving budget, and only mutate the trimmed body (a
no-trim `fitItemSection` returns the loader's genuine-empty body by reference —
mutating it would falsely stamp a real no-data empty). Extra review question:
when a section reconciles at the caller rather than inside the fitter, is a
genuine no-data empty (loader emitted `items: []`) left unstamped?

## [2026-07-22] Requested degraded sections and cited items need self-contained truth

**Severity:** MEDIUM (P2)
**Source:** PR #353 / issue #327 Terra terminal audit
**Scope:** `src/tools/agent-context-pack-durable-memory.ts`, context-pack section/citation contracts
**Status:** fixed-pre-merge

### Pattern

A requested section that fails internally must not disappear into the same shape
as an unrequested section. PR #353 initially omitted `durable_memory` when recall
threw, leaving only a degraded warning; callers could not distinguish "not
requested" from "requested but unavailable." It also put `source_ref` only on
the separate citation even though each recalled item claimed item-level
resolvability. The fix returns a truthful empty `recall_failed` envelope and
builds one bounded `source_ref` per row, attaching the same value to both item and
citation. Whole-pack trimming then prunes citations by retained `citation_id`,
keeping an item/citation/source-ref bijection.

### Review Questions

- Does every explicitly requested degraded section return a stable empty envelope
  with zero counts and a specific content-free reason, while an unrequested
  section remains absent?
- If an item contract promises `source_ref`, is it present on the item itself and
  equal to the matching citation's reference?
- After partial trim, all-item trim, or whole-section starvation, are there any
  dangling citations or source refs?
- Is duplicated item/citation provenance charged to the serialized hard budget,
  and do higher-priority sections still survive unchanged?

## [2026-07-22] Canonical hash text must not depend on nondeterministic array_agg order

**Severity:** P2
**Source:** PR #356 / issue #345 terminal audit, 2026-07-22
**Scope:** `src/embedding-canonical.ts` `decisionCanonicalText`; the decision
writers `src/tools/log-decision.ts`, `src/rest-api.ts` (`POST /decisions`),
`src/tools/update-entry.ts`; the repair registry `src/embedding-targets.ts`
(decisions `sourceHash`)
**Status:** fixed

### Pattern

Decisions embed and hash the SAME canonical string, built by
`decisionCanonicalText`. `content_hash` is baked at INSERT from that string. Both
INSERT writers dedupe on `ON CONFLICT (content_hash, namespace)` and, on
conflict, MERGE tags via
`array_agg(DISTINCT tag) FROM unnest(decisions.tags || EXCLUDED.tags)` —
**without recomputing `content_hash`**. Postgres does not guarantee
`array_agg`'s order. The canonical text folded tags in raw array order, so a
post-conflict row (with its arbitrarily reordered merged tag set) recomputed a
DIFFERENT source hash than the stored one. The embedding-repair registry then
flagged the row as false `source_drift`, regenerated a different vector, and
rewrote the `content_hash` dedup key on **every** repair pass — perpetual churn
on rows nobody edited. `update_entry`, which recomputes the hash from the merged
row, had the same exposure from any tag reordering.

### Rule

Any text fed to a stored content hash must be a deterministic function of the
row's semantic content, invariant under representations the storage layer may
reorder (`array_agg`, `jsonb_agg`, set-returning joins, unordered `text[]`). Fix
it at the ONE shared canonicalizer both the writer and the repair/recompute path
call — normalize (dedupe + sort) there, without mutating the caller's input, so
the INSERT hash, the post-conflict merged-row recompute, and every other writer
converge on one string. The fix sorts only `tags` (the merged column);
`alternatives` keeps caller order because its merge does not reorder it. A merge
can only fire when the canonical text (and thus the normalized tag set) is
already identical, so the `array_agg` union only re-adds duplicates of an
existing set — it never introduces a genuinely new tag that should change the
hash.

### Review Questions

- Does any column that feeds a stored hash get merged/aggregated by SQL
  (`array_agg`, `jsonb_agg`, `||` on arrays) in a way the hash is NOT recomputed
  from? If so, is the hash input order-invariant for that column?
- Is the normalization at the single shared builder both the writer and the
  repair registry call, so the two can never diverge?
- Does normalization dedupe AND sort, and does it avoid mutating the caller's
  input array (a fresh array, not an in-place `.sort()`)?
- Are there regression tests for reversed and duplicated tag inputs, AND a live
  `ON CONFLICT` merge test proving the merged row is not flagged `source_drift`
  and its `content_hash` is preserved? Both must fail on the pre-fix code.
- Were parallel expectations updated (e.g. `embedding-targets.test.ts`) — a
  reference asserting the old raw-order fold is itself a latent regression.

## [2026-07-22] Empty-envelope `empty_reason` must reconcile with the counters that produced it

**Severity:** MEDIUM
**Source:** PR #359 (P2), fix `fix(333)`; #333 prior-context suppression
**Scope:** `src/tools/agent-context-pack-durable-memory.ts`, any section that emits both an `empty_reason` and content-free counters
**Status:** active

### Pattern

A section that emits a zero-item envelope AND separate counters (here
`prior_context_suppression: {recalled, suppressed, net_new, emitted}`) can put
the two in direct contradiction. `durable_memory` derived `empty_reason` from
only two causes — `all_suppressed` (all recalled rows were prior context) vs
`no_matches` (recall found nothing) — and missed a third: a record survived
suppression (`net_new > 0`) but produced no emittable body (null / empty-string
`content_preview`, or the char budget was too small for even the first body).
That case fell through to `no_matches`, so the envelope claimed recall found
nothing while `net_new > 0`, `emitted = 0`, and `truncated = true` all said a
net-new match existed and was dropped. The counters were correct; the reason
lied about them.

The truthful fix adds a distinct, content-free reason (`content_unavailable`)
and derives `empty_reason` in the only order that reads correctly:
`net_new > 0` → `content_unavailable`; else recalled-and-all-suppressed →
`all_suppressed`; else → `no_matches`. `net_new` is tested first so a
net-new-but-unemittable section can never be mislabeled. The distinction is
kept truthful without inventing a body: the reason is derived from the same
counters the envelope already exposes, not from re-reading content.

Note the boundary split: the section loader owns the *genuine* empty reasons
(no data / all-suppressed / content-free); the whole-pack allocator separately
stamps `whole_pack_budget` only when its own re-fit trims a non-empty body to
empty. The two never collide because the content-free case emits no body for the
allocator to trim.

### Review Questions

- Does a zero-item / empty envelope carry an `empty_reason` AND separate
  counters? Do all counter combinations map to a distinct, truthful reason, or
  can a real state (e.g. `net_new > 0, emitted = 0`) fall through to a reason
  that contradicts the counters?
- Is the reason derived from the counters/state the envelope already exposes,
  or re-derived from a narrower predicate that misses a case?
- Are the empty-reason branches ordered so the most specific truthful cause wins
  (net-new-but-unemittable before "no matches")?
- Is there a regression for the null AND empty-string content case proving the
  reason, `truncated`, the counters, and empty citations together — and does it
  fail on the pre-fix code (received the wrong reason)?
- Is there a no-over-suppression guard proving an unemittable record does not
  hide or starve a sibling record that IS emittable (something emitted ⇒ no
  content-free empty reason)?
- If a downstream allocator can also stamp an `empty_reason`, is the ownership
  boundary explicit so the loader-owned and allocator-owned reasons cannot
  overwrite each other in the wrong case?

## [2026-07-22] A "non-retryable" classification is inert unless the queue honors it

**Severity:** MEDIUM
**Source:** Issue #346 (MAINT-4), graph-derivation queue integration
**Scope:** `src/maintenance-queue.ts` (`fail`, runner dispatch), any handler that
throws a terminal/non-retryable error
**Status:** active

### Pattern

The graph-derivation handler classified drift (revoked approval, retired,
content re-observed, stale revision) as a `GraphDerivationTerminalError` — but
the class was only a plain `Error`, and `MaintenanceQueue.fail` dead-lettered
solely on `attempts >= max_attempts`. So a "terminal" failure was correctly
*named* yet still burned the full bounded-retry budget (N backoff attempts)
before dead-lettering. A classification that no code branches on is a comment,
not behavior. The mirror of this on the write side is equally easy to miss: a
handler must not be able to force an *immediate* dead-letter for a genuinely
retryable failure either — the terminal decision has to be a distinct,
queue-owned signal, not something derivable from a handler-mutable field.

### Rule

When a handler can declare a failure non-retryable, the queue must (1) own the
marker type at its own boundary (handlers depend on the queue, never the
reverse — a handler's terminal subclass `extends` the queue marker so the queue
imports nothing from the handler), (2) identify it by *type* at the dispatch
boundary and pass an explicit `terminal` flag into `fail`, and (3) fork the
persisted-row UPDATE so a terminal failure dead-letters on THIS attempt
regardless of remaining budget, while an ordinary error keeps the exact bounded
backoff/retry policy. Derive the decision from the durable row + the flag, never
from the handler-supplied job object. Store a distinct content-free category
(`terminal`) so dead-letter analysis can tell a policy-driven immediate
dead-letter apart from retry-exhaustion and expired-lease. If the category is
CHECK-constrained, ship the migration (fresh inline + a named re-derive for
already-upgraded DBs, mirroring the `lease_expired` compat migration) or the
first terminal write fails on upgraded databases.

### Review Questions

- Is the terminal/non-retryable error a queue-owned type the handler extends, or
  a bare `Error` the queue can't distinguish from a retryable one?
- Does `fail` actually branch on a terminal signal, or only on
  `attempts >= max_attempts`? Is there a test with `attempts < max_attempts`
  proving dead-letter-on-attempt-1 for terminal AND bounded retry for ordinary?
- Is the terminal decision derived from the durable row + an explicit flag, not
  from a handler-mutable `job` field a handler could set to force a dead-letter?
- Is a NEW `last_error_category` value added to BOTH the fresh inline CHECK and a
  named re-derive migration for already-upgraded DBs, with a drift-guard test?
- Is the failure log content-free (stable category only, never the reason text)?

## [2026-07-23] Snapshot validation and derived writes must share one locked transaction

**Severity:** HIGH (P1)
**Source:** PR #358 opposite-runtime terminal audit (issue #346)
**Scope:** `src/graph-derivation-handler.ts`, multi-statement maintenance derivations
**Status:** fixed-pre-merge

### Pattern

The graph handler validated a source snapshot, then stamped the final derivation
hash and wrote nodes, links, and stale-edge pruning in independent statements.
A later transient failure could leave the completed hash with an incomplete graph;
a retry then returned `unchanged` and never repaired it. The same gap let an old
job pass its snapshot check, pause, and overwrite a newer derivation after the
source advanced.

### Rule

Lock and revalidate the authoritative source row with `SELECT ... FOR UPDATE`,
then run the entire derived write set on the same checked-out client and in the
same transaction. Commit the source proof, final hash, nodes, links, and pruning
as one unit; rollback all of them on any error. This serializes source updates
with derivation so an old job either finishes before the source advances or sees
drift and terminal-stops after the newer revision commits.

### Review Questions

- Can a final hash/status stamp commit before any later derived write or prune?
- Do snapshot validation and every derived mutation use one transaction/client?
- Is the source row locked so concurrent source updates cannot invalidate the
  snapshot between validation and commit?
- Does a real-PostgreSQL fault-injection test prove a mid-derivation failure leaves
  no partial hash, nodes, or links and that retry converges?
- Does a deterministic old/new interleaving test prove the newer snapshot remains
  final and an obsolete job cannot overwrite it?

## [2026-07-23] Canonical anchor identity must also satisfy display-name uniqueness

**Severity:** MEDIUM (P2)
**Source:** PR #358 exact-head terminal audit (issue #346)
**Scope:** `src/graph-derivation.ts`, entity tables with independent canonical-id and display-name unique indexes
**Status:** fixed-pre-merge

### Pattern

An anchor upsert correctly arbitrated on stable `canonical_id`, but the table also
enforced live uniqueness on `(namespace, entity_type, lower(name))`. Two distinct
source IDs with the same title therefore missed the canonical conflict and failed
on the name index with deterministic `23505`; a rename onto a sibling title failed
the same way.

### Rule

When one row is constrained by independent identity indexes, the stored values
must satisfy all of them. Keep the human label readable, append the stable
canonical identity to form a bounded collision-safe storage name, and preserve
the complete display label separately. Prove same-title creation and
rename-to-existing-title against real PostgreSQL.

### Review Questions

- Does an upsert arbitrate one unique index while another applicable index can
  still reject the proposed row?
- Can two stable IDs legitimately share a human title, and if so is the stored
  name deterministic, readable, bounded, and collision-safe?
- Does a real-PostgreSQL regression cover both duplicate-title creation and a
  rename onto an existing title?

### Follow-up: display state must refresh independently of structural derivation

A collision-safe name is incomplete if the unchanged short-circuit ignores a
pure title rename. The derivation hash intentionally covers the node set, not the
human label, so the `unchanged` path must separately compare and refresh the
stored name plus `metadata.display_name`. Production callers must pass the full
label to the primitive and bound only the indexed storage name; slicing upstream
silently destroys the supposedly preserved display value. Tests need a pure
rename with identical topics/people and a label longer than the storage limit.

## [2026-07-23] Maintenance handlers must reject unsupported job versions before parsing

**Severity:** MEDIUM (P2)
**Source:** PR #358 exact-head terminal audit (issue #346)
**Scope:** `src/graph-derivation-handler.ts`, versioned maintenance payloads
**Status:** fixed-pre-merge

### Pattern

`graph.derive` enqueue stamped a payload version, but its handler validated only
the payload shape. A future-version payload that remained structurally compatible
could execute under an older deployment after rollback, applying obsolete
semantics instead of failing closed.

### Rule

Every versioned handler checks the exact job version before payload parsing or any
read/write. Unsupported older or newer versions are permanent input failures and
must use the queue-owned terminal path. Tests cover current-version dispatch plus
both version directions.

### Review Questions

- Is the enqueued version checked by the handler, or merely persisted?
- Does the guard run before payload parsing and database access?
- Do older and future versions terminal-stop immediately while the exact current
  version still dispatches?

## [2026-07-23] Fallback/projection envelopes must inherit the real upstream reason, not fabricate a complete empty

**Severity:** MEDIUM
**Source:** PR #361 review swarm, 2026-07-23 (issue #334 cited reflex pointers)
**Scope:** `src/tools/agent-reflex-pointers.ts` and any thin wrapper/projection
that re-derives a section envelope from an upstream context-pack section
**Status:** fixed-pre-merge

### Pattern

The new `agent_reflex_pointers` tool projects a subset of the shared
`agent_context_pack` build. On the degraded/empty path it built its own envelope
with `truncated: false` and a locally-invented empty reason, discarding the
upstream section's actual `truncated` flag and `empty_reason`. So a reflex
response reported a clean complete read while the upstream `durable_memory` /
pointers section had truncated its ranked tail or was empty for a specific
content-free cause. A projection layer that fabricates its own "everything is
here" envelope is the same lie as a fallback that maps any success to
"complete" — the truncation/empty truth lives upstream and must be carried
through, not regenerated. The fix inherits the upstream section's `truncated`,
`empty_reason`, and counts verbatim into the projected envelope, only narrowing
the item/citation set, and reconciles the projected `truncated`/`empty_reason`
if the projection itself drops rows.

This is the projection-layer sibling of the whole-pack reconciliation entries
([2026-07-22] whole-pack-trimming-must-reconcile-section-truth and
[2026-07-22] empty-envelope-empty_reason-must-reconcile-with-the-counters):
those fix the fitter/loader; this one fixes a thin tool built ON TOP of an
already-reconciled section, which must not overwrite that reconciled truth with
a default.

### Review Questions

- Does a wrapper/projection over an upstream section synthesize its own
  `truncated`/`empty_reason`/counts, or inherit the upstream values? A synthesized
  default (`truncated: false`, generic empty reason) hides a real upstream
  truncation or content-free empty.
- If the projection itself drops items (narrows to a subset), does it re-stamp
  `truncated: true` on top of the inherited state rather than replacing it?
- Is there a regression proving a projected envelope reports the SAME
  `empty_reason` the upstream section produced (e.g. `content_unavailable`,
  `all_suppressed`, `whole_pack_budget`), and that an upstream-truncated section
  stays truncated in the projection — failing on the pre-fix fabricated-empty
  code?

## [2026-07-23] Persisted observations must reject duplicate identity before mutating, and receipt fields must be reachable and truthful

**Severity:** MEDIUM
**Source:** PR #365 review swarm, 2026-07-23
**Scope:** any tool that persists an observation/record keyed by a derived
identity and returns a structured receipt
**Status:** fixed-pre-merge

### Pattern

Two coupled receipt-truth defects shipped together:

1. **Dedupe-after-mutation.** The write checked for an existing row with the same
   derived identity but only AFTER it had already begun mutating (or after the
   INSERT raced), so a duplicate identity could either partially apply or return a
   "created" receipt for a row it did not create. Identity-keyed persistence must
   reject the duplicate BEFORE any mutation — either a pre-mutation existence
   check inside the same locked transaction, or an `ON CONFLICT` that provably
   distinguishes a fresh create from a merge and returns the honest verdict
   (compare the [2026-07-22] seed-proof entry: `merged:false` proves a real
   create; a merge must not be reported as a creation).
2. **Unreachable / untruthful receipt fields.** The receipt advertised fields
   whose producing branch could never run (a status the code path no longer
   emits) or whose value contradicted what was persisted (a count/id that did not
   reflect the actual write). A receipt field that no branch can populate, or that
   is derived from a different value than the one written, is a dead or lying
   contract — every advertised field must be reachable and derived from the
   persisted row.

### Review Questions

- Does the write reject a duplicate derived identity BEFORE mutating (locked
  existence check or conflict-aware upsert), or can a duplicate partially apply /
  be reported as a fresh create?
- Is every receipt field reachable — is there a code path that actually emits
  each advertised status/field, and a test asserting the dead ones are absent
  (see the quality lane's unreachable-bucket entry)?
- Do the receipt's counts/ids/flags derive from the persisted row, so they cannot
  contradict what was written (see the seed-proof and whole-pack-truth entries)?
- Is there a regression that submits the same identity twice and proves the second
  call is rejected (no mutation, honest verdict), failing on the pre-fix
  mutate-then-check ordering?
