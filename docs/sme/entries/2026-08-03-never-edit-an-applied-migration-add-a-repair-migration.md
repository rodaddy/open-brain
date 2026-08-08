---
lane: domain-backend
order: 29
section: harvest-522
---
## [2026-08-03] Never edit an applied migration -- add a repair migration

**Severity:** not stated in source
**Source:** PR #352; harvested in #522
**Scope key:** `process.never_edit_an_applied_migration_add_a_repair`
**Status:** active

### Pattern

The migration runner tracks filenames without checksums, so editing an already-applied migration file silently diverges upgraded databases from fresh ones -- fresh CI databases go green while a real upgraded database keeps the stale schema. Never fix a migration by editing it; add an additive follow-up migration that repairs the persisted object by name and includes a drift guard asserting the original and repair allowlists stay equal.

Verbatim, from the source:

> the persistent test database had already recorded migration 026 before `lease_expired` was added to that file, so the filename-only migration ledger skipped the edited body. Fresh db-integration databases passed, while the upgraded persistent database correctly failed.
