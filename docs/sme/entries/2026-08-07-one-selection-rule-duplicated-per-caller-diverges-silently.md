---
lane: correctness
order: 65
section: harvest-522
---
## [2026-08-07] One selection rule, duplicated per caller, diverges silently

**Severity:** HIGH
**Source:** issue #433 defect 1, PR #610 (brain_answer could not see session events)
**Scope key:** `sme.duplicated_selection_lists_diverge`
**Status:** active

### Pattern

Reusable review check: when two or more call sites independently re-derive the
same "what may I read/write/see" list, treat that as the defect, not the
symptom. Fixing only the caller named in the bug leaves the other copies wrong.

In #433 the selection was open-coded at each recall surface. `search_brain`
computed `ALL_TABLES.filter(canRead)` and then appended `entities`;
`brain_answer` computed `ALL_TABLES.filter(canRead)` and appended nothing.
Neither appended `ob_session_events`. The two lists had already silently
diverged from each other, and a corpus of 11,136 rows was unreachable from the
tool agents actually ask. Each new recall surface was one more place to forget,
and nothing in the type system or the tests noticed the disagreement, because
each copy was internally consistent.

Three things to check on any PR that adds a readable source:

1. Grep for every site that filters the canonical list. If there is more than
   one, the fix is to extract one selection function that all callers use, so
   a new source appears everywhere at once instead of one place at a time.
2. Check every SERVING TREE, not just the one you are editing. This repo has
   two live entrypoints (`src/index.ts` serves core01 via
   `deploy/open-brain.service` and `scripts/run-two-worker.ts`;
   `server/main.ts` is the local-clone serving entrypoint), each with its own
   `brain_answer`. Fixing one leaves a live path still blind.
3. Beware the acceptance check re-deriving the list a fourth time. A gate that
   hand-rolls its own copy of the selection can pass while the product stays
   broken -- it must call the real exported selection function.

Corollary on WIDENING: adding a physical table to the permissions/type union is
usually the wrong shape for a read-only corpus. `ob_session_events` has no
write contract and no PERMISSIONS row, so it was added as a read-only retrieval
source with its own CTE branch (the existing `entities` precedent) rather than
by widening `Table`/`ResourceTable`, which would have demanded a write contract
it does not have. Also confirm the extraction did not quietly widen a caller:
folding the two lists into one initially added `entities` to `brain_answer`,
a behavior change the issue never asked for, so it was made opt-in.

Corollary on INDIRECT NAMESPACING: a corpus without its own `namespace` column
is a namespace-isolation risk the moment it becomes searchable.
`ob_session_events` reaches namespace only through
`ob_session_lanes` on `lane_id`, so every new CTE must carry the auth-derived
predicate across that JOIN. Prove it by deleting the predicate and watching a
cross-namespace test fail; an isolation test that has never been seen to fail
is decoration.
