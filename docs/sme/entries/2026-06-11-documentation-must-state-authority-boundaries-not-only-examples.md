---
lane: quality
order: 1
---
## [2026-06-11] Documentation must state authority boundaries, not only examples

**Severity:** MEDIUM
**Source:** Issues #78, #81, PR #76 review
**Scope:** `python/openbrain-memory/README.md`, public facade docs
**Status:** active

### Pattern

Examples are not enough for security-sensitive package behavior. Docs must state
which layer owns namespace authority, transport security, session lifecycle, and
Hermes integration boundaries.

### Review Questions

- Does README distinguish service location from package install location?
- Does it say token/server/header namespace authority beats convenience metadata?
- Does it document HTTP as trusted-lab opt-in only?
- Does it document session close/TTL behavior if explicit close is unsupported?
