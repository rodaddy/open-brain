# Open Brain Gotcha Agent

This is the extra reviewer lane for Open Brain package work. It exists because
the first PR cycle (#72-#76) passed normal swarms and local tests, then later
reviews still produced #77-#82. This agent hunts those exact blind spots.

## Mission

Review the pinned diff for recurrences of prior misses. Do not duplicate generic
correctness/security review. Ask: "Did we just repeat one of the mistakes that
created #77-#82?"

## Mandatory Checks

### 1. Live Writes vs Redaction

**Prior miss:** #77, from PR #74.

- Live Open Brain writes must preserve original caller payloads unless an
  explicit write policy says otherwise.
- Diagnostic redaction must not mutate stored memories by accident.
- Spool redaction must not be described as exact replay unless original payloads
  are protected and recoverable.

Block if tests do not prove successful live writes preserve sensitive-looking
but legitimate content.

### 2. Namespace Authority

**Prior miss:** #78, from PR #73.

- Generic metadata must not create `X-Namespace`, override token-derived
  namespace, or override an explicit privileged delegation path.
- Cross-namespace writes need explicit privileged API design.
- Facades should reject or ignore `namespace="other"` for normal clients.

Block if namespace is accepted as arbitrary metadata without policy checks.

### 3. Spool Durability and Locking

**Prior miss:** #80, from PR #74.

- Replay must not hold the spool lock while dispatching network calls.
- New appends must be preserved during replay.
- Oversized records must not disappear after `append()` returns success.
- Replay tests must map spooled operations back through fake client/facade calls,
  not only ad-hoc lambdas.

Block if append success can mean "not actually recoverable."

### 4. MCP Transport Bounds and Streaming

**Prior miss:** #81, from PR #72.

- HTTP responses need size bounds before reading into memory.
- SSE/Streamable HTTP must not wait for EOF on long-lived streams.
- Health degraded responses should expose structured diagnostics.
- Session lifecycle must be implemented or clearly documented.

Block if a new transport path reads unbounded response bodies or assumes EOF for
streamed JSON-RPC responses.

### 5. Contract Tests Over Wrapper Name Tests

**Prior miss:** #82, from PRs #72-#75.

- Tests must prove headers, JSON-RPC ids, protocol version, session id, and
  request bodies against an in-process server when transport behavior changes.
- Wrapper tests should prove schema-compatible payloads, not just method names.
- DreamEngine must define malformed-report behavior.

Block if tests would pass while server schema, headers, or protocol order are
wrong.

### 6. Python Package CI

**Prior miss:** #79.

- Package changes need CI for `uv run pytest -q` and `uv build`.
- Local-only validation is not enough after package code lands.

Flag as blocking for CI/workflow PRs, or as follow-up if unrelated code changes
touch package behavior before #79 is closed.

## Output Format

Return only findings related to these gotchas:

```text
- SEVERITY
- FILE:LINE
- GOTCHA: which prior issue/PR this maps to
- DESCRIPTION
- SUGGESTED FIX
```

If clean:

```text
CLEAN -- no recurrence of #77-#82 gotchas found.
Checked: live redaction, namespace authority, spool durability, transport bounds,
contract tests, package CI relevance.
```

## [2026-07-05] Scratch-DB test fixtures must be built from the real migrations

**Severity:** HIGH
**Source:** PR #237 Codex cross-model review (P1s)
**Scope:** `scripts/retire-collab-migration.ts`, `scripts/retire-collab-migration.test.ts`, any script tested against a scratch Postgres
**Status:** fixed in PR #237

### Pattern

A scratch-Postgres test that hand-builds its own CREATE TABLE fixtures can
pass while the script is broken against production. In PR #237 the invented
fixture gave `ob_session_lanes` an `archived_at` column that production does
not have (its lifecycle is `status` + `ended_at`), so the migration script's
lane step would have crashed on the live DB while the test stayed green. The
same invented schema also hid the second active-uniqueness index on
`ob_entities (namespace, entity_type, canonical_id)`.

Rule: scratch-DB tests MUST create their schema by running the repo's actual
migrations (`runMigrations(pool)` from `src/db/migrate.ts`), never by
hand-writing DDL. Then schema drift between script and production cannot hide.

### Review Questions

- Does any DB-backed test create tables with hand-written DDL instead of the
  repo migrations? Reject it.
- Does a data-migration script touch a column without grepping ALL migrations
  for that table's real lifecycle columns (soft-delete may be `archived_at` on
  one table and `status`/`ended_at` on another)?
- Are multi-step mutating scripts transactional so a mid-run failure cannot
  strand earlier steps?
- Does the script audit for affected-but-unmigrated content (all tables the
  removed code path served), failing loudly instead of reporting success?

## [2026-07-06] Recovery WAL replay must validate rows and preserve bounded trims

**Severity:** HIGH
**Source:** PR #253 initial swarm for Issue #221
**Scope:** `src/realtime/recovery-wal.ts`, any append-only recovery/spool WAL
**Status:** fixed in PR #253

