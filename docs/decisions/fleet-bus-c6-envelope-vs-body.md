# C6: coordination rides the typed envelope; the body is opaque

**What this is:** the enforceable behavior rule Open Brain adopted from the
fleet-bus C6 contract. [`../GLOSSARY.md`](../GLOSSARY.md) defines envelope vs
body correctly but stops at definitions — this file states what the code must
and must not do. The contract itself lives in an external repo, so a
working-tree reader otherwise has no way to reach the rule.

**Source issue:** #291 — "Adopt C6: keep coordination in the typed envelope;
body is opaque"
**Decided / closed:** 2026-07-22 (audit complete, verified against main
`7aa529a`)
**Status:** conformant. Audit, not a code change.

**Upstream contract:**
[fleet-bus C6 — Envelope vs. Message Body](https://github.com/rodaddy/fleet-bus/blob/main/docs/contracts/C6-envelope-vs-message-body.md)

---

## The rule

Verbatim from #291:

> fleet-bus now makes **C6 — Envelope vs. Message Body** the code-enforced
> default: coordination (completion, stance, liveness, routing) rides **typed
> envelope fields** (`typed_signal` + the known wire keys); the message body
> (`payload`) is **opaque to the bus** — free for a receiver to use, but never
> a coordination signal, and control-looking body text is inert.

### As a consumer

> derive completion/stance/routing from the **typed envelope** (`typed_signal`,
> routing keys), never by scraping `payload` or reply text. The
> `[[done]]`/`[[stance]]` trailer path is gone (fleet-bus #205/#209).

### As a producer

> emit typed **`Done`/`Stance`** on `typed_signal`, keep OB-specific data in
> `payload` as opaque body — never expect the bus to act on a body key.

### Acceptance

> OB's bus paths read/write coordination through the typed envelope; `payload`
> is used only as opaque receiver data, documented as such.

## Why it matters

Control-looking text in a body is **inert**. That is a security property, not a
convenience: if a body key or a `[[done]]`-shaped string could drive
coordination, then anything that can put text in a payload — including content
that flowed in from a model or a user — can drive the bus. Typed envelope
fields cannot be forged from body content.

The removed trailer path (`[[done]]` / `[[stance]]`) is the concrete example of
what this replaced.

## Open Brain's conformance, as verified

From the closing audit against main `7aa529a`:

- **Consumer path:** [`src/nats-bridge.ts`](../../src/nats-bridge.ts) parses
  the fleet envelope and hard-rejects any inbound envelope whose typed `kind`
  is not `context_pack_request` **before** touching payload — dispatch is
  envelope-typed; payload is opaque request data only. No reply/loop poisoning
  path.
- **No body-scraped coordination anywhere:** no `[[done]]`/`[[stance]]` or
  payload-derived completion across `src/` and `python/`. OB never consumed the
  removed trailer path.
- **Producer path:** OB emits only typed request/reply envelopes
  (`context_pack_response` with body/payload as opaque receiver data); it has
  **no Done/Stance emission at all**.
- **Wire parity:**
  `python/openbrain-memory/src/openbrain_memory/nats_wire.py` reuses
  `fleet_nats.Envelope` when importable (byte-for-byte parity probed
  2026-07-08) with a 1:1 mirror fallback (PRs #284/#285).

## The one permitted body read, recorded explicitly

> the bridge reads `payload.namespace` as receiver-local data (lane override) —
> C6 explicitly permits receiver-side use of the opaque body; it is gated by
> `OPENBRAIN_NATS_ALLOW_NAMESPACE_OVERRIDE` with the documented cross-tenant
> precondition.

This is conformant because it is *receiver-local use*, not coordination: the
bus is not asked to act on the key. Anyone adding a second body read should
check it against that same distinction — and note the override is env-gated,
not on by default.

## Related

- [`../fleet-nats-integration.md`](../fleet-nats-integration.md) — the adoption.
- [`../nats-jetstream-foundation.md`](../nats-jetstream-foundation.md)
- [`../GLOSSARY.md`](../GLOSSARY.md) — envelope / contract definitions (#292).
