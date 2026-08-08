---
lane: quality
order: 14
---
## [2026-07-23] Migration-mirrored search expressions need all-table parity and unindexed-mode runbooks

**Severity:** MEDIUM
**Source:** PR #368 review, 2026-07-23
**Scope:** runtime SQL that mirrors generated-column migrations and operational
query-mode configuration
**Status:** active

When runtime SQL duplicates a migration-owned generated-column expression,
functional parity must cover every table and every contributing field, not one
representative table or SQL-string inspection. If a selectable mode recomputes
that expression without its index, operator docs must state the scan/cost
tradeoff, safe enablement boundary, monitoring/timeout expectations, and
rollback procedure.

### Review Questions

- Do real-Postgres tests prove indexed/default versus recomputed-mode parity for
  every table and each migration-owned text source?
- Do operator docs identify the unindexed path, expected cost controls,
  observability, enablement scope, and rollback?
