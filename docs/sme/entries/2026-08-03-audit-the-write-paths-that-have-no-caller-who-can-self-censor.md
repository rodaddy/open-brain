---
lane: security
order: 39
section: harvest-522
---
## [2026-08-03] Audit the write paths that have no caller who can self-censor

**Severity:** not stated in source
**Source:** https://github.com/rodaddy/open-brain/issues/236; harvested in #522
**Scope key:** `sme.audit_write_paths_lacking_a_composer`
**Status:** active

### Pattern

When a system's secret safety rests on "the caller does not write secrets," the security question is: which write paths have no caller who can self-censor? Automated importers, backfill scripts, and LLM-summarization pipelines fed by raw transcripts have no composer and therefore inherit no protection — they need explicit redaction at their own boundary. Audit write paths by composer presence, not by tool surface.

Verbatim, from the source:

> Found during an OB write-path audit (does anything write to OB from a source that cannot self-censor?). Answer: exactly one path, this one. ... `scripts/ob-backfill.ts` is an automated importer with **no human/agent composing the payload** and **no secret redaction** ... it bypasses [the contract] because there is no composer and no redactor.
