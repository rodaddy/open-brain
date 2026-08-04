# The supervisor trips before it notifies

**Scope key:** `repo.open_brain.supervisor_trips_before_it_notifies`
**Source:** issue #399 (DREAM-10: Loop supervisor)
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

A loop supervisor is trip → release → notify, in that order: detection must halt the offending stage rather than only observing it, because alerting on a runaway that keeps running delivers 400 notifications while the box burns. Tripped state must be persisted so a restart cannot silently clear a breaker and resume the runaway; repeat trips back off exponentially. Notification must also fire on silence — 'REM has not run in N hours' is as important as 'REM ran 400 times' — and must be content-free and deduplicated. Volume that looks like success must still trip an alarm, because 'something is broken' is far more likely than 'genuinely huge legitimate volume'.

## Verbatim, from the source

> An alert on a runaway loop that keeps looping is a notification delivered 400 times while the box burns. **Detection must halt the offending stage, not just observe it.** [...] Tripped state must be **persisted**, not in-memory — a restart cannot silently clear a breaker and resume the runaway.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
