---
lane: security
order: 24
---
## [2026-07-22] Child-process stderr and validation catch paths are part of every content-free surface (RECURRING)

**Severity:** MEDIUM
**Source:** PR #318 review swarm, 2026-07-22
**Scope:** `scripts/restore.ts` (`runPgRestore`, `validatePostRestore` catch
paths), `scripts/backup.ts` (`runPgDump`), `scripts/backup-lib.ts`
(`summarizeChildStderr`, `fileEntrySchema`)
**Status:** fixed-pre-merge

### Pattern

RECURRING — third occurrence after #275 and #316: every NEW operator/tool
surface that certifies content-freedom ships with an unsanitized error path.
This round it was CHILD-PROCESS stderr: the backup/restore CLIs passed raw
`pg_dump`/`pg_restore` stderr into thrown errors and receipts, and pg stderr
carries literal row data on mid-COPY failures (`CONTEXT: COPY <table>, line
N: "<row content>"`, `DETAIL:`/`HINT:` lines, quoted values). Validation
catch blocks likewise embedded raw `err.message`. Fixed by sanitizing child
stderr to exit code + error class only (first stderr line, tool/severity
prefixes stripped, cut before the first ':' or quote —
`summarizeChildStderr`), by making every validation catch detail
pg-code/name-only (post-#316 `bulk_archive` shape), and by leak tests that
inject sentinel row content through a fake `pg_restore`/throwing driver.
Related: manifest-style FILE LISTS need bare-filename constraints — a
tampered manifest `files[].name` like `../x` turns verify's stat/sha256 pass
into a path-traversal read oracle; schema-reject anything that is not a bare
filename.

### Review Questions

- Does the new surface spawn child processes, and is their stderr summarized
  to an error class instead of passed through to errors/receipts/logs?
- Are ALL catch paths on the surface code/name-only (never `err.message`),
  including validation loops, not just the happy-path receipt?
- Is there a leak test that injects sentinel row content via child stderr
  (CONTEXT/COPY/DETAIL lines) AND via a throwing driver, asserting the
  receipt carries neither the sentinel nor any quoted fragment?
- Do operator-supplied file lists (manifests, indexes) constrain names to
  bare filenames before any stat/read/hash uses them?

### [2026-07-22] Fourth occurrence — new MCP tool surface (source registry)

**Source:** PR #351 / issue #337 review swarm
**Scope:** `src/tools/source-registry.ts` (all five registry handlers)

RECURRING again: the new `register/list/update/remove/eligibility` MCP handlers
called the registry layer with no throw guard. `registerSource` re-throws any
non-23505 error and the other paths call `pool.query` bare, so a raw driver
error (message can carry `tags[]` row values on a failed write) would escape the
handler and be serialized by the MCP SDK. Fixed with a single `guarded(op, fn)`
wrapper per handler that returns ONE stable content-free `internal_error`
envelope (`ok:false, code:"internal_error", error:"source registry operation
failed"`) and logs only the operation name plus an allowlisted error code/name
(regex-bounded), never `err.message`. Typed expected results
(`namespace_denied`/`not_found`/`stale_revision`/`retired`/`conflict`/
`approval_state`) still flow through `errorResult` unchanged — the catch only
intercepts the throw path. Regression injects a non-23505 sentinel-bearing error
and asserts the response and all `console.*` log lines omit the sentinel and raw
message, and a paired test proves a typed denial is not collapsed to
`internal_error`.

Extra review question for this class:

- Does a content-free catch envelope PRESERVE typed expected result codes, or
  does it flatten every failure (including authorization denials the caller
  needs to see) into one opaque error?
