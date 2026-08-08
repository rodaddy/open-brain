---
lane: quality
order: 6
---
## [2026-07-06] Mutating wrappers must distinguish no-op from successful writes

**Severity:** MEDIUM
**Source:** PR #254 initial swarm for Issue #247
**Scope:** explicit apply/dry-run pairs such as `decompose_entry`
**Status:** fixed in PR #254; keep as active checklist

### Pattern

`decompose_entry` originally overwrote every explicit apply response with
`status: "applied"`, even when the source entry was not oversized and the plan
had `would_write: 0`. That blurred "nothing eligible to write" and "writes
succeeded", and the no-op output state was undocumented.

### Review Questions

- Does an explicit mutating wrapper preserve no-op states instead of claiming a
  successful mutation?
- Are output statuses all reachable, documented, and covered by tests?
- Does the contract explain empty `written_ids` as no-op/skipped/duplicate
  rather than leaving clients to infer success?
