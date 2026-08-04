# Context pack boundaries, contract first

**Scope key:** `architecture.context_pack_boundaries_and_contract_first`
**Source:** https://github.com/rodaddy/open-brain/issues/220
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

Realtime agent memory has non-negotiable boundaries: exact-scope filters run BEFORE vector/ranking; raw working trace is never silently promoted into durable memory; the client/runtime (not the server) owns promotion and relegation decisions; shared-kb writes require an explicit promotion workflow; HTTP/MCP stays the default until a separate rollout decision changes it; and Open Brain stays durable operational memory, never raw transcript storage or a behavior layer. The `agent_context_pack` contract is the product surface and is specified before any transport implementation — NATS is only the transport foundation.

## Verbatim, from the source

> Exact-scope filters happen before vector/ranking behavior. Raw/working trace must never be silently promoted into durable known memory. The server may assist with candidates, but client/runtime owns promotion and relegation decisions. Shared-kb writes require explicit promotion workflow. HTTP/MCP compatibility remains until NATS proves better ... Write the `agent_context_pack` contract/spec first. Do not start with NATS implementation until the envelope and scope rules are stable enough to carry.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
