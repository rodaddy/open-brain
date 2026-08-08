---
lane: security
order: 22
---
## [2026-07-21] Disposition/certification docs must cover error paths, not just denial paths

**Severity:** MEDIUM
**Source:** PR #316 review swarm, 2026-07-21
**Scope:** `src/tools/bulk-archive.ts`, `docs/memory-contract.md` disposition
table, any surface a doc certifies as "content-free"
**Status:** fixed-pre-merge

### Pattern

The #297 disposition table certified the deletion/archive surface as
content-free while `bulk_archive`'s catch block still returned raw pg
`err.message` (`Transaction failed: ${message}`) across the MCP transport
boundary and logged it verbatim. A denial/no-op path being content-free says
nothing about the ERROR path of the same surface; certifying a surface in a
disposition doc without walking its catch blocks lets a leak ship under a
"verified content-free" label. Fixed by a stable `"Transaction failed"`
response, `err.code`/`err.name`-only logging, and a leak regression test that
throws a sensitive-looking pg error and asserts the response contains none of
it.

### Review Questions

- When a doc/table certifies a surface as content-free or isolated, was every
  `catch` block on that surface checked for interpolated `err.message` in the
  response or logs?
- Does the certification claim scope itself (denial path vs error path), and
  does each claimed path have its own test?
- Is there a leak test that injects a dependency error carrying
  table/constraint/namespace-shaped fragments and asserts the transport
  response is the stable string only?
