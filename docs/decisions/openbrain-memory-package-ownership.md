# Package ownership: this repo owns the client, Hermes owns the adapter

**Scope key:** `decision.openbrain_memory_package_ownership_and_placement`
**Source:** rodaddy/open-brain#66, #71 (issue bodies)
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

Repo ownership boundary: `rodaddy/open-brain` owns the protocol, client, and memory-policy package; `rtech-hermes` owns only the thin Hermes lifecycle adapter. `python/openbrain-memory/` living in this repo does NOT mean it runs on the Open Brain host — it installs on agent hosts (Bilby, Skippy, Nagatha, automation) and talks to the remote service over HTTP/MCP.

## Verbatim, from the source

> `rodaddy/open-brain`: owns protocol/client/memory policy package; `rtech-hermes`: owns Hermes lifecycle adapter only. ... README prevents confusion that package placement means it only runs on the LXC.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
