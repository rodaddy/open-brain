---
lane: adversarial
order: 4
---
## [2026-07-06] Retry bounds need a stable server-validated root

**Severity:** HIGH
**Source:** PR #244 initial swarm for Issue #176
**Scope:** `src/tools/append-session-event.ts`, any bounded resend/retry chain
stored in client-supplied metadata
**Status:** fixed in PR #244

### Pattern

Bounded resend logic can look correct while still trusting client lineage. In
PR #244, `reject_detail.resubmit_metadata.sanitized_resubmit_of` rotated to the
newest rejected event id after each failed sanitized resend. A client that
followed the returned metadata, or a malicious caller that supplied a later
rejected event as the root, could start a fresh counter and bypass the intended
bound.

### Review Questions

- Does the server keep a stable original/root id across the whole retry chain?
- Is the supplied root validated against same-lane state, rather than trusted as
  arbitrary metadata?
- Does a later retry/rejection ever become the new root and reset the counter?
- Is there a regression where a contract-following retry fails again and the
  next `resubmit_metadata` still points to the original root?
- Is there a regression where a rotated or invalid root is non-resubmittable
  instead of starting a fresh counter?

### Prior Fix

PR #244 validates `sanitized_resubmit_of` as an original same-lane rejected
event, keeps the original root in returned `resubmit_metadata`, and marks
rotated/non-root attempts at the retry bound. Regression tests cover both a
contract-following failed resend and an explicit rotated-root reset attempt.
