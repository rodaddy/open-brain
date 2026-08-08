---
lane: gotcha-agent
order: 7
---
## [2026-07-06] Release docs must not read as local live-execute approval

**Severity:** MEDIUM
**Source:** PR #259 initial and fix-verification swarms for Issue #167
**Scope:** release preflight docs, migration runbooks, live DB command blocks, destructive script entrypoints
**Status:** fixed in PR #259; keep as active checklist

### Pattern

A runbook can correctly say "dry-run first" but still create operational risk if
it labels a destructive command as approved before the release gate is complete.
For live DB migrations, command blocks must say the approved release/runtime
environment is required and that local PR checkouts or scratch shells must not
be pointed at production credentials. If a script owns the destructive action,
the script should also fail closed before DB access; a copy-pasteable comment or
doc-only shell guard is not enough by itself.

### Review Questions

- Does any command block with `--execute` look pre-approved rather than
  approval-gated?
- Does the doc name where the command is allowed to run?
- Does it explicitly forbid local PR checkouts or scratch shells with
  production credentials when that boundary matters?
- Does the script entrypoint enforce the approval gate before any DB query or
  transaction starts?
