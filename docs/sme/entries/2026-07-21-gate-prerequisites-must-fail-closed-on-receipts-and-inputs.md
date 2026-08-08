---
lane: security
order: 18
---
## [2026-07-21] Gate prerequisites must fail closed on receipts and inputs

**Severity:** MEDIUM
**Source:** PR #313 / PR development#44 review swarm 2026-07-21
**Scope:** CI warm-up/cache steps and environment-derived gate inputs
**Status:** fixed-pre-merge

- A warm-up gate that accepted failed receipts let downstream jobs proceed as if the prerequisite succeeded; a failed warm-up receipt must be a hard failure, never advisory.
- Cache/env override class: caches and environment variables feeding a gate (e.g. the uv cache) are influencable inputs; gates must validate what actually executes at gate time, not what a cached or declared artifact claimed earlier.