### Pattern

A recovery WAL can pass happy-path restart tests while still failing its core
purpose. PR #253 initially parsed any JSONL row with a known `op` and cast it to
the WAL record type, so a partial row such as `{"op":"append"}` could crash
store construction during replay. The same first pass trimmed over-budget
records in memory but wrote only append records to the WAL, so trimmed recovery
items could reappear after restart. A follow-up fix-verification pass found the
same class of bug in partial or legacy append-only WALs: replay cannot trust
writer-generated purge rows as the only cap enforcement, because a crash,
truncated file, manual recovery, or older build can leave valid append rows over
budget.

### Review Questions

- Does replay validate every row by operation before applying it, including
  required scope, item, action/status, and parseable timestamps?
- Does one malformed-but-valid JSON row get skipped/quarantined instead of
  crashing startup?
- Are trim, purge, expiration, and session/global cap decisions durable across
  replay via tombstones, compaction, or equivalent?
- Do tests exceed per-session, global-item, and session-count caps, restart
  from the WAL, and prove the visible state stays bounded?
- Do tests hand-write valid append-only WAL rows that were not generated by the
  current writer, so replay itself proves caps and timestamp validation?

## [2026-07-06] Python DreamEngine wrappers must enforce server schema bounds

**Severity:** MEDIUM
**Source:** PR #254 gotcha lane for Issue #247
**Scope:** `python/openbrain-memory/src/openbrain_memory/dream.py`, any Python
wrapper that pre-validates MCP tool arguments
**Status:** fixed in PR #254; recurrence of #82 wrapper contract drift

### Pattern

`DreamEngine.decompose_entry()` initially accepted `max_chunk_chars` values from
`1..8000`, while the server schema and contract require `500..8000`. Happy-path
wrapper tests passed, but the wrapper could still emit a request the server
would reject.

### Review Questions

- Do Python wrapper bounds exactly match the server Zod schema and contract
  manifest, including lower bounds?
- Are boundary tests present for just-below-minimum, minimum, maximum, and
  just-above-maximum values?
- Do gotcha lanes check schema-compatible payloads rather than only method names
  or happy-path forwarding?

## [2026-07-06] Cross-field wrapper validation must mirror server invariants

**Severity:** MEDIUM
**Source:** PR #254 Claude/Opus cross-review for Issue #247
**Scope:** Python DreamEngine wrappers and any facade that pre-validates related
numeric fields
**Status:** fixed in PR #254; recurrence class of wrapper contract drift

### Pattern

Matching per-field min/max bounds is not enough when the server has a
cross-field invariant. `decompose_entry` must reject `overlap_chars >=
max_chunk_chars`; otherwise a Python caller can create pathological chunking or
send a payload the server rejects.

### Review Questions

- Do wrapper tests cover related-field combinations, not only independent
  bounds?
- Does the wrapper reject the same invalid payloads the server rejects before
  making a client call?
- Does contract/help text name the cross-field invariant so generated clients
  can mirror it?

## [2026-07-07] Stub transports must not expose fake availability

**Severity:** MEDIUM
**Source:** PR #261 initial swarm for Issue #223
**Scope:** `python/openbrain-memory/src/openbrain_memory/client.py`, optional transport facades
**Status:** fixed in PR #261; recurrence of #82 wrapper contract drift

### Pattern

An opt-in transport stub can be useful, but it must not let callers report the
transport as runtime-available before any runtime path exists. PR #261 initially
exported an `AVAILABLE` enum value and accepted it in `NatsTransport` even
though all non-fallback calls still raised unavailable, and the fallback test
only checked method names rather than the full HTTP/MCP request contract.

### Review Questions

- Does a planned/stub transport derive availability from real runtime behavior
  instead of caller-supplied labels?
- Does the no-fallback error avoid claiming a fallback exists?
- Do fallback tests assert headers, session reuse, JSON-RPC ids, protocol
  version, URL, timeout, and tool-call body, not just method names?

## [2026-07-07] Python NATS clients must fail closed on protocol drift before fallback

**Severity:** MEDIUM
**Source:** PR #263 initial swarm for Issue #223
**Scope:** `python/openbrain-memory/src/openbrain_memory/client.py`, Python
request/reply transport facades
**Status:** fixed in PR #263; keep as active checklist

### Pattern

A Python secondary transport can preserve HTTP fallback while still hiding the
exact regressions the realtime path needs to surface. In PR #263, the first
Python request/reply pass caught every exception from the NATS path, so response
schema/id/operation/status mismatches and local envelope validation errors could
silently retry over HTTP. It also left NATS availability open after later
successful `get_contract` responses stopped advertising a valid NATS state,
sent oversized envelopes to the driver before the server-side 64 KiB cap could
reject them, and re-raised raw driver exceptions when fallback was disabled.

### Review Questions

- Does fallback catch only transport-unavailable/request failures, not local
  validation or protocol-conversion errors?
