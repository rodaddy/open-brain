---
lane: security
order: 25
---
## [2026-07-22] Digest shape is not proof of observed bytes

**Severity:** P2
**Source:** PR #351 terminal audit (issue #337)
**Status:** fixed-pre-merge

A public tool must not accept a caller-asserted digest as observed-content truth merely because it has SHA-256 shape. Keep source hashes behind a trusted collector path that hashes received bytes server-side; test that the public schema omits the field.
