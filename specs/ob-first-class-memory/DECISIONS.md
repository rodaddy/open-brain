# Decisions

## D1 — Owning boundary

The new foundation belongs inside `openbrain-memory`, above existing `OpenBrainClient`/`AgentMemory` protocol methods and below runtime-specific hooks. Thin adapters exchange bounded JSON with this package API.

## D2 — No invented runtime identity

Namespace, agent identity, project/repository scope, service URL, and token come only from explicit arguments or named environment variables. The package does not hardcode deployment identity or secrets.

## D3 — Truthful outcomes

Receipts describe observed outcomes, not intent. A direct durable success may be `saved`; a local durable queue is `spooled`; a successful secondary path is `fallback`; an operation with no durable destination is `lost`/failed. Setup/call attempts alone are never saved.

## D4 — Distilled content only

This API accepts caller-distilled lifecycle content, not transcript payloads. Existing package redaction and size limits remain the source of truth and are applied before direct or fallback writes.

## D5 — Lane prerequisite and requested write share spool ownership

A fresh-lane failure is handled at the runtime lifecycle/spool boundary. The
runtime defers the failed `session_start` spool record until the requested write
payload is known, then `JsonlSpool.append_batch()` commits both in replay order
or commits neither. Spools without atomic batch support cannot claim the
requested write is durable and therefore produce a truthful `lost` receipt.

## D6 — Ordered spool groups survive retention and replay

Multi-record batches carry opaque group metadata through JSONL parsing and
rewrite. Capacity trimming evicts complete contiguous groups, never individual
members. Replay preserves normal per-record success removal, but a failed grouped
prerequisite blocks later records in that group until a subsequent replay. Legacy
records without group metadata remain independent and compatible.

## D7 — Exact scope must be persisted and recalled at the server boundary

A scoped append to a legacy lane may atomically fill previously null agent/platform/server/channel/thread coordinates, but it must never overwrite an asserted coordinate. The attachment update is constrained by lane ID, auth-derived namespace, session key, and conditional equality; a concurrent conflicting assertion fails closed. `agent_context_pack` returns `durable_lane_context` only when explicitly requested and only after all seven exact coordinates match.

## D8 — Runtime injection is a prioritized allowlist, not raw context serialization

The package/server own memory selection and safety. The separately owned Development provider branch formats only auth-derived scope, allowed distilled durable event types, bounded lane checkpoint text, and string working-set items. Durable events are emitted before lower-priority working context so the 3,000-character Claude/Codex/Pi envelope preserves current cross-runtime continuity. Unknown context fields, question events, diagnostics, transcripts, tools, and arbitrary metadata are not injected. This Open Brain candidate supplies and validates the server/package contract only; it does not contain the provider implementation.

## D9 — Bump to contract v22 and state the real package floor

`durable_lane_context` is opt-in and legacy append call shapes remain wire-compatible, but the canonical hashed public contract changes: tool versions, accepted section names, output declarations, and exact-scope attachment semantics are new. Downstream Hermes enforcement pins both `contract_version` and `schema_hash`, and repository history bumps the memory-tools contract whenever hashed required fields change. Keeping v21 would therefore mislabel a contract that strict old clients reject on hash drift. The server contract becomes `2026-07-17.memory-tools.v22`; tool-level versions become `agent_context_pack` v2 and `append_session_event` v8.

Package `0.1.8` requires server contract v22 with `agent_context_pack` v2 and `append_session_event` v8. The v22 manifest minimum and range are `0.1.8` / `>=0.1.8 <1.0.0`; package `0.1.7` pins v21 and is not v22-compatible. This is the narrow necessary break: valid legacy wire call shapes remain additive, but the first-class runtime does not accept v21 and strict contract-aware 0.1.7 clients must upgrade.

## D10 — Transport priority stays direct HTTP, optional mcp2cli, then spool

`openbrain-memory` calls Open Brain directly over streamable HTTP `/mcp` first. An injected fixed-argv `mcp2cli` route is an optional secondary path used only after direct setup/call failure and is disabled by default. For writes, the local JSONL spool is the last durable fallback after both network paths fail; `spooled` is never reported as `saved`. Recall fails open without writing to the spool.

## Future decision template

- Date/context:
- Doc/code disagreement or scope change:
- Options considered:
- Decision and rationale:
- Validation impact:
