---
lane: adversarial
order: 28
section: harvest-522
---
## [2026-08-03] No errors on a freshly restarted service proves nothing

**Severity:** not stated in source
**Source:** issue #162 (comment by rodaddy, 2026-06-19 regression report); harvested in #522
**Scope key:** `verification.no_errors_on_fresh_restart_proves_nothing`
**Status:** active

### Pattern

An absence of errors on a freshly restarted service is not evidence a fix worked — with no traffic in the window, no error had a chance to fire. Verify a deployed fix by driving one real request through the real client path (real MCP call, real parameterized query, confirmed row in the DB), never by hand-written SQL that approximates the query or by an error-count delta over a short uptime window. Corollary from the same thread: mock pools cannot catch SQL constraint or parameter-type-inference failures; env-gated DB-backed integration tests are required for query-shape changes.

Verbatim, from the source:

> The "240/24h stopped after restart" reading was a **false positive** — the service had only ~40s uptime with no lane traffic, so no new errors had a chance to fire. The first real lane write (mine, just now) fails. ... verified against hand-written SQL rather than the actual parameterized query.
