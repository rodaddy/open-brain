---
lane: gotcha-agent
order: 29
section: harvest-522
---
## [2026-08-03] Cross-language wire bugs are invisible to same-language review lanes

**Severity:** not stated in source
**Source:** issue #282 (pre-merge gauntlet comment); harvested in #522
**Scope key:** `review.cross_language_wire_needs_shared_fixture`
**Status:** active

### Pattern

Cross-language wire bugs are structurally invisible to same-language review lanes: each lane validates its own side's shape, so a TS/Python mismatch (response `kind` string, override field path) passes both reviews and fails only end-to-end. When a change spans two runtimes on one wire, require a shared cross-language fixture both sides validate against, and add a review lane (or opposite-runtime auditor) whose explicit job is comparing the two implementations field-by-field.

Verbatim, from the source:

> Codex caught two end-to-end blockers the same-language reviewers structurally could not (each swarm tested one side's own shape; the bugs are in the TS↔Python mismatch). ... **Root cause:** no shared cross-language wire fixture — TS and Python drifted independently.
