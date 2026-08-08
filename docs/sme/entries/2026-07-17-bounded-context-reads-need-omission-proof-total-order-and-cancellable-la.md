---
lane: domain-backend
order: 18
---
## [2026-07-17] Bounded context reads need omission proof, total order, and cancellable latency

**Severity:** HIGH
**Source:** PR #294 Full-tier review and terminal audit
**Scope:** `agent_context_pack` durable lane/event reads and bounded database retrieval
**Status:** fixed in PR #294

A bounded context query must fetch one extra row before truncating so omission flags are truthful, use a total order such as `(created_at, id)` in both selection and returned chronology, and keep timestamp comparison database-owned. PostgreSQL ordering boundaries must not round-trip through millisecond-precision `Date` values, which can collapse distinct timestamps and skip or duplicate rows. The request budget must cover pool acquisition as well as query execution: race `pool.connect()` against the remaining deadline, and if acquisition resolves after timeout, release that late client immediately so the pool does not leak capacity. Every acquired-client query, including `BEGIN`, transaction-local timeout setup, reads, commit, and rollback, must carry pg's per-query `query_timeout`; never bootstrap it with an unbounded session `SET`. Keep PostgreSQL `statement_timeout` transaction-local for server-side read cancellation, and discard a client after a timed-out or protocol-uncertain query rather than queueing cleanup behind it. Tests must cover sub-millisecond timestamps, timestamp ties, exactly-at-limit versus over-limit results, a saturated pool with late acquisition, a concretely wedged transaction start, per-query timeout configuration, and no session `SET`/`RESET`.
