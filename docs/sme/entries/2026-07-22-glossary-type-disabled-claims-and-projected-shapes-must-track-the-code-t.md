---
lane: quality
order: 11
---
## [2026-07-22] Glossary/type "disabled" claims and projected shapes must track the code that now emits keys

**Severity:** MEDIUM
**Source:** PR #351 / issue #337 review swarm
**Scope:** `docs/GLOSSARY.md`, `src/tools/search-brain.ts` (`SearchRow.extracted_metadata`), `src/extraction.ts`
**Status:** fixed-pre-merge

- The glossary stated runtime write-time extraction was "disabled" while
  `backgroundExtract` had been switched on to write deterministic
  structural metadata (`title`, `content_hash`, `hash_version`, `byte_length`,
  deterministic ISO `dates`) into `extracted_metadata`. When a feature's on/off
  wording lives in docs, flipping the code must flip the doc in the same change.
- The public `SearchRow.extracted_metadata` projected type still listed only the
  four semantic keys, omitting the structural keys now stored and returned. A
  projected/public type that omits keys the write path emits is stale: align it
  and note which keys are content-free.
- Idempotent no-op paths (repeat `remove_source`) must communicate truthful
  success without a side effect (no revision bump); assert the no-op in tests so
  a future "always bump" refactor is caught.
