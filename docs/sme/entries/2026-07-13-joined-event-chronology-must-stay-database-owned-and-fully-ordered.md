---
lane: domain-backend
order: 17
---
## [2026-07-13] Joined event chronology must stay database-owned and fully ordered

**Severity:** HIGH
**Source:** Issue #288 Full-tier review and focused verification
**Scope:** transcript citation migration and neighbor SQL
**Status:** fixed in issue #288 implementation

Do not round-trip PostgreSQL timestamps through millisecond JS dates for tuple boundaries. Compare against the target row in SQL, qualify every projected column, apply direction to every ORDER BY term, and make constraint creation retry-idempotent.
