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

## Future decision template

- Date/context:
- Doc/code disagreement or scope change:
- Options considered:
- Decision and rationale:
- Validation impact:
