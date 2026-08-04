# `get_contract` is the whole manual

**Scope key:** `contract.get_contract_is_the_whole_manual`
**Source:** issue #172 (body, provenance line credits Rico 2026-06-19)
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

Downstream agents are 100% contract-driven: get_contract is their entire knowledge of the tool surface, so every agent-facing tool and field must carry real per-field/per-tool usage help, not bare type/length schemas. A capability documented only in code or repo docs does not exist for the agent. Any new behavior must be expressed in the contract so contract-driven clients pick it up with no client code change.

## Verbatim, from the source

> Hermes agents are **direct HTTP clients of the OB server** and are **100% contract-driven**: whatever `get_contract` returns is the agent's *entire* knowledge of what it can do and how. ... So if the "how/when/why" of a capability isn't in the contract, the agent cannot know it.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
