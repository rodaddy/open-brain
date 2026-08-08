---
lane: domain-backend
order: 27
section: harvest-522
---
## [2026-08-03] A shared pattern list has multiple consumers with different failure modes

**Severity:** not stated in source
**Source:** https://github.com/rodaddy/open-brain/issues/232; harvested in #522
**Scope key:** `sme.shared_pattern_list_has_multiple_consumers`
**Status:** active

### Pattern

When a pattern list feeds both a cosmetic redactor and a fail-closed reject gate, adding a broad heuristic to the shared list turns false positives into denial of service. Reviewing a change to a shared pattern/rule list means enumerating every consumer and checking whether each tolerates over-matching; keep high-recall heuristics in a separate list applied only to the cosmetic consumer.

Verbatim, from the source:

> `SECRET_PATTERNS` has **two** consumers in this package: `redact_text` (cosmetic redaction) AND `agent._reject_secret_payload` (a **fail-closed receipt reject gate**). ... A verbatim add to `SECRET_PATTERNS` broke the reject gate: the high-entropy heuristic matches benign 40+ char slash/underscore **file paths** ... causing a valid receipt to be **falsely rejected**.
