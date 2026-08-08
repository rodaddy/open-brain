---
lane: correctness
order: 30
---
## [2026-07-22] Unknown/foreign retrieval hits must fail closed, never drop before scoring

**Severity:** MEDIUM (P1)
**Source:** PR #348 terminal audit, 2026-07-22 (issue #322 live recall gate)
**Scope:** `eval/open-brain/live/gate.ts` (`toFixtureRetrieval`), any scorer that
maps live retrieval hits back to fixture/expected ids before computing metrics
**Status:** fixed-pre-merge

### Pattern

`toFixtureRetrieval` mapped each hit's server id back to a fixture id and
**silently skipped** any hit not in the seed map, and it never checked the hit's
namespace at all. An unmapped or foreign-namespace hit therefore disappeared
before scoring: ranks compressed (recall/MRR looked better than reality), a real
cross-namespace leak left `namespace_leaks=0`, and the run could still reach
PASS. Dropping an unaccountable hit is fail-OPEN. The fix validates EVERY hit
before mapping — it must carry the EXACT bound primary namespace AND an id this
run created (present in the seed map, which holds both primary and negative
seeded ids) — and throws a content-free `LiveTransportError`
(`search_brain:foreign-namespace` / `:unknown-hit`) otherwise, which defers to
teardown and blocks PASS. A KNOWN negative-role id surfacing under the primary
namespace is NOT a validation failure: it maps and flows to the scorer, which
counts it as the namespace leak (that is how in-namespace leakage is scored).

### Follow-up [2026-07-22, PR #348 terminal fix]: the parse boundary drops entries a layer earlier than the mapper

`toFixtureRetrieval` only ever sees the hits `parseHits` (the transport parse
boundary in `transport.ts`) chose to emit. `parseHits` was itself fail-OPEN: a
non-array / invalid-JSON success body returned `[]` (conflating a malformed
result set with a real empty read), and any non-object row or row lacking a
string id was silently skipped. Those discarded raw results never reached the
gate validator, so the gate-level fix above could not see them — the same
rank-compression / hidden-leak hole, one layer up. Fix `parseHits` to fail
closed: a success body MUST be a JSON array (`search_brain:malformed-results`
otherwise) and EVERY entry MUST be an object with a non-empty string id
(`search_brain:malformed-hit` otherwise). Keep namespace OPTIONAL at the parse
boundary so a valid-but-namespace-less hit still reaches the gate and is
classified there as `foreign-namespace` — moving the namespace check into
`parseHits` would mask that distinct gate-level classification. The isolation
probe (`attemptRead`) shares `parseHits`, so a malformed negative-namespace body
throws instead of being misread as `hitCount: 0` (an empty allowed read).

### Review Questions

- Does a retrieval/scoring mapper `continue`/skip hits it cannot map? A skipped
  hit compresses ranks and can hide a leak — validate and fail closed instead.
- **Does the layer that PARSES the raw result set (before the mapper) also fail
  closed?** A parser that returns `[]` for a non-array body, or skips a
  non-object / idless row, drops the evidence before the mapper can validate it —
  fix both the parse boundary and the mapper.
- Is the retrieved row's namespace (or tenant/scope) checked to be EXACTLY the
  one the query bound, so a row returned from outside the bound scope fails the
  run rather than being scored or dropped?
- Are the expected-but-present hits still returned alongside the bad one in the
  test, proving the failure fires even when good data is also present (not just
  on an all-bad result)?
- Is the failure label content-free (no hit id, namespace value, or body)?
- Do the read path (`search`) and the isolation-probe path (`attemptRead`) share
  ONE parse boundary, so a malformed body cannot be misread as an empty allowed
  read on the probe path?
