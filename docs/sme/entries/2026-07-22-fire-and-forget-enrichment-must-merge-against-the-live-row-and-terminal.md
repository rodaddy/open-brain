---
lane: adversarial
order: 15
---
## [2026-07-22] Fire-and-forget enrichment must merge against the live row, and terminal states must be terminal

**Severity:** MEDIUM
**Source:** PR #351 / issue #337 review swarm
**Scope:** `src/extraction.ts` (`backgroundExtract`), `src/source-registry.ts`
(`updateSource`, `removeSource`), interpolated-table allowlists
