---
lane: adversarial
order: 30
section: harvest-522
---
## [2026-08-03] A detector guard is also an exclusion filter

**Severity:** not stated in source
**Source:** https://github.com/rodaddy/open-brain/issues/232; harvested in #522
**Scope key:** `sme.detector_guards_are_exclusion_filters`
**Status:** active

### Pattern

A detector guard framed as "prevents over-matching X" is often silently also an under-matching filter that excludes real targets. Review detector tests for engineered-to-pass fixtures: if every positive test injects the exact feature the regex requires and every negative test omits it, the suite proves the regex matches itself, not that it catches real inputs. Demand adversarial fixtures on both sides of each guard.

Verbatim, from the source:

> Every "scrubs" test injects a symbol; NO test for the pure-alnum-40 leak; the two SHA-negative tests use only lowercase-hex-no-punctuation, so they never catch the `commit-<sha>-tag` over-redaction. ... **Killshot: the symbol requirement is a secret-EXCLUSION filter, not an anti-SHA tweak.**
