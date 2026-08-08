---
lane: gotcha-agent
order: 35
section: harvest-522
gap: 0
---
## [2026-08-06] A fix lane's trunk merge silently reverted the sibling feature — both suites green

**Severity:** HIGH (caught pre-merge by delta verification)
**Source:** PR #600 fix lane, merge commit 55d701d; detected in the 3cfbd75..06430ef delta verify
**Scope key:** `review.trunk_merge_verified_against_sibling_features`
**Status:** active

### Pattern

When a fix lane merges trunk into its branch and both branches touched the same module, the merge resolution is new, unreviewed code — and the failure mode is silent feature reversion: PR #600's merge rewrote the real sink's `emit` for its background lane and dropped the only call that renders `body.spans`, so PR #599's retrieval-evidence children would have been built, masked, and discarded in production. Every test stayed green on both sides because both features asserted against fake sinks; no test drove the REAL sink with the sibling's payload. Review checks: (1) diff the merge commit itself, not just the fix commits; (2) any shared-module merge needs a behavioral check that BOTH features still function through the real seam; (3) uncovered rendering/dispatch seams (a helper whose only callers are its export and a test) are where reverts hide. The catch here came from a delta verifier running the same mocked-SDK script against both refs — cheap, decisive, worth repeating.
