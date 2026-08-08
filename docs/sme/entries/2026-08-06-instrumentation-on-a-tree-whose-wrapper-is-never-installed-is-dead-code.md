---
lane: correctness
order: 60
section: harvest-522
---
## [2026-08-06] Instrumentation on a tree whose wrapper is never installed is dead code the tests cannot see

**Severity:** HIGH
**Source:** PR #599 review swarm (retrieval-evidence spans), finding H1
**Scope key:** `review.instrumentation_reaches_production_tree`
**Status:** active

### Pattern

This repo has TWO serving trees (`server/main.ts` for the local clone, `src/index.ts` for core01), and a cross-cutting install (tracing, audit, any registerTool wrapper) done on only one of them leaves the other tree's call sites permanently inert: `activeMcpTrace.getStore()` is always undefined, every helper takes its early-return branch, and nothing fails. PR #599 shipped ~half its added lines as exactly this — the PR body claimed "both serving trees" while the core01 tree had zero tracing references. Unit tests driving the helper directly cannot catch it; the guard is an end-to-end test that registers a REAL tool under the installed wrapper and asserts the expected span/effect, per tree. Review question for any wrapper-based feature: name the file:line where the wrapper is INSTALLED on each tree that serves production, and the test that would fail if it were not.

### Pattern (same PR, finding M3)

A span or timing wrapper around `run: () => alreadyComputedValue` measures nothing: `duration_ms` is structurally ~0 and the stage's exception path can never fire, while the identically-named span on the other tree measures real work. A silently-wrong diagnostic is worse than an absent one. Check that the computation is INSIDE the measured callback everywhere the span name is emitted.
