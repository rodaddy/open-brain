---
lane: gotcha-agent
order: 16
---
## [2026-07-20] Silent caller-input rewriting instead of fail-closed conflict

**Severity:** MEDIUM
**Source:** Issue #297 export slice, PR #305 (#293-family review)
**Scope:** `python/openbrain-memory/src/openbrain_memory/agent.py`,
`src/agent-memory.ts`, `src/disclosure-bundle.ts`
**Status:** active

### Pattern

`export_disclosure_bundle` silently OVERWROTE a caller-supplied lane
sessionKey/agent/project with the active session's values. Silent rewriting
hides caller bugs and spoofing attempts; identity/scope conflicts must fail
closed with an explicit error, and outputs should carry an immutable
session-derived isolation stamp. Also: a "server-side gate" finding can be
stale if the path is a pure local formatter — verify a server round-trip
actually exists before prescribing a server-side fix.

### Review Questions

- Where caller input overlaps session-derived identity, is a conflict an error
  rather than a silent substitution?
- Are supplied items carrying identity fields (session_key, agent, project,
  namespace) validated against the export scope, with unverifiable fields
  rejected?
- Is the Python/TS behavior symmetric, with mirrored regression tests?
- Does the fix location match where the data actually flows (client formatter
  vs server tool)?
