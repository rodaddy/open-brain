---
lane: adversarial
order: 34
section: harvest-522
---
## [2026-08-06] A field named preview that carries the full body turns evidence spans into a request-path amplifier

**Severity:** HIGH
**Source:** PR #599 review swarm, finding H2 (measured: 47.6 MB / 528 ms on one traced search)
**Scope key:** `review.evidence_payload_bounded_and_deduplicated`
**Status:** superseded by issue #604 operator ruling (2026-08-06)

### Pattern

`content_preview` in this repo is defined as the FULL `t.content` (src/tools/table-constants.ts). PR #599 initially responded to the measured transcript-dump payload by slicing every evidence row to 300 characters. Issue #604 reversed that remedy at the owning boundary: healthy retrieval evidence flows in full after masking; rank input stays ids/counts-only so rows are not serialized redundantly; the whole-call byte guard remains only as an emergency circuit breaker for pathological corpus rows; and the four raw-JSONL transcript dumps were decomposed and archived through the normal lifecycle. Do not reintroduce routine per-row shortening. Review the corpus shape first, preserve full evidence, deduplicate repeated span payloads, and keep detector compilation at module scope.
