---
lane: correctness
order: 54
section: harvest-522
---
## [2026-08-03] Sibling wrappers on one endpoint need shared normalization

**Severity:** MEDIUM (stated in source)
**Source:** https://github.com/rodaddy/open-brain/issues/218; harvested in #522
**Scope key:** `sme.sibling_wrappers_need_shared_normalization`
**Status:** active

### Pattern

When two sibling client methods call the same server endpoint, a normalization/cap applied in one and not the other is a contract escape: the unnormalized sibling sends unsupported fields and bypasses server limits. Review parallel wrapper methods for a shared normalization path rather than duplicated inline logic, and add a regression proving the field is not forwarded.

Verbatim, from the source:

> MEDIUM: Python `AgentMemory.checkpoint(..., receipt_refs=[...])` accepted `receipt_refs` after the parity change but forwarded it directly to `session_wrap`, unlike `wrap_session()`. That could still send an unsupported server field and bypass the max-20 `next_steps` cap. ... Fix: `checkpoint()` and `wrap_session()` now share one `_session_wrap_metadata()` normalization path.
