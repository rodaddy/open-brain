---
lane: correctness
order: 39
---
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
