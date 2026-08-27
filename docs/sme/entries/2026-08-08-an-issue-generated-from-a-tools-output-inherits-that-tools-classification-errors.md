---
lane: adversarial
order: 89
---
## [2026-08-08] An issue generated from a tool's output inherits that tool's classification errors

**Severity:** HIGH
**Source:** PR #663 (#661 five-keys lane), operator ruling 29.2a, Tightenings round 20
**Scope:** issues filed from tool output; `scripts/done-means/661-launcher-honors-six-keys.sh`; launcher env handling
**Status:** active

### Pattern

#659's drop reporter could not tell set-empty from set-valued, so its boot line named a PROHIBITED key, and the resulting ruling said "honor all six." A lane that simply obeyed would have shipped a change the source forbids.

The lane validated each enumerated key against source, found the prohibition (`PROHIBITED_PATH_KEYS`, test-pinned), HELD AT PROVEN RED, and escalated with options rather than obeying or silently deviating. The operator amended the ruling.

This is the no-variations rule's DESIGNED behavior. Brief it as the expectation, not as an exception a lane has to be brave to take.

### What to do

- Treat a briefed enumeration derived from tool output as a hypothesis. Validate each element against source before building on it.
- Hold at proven RED and escalate with options. Never obey a briefing the source contradicts, and never deviate quietly.
- **Empty-means-suppressed is repo precedent** (`QMD_PATH=`). A drop reporter distinguishes unset / set-empty / set-valued and SKIPS explicit suppressions rather than announcing them — a per-suppression boot line is exactly the noise the #659 scope rule exists to prevent.

### Corollary: report equivalent mutants as equivalent, not as kills

A survived mutant (`=== ""` versus `!configured` behind an undefined-guard) was provably UNREACHABLE, not a check gap. The first instinct — "fix" the check — would have shipped a false rationale into the repo.

A survived mutant deserves the same why-analysis as a failed clause.

### Corollary: prove new tests execute

Assert the test COUNT went up (14 to 19). A green suite may simply never have loaded the new file, and green-because-absent is indistinguishable from green-because-passing at the summary line.
