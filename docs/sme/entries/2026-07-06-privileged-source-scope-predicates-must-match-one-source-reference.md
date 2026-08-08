---
lane: security
order: 9
---
## [2026-07-06] Privileged source-scope predicates must match one source reference

**Severity:** HIGH
**Source:** PR #255 pre-PR and initial swarm review for Issue #118
**Scope:** `src/source-refs.ts`, `src/tools/get-entry.ts`,
`src/tools/search-brain.ts`, `src/tools/search-all.ts`,
`src/tools/brain-answer.ts`, generic full-row REST reads
**Status:** fixed in PR #255; keep as active checklist

### Pattern

Structured source metadata is a privilege boundary for closed-brain deployments.
A JSONB predicate that checks `client_id`, `matter_id`, and `document_id` with
independent containment clauses can match those keys across separate
`source_refs` objects on the same row. That lets one row satisfy a scoped query
even though no single cited source belongs to the requested client/matter/doc.
Adding privileged `source_refs` to shared full-row projections can also leak
them through namespace-only reads unless every generic read surface redacts by
default. Scope filters must also account for every identifier accepted on
`source_refs`; accepting `path` or `dms_id` without allowing the same fields in
`source_scope` creates write-only provenance that cannot be safely returned.
The scope gate and the returned-source-ref filter must validate refs at the same
granularity: all-or-nothing array validation can silently drop a valid matching
ref when any sibling ref is malformed, and SQL gates that do not require a
document identifier can let row content pass a scope that no returned citation
can satisfy.

### Review Questions

- Do multi-key source-scope filters require all supplied keys to match the same
  `source_refs` array element, for example through `jsonb_array_elements` and
  one `EXISTS` predicate?
- Are all accepted source-ref identifiers represented in `source_scope`
  (`client_id`, `matter_id`, `document_id`, `path`, and `dms_id`)?
- Are scoped filters parameterized and applied consistently to search,
  answer/citation, compact fetch, and full fetch paths?
