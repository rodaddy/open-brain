---
lane: adversarial
order: 9
---
## [2026-07-08] Reusing an output field with a new value distribution is a contract change

**Severity:** MEDIUM
**Source:** PR #278 pre-merge gauntlet for Issue #268
**Scope:** `search_all`/`brain_answer` graph evidence rows, any consumer-visible
field whose value range changes without a schema change
**Status:** fixed in PR #278

### Pattern

Emitting an existing output field with a new value distribution -- `score` set
to a raw link weight instead of the established [0,1] relevance range -- is a
value-level contract change hiding under "no schema change." Downstream ranking,
thresholds, and display logic built for the old distribution silently misbehave.
Clamp/normalize at the consumer boundary and classify the change in the
downstream rollout gate even though the schema is untouched.

### Review Questions

- Does a new evidence source write into a pre-existing field? What distribution
  do current consumers assume for it?
- Is the new value clamped/normalized to the established range at the boundary?
- Was the change classified under `docs/downstream-rollout.md` as
  client-visible despite having no schema diff?
- Do tests assert the emitted values stay inside the documented range?
