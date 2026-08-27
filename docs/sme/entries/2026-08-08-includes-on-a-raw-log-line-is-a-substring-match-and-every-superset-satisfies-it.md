---
lane: correctness
order: 92
---
## [2026-08-08] `includes()` on a raw log line is a substring match, and every superset satisfies it

**Severity:** HIGH
**Source:** #656 observer-wiring lane, Tightenings round 17
**Scope:** `scripts/done-means/656-capture-observer-wired.sh` and any clause reading structured logs as text
**Status:** active

### Pattern

`includes("<event_name>")` against a raw log line matches every SUPERSET of that name. A renamed event (`x_MUTED`) kept two clauses green — the clause passed both when the notice existed AND when it had been renamed away.

Round-9 negative-match family, new spelling.

### What to do

- Parse the line and compare the `msg` field for EQUALITY (`findEvent()`), then mutation-test the rename to prove the clause discriminates.
- **A "loud on absence" claim asserts BOTH halves in ONE clause** — loud in the log AND quiet in the health verdict. Split into two clauses and each half passes for the wrong reason: silence-on-absence is the status quo, and a verdict-on-absence violates absence-is-not-staleness. Two audiences, one clause.

### Corollary: record gate paybacks as deliberately as gate taxes

The design-lookup gate fired on the exact edit where the lane was about to hand-roll shutdown teardown in a catch block. The surfaced doc showed `backgroundRuntimes` already owns ordered shutdown, and the delta collapsed to one runtime registration instead of a whole new mechanism.

If only the TAXES get recorded, the ledger only ever argues for retirement.

### Corollary: two CI runs of one identical SHA

The `push` and `pull_request` workflows both run `check` on the same commit, so every PR gets a two-runs-same-SHA comparison for free. Use it before concluding a branch defect — #643's shape recurred and was settled this way.

### Corollary: empty after a timeout is DID-NOT-RUN

`aqmd search` returning EMPTY after a 120s+ timeout is worse than slow: it reads as "no results." Wrap it in `timeout` AND treat empty output as did-not-run; `qmd search` direct is the roughly one-second fallback.
