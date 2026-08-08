---
lane: correctness
order: 8
---
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
