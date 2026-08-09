---
lane: gotcha-agent
order: 68
---
## [2026-08-09] A hardcoded 0 standing in for an unmeasured quantity is a silent data loss

**Severity:** HIGH
**Source:** #680 (cutover blocker B2) — 15 raw turns and ~44 lifecycle records permanently abandoned while `/health` read `spool_pending:0, reason:"capture lane delivering"`
**Scope:** any health block, metric, counter, or status field a vantage point cannot actually measure
**Status:** active

### Pattern

A reporting surface needs a number it cannot observe, so it passes `0` — or
`?? 0`, or omits the field so a reader defaults it. The value is not wrong in a
way anyone notices, because zero is exactly what a HEALTHY system reports. The
two states collapse into one:

- **nothing is wrong** — measured, and the count really is zero.
- **nobody looked** — unmeasured, rendered as if measured.

Every alert, dashboard, and reviewer downstream now reads the second as the
first. The failure is not that the surface is silent; it is that the surface is
CONFIDENTLY GREEN over the exact condition it exists to report.

Measured instance: `liveness-observer.ts` hardcoded `spoolPending: 0` because a
server genuinely cannot enumerate client-side spool files. That reasoning was
CORRECT for spool depth and was silently inherited by quarantine — a different
quantity a client already computes (`SpoolStatus.quarantined_count`) and can
simply report. Fifteen turns were confirmed absent from `ob_raw_turns` and
present on disk in a sidecar, while the same session kept delivering 1,819
further turns, so the lane looked healthy by every available signal. The count
that would have revealed it had existed for weeks with zero consumers anywhere
outside the module that computed it.

### What to check in review

1. **For every 0 in a status/health/metric construction, ask "measured, or
   assumed?"** A literal `0`, a `?? 0`, or a default parameter on a field the
   producer cannot see is the smell. The fix is ABSENT (`undefined`, field
   omitted), never a neutral-looking number.
2. **A computed value with no consumer is a defect, not dead code.** Grep the
   count's name across the tree. If the only references are the module that
   computes it and its own tests, the observability it represents does not
   exist — someone built the measurement and never connected it.
3. **When a module documents WHY it cannot observe something, check that the
   reasoning still holds for every field it covers.** "A server cannot read
   client files" is true of a spool's live depth and false of a count the
   client already reports. Inherited justifications are how a correct argument
   ends up defending an incorrect case.
4. **Ask whether the fault is gated on liveness quorum, and whether it should
   be.** "Is it working right now?" is meaningless on a quiet night and
   correctly suppressed below quorum. "Is data already lost?" is equally true
   at 3am — gating it hides precisely the deployment that stopped working
   BECAUSE its records were being dropped.
5. **A latch or dedupe that suppresses repeats must be checked against the
   fact's LIFETIME.** State-change suppression is right for a transient
   condition that resolves itself and wrong for a standing one that never
   does: the recovery is exactly when a healthy-looking report buries the
   permanent loss.

### Test that proves it

Assert the ABSENT case separately from the zero case, and mutation-test it —
this class is invisible in a fully-green run:

```ts
it("omits the count entirely when nothing reported one", () => {
  const reading = readCaptureLiveness(deliveringObservation()); // no input
  expect(reading).not.toHaveProperty("quarantined_count");
});
```

Replacing the conditional spread with `quarantined_count: quarantined ?? 0`
(the defect's own shape) must turn the suite red. In #680 that mutant was
killed by 2 tests; without the absent-case clause it would have survived, and
the check would have certified the defect.
