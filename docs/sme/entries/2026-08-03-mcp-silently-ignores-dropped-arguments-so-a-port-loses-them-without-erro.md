---
lane: correctness
order: 58
section: harvest-522
---
## [2026-08-03] MCP silently ignores dropped arguments, so a port loses them without error

**Severity:** not stated in source
**Source:** https://github.com/rodaddy/open-brain/pull/516; harvested in #522
**Scope key:** `review.mcp_silently_ignores_dropped_args`
**Status:** active

### Pattern

MCP tool schemas silently ignore unknown arguments, so a port that drops a declared argument produces no error -- callers keep sending it and get unbounded results. session_context lost event_limit/event_types/importance in the rewrite and returned 1,256 events / 3.2MB for a request asking for 3, killing every resume on the machine. Review question for any tool port: does the new schema declare every argument the frozen contract declares, and is each one actually APPLIED in the query rather than merely accepted?

Verbatim, from the source:

> The MCP schema silently ignores unknown arguments, so clients passing `event_limit` got the whole lane anyway.
