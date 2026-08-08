---
lane: correctness
order: 61
section: harvest-522
---
## [2026-08-06] Verification tooling must never render absence of evidence as equivalence

**Severity:** HIGH
**Source:** PR #601 review swarm (trace forensics tooling), findings H1/H2/H3
**Scope key:** `review.comparison_tools_fail_toward_unknown`
**Status:** active

### Pattern

A diff/comparison tool is an operator trust surface: what it prints is what the operator believes happened, so its worst failure is a false "identical". PR #601 shipped three ways to produce one: (1) same-named spans unioned into one bucket, so swapped per-occurrence results compared equal — align occurrences pairwise by index, never union; (2) two traces with zero observations compared equal — but batched exporters make "not flushed yet" and "identical" indistinguishable, so zero compared evidence is `unknown` with its own exit code, never `equivalent`; (3) stages whose evidence is counts-only (the degraded shape) compared equal because only row-id sets were consulted — when the primary evidence is absent, compare the fallback fields and NAME the basis in the output. Also: ranked selections compare as ordered sequences (order IS the ranking; a Set comparison hides a pure reordering regression). Review question for any comparison/verification tool: enumerate every path that can print "same" and prove each one actually compared something.
