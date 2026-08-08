---
lane: quality
order: 16
section: harvest-522
---
## [2026-08-03] Provenance that no read projection exposes is not a control

**Severity:** not stated in source
**Source:** rodaddy/open-brain#62 (review swarm comment by rodaddy); harvested in #522
**Scope key:** `sme.quality.written_provenance_must_be_readable`
**Status:** active

### Pattern

Provenance that is written but not exposed through any read projection is unauditable and therefore not a real control. When a change adds a provenance or audit column, verify it appears in the retrieval projections of every surface (REST and MCP) or that a named provenance endpoint exists.

Verbatim, from the source:

> PR #62 writes `promoted_from`, but PR #61/stack entry projections omit it from REST and MCP `get_entry` results. Promoted entries should be auditable after creation.
