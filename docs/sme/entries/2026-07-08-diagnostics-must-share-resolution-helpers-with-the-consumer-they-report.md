---
lane: gotcha-agent
order: 9
---
## [2026-07-08] Diagnostics must share resolution helpers with the consumer they report on

**Severity:** MEDIUM
**Source:** PR #277 pre-merge gauntlet for Issue #270
**Scope:** `src/operator-doctor.ts`, qmd probe, any doctor/status probe that
reports the health of another subsystem's dependency
**Status:** fixed in PR #277

### Pattern

The doctor's qmd probe initially resolved `QMD_PATH` with its own default logic
instead of the resolution used by `search_all`'s qmd consumer. The probe could
report qmd healthy/unhealthy for a binary path the actual consumer never uses,
making the diagnostic lie in exactly the failure cases it exists for.

### Review Questions

- Does the probe import/call the same resolution helper (path, URL, env
  default) as the consumer it reports on, rather than reimplementing it?
- If the consumer's default changes, does the probe change with it by
  construction, or only by convention?
- Do tests pin probe resolution and consumer resolution to the same value?
