---
lane: correctness
order: 98
---
## [2026-08-28] A brief number is an anchor: read the manifest entry before touching the floor

**Severity:** MEDIUM. **Status:** active.

**Source:** PR #957 (the session-12 append-session-event split).

**Scope:** `scripts/assert-db-tests-ran.ts` and every #878 conversion brief.

### Pattern

A brief that states `minTests M` for an existing `REQUIRED_SUITES` entry can
simply be wrong. In session 12 both the handover and the plan said `minTests 8`
for `append_session_event create_if_missing (live Postgres)`, while
`scripts/assert-db-tests-ran.ts:40` carried 4 and JUnit emitted 8. Read through
rule 55's "entry exists, floor unchanged" clause, the stated number sent the
first step the wrong way, and the wrong count would have stayed in the file:
the rule protects the floor from drift, not from a value that was already
incorrect. The same class of error ran through the plan's per-group counts —
four of seven groups were off by one or two its, and an event-type loop array
described as 8 entries carried 9.

### Check

The lane reads the manifest entry line itself rather than the brief's quotation
of it, measures the suite with JUnit output, and — where the two disagree —
corrects both the entry and `MIN_TOTAL_LIVE_TESTCASES` by the measured delta,
announcing the original and adjusted values. `bun test
scripts/assert-db-tests-ran.test.ts` is the receipt. Every count a brief states
is treated as an anchor to verify against the file, not a fact to carry.
