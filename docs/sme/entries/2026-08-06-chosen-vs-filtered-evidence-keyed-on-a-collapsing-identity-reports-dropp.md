---
lane: adversarial
order: 35
section: harvest-522
---
## [2026-08-06] Chosen-vs-filtered evidence keyed on a collapsing identity reports dropped rows as chosen

**Severity:** MEDIUM
**Source:** PR #599 review swarm, finding M4
**Scope key:** `review.selection_evidence_keys_are_unique_per_candidate`
**Status:** active

### Pattern

Selection evidence built by re-matching candidates against results via a derived key (`row.id ?? "qmd:" + path`) lies whenever the key collapses: qmd rows carry no id, chunks share paths, and absent paths collapse to one literal key — so a dropped candidate is reported `chosen: true`, answering "why wasn't this returned" with an affirmative falsehood. Key selection by pre-sort array index (or have the selecting code RETURN its classification) rather than re-deriving identity, and distinguish drop REASONS the branch structure knows (pagination offset vs ranking window vs limit). Test shape: two candidates that collapse to one key where only one survives; assert exactly one chosen.
