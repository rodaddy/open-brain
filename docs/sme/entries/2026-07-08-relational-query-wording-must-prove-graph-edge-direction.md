---
lane: correctness
order: 15
---
## [2026-07-08] Relational query wording must prove graph edge direction

**Severity:** MEDIUM
**Source:** PR #274 initial swarm for Issue #267
**Scope:** `src/tools/search-brain.ts`, relational graph retrieval tests
**Status:** fixed in PR #274; keep as active checklist

### Pattern

Natural-language relation prompts can encode the inverse of the storage edge.
In PR #274, "What depends on Alpha?" was initially tested as
`Alpha -> target`, but the natural answer is rows that depend on Alpha
(`target -> Alpha`). A test oracle with the same wrong direction can make the
implementation and fixtures agree while user semantics are wrong.

### Review Questions

- For each relational phrase, does the test name the expected graph direction
  explicitly?
- Does "What depends on X?" hydrate rows whose link points to X, while "What
  does X depend on?" hydrates rows pointed to by X?
- Are fixture links shaped independently from the implementation SQL, so the
  test fails when the join direction is inverted?
