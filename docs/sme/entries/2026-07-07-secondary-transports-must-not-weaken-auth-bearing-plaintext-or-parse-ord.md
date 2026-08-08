---
lane: security
order: 10
---
## [2026-07-07] Secondary transports must not weaken auth-bearing plaintext or parse-order gates

**Severity:** HIGH
**Source:** PR #262 initial swarm for Issue #223
**Scope:** `src/nats-runtime.ts`, `src/nats-bridge.ts`, NATS or other bearer-token transport bridges
**Status:** fixed in PR #262; keep as active checklist

### Pattern

Auth-bearing secondary transports can accidentally create a weaker side door
than HTTP/MCP. In PR #262, the first NATS bridge pass accepted any non-empty
`nats://` URL for runtime availability, including remote plaintext brokers, and
parsed/schema-validated the request body before bearer-token auth or request
size checks. Parser/schema details were also returned to callers.

### Review Questions

- Does an auth-bearing plaintext transport allow only local/trusted endpoints by
  default, with any remote plaintext override explicitly named and documented?
- Does the bridge authenticate cheap headers before parsing untrusted bodies?
- Is request size bounded before decode/schema validation?
- Do bad request responses avoid leaking raw parser or schema diagnostics across
  the transport boundary?
- Do unscoped namespace-only reads redact privileged `source_refs` by default?
- Does any generic shared projection include privileged source metadata without
  a caller-specific redaction or scope gate?
- Do scoped searches exclude result families without `source_refs` rather than
  returning unscoped evidence?
- Do regression tests cover parameterization, same-ref matching, scoped output
  filtering, and unscoped read redaction?
- Does returned-source-ref filtering keep valid matching refs even when a
  sibling ref is malformed, instead of dropping the whole array?
- Does the SQL scope gate require the matched array element to be a real
  citable ref (`document_id`, `path`, or `dms_id`) so row visibility and
  returned citations agree?