- Are concrete driver exceptions wrapped in a sanitized Open Brain exception
  before escaping fallback-disabled canary/debug paths?
- Does a later successful `get_contract` without explicit valid NATS
  availability close the NATS gate instead of preserving stale availability?
- Does the client enforce the server's NATS request-size cap before sending to
  the driver, falling back to HTTP when configured?
- Do tests prove malformed NATS responses, missing required envelope fields,
  oversized payloads, stale contract responses, and sensitive driver exception
  strings behave correctly?

## [2026-07-07] Secondary transports must preserve HTTP scope and argument parity

**Severity:** HIGH
**Source:** PR #263 Claude/Opus cross-review for Issue #223
**Scope:** `python/openbrain-memory/src/openbrain_memory/client.py`, optional
secondary transport facades for existing MCP tools
**Status:** fixed in PR #263; keep as active checklist

### Pattern

An opt-in secondary transport can pass happy-path tests while silently changing
the caller's scope or request arguments. In PR #263, the Python NATS path first
used authorization-derived namespace only, even when the HTTP client would send
`X-Namespace` for delegated namespace clients. It also copied only the current
known `agent_context_pack` body keys into the NATS envelope, so any unsupported
or future argument would be dropped instead of preserving HTTP behavior.

### Review Questions

- Does the secondary transport preserve the same namespace/source-of-authority
  as HTTP, or intentionally fall back/fail closed when the secondary server
  contract cannot represent that scope?
- Does it preserve the caller's tool arguments, or explicitly fall back to HTTP
  when arguments are outside the secondary envelope contract?
- Do tests cover delegated namespace clients and unexpected/future tool
  arguments, not only the default happy-path scope?
- Does a failed contract refresh close stale secondary-transport availability
  unless the response affirmatively advertises that transport as available?

## [2026-07-06] Release docs must not read as local live-execute approval

**Severity:** MEDIUM
**Source:** PR #259 initial and fix-verification swarms for Issue #167
**Scope:** release preflight docs, migration runbooks, live DB command blocks, destructive script entrypoints
**Status:** fixed in PR #259; keep as active checklist

### Pattern

A runbook can correctly say "dry-run first" but still create operational risk if
it labels a destructive command as approved before the release gate is complete.
For live DB migrations, command blocks must say the approved release/runtime
environment is required and that local PR checkouts or scratch shells must not
be pointed at production credentials. If a script owns the destructive action,
the script should also fail closed before DB access; a copy-pasteable comment or
doc-only shell guard is not enough by itself.

### Review Questions

- Does any command block with `--execute` look pre-approved rather than
  approval-gated?
- Does the doc name where the command is allowed to run?
- Does it explicitly forbid local PR checkouts or scratch shells with
  production credentials when that boundary matters?
- Does the script entrypoint enforce the approval gate before any DB query or
  transaction starts?

## [2026-07-08] Request-metadata features must be measured on raw args through the real dispatch path

**Severity:** BLOCKER
**Source:** PR #275 pre-merge gauntlet for Issue #269
**Scope:** `src/audit-log.ts`, `src/tools/__tests__/mcp-audit-log.test.ts`, any
feature that records request metadata (unknown keys, payload size, declared
parameters) from tool arguments
**Status:** fixed in PR #275

### Pattern

The audit wrapper initially measured arguments after Zod parsing had already
stripped unknown keys, so `unknown_parameter_count` was provably 0 through the
real dispatch path. The tests were green anyway: a unit test "proved" the
counting helper against raw args it constructed itself, and the integration
test certified 0 as the correct answer. Green tests over a runtime shape the
SDK never produces.

### Review Questions

- Is the metadata measurement taken from the raw client-sent arguments, before
  any schema parse/strip layer runs?
- Is the feature tested through the real client dispatch path (in-process MCP
  client -> server), not only via a helper called on hand-built raw args?
- Does at least one test send an argument the schema does not declare and
  assert a nonzero unknown count -- an assertion that would fail if the
  raw-vs-parsed layer is wrong?
- Would the integration test still pass if the measurement point silently moved
  behind the parser? If yes, the test certifies the bug.

## [2026-07-08] Diagnostics must share resolution helpers with the consumer they report on

**Severity:** MEDIUM
**Source:** PR #277 pre-merge gauntlet for Issue #270
**Scope:** `src/operator-doctor.ts`, qmd probe, any doctor/status probe that
reports the health of another subsystem's dependency
**Status:** fixed in PR #277

### Pattern

The doctor's qmd probe initially resolved `QMD_PATH` with its own default logic
instead of the resolution used by `search_all`'s qmd consumer. The probe could
report qmd healthy/unhealthy for a binary path the actual consumer never uses,
making the diagnostic lie in exactly the failure cases it exists for.

### Review Questions

- Does the probe import/call the same resolution helper (path, URL, env
  default) as the consumer it reports on, rather than reimplementing it?
- If the consumer's default changes, does the probe change with it by
  construction, or only by convention?
- Do tests pin probe resolution and consumer resolution to the same value?
