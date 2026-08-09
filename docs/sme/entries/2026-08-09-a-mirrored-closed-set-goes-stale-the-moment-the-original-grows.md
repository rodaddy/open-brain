---
lane: correctness
order: 70
---
## [2026-08-09] A mirrored closed set goes stale the moment the original grows — and the mirror that judges ABSENCE fails silently

**Severity:** HIGH
**Source:** #681 (cutover blocker B3) — `server/capture/liveness-observer.ts` seeded `EXPECTED_ROLES = ["user","assistant"]` beside an ingest enum accepting three; `tool` frozen at 14,006 rows from 2026-08-01 while `/health` read `stale: false, silent_roles: []` for eight days
**Scope key:** a closed set (enum, role list, status list, kind list, allowlist) written out a second time in another module
**Status:** active

### Pattern

A retyped copy of a closed set is not wrong when it is written — it is wrong *later*, and nothing announces the transition. The original grows a member, the copy does not, and every test written against either one still passes. #681's literal was correct for the enum it sat beside and became a blind spot the day a third role was added.

What makes this severity HIGH rather than cosmetic is **which direction the copy is read in**. A stale copy used to *accept* input fails loudly: the new member arrives, validation rejects it, someone sees an error. A stale copy used to judge **absence** fails silently and in the reassuring direction — the member that is missing from the copy is exactly the member that can never be reported missing.

The #681 mechanism, worth recognising by shape: counts came from `SELECT ... GROUP BY role`, and a role with zero arrivals returns **no row at all**. The judge folded over returned rows, so a role neither seeded nor present was never a key, and the silent-role fault was structurally unable to name it. Dead role → no rows → no group → no key → not silent → healthy. The health check reported green over a dead speaker on the very evidence a production cutover was to rely on.

This is the second instance of the same defect in the same module: #447 was the identical shape with `assistant` as the missing role, and the seed added to fix it was itself written as a literal — so the fix preserved the mechanism and the next role walked into it.

### Review checks

- **Grep the codebase for the set's members, not the set's name.** A second copy rarely shares the identifier; it is a bare array of the same strings somewhere else. Three copies of the role set existed here (`server/tools/`, `src/tools/`, the SQL `CHECK`) and only one was derived.
- **For every mirrored set, ask which direction it is read in.** If any consumer uses it to decide what is MISSING, absent-member drift is silent and needs a derived source or a drift test — reasoning that "we'd notice" is exactly what failed for eight days.
- **A fix that adds the missing member to the literal is not a fix.** It resolves the instance and preserves the mechanism. Require either derivation from one exported source or an executable drift assertion; "add the missing one" is the finding, not the remedy.
- **Where a copy genuinely cannot be folded in — a separate deployment tree, an applied migration's `CHECK` (immutable history), another language — the drift test IS the enforcement.** Copies that agree because something asserts they agree are a different world from copies that agree because nobody has touched one yet.
- **Check the fold for `GROUP BY`-shaped blindness generally.** Any aggregate that reports per-category health from returned rows alone cannot see a category with no rows. The expected categories must be seeded before the fold, and the seed must come from the authority that defines them.
- **When widening such a seed, read the existing test fixtures as evidence of the old world.** Two tests here encoded the two-role assumption and failed on the corrected behaviour — the failures were the fix working, not a regression, but a lane that "fixed" the fixtures without reading them would have narrowed the seed back.
