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
- Does the test observe `Authorization`, `X-Namespace`, `X-Agent-Id`, `X-Role`,
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
