# A new transport reuses the authoritative assembler

**Scope key:** `architecture.new_transport_reuses_authoritative_assembler`
**Source:** https://github.com/rodaddy/open-brain/pull/262
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

A new transport must not become a side door around auth: the NATS bridge requires a bearer token, resolves it through the existing token map, and calls the exact same server-side `agent_context_pack` assembler used by MCP so namespace predicates and exact-scope filtering cannot be bypassed. Transport availability is contract-gated — `get_contract()` advertises NATS only when server runtime, bridge enablement, URL trust, and live bridge health all agree — so clients never see an advertised-but-dead transport.

## Verbatim, from the source

> Reuses the existing server-authoritative `agent_context_pack` assembler so NATS cannot bypass bearer-token auth, namespace predicates, exact-scope filtering, or HTTP/MCP default behavior. Makes NATS runtime availability contract-gated: `get_contract()` reports NATS availability only when the server runtime, bridge enablement, URL trust, and live bridge health all agree.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
