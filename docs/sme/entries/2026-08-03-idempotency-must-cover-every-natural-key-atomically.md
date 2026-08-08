---
lane: correctness
order: 50
section: harvest-522
---
## [2026-08-03] Idempotency must cover every natural key, atomically

**Severity:** not stated in source
**Source:** rodaddy/open-brain#62 (review swarm comment by rodaddy); harvested in #522
**Scope key:** `sme.correctness.idempotency_must_cover_all_natural_keys`
**Status:** active

### Pattern

A check-then-insert idempotency guard that tests only one duplicate key is not idempotent: enumerate every table-specific natural/unique key, and make the write atomic via table-specific ON CONFLICT or a guarded single insert. Return the existing row as a duplicate rather than surfacing a unique-constraint violation as a 500.

Verbatim, from the source:

> Promotion prechecks only active `content_hash` duplicates before insert. Inserts can still violate table-specific unique keys such as `relationships(namespace, person_name)`, `projects(namespace, name)`, and `sessions(namespace, session_id)`. The check-then-insert flow can race under concurrent promote requests.
