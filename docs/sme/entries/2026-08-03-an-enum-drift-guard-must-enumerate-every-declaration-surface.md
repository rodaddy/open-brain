---
lane: gotcha-agent
order: 30
section: harvest-522
---
## [2026-08-03] An enum-drift guard must enumerate every declaration surface

**Severity:** not stated in source
**Source:** PR #428 (feat(412): one event vocabulary); harvested in #522
**Scope key:** `sme.enum_drift_guard_enumerates_every_surface`
**Status:** active

### Pattern

Reusable review check: when guarding an enum/vocabulary against drift, enumerate ALL declaration surfaces — here there were eight (Python definition, TS client, TS server set, a TS union, MCP tool schema, tiering union, SQL table constants, and the migration CHECK constraint), where the issue named only two. The database CHECK constraint matters most: code drifting wider than it means validation passes, the insert is refused, and the caller sees exit 0 with no row. The guard must include a 'no seventh copy appeared' assertion, and its path filter must match path components (`tests/`, `*.test.ts`) rather than the substring 'test', which silently skipped `latest.ts`, `manifest.ts`, and `attestation.ts`.

Verbatim, from the source:

> **There were not two copies. There are six, plus SQL.** [...] **The SQL constraint is included and matters most.** Postgres is the authority, so a code set drifting *wider* than the constraint reproduces the exact reported symptom: validation passes, the insert is refused, and the caller sees exit 0 with no row.
