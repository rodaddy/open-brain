---
lane: correctness
order: 1
---
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
