---
lane: gotcha-agent
order: 10
---
## [2026-07-13] Required-tool changes must bump every client compatibility fixture

**Severity:** HIGH
**Source:** Issue #288 Full-tier gotcha and fix verification
**Scope:** public contract plus openbrain-memory package
**Status:** fixed in issue #288 implementation

Adding a required tool while retaining the released client version makes the manifest lie. Bump the package, minimum/range, lockfile, server assertions, and Python contract fixtures together; search expected error strings for the retired range too.
