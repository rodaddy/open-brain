---
lane: domain-backend
order: 95
---
## [2026-08-08] A "compose it" lane must ask what the composer can actually see

**Severity:** HIGH
**Source:** #652 capture-health composition lane, Tightenings round 14
**Scope:** `/health` inputs, `server/main.ts` composition, `scripts/done-means/652-capture-health-composed.sh`
**Status:** active

### Pattern

The reader wanted watermark bytes and spool depth — client-side per-hook files a SERVER cannot enumerate. Passing an honest-looking `0` for an unobservable count is not neutral: zero-while-sessions-ran IS the wedged fault, so a hardcoded zero would degrade EVERY healthy deployment into a permanent false alarm.

Substitute a value that preserves the PROPERTY (turns arriving is approximately watermark advancing), and publish which faults the vantage point can actually raise. Round 10's TEST-NET lesson in the counts domain.

### What to do

- **A per-role check must SEED the expected roles before folding rows.** `GROUP BY role` returns no group for the dead speaker — the exact entity the check exists to find. A fold over returned rows reports a busy lane and rebuilds #447.
- **Late-binding needs its own clause.** Two requests against one composed app, with the observation CHANGED between them, was the only clause that caught a boot-captured reading. Any health input composed as a closure carries this clause.
- **A type added for a future composer is exported at the boundary in the SAME PR.** `tsc` found #648's `TransportCaptureHealth` declared but never barrel-exported — invisible until the first composer tried to import it.

### Corollary: declare your own remaining gap

A WRITTEN-not-RUNNING declaration that names its own missing piece makes the NEXT lane cheap. #648's residual-risk field pointed straight at the composition root, and this lane declared its own gap the same way — `server/main.ts` wiring awaiting an operator config ruling on namespace, window, and refresh cadence.

Hardcoding defaults to satisfy a dispatch expectation would have been the adjusted-silently failure.
