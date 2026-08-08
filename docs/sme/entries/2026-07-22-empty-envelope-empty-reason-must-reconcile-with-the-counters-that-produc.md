---
lane: correctness
order: 35
---
## [2026-07-22] Empty-envelope `empty_reason` must reconcile with the counters that produced it

**Severity:** MEDIUM
**Source:** PR #359 (P2), fix `fix(333)`; #333 prior-context suppression
**Scope:** `src/tools/agent-context-pack-durable-memory.ts`, any section that emits both an `empty_reason` and content-free counters
**Status:** active

### Pattern

A section that emits a zero-item envelope AND separate counters (here
`prior_context_suppression: {recalled, suppressed, net_new, emitted}`) can put
the two in direct contradiction. `durable_memory` derived `empty_reason` from
only two causes — `all_suppressed` (all recalled rows were prior context) vs
`no_matches` (recall found nothing) — and missed a third: a record survived
suppression (`net_new > 0`) but produced no emittable body (null / empty-string
`content_preview`, or the char budget was too small for even the first body).
That case fell through to `no_matches`, so the envelope claimed recall found
nothing while `net_new > 0`, `emitted = 0`, and `truncated = true` all said a
net-new match existed and was dropped. The counters were correct; the reason
lied about them.

The truthful fix adds a distinct, content-free reason (`content_unavailable`)
and derives `empty_reason` in the only order that reads correctly:
`net_new > 0` → `content_unavailable`; else recalled-and-all-suppressed →
`all_suppressed`; else → `no_matches`. `net_new` is tested first so a
net-new-but-unemittable section can never be mislabeled. The distinction is
kept truthful without inventing a body: the reason is derived from the same
counters the envelope already exposes, not from re-reading content.

Note the boundary split: the section loader owns the *genuine* empty reasons
(no data / all-suppressed / content-free); the whole-pack allocator separately
stamps `whole_pack_budget` only when its own re-fit trims a non-empty body to
empty. The two never collide because the content-free case emits no body for the
allocator to trim.

### Review Questions

- Does a zero-item / empty envelope carry an `empty_reason` AND separate
  counters? Do all counter combinations map to a distinct, truthful reason, or
  can a real state (e.g. `net_new > 0, emitted = 0`) fall through to a reason
  that contradicts the counters?
- Is the reason derived from the counters/state the envelope already exposes,
  or re-derived from a narrower predicate that misses a case?
- Are the empty-reason branches ordered so the most specific truthful cause wins
  (net-new-but-unemittable before "no matches")?
- Is there a regression for the null AND empty-string content case proving the
  reason, `truncated`, the counters, and empty citations together — and does it
  fail on the pre-fix code (received the wrong reason)?
- Is there a no-over-suppression guard proving an unemittable record does not
  hide or starve a sibling record that IS emittable (something emitted ⇒ no
  content-free empty reason)?
- If a downstream allocator can also stamp an `empty_reason`, is the ownership
  boundary explicit so the loader-owned and allocator-owned reasons cannot
  overwrite each other in the wrong case?
