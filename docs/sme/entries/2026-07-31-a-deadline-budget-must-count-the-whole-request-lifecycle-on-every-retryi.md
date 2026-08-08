---
lane: domain-backend
order: 24
---
## [2026-07-31] A deadline budget must count the WHOLE request lifecycle, on every retrying layer

**Severity:** HIGH
**Source:** Sol round-2 review of 575074e..4b74950, fixed in `42ccf0c`
**Scope:** `python/openbrain/src/openbrain/apps/hooks/session.py`, any
deadline-bound client construction
**Status:** active

### Pattern

The first deadline fix pinned `RetryPolicy(attempts=1)` on the CLIENT only —
`AgentMemory` kept the sibling default and independently retried a 429 on
`session_start` (reproduced: one 429 → two calls). And the budget arithmetic
counted 4 requests when the real lifecycle is FIVE (initialize,
notifications/initialized, session_start, ingest_raw_turn, DELETE on close),
so 5×1.0s consumed the whole 5s deadline before process overhead. The fix
names every request in the constant block, passes the policy to EVERY layer
that can retry, and an import-time assert enforces
`requests × timeout + overhead < deadline` so a later widening fails at
import, not in production.

### Review Questions

- List every network request the full lifecycle makes, including cleanup —
  does the budget arithmetic name and count all of them?
- Does EVERY layer that can retry (client, agent wrapper, transport) receive
  the pinned policy, or only the outermost?
- Is the arithmetic enforced by an assert/test, or is it a comment that can
  silently rot?
