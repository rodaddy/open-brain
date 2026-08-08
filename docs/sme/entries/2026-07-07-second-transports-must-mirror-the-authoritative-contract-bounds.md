---
lane: domain-backend
order: 10
---
## [2026-07-07] Second transports must mirror the authoritative contract bounds

**Severity:** MEDIUM
**Source:** PR #260 initial swarm for Issue #223
**Scope:** `src/nats-runtime.ts`, `src/tools/agent-context-pack.ts`, transport bridge schemas
**Status:** fixed in PR #260; keep as active checklist

### Pattern

A first-class second transport can still drift if its planning envelope accepts
fields, section names, or budgets that the authoritative HTTP/MCP tool would
reject. Planned-only bridge code is contract surface area: callers can build
against it before runtime rollout. NATS `agent_context_pack` must use the same
section enum, comparable bounds for query/budget, and a strict body schema so
unsupported planned fields fail before fallback planning.

### Review Questions

- Does the secondary transport import or mirror the same enum/bounds as the
  authoritative tool or manifest?
- Are unknown section names and unsupported body fields rejected before bridge
  planning instead of being stripped silently?
- Are query and budget limits no looser than the primary tool schema?
- Do tests cover drift cases, not only the happy-path envelope?
