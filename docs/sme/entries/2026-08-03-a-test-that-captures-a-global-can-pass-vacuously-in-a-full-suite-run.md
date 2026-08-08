---
lane: adversarial
order: 33
section: harvest-522
---
## [2026-08-03] A test that captures a global can pass vacuously in a full-suite run

**Severity:** not stated in source
**Source:** issue #422 (source-sync.test.ts full-suite failure); harvested in #522
**Scope key:** `sme.global_capture_tests_pass_vacuously`
**Status:** active

### Pattern

Reusable review check: a security-boundary test that captures output by monkey-patching a global (`console.error`) can silently capture zero lines in a full-suite run, after which every downstream assertion passes vacuously while the suite still reports coverage. Assert against the logger boundary directly instead of a rebindable global; if a capture stays, it must fail loudly when it captures zero lines for a reason other than the one under test.

Verbatim, from the source:

> When `failLine` is `undefined`, the redaction assertions never meaningfully run. A test that silently stops checking is worse than one that is simply absent, because the suite still reports it as covered.
