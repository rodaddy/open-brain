---
lane: gotcha-agent
order: 40
---
## [2026-08-08] Nothing is adjusted silently: tools announce every self-made decision

**Severity:** HIGH
**Source:** Operator ruling 2026-08-08 during the PR #616 decisions review; first instance `scripts/lane-bootstrap.ts` DB-name shortening
**Scope:** any script, tool, or lane that transforms its input to satisfy a constraint
**Status:** active

### Pattern

Operator ruling, verbatim intent: "anything silently is an unacceptable outcome." When a tool adjusts something on its own — shortens a name to fit a bound, substitutes a default, skips an inapplicable step, coerces a value, retries with a variant — the adjustment must be announced in its output, even when the adjustment is provably safe.

The instance that produced the ruling: `lane-bootstrap.ts` correctly kept DB names under Postgres's 63-byte identifier bound (server truncates silently — the danger it defended against), but performed its own slug-shortening without printing it. The defense against silent behavior was itself silent. Correct handling and unannounced handling are different defects: the first corrupts state, the second corrupts the operator's model of state.

Review checks:

- For every `slice`/`substring`/`replace`/default-fallback on the path from user input to an external system, find the corresponding output line that states original → adjusted and why. Absent line = defect.
- "It only changes cosmetics" is not an exemption; the transcript must let the reader map what they asked for to what exists.
- Skipped steps count: a tool that decides a step is N/A says so and why (the downstream-rollout classification format is the model).
- The announcement belongs in the tool's normal output, not a log level that is off by default.
