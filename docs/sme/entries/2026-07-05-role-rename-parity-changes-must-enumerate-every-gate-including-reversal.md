---
lane: security
order: 7
---
## [2026-07-05] Role rename/parity changes must enumerate EVERY gate, including reversal paths

**Severity:** MEDIUM (P2)
**Source:** PR #235 cross-model (Codex) review
**Scope:** `src/rest-promotion.ts` (`/api/v1/demote`), `src/tools/demote-entry.ts`, `src/tools/promote-shared.ts`
**Status:** fixed in PR #235

### Pattern

The #168 `n8n` -> `ob-admin` rename updated every gate that previously paired
`admin` with `n8n`, but missed gates that hard-coded `role === "admin"` alone:
both demote gates (REST + MCP) and the `promote_shared` entry gate. Result: an
admin-equivalent role could promote/archive but got 403 reversing a bad
promotion -- the forward path and its reversal path diverged in authority.

### Review Questions

- For any role add/rename/parity change, did someone grep for BOTH forms:
  paired predicates (`=== "admin" || === "<role>"`) AND lone
  `=== "admin"` / `!== "admin"` literals across `src/`?
- Is each remaining admin-only literal either extended or explicitly justified
  as intentionally admin-only?
- Do mutation gates and their REVERSAL gates (promote/demote, archive/restore)
  grant the same roles? Asymmetry is usually a bug.
- Does the parity regression suite enumerate every gate (REST and MCP variants
  separately) rather than spot-checking one?
