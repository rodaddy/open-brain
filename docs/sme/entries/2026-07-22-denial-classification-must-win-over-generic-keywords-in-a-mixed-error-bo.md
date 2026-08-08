---
lane: adversarial
order: 18
---
## [2026-07-22] Denial classification must win over generic keywords in a mixed error body

**Severity:** MEDIUM (P2)
**Source:** PR #348 review swarm, 2026-07-22 (issue #322 live recall gate)
**Scope:** `eval/open-brain/live/transport.ts` (`redactToolFailure`,
`sanitizeThrownTransportError`), any content-free error classifier that picks a
single keyword from an allowlist by first-match
**Status:** fixed-pre-merge

### Pattern

Three adversarial classes surfaced in the source-registry substrate:

1. **Snapshot clobber:** a fire-and-forget background UPDATE that recomputes an
   array column (tags) in JS from the snapshot captured at write time overwrites
   whatever a concurrent same-content upsert merged into the row in the interim.
   Fixed by merging the extracted candidates onto the LIVE column in SQL
   (`unnest(t.tags)` union, append-only for genuinely-new case-insensitive
   keys), keeping `id + auth-derived namespace + archived_at IS NULL`. `$1`
   carries only the candidates, never the pre-merged full array.
2. **Over-broad interpolated-table allowlist:** `EXTRACTION_TABLES` listed
   tables (relationships/projects/sessions) that were never callers and lack the
   `extracted_metadata` column, so enrichment there would UPDATE a nonexistent
   column. Narrow an interpolation allowlist to the exact current callers with
   the required column, and add a test rejecting a formerly-listed table.
3. **Non-terminal "terminal" state:** a soft-delete (retired) that `updateSource`
   could still move back to active/paused re-opens ingestion eligibility. Guard
   the UPDATE with `lifecycle_state <> 'retired'` and, on 0 rows, distinguish
   `retired` from `stale_revision`/`not_found` using an existence probe scoped to
   the caller's OWN namespace (no cross-namespace oracle). `remove_source` is
   idempotent: a repeat on an already-retired row is a no-op success with no
   revision bump; a missing/wrong-namespace id stays `not_found`.

### Review Questions

- Does any background/enrichment UPDATE that rebuilds an array/JSON column read
  the LIVE column, or does it overwrite from a stale in-process snapshot?
- Is every interpolated-table allowlist scoped to tables that both have the
  target column and are actual current callers, with a rejection test?
- Is every "terminal"/soft-delete state actually terminal — can an update path
  move it back into an eligible/active state?
- Do retired/idempotent no-op results avoid becoming a staleness or existence
  oracle across namespaces, and does the no-op path skip the revision bump?
The content-free redactor selected the error keyword with a single
`KEYWORDS.find(kw => body.includes(kw))` over one flat array. Server error
bodies routinely mix phrases — "invalid request: unauthorized for namespace",
"invalid archive: forbidden" — and because `"invalid"` sat ahead of
`"unauthorized"` / `"forbidden"` in the array, first-match returned the generic
keyword and the label was classified as a NON-denial error. That silently
weakens the two places denial classification matters: the isolation proof (a
real permission denial mislabeled as a plain error is not counted as isolation
proof) and a teardown/auth failure (a namespace/permission refusal read as a
generic error loses its security meaning). Fixed by splitting the allowlist into
denial keywords (`permission denied`, `not authenticated`, `unauthorized`,
`forbidden`) matched FIRST, then generic keywords, so a mixed body always
classifies as a denial regardless of array order.

### Review Questions

- Does any single-keyword error/label classifier depend on array ORDER to pick
  the "right" keyword, when a real body can contain more than one match?
- Are the security-relevant signals (denial / auth / permission) matched with
  explicit precedence over generic ones (invalid / not-found / timeout), not by
  incidental list position?
- Is there a mixed-body test for BOTH the response-error path
  (`redactToolFailure`) and the thrown-error path
  (`sanitizeThrownTransportError`), asserting the denial keyword wins over a
  leading generic keyword AND over a bare HTTP status code?
- Does a generic-only body still classify as non-denial (no over-broad
  promotion of every error to a denial)?
