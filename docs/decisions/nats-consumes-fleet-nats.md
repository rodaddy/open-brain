# Open Brain consumes fleet-nats; it does not fork it

**Scope key:** `architecture.nats_consumes_fleet_nats_not_own_fork`
**Source:** https://github.com/rodaddy/open-brain/issues/223
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

NATS work in Open Brain consumes `rodaddy/fleet-bus`'s canonical `fleet-nats` package via a thin adapter rather than forking its own NATS glue. Connection config stays in env (`FLEET_NATS_URL`, `FLEET_AGENT_ID`, `FLEET_ENV`) — never hardcode CT274/core01 URLs. JetStream is infrastructure/durability/observability only; the agent-facing context-pack path stays NATS core request/reply plus HTTP fallback. The DAP orchestrator, per-agent Hermes subscribers, k-board bridge, trio deploy, and e2e proving run are fleet-bus-owned and out of scope for Open Brain.

## Verbatim, from the source

> Consume/align with `fleet-nats` primitives: `BusConfig`, `Envelope`, `FleetBus`, and `fleet_nats.subjects`. Keep connection config in env (`FLEET_NATS_URL`, `FLEET_AGENT_ID`, `FLEET_ENV`); do not bake CT274/core01 URLs into code. Treat JetStream as infrastructure/durability/observability ... Do not take over fleet-bus-owned work: DAP orchestrator, per-agent Hermes subscribers, k-board bridge, trio deploy, and e2e Discord/k-board proving run.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
