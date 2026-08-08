---
lane: domain-backend
order: 6
---
## [2026-06-27] Adapter contract mappings must match facade behavior

**Severity:** MEDIUM
**Source:** PR #218 full swarm
**Scope:** `src/contract.ts`, `docs/agent-memory-adapter-contract.md`, Python/TS facades
**Status:** fixed in PR #218

### Pattern

The local adapter contract can mislead downstream generated consumers if a
method advertises tool calls the facade does not make. In PR #218, `wrap`
advertised `session_context` even though only `compact` reads context before
`session_wrap`, and Python `recall` initially lacked the TS facade's optional
session/answer behavior.

### Review Questions

- Does `get_contract().agent_memory_adapter.methods.*.maps_to` match actual
  facade calls?
- If TS and Python are both advertised as runtime facades, do they expose the
  same Hermes-facing behavior even if return shapes differ?
- Are transport/runtime rollout changes kept out of Open Brain unless the
  downstream rollout issue explicitly owns them?
