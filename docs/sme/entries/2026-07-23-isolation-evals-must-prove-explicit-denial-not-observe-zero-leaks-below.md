---
lane: adversarial
order: 24
---
## [2026-07-23] Isolation evals must prove EXPLICIT denial, not observe zero leaks below a ranking cut

**Severity:** MEDIUM
**Source:** PR #364 review swarm, 2026-07-23
**Scope:** isolation/leak evals and any test that infers a boundary holds from a
metric (recall/leak count) computed over a truncated result set
**Status:** fixed-pre-merge

### Pattern

The isolation eval concluded "no leak" from observing zero foreign-namespace hits
in the returned/scored results — but the results were the top-K after a ranking
cut, so a foreign row ranked below the cut was simply never seen, not proven
denied. Absence-below-a-cut is not denial: a real cross-namespace leak that
happens to rank low reads as a pass, and the eval's isolation guarantee is
vacuous. This is the eval-design mirror of the [2026-07-22] correctness entries
(unknown/foreign hits must fail closed, never drop before scoring; isolation
evals must PROVE explicit denial): the boundary must be exercised by a probe that
attempts to read the foreign row directly and asserts an explicit denial /
zero-row scoped read, not inferred from a leak counter over a bounded ranking.
Pair it with the enumeration discipline from the [2026-07-21] negative-matrix
entry — enumerate the surface, attempt an override, and anchor at least one denial
on a real database (foreign row provably untouched/unreadable) with a paired
owning-identity success proving the probe is non-vacuous.

### Review Questions

- Does the isolation eval assert an EXPLICIT denial (a direct probe read of the
  foreign row returns zero rows / a permission denial), or does it only observe
  zero foreign hits in a top-K / above-cut scored set?
- Could a foreign row rank BELOW the result cut and thus be counted as "no leak"
  when it was merely unranked, not denied?
- Is there a direct-read probe scoped to the foreign namespace asserting the row
  cannot be read, plus a paired owning-namespace read proving the probe is not
  vacuously empty?
- Is at least one denial anchored on a real database (row provably unreadable from
  the wrong namespace), per the negative-matrix live-anchor rule?
