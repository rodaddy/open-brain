---
lane: correctness
order: 12
---
## [2026-07-06] Rejected nominations must strip all coupled lifecycle metadata

**Severity:** MEDIUM
**Source:** PR #251 Claude cross-review for Issue #224
**Scope:** `src/tools/append-session-event.ts`, synchronous shared-kb nomination rejection
**Status:** fixed in PR #251

### Pattern

Rejected shared nominations must not leave partial metadata that downstream
tools interpret as intent. In PR #251, the sync rejection path stripped
`share_candidate` for secret/private nominations but initially left
`memory_lifecycle_action=nominate_shared` and candidate detail fields behind.
That created an orphan lifecycle marker after the server had rejected the
nomination.

### Review Questions

- When the server rejects a flag or lifecycle action, are all coupled metadata
  fields stripped as one invariant-preserving group?
- Can any downstream scanner, contract consumer, or audit path still read a
  rejected event as pending nomination intent?
- Do rejection tests assert absence of the entire metadata group, not only the
  primary boolean flag?

### Prior Fix

PR #251 strips `share_candidate`, `memory_lifecycle_action`, candidate detail
fields, and `evidence_refs` from rejected nominations before stamping the
rejection marker. Regression tests cover secret/private rejected nominations.
