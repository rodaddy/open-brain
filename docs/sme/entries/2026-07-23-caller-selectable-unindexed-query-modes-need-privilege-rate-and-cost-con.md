---
lane: security
order: 28
---
## [2026-07-23] Caller-selectable unindexed query modes need privilege, rate, and cost controls

**Severity:** MEDIUM
**Source:** PR #368 review, 2026-07-23
**Scope:** caller-selected FTS configurations and other query modes that bypass
an index
**Status:** active (FTS instance addressed post-merge: the privilege gate now
applies to the EFFECTIVE config regardless of provenance -- env-default
non-English degrades ordinary roles to the indexed english path; vector mode
ignores the unused `fts_config`; and permitted non-default statements are
bounded by a transaction-scoped `SET LOCAL statement_timeout` from validated
`OPENBRAIN_FTS_STATEMENT_TIMEOUT_MS`, default 5000 ms. Pattern stays active for
future unindexed modes.)

An allowlisted query mode can still be a resource-exhaustion surface. If a
caller can replace an indexed predicate with per-row computation across multiple
tables, the server must constrain who may select it and bound its aggregate
frequency and database cost; ordinary result limits do not bound the scan work
performed before rows are returned.

### Review Questions

- Is the unindexed mode restricted to an appropriate role or server-owned
  corpus setting rather than every reader?
- Are rate, concurrency, statement-timeout, and cost/table-scope limits enforced
  and tested on the expensive path?
