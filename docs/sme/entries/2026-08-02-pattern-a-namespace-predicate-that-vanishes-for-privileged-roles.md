---
lane: adversarial
order: 27
---
## Pattern: a namespace predicate that vanishes for privileged roles

**Provenance:** #485 (find_duplicates), found while porting the last ten tools
onto the rewrite server. Severity: HIGH. Status: fixed on the rewrite path.

The predicate builders in this repo return an EMPTY clause for a global role,
because a global role reads everything and so needs no filter. That is correct
for a single-table read. It is a defect the moment the query is a self-join, a
fan-out, or anything else whose cost depends on the predicate rather than on
the row ceiling.

`find_duplicates` appended a read predicate to each side of a pairwise
self-join. For `admin`/`ob-admin` the readable-namespace set is `undefined`, so
BOTH sides contributed the empty string and the emitted SQL had no namespace
filter at all. `ORDER BY distance ASC` meant `LIMIT` could not save it: every
surviving pair's distance is computed before anything can be ordered.

Measured on a 24,845-row corpus (~308M pairwise halfvec distances):

| shape | result |
|---|---|
| namespace-scoped | 256.7 ms, 5 rows |
| unscoped (the admin path) | cancelled at 60,074 ms by `statement_timeout` |

The second-order damage is what makes this worth a lane entry. The pooled
connections did not come back -- 42 backends were observed still `active` on
this join five minutes after the run that launched them had ended. In `bun
test`, every later test needing a connection then failed on a pool that never
refilled, so ONE slow query produced a cascade of unrelated red: a parity run
reported 13 failures where only 6 were real, and separating them cost a full
investigation.

### Review Questions

- For every emitted predicate, ask **what this query does when the predicate is
  empty**, not merely whether the predicate is correct when present. "Admin sees
  everything" and "admin runs an unbounded quadratic join" are the same code
  path.
- Is the predicate applied to **both** sides of a self-join? One-sided scoping
  still admits cross-namespace pairs, which is an isolation leak wearing a
  performance costume.
- Does the tool expose any argument that can bound the scan? `find_duplicates`
  exposed none, so an admin caller had no way to narrow it even knowing the
  hazard. A privileged path with no way to scope it is not an escape hatch.
- Does `LIMIT`/`FETCH FIRST` actually bound the WORK, or only the output? With
  `ORDER BY` over a computed expression it bounds only the output.
- Is there a `statement_timeout` on any query whose cost is not index-bounded?
  Treat an unbounded statement on a pooled connection as a fault that takes the
  whole suite down, not as one slow call.
- When a test run shows many failures at once, check for pool starvation before
  believing the count. A connection leak makes unrelated tests fail in numbers
  that mislead the entire triage.
