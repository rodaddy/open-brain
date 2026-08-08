---
lane: gotcha-agent
order: 32
section: harvest-522
---
## [2026-08-03] SessionStart additionalContext has a practical inline bound

**Severity:** not stated in source
**Source:** https://github.com/rodaddy/open-brain/pull/465; harvested in #522
**Scope key:** `hooks.session_start_context_inline_bound`
**Status:** active

### Pattern

Claude Code's SessionStart additionalContext has an observed practical inline bound: an oversized payload is persisted to a file and surfaced as a short preview, so the session silently receives a fraction of it. Emit canon as plain text (one line per rule, full body) rather than a raw JSON envelope, and split large packs across independently registered SessionStart emissions. This is formatting, not content reduction -- rule bodies stay byte-for-byte whole, and the fix must be validated by a whole-rule check that each body appears exactly once across the emissions.

Verbatim, from the source:

> `openbrain-session-start` dumped the raw `agent_context_pack` JSON envelope (~30 KB of nested items, ids, citations, confidences, warnings) into `additionalContext`, and Claude Code persisted a payload that large to a file it surfaced as only a ~2 KB preview -- the session saw 2-3 of 31 items
