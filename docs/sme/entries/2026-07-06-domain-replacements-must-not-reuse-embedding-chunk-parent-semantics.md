---
lane: domain-backend
order: 9
---
## [2026-07-06] Domain replacements must not reuse embedding chunk parent semantics

**Severity:** MEDIUM
**Source:** PR #254 Claude/Opus cross-review for Issue #247
**Scope:** `thoughts.parent_id`, decomposition/rewrite tools, recall-visible
replacement rows
**Status:** fixed in PR #254; keep as active checklist

### Pattern

`thoughts.parent_id` is not a generic provenance link. It identifies embedding
sub-chunks, and recall/listing paths intentionally exclude rows with
`parent_id IS NOT NULL` from top-level results. A tool that writes replacement
thoughts as standalone recall entries must not set `parent_id` to the source
row just to preserve lineage.

### Review Questions

- Is the new row supposed to be recall/list visible as a top-level memory?
- If yes, does it keep `parent_id = null` and put lineage in provenance/tags or
  the owning relationship model instead?
- Do tests assert the insert parameters keep replacement rows out of chunk-only
  semantics?
