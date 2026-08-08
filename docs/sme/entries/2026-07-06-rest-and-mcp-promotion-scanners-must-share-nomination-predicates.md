---
lane: correctness
order: 13
---
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
