---
lane: correctness
order: 32
---
## [2026-07-22] Whole-pack trimming must reconcile section truth, not only retained items

**Severity:** MEDIUM (P2)
**Source:** PR #353 / issue #327 Full-tier review
**Scope:** `src/tools/agent-context-pack-budget.ts`, ranked context-pack sections
**Status:** fixed-pre-merge

### Pattern

A whole-pack fitter can correctly drop low-priority items and citations while
leaving the section envelope's own state stale. In PR #353, `durable_memory`
reported `truncated: false` after ranked tail items were removed, and an empty
retained envelope lacked a stable whole-pack empty reason. Counts and citations
were correct, but the section still lied about whether the caller received the
full result. The fix reconciles every trimmed return path: any dropped item sets
`truncated: true`; an emptied-but-retained envelope reports
`empty_reason: "whole_pack_budget"`; counts, citations, warnings, and serialized
budget are rechecked after metadata changes.

### Review Questions

- When a pack-level fitter drops items, does it update the section's own
  `truncated` and `empty_reason`, not only arrays and counts?
- Are both partial-tail-drop and all-item-drop paths covered by tests that fail
  against the old metadata behavior?
- If reconciliation adds metadata, is the serialized pack measured again so the
  fix cannot exceed the hard budget?
- Do citations and warnings derive from the final retained item set?

### Recurrence (PR #357 / issue #328)

The same defect recurred in a different code location: the structured
`profile_guidance` / `process_guidance` / `repo_facts` sections re-fit through
`fitItemSection`, which — unlike `fitRankedItemSection` — does NOT self-reconcile
the section body. So the reconciliation must happen in the **caller**
(`admitStructuredSection` in `agent-context-pack.ts`): after a trim it stamps
`truncated: true`, and `empty_reason: "whole_pack_budget"` when the trim empties
an admitted envelope. Stamp before the serving/overflow checks so the added keys
are counted against the surviving budget, and only mutate the trimmed body (a
no-trim `fitItemSection` returns the loader's genuine-empty body by reference —
mutating it would falsely stamp a real no-data empty). Extra review question:
when a section reconciles at the caller rather than inside the fitter, is a
genuine no-data empty (loader emitted `items: []`) left unstamped?
