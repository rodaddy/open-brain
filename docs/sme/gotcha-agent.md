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
