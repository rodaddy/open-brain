---
lane: domain-backend
order: 14
---
## [2026-07-08] Streamable-HTTP builds a fresh McpServer per session -- "once per process" state resets

**Severity:** HIGH
**Source:** PR #275 pre-merge gauntlet for Issue #269
**Scope:** `src/index.ts` serverFactory, install/register functions for tools
and wrappers, any state initialized inside MCP server construction
**Status:** fixed in PR #275

### Pattern

The streamable-HTTP transport constructs a fresh `McpServer` per session via
`serverFactory`. Any "once per process" state initialized inside an
install/register function -- retention sweep timers, warn-once flags, counters,
caches -- silently resets on every new session. In PR #275 this would have
respawned per-session state the audit feature assumed was process-wide.

### Review Questions

- Is any state declared inside an install/register/tool-setup function assumed
  to be process-wide? It is actually per-session under serverFactory.
- Is process-wide state module-scoped or keyed by the shared pool/config object
  instead?
- Do tests create two sessions (two factory invocations) and prove the state is
  shared or reset as intended?
