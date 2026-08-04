# `openbrain-memory` is the canonical client

**Scope key:** `architecture.openbrain_memory_is_the_canonical_client`
**Source:** issue #177 ("Make openbrain-memory importable/installable + canonical redaction")
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

A canonical client package that downstream repos cannot install gets forked, and the fork drifts until a contract bump takes an agent down. `openbrain-memory` owns contract DSL interpretation, the direct package facade, lane/spool helpers, and the single canonical client redaction; Hermes owns runtime policy (read allowlist, session_key derivation, memory-mode gating, fail-closed startup). The `get_contract` DSL is a deliberate non-JSON-Schema internal format — document it and ship a package-owned converter rather than changing the wire format.

## Verbatim, from the source

> As a result, **rtech-hermes never adopted it** and instead maintains a full FORK of the OB client ... which has drifted from the server contract and caused a production outage (the v5 `type:"enum"` contract bump produced invalid tool schemas → model HTTP 400 → agent hard-down).

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
