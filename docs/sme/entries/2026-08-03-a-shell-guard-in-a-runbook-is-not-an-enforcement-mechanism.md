---
lane: adversarial
order: 31
section: harvest-522
---
## [2026-08-03] A shell guard in a runbook is not an enforcement mechanism

**Severity:** not stated in source
**Source:** https://github.com/rodaddy/open-brain/pull/259; harvested in #522
**Scope key:** `sme.doc_shell_guard_is_not_enforcement`
**Status:** active

### Pattern

A copy-pasteable shell guard in a runbook is not an enforcement mechanism; the operator can omit it by copying only the command line. When a migration/maintenance script gates its mutating path in code, review the READ path too: a live dry-run against production is still live access and needs the same in-script fail-closed sentinel, keyed on the target host rather than on the `--execute` flag. Resolution in this repo: `scripts/retire-collab-migration.ts` now requires the approval sentinel before ANY query when `DB_HOST` is non-local.

Verbatim, from the source:

> The script only calls `assertExecuteApproval` when `args.execute` is true (line 537). A dry-run therefore hits the live DB ... with **no script-level sentinel check** — the *only* protection is the doc's `[ "$OPENBRAIN_..." = ... ]` shell guard ... An operator who copies just the `bun run ...` line ... reaches live production with zero fail-closed enforcement.
