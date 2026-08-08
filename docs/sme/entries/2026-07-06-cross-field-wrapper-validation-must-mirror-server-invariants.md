---
lane: gotcha-agent
order: 3
---
## [2026-07-06] Cross-field wrapper validation must mirror server invariants

**Severity:** MEDIUM
**Source:** PR #254 Claude/Opus cross-review for Issue #247
**Scope:** Python DreamEngine wrappers and any facade that pre-validates related
numeric fields
**Status:** fixed in PR #254; recurrence class of wrapper contract drift

### Pattern

Matching per-field min/max bounds is not enough when the server has a
cross-field invariant. `decompose_entry` must reject `overlap_chars >=
max_chunk_chars`; otherwise a Python caller can create pathological chunking or
send a payload the server rejects.

### Review Questions

- Do wrapper tests cover related-field combinations, not only independent
  bounds?
- Does the wrapper reject the same invalid payloads the server rejects before
  making a client call?
- Does contract/help text name the cross-field invariant so generated clients
  can mirror it?
