---
lane: correctness
order: 18
---
## [2026-07-17] Cross-tool lifecycle writers must round-trip exact scope

**Severity:** HIGH
**Source:** PR #294 Full-tier review
**Scope:** `session_start`, scoped `append_session_event`, `session_checkpoint`, `session_wrap`, and their Python wrappers
**Status:** fixed in PR #294

Every lifecycle writer must establish the complete exact-scope coordinate set before persisting, including asserted nullable coordinates. Exact nullable scope is presence-sensitive: an explicitly asserted `null` key is not equivalent to an omitted key, so validators must check key presence before comparing values. Checkpoint and wrap cannot silently drop those coordinates or send a sibling tool's payload shape; tests must start a scoped lane, checkpoint it, wrap it, and prove the same exact scope is recovered end to end.
