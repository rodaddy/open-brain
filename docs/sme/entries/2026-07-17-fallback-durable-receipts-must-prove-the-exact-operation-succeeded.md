---
lane: adversarial
order: 11
---
## [2026-07-17] Fallback durable receipts must prove the exact operation succeeded

**Severity:** HIGH
**Source:** PR #294 Full-tier review
**Scope:** Python local-first primary direct routing, `mcp2cli` subprocess fallback, and direct-start recovery
**Status:** fixed in PR #294

A generic success-shaped primary or fallback response is not durable evidence. Both paths must validate tool-specific result fields and presence-sensitive exact nullable scope proof for `session_start` and `agent_context_pack`; subprocess fallback must also bound stdout/stderr while streaming so a noisy child cannot exhaust memory. Response/receipt validation failures belong to the recoverable runtime path and must continue to the configured fallback or spool; caller-input validation failures must stop before any transport attempt. If direct start partially succeeds and a later step fails, fallback must verify the intended lane rather than treating any active lane as proof. Tests must force primary and fallback partial-start failure, wrong-lane evidence, null-versus-omitted scope, malformed success payloads, invalid caller input, and unbounded-output pressure.
