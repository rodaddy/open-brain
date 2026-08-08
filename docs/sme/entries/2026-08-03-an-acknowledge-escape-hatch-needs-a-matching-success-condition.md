---
lane: correctness
order: 53
section: harvest-522
---
## [2026-08-03] An --acknowledge escape hatch needs a matching success condition

**Severity:** not stated in source
**Source:** https://github.com/rodaddy/open-brain/pull/259; harvested in #522
**Scope key:** `sme.acknowledge_escape_hatch_needs_success_condition`
**Status:** active

### Pattern

An `--acknowledge-*` escape hatch that lets a migration proceed past unhandled rows must be matched by a post-execute success condition that accounts for those rows. Otherwise the runbook's checklist can pass in full while the acknowledged rows stay unreconciled and become invisible at the next cleanup step. When reviewing a migration runbook, verify the success conditions detect every state the escape hatch can leave behind.

Verbatim, from the source:

> When `--execute --acknowledge-out-of-scope` is used ... Step 5's four success conditions ... none of them assert that `audit.total_out_of_scope` returned to 0 or matches the acknowledged classification. An operator can pass all four listed conditions while the acknowledged out-of-scope rows ... remain live-unique and about to become invisible on fallback removal.
