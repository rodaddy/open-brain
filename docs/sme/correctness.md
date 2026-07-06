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
**Source:** Issues #82, PR #73 review loop
**Scope:** `python/openbrain-memory/**`
**Status:** active

### Pattern

Wrapper tests that only assert a method name or `probe=True` can pass while the
real MCP tool rejects the payload. PR #73 needed several fixes because facade
methods forwarded unsupported top-level fields or missed required fields.

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
source) lane succeeds; non-null channel mismatch still denies; live-Postgres
suite proves the real ON CONFLICT create/race + scope denial.

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
