---
lane: gotcha-agent
order: 38
section: harvest-522
---
## [2026-08-07] `_DOCS/STANDARDS-*.md` in this repo are generated — lessons written there are erased

**Severity:** MEDIUM. **Status:** open — near-miss caught before writing,
2026-08-07.

Asked to record a durable lesson in `_DOCS/`, the obvious move is to append it
to the matching `_DOCS/STANDARDS-*.md`. **Every file in this repo's `_DOCS/` is
generated** and carries a `source-hash` (verified 2026-08-07: all 8 files
match `rg -l 'source-hash' _DOCS/`). `AGENTS.md` states they must never be
hand-edited; a rule change goes in the Development `_DOCS/` source, then
`bun _ob/scripts/sync-repo-standards.ts open-brain` regenerates the copies.

A lesson appended to a generated file survives until the next sync and then
vanishes with no error and no diff anyone reads — the precise failure mode that
"we should only have to figure this out once" is meant to prevent.

Review checks for the next swarm:

- **Before writing to any `_DOCS/` path, check for a `source-hash`.** If it has
  one, the file is a build artifact.
- **Route by lesson type, not by which directory came to mind first:** a review
  blind spot goes in `docs/sme/<lane>.md`; a design choice with rationale worth
  not re-litigating goes in `docs/decisions/` (its README explains why issues
  alone are insufficient).
- **Repo-local first; promotion is a separate, later, operator decision.**
  While a practice is still being worked out it stays in this repo's `docs/`.
  Operator, 2026-08-07: *"right now we're doing our own docs in this repo and
  once we've sussed it out, we might put something in `_DOCS` where it'll live
  forever. But right now we're just sussing it out."* Promoting an unproven
  practice makes every other repo inherit a rule that has not earned it yet.
  Do not treat promotion as a tidy-up step at the end of a task.
