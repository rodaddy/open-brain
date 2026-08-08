---
lane: security
order: 36
section: harvest-522
---
## [2026-08-03] Redaction changes need both directions tested and one shared helper

**Severity:** MEDIUM (stated in source)
**Source:** rodaddy/open-brain#88 (comment by rodaddy); harvested in #522
**Scope key:** `sme.security.redaction_needs_both_directions_and_one_helper`
**Status:** active

### Pattern

Redaction changes need both directions tested: a broadened unlabeled pattern must not eat benign values of the same shape (a 40-char SHA is not an AWS secret), and narrowing must be paired with contextual labelled matching so real secrets are not newly missed. Every diagnostic surface must call the ONE shared redaction helper — a client that keeps its own private patterns silently misses each new shape added to the shared one.

Verbatim, from the source:

> MEDIUM: AWS secret-like redaction was too broad and could redact benign 40-character hashes. ... MEDIUM: Client diagnostics still had separate redaction patterns, so new shared redaction shapes would not apply to `OpenBrainHTTPError` bodies.
