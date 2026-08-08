---
lane: domain-backend
order: 8
---
## [2026-07-06] Multi-row explicit apply paths need atomicity or progress semantics

**Severity:** MEDIUM
**Source:** PR #254 initial swarm for Issue #247
**Scope:** `src/tools/decompose-entry.ts`, any MCP tool that turns one explicit
apply call into multiple durable writes
**Status:** fixed in PR #254; keep as active checklist

### Pattern

`decompose_entry` originally inserted replacement thoughts one chunk at a time
without a transaction. If embedding generation or a later insert failed after
earlier chunks committed, the caller would receive an error without
`written_ids` while durable partial replacements remained. That is an ambiguous
apply contract.

### Review Questions

- Does one explicit apply call produce multiple durable writes?
- If yes, are those writes wrapped in `BEGIN`/`COMMIT`/`ROLLBACK`, or does the
  tool explicitly return recoverable partial progress?
- Is there a regression test forcing a mid-batch failure and proving rollback
  or documented progress semantics?
