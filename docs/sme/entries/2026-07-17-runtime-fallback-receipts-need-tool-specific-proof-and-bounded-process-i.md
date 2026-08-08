---
lane: gotcha-agent
order: 12
---
## [2026-07-17] Runtime fallback receipts need tool-specific proof and bounded process I/O

**Severity:** HIGH
**Source:** PR #294 Full-tier review
**Scope:** `python/openbrain-memory/src/openbrain_memory/_runtime_router.py`, `runtime.py`
**Status:** fixed in PR #294; recurrence class of #81/#82 transport and contract proof

Do not accept a generic success envelope as proof of a durable lifecycle write. Validate the expected receipt for the invoked tool, preserve exact nullable scope coordinates, stream subprocess output under fixed bounds, and after direct-start partial failure verify the intended lane before claiming fallback success. Exercise wrong-lane, malformed-receipt, null-scope, partial-start, timeout, and noisy-child failures.
