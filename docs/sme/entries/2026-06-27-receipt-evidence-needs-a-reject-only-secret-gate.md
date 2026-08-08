---
lane: security
order: 5
---
## [2026-06-27] Receipt evidence needs a reject-only secret gate

**Severity:** HIGH
**Source:** PR #218 full swarm
**Scope:** `src/agent-memory.ts`, `python/openbrain-memory/src/openbrain_memory/agent.py`
**Status:** fixed in PR #218

### Pattern

Receipt wrappers rejected authority keys but still accepted obvious secret-like
evidence in `sources`, `outputs`, `validations`, residual risk, or extra
metadata. Redacting persisted receipts would corrupt evidence, so wrappers need
a reject-only gate before durable writes.

### Review Questions

- Does `recordReceipt` / `record_receipt` reject secret-looking strings and
  sensitive key names before `append_session_event`?
- Are diagnostics/redaction separate from the persisted receipt payload?
- Are TS and Python tests covering both sensitive keys and labeled bearer/API
  material?
